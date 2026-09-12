const { Markup } = require('telegraf');
const {
  getSession,
  updateSession,
  createAdminHandoff,
  getAdminHandoffByMessageId,
  getPendingHandoff,
  markAdminHandoffFulfilled,
  getOutageFlag,
  setOutageFlag,
} = require('../db');
const { postToSupportTopic, isAdminGroupMessage } = require('../lib/adminGroup');
const { escapeHtml, reply, sendHtml } = require('../lib/html');
const { lookupDevice } = require('../lib/deviceLookup');
const { SMARTERS_DOWNLOADER_CODE } = require('../lib/setupInstructions');
const { createCooldown } = require('../lib/cooldown');

// Blocks rapid re-triggering of /start for the same reason as the
// onboarding bot — see bots/onboard.js.
const START_COOLDOWN_MS = 10_000;
const startCooldown = createCooldown(START_COOLDOWN_MS);

// Per-user conversation state. Support chats are short synchronous
// back-and-forths, not multi-day pauses like onboarding, so plain in-memory
// state (lost on restart) is enough for v1 — no SQLite table needed.
const conversations = new Map();

// The three setup_steps_ref values that go through the Downloader + code +
// Smarters Pro APK sideload mechanism (see lib/setupInstructions.js) — app
// download issues on these get Downloader-specific troubleshooting instead
// of the generic "check the app store" steps.
const SIDELOAD_REFS = new Set(['firestick_sideload', 'android_sideload', 'google_tv_sideload']);

const LOGIN_COMMON_CHECKS =
  "First, double-check the basics: make sure <b>Xtream Codes Login</b> is selected (not M3U/URL), there's no typo or extra space in the server, username, or password (especially if you copy-pasted them), and your 24-hour trial hasn't expired.";

function loginStepsForDevice(device) {
  const app = device ? device.app_to_install : null;
  let deviceStep;
  if (app === 'GSE Smart IPTV') {
    deviceStep =
      'Open <b>GSE Smart IPTV</b>, delete the saved playlist, and re-add it via Xtream Codes Login with the same details.';
  } else if (app === 'MyIPTV Player') {
    deviceStep = 'Open <b>MyIPTV Player</b>, remove the existing login, and re-add it via Xtream Codes Login.';
  } else {
    // IPTV Smarters Pro covers Firestick/Android TV Stick, Phone (Android),
    // and Desktop/Mac — also the fallback when the device couldn't be
    // matched, since it's the most common app across devices.
    deviceStep =
      'Open <b>IPTV Smarters Pro</b>, delete the saved playlist, and re-add it using Xtream Codes Login — double-check the server URL, username, and password for typos or extra spaces.';
  }
  return `${LOGIN_COMMON_CHECKS}\n\n${deviceStep}\n\nDid that fix it?`;
}

function downloadStepsForDevice(device) {
  const isSideload = device && SIDELOAD_REFS.has(device.setup_steps_ref);
  if (isSideload) {
    return `Double-check you entered code <b>${SMARTERS_DOWNLOADER_CODE}</b> exactly in Downloader — try again after a minute if it says "file not found" (codes are occasionally rate-limited). Confirm <b>Apps from Unknown Sources</b> is still enabled in Developer Options, and that you have enough free storage.\n\nDid that fix it?`;
  }
  return "Confirm you're searching for the right app name — <b>IPTV Smarters Pro</b> (Android/PC), <b>GSE Smart IPTV</b> (iPhone/iPad), <b>MyIPTV Player</b> (Xbox). Check your internet connection and restart the store app if the download is stuck.\n\nDid that fix it?";
}

const BUFFERING_GENERIC_STEPS =
  'Try moving your device closer to the router, or switching to a wired ethernet connection if your device supports it. Close any other apps or streams using bandwidth on your network.\n\nIs it still buffering?';

const CATEGORIES = {
  server: {
    label: 'Server down',
    needsDevice: true,
    devicePrompt: 'Which device are you using?',
    followUp: () => 'Try restarting the app. Is it working now?',
    offerResolution: true,
    ispAware: true,
    outageAware: true,
  },
  buffering: {
    label: 'Buffering',
    needsDevice: true,
    devicePrompt: 'Which device are you using?',
    followUp: () => BUFFERING_GENERIC_STEPS,
    offerResolution: true,
    ispAware: true,
    outageAware: true,
  },
  login: {
    label: 'Login issue',
    needsDevice: true,
    devicePrompt: 'Which device are you using?',
    followUp: loginStepsForDevice,
    offerResolution: true,
  },
  download: {
    label: 'App download issue',
    needsDevice: true,
    devicePrompt: 'Which device are you trying to install the app on?',
    followUp: downloadStepsForDevice,
    offerResolution: true,
  },
  other: {
    label: 'Other',
    needsDevice: false,
    questions: [{ key: 'details', prompt: 'Please describe the issue.' }],
    offerResolution: false,
  },
};

const categoryKeyboard = Markup.inlineKeyboard(
  Object.entries(CATEGORIES).map(([key, cat]) => Markup.button.callback(cat.label, `sup_cat_${key}`)),
  { columns: 2 }
);

const resolutionKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('Fixed now', 'sup_resolved_yes'),
  Markup.button.callback('Still broken', 'sup_resolved_no'),
]);

const ispPatternKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('Consistently', 'sup_isp_pattern_consistent'),
  Markup.button.callback('On and off', 'sup_isp_pattern_intermittent'),
]);

function fixResolutionKeyboard(adminMessageId) {
  return Markup.inlineKeyboard([
    Markup.button.callback('That worked', `supportfix_ok_${adminMessageId}`),
    Markup.button.callback('Still broken', `supportfix_bad_${adminMessageId}`),
  ]);
}

function deviceChoiceKeyboard(devices) {
  return Markup.inlineKeyboard(
    devices.map((d, i) => Markup.button.callback(d.display_name, `sup_device_${i}`)),
    { columns: 1 }
  );
}

function username(ctx) {
  if (ctx.from.username) return `@${ctx.from.username}`;
  return `${escapeHtml(ctx.from.first_name || 'customer')} (id ${ctx.from.id})`;
}

function planLabel(tier) {
  return `${tier} device${tier === 1 ? '' : 's'}`;
}

async function showCategoryMenu(ctx) {
  await reply(ctx, 'What can we help you with?', categoryKeyboard);
}

// Every device the customer has on file, in a uniform shape regardless of
// whether it came from a single-device order (legacy top-level session
// columns) or a multi-device order (devices_json array).
function getKnownDevices(onboardingSession) {
  if (!onboardingSession) return [];

  if (onboardingSession.devices_json) {
    try {
      const arr = JSON.parse(onboardingSession.devices_json);
      if (Array.isArray(arr) && arr.length) {
        return arr.filter(Boolean).map((d, i) => ({
          display_name: d.display_name || `Device ${i + 1}`,
          app_to_install: d.app_to_install || null,
          setup_steps_ref: d.setup_steps_ref || null,
        }));
      }
    } catch {
      // Malformed devices_json — fall through to the legacy fields below.
    }
  }

  if (onboardingSession.device_display_name) {
    return [
      {
        display_name: onboardingSession.device_display_name,
        app_to_install: onboardingSession.device_app_to_install || null,
        setup_steps_ref: onboardingSession.device_setup_steps_ref || null,
      },
    ];
  }

  return [];
}

// Sends the (possibly device-branched) follow-up and marks the
// conversation as awaiting the Yes/No resolution tap. The text is cached
// on state so a stray text message re-shows the same follow-up instead of
// recomputing it.
async function sendFollowUp(ctx, state, device) {
  const category = CATEGORIES[state.categoryKey];
  const text = category.followUp(device);
  state.followUpText = text;
  state.awaitingResolution = true;
  await reply(ctx, text, resolutionKeyboard);
}

// Server down / Buffering, when the customer's onboarding session has a
// flagged ISP: skip the device question (the device doesn't change an ISP
// diagnosis) and go straight to a targeted question, then straight to a
// ticket — restarting the app doesn't fix a known ISP issue, so there's no
// resolution offer on this path.
async function startCategory(ctx, key) {
  const category = CATEGORIES[key];

  if (category.outageAware) {
    const outage = getOutageFlag();
    if (outage.active) {
      await reply(
        ctx,
        `This is a known issue — ${escapeHtml(outage.description)}. We're on it, no need to open a ticket.`
      );
      return;
    }
  }

  const onboardingSession = getSession(ctx.from.id);

  if (category.ispAware && onboardingSession && onboardingSession.isp_flagged) {
    conversations.set(ctx.from.id, { categoryKey: key, ispAware: true, answers: {} });
    await reply(
      ctx,
      `You're on <b>${escapeHtml(onboardingSession.isp_input)}</b>, which we've flagged for occasional connectivity issues.\n\nIs this happening consistently, or on and off?`,
      ispPatternKeyboard
    );
    return;
  }

  if (category.needsDevice) {
    const devices = getKnownDevices(onboardingSession);

    if (devices.length === 1) {
      const state = { categoryKey: key, answers: { device: devices[0].display_name } };
      conversations.set(ctx.from.id, state);
      await sendFollowUp(ctx, state, devices[0]);
      return;
    }

    if (devices.length > 1) {
      const state = { categoryKey: key, awaitingDeviceChoice: true, devices, answers: {} };
      conversations.set(ctx.from.id, state);
      await reply(ctx, 'Which device is this affecting?', deviceChoiceKeyboard(devices));
      return;
    }

    // No device on file (e.g. they message support without ever finishing
    // onboarding) — ask, and try to match their answer against the device
    // database so they still get device-specific steps where possible.
    const state = { categoryKey: key, awaitingDeviceText: true, answers: {} };
    conversations.set(ctx.from.id, state);
    await reply(ctx, category.devicePrompt);
    return;
  }

  conversations.set(ctx.from.id, { categoryKey: key, questionIndex: 0, answers: {} });
  await askNextQuestion(ctx);
}

async function askNextQuestion(ctx) {
  const state = conversations.get(ctx.from.id);
  const category = CATEGORIES[state.categoryKey];
  await reply(ctx, category.questions[state.questionIndex].prompt);
}

async function handleAnswer(ctx, state) {
  const category = CATEGORIES[state.categoryKey];
  const question = category.questions[state.questionIndex];
  state.answers[question.key] = ctx.message.text.trim();
  state.questionIndex += 1;

  if (state.questionIndex < category.questions.length) {
    await askNextQuestion(ctx);
    return;
  }

  if (category.offerResolution) {
    await sendFollowUp(ctx, state, null);
  } else {
    await logTicket(ctx, state);
    conversations.delete(ctx.from.id);
  }
}

async function handleDeviceText(ctx, state) {
  const rawText = ctx.message.text.trim();
  const matched = lookupDevice(rawText);

  state.answers.device = matched ? matched.display_name : rawText;
  state.awaitingDeviceText = false;

  await sendFollowUp(
    ctx,
    state,
    matched ? { app_to_install: matched.app_to_install, setup_steps_ref: matched.setup_steps_ref } : null
  );
}

async function handleDeviceChoice(ctx, index) {
  const state = conversations.get(ctx.from.id);
  if (!state || !state.awaitingDeviceChoice) {
    await reply(ctx, 'Let’s start over. What can we help you with?', categoryKeyboard);
    return;
  }
  const device = state.devices[index];
  if (!device) {
    await reply(ctx, 'Please tap one of the buttons above.', deviceChoiceKeyboard(state.devices));
    return;
  }

  state.answers.device = device.display_name;
  state.awaitingDeviceChoice = false;

  await sendFollowUp(ctx, state, device);
}

async function handleIspPattern(ctx, patternLabel) {
  const state = conversations.get(ctx.from.id);
  if (!state) {
    await reply(ctx, 'Let’s start over. What can we help you with?', categoryKeyboard);
    return;
  }
  state.answers.pattern = patternLabel;
  await reply(
    ctx,
    "Thanks — this matches the known issue pattern we're tracking.\n\nWe'll log this instance for the team."
  );
  await logTicket(ctx, state);
  conversations.delete(ctx.from.id);
}

async function logTicket(ctx, state) {
  const category = CATEGORIES[state.categoryKey];
  const onboardingSession = getSession(ctx.from.id);

  const lines = [
    `🎫 <b>Support Ticket — ${category.label}</b>`,
    '',
    `<b>Customer:</b> ${username(ctx)}`,
    ...Object.entries(state.answers).map(
      ([key, value]) => `<b>${escapeHtml(key[0].toUpperCase() + key.slice(1))}:</b> ${escapeHtml(value)}`
    ),
  ];

  if (onboardingSession) {
    lines.push(
      '',
      `<b>Plan on file:</b> ${onboardingSession.plan_tier ? planLabel(onboardingSession.plan_tier) : 'unknown'}`,
      `<b>Device on file:</b> ${onboardingSession.device_display_name ? escapeHtml(onboardingSession.device_display_name) : 'unknown'}`
    );
    if (onboardingSession.isp_input) {
      const flaggedNote = onboardingSession.isp_flagged ? ' (flagged)' : '';
      lines.push(`<b>ISP on file:</b> ${escapeHtml(onboardingSession.isp_input)}${flaggedNote}`);
    }
  }

  lines.push('', `Time: ${new Date().toISOString()}`);

  await postToSupportTopic(ctx.telegram, lines.join('\n'));
  await reply(ctx, "Thanks — we've flagged this to the team.\n\nThey'll follow up here shortly.");
}

// A diagnostic that didn't fix it needs a human, not another canned tip —
// get their own description of what's happening, then post a reply-able
// ticket to the Support topic so a reply from the team is forwarded
// straight back to the customer (see handleSupportFixReply below).
async function handleDescriptionAndEscalate(ctx, state) {
  state.answers.description = ctx.message.text.trim();
  state.awaitingDescription = false;
  await logSupportFixTicket(ctx, state);
  conversations.delete(ctx.from.id);
}

async function logSupportFixTicket(ctx, state) {
  // Don't post a second reply-able ticket if one's already pending for
  // this user (e.g. from rapidly restarting the support flow before the
  // team has replied to the first one) — the existing one still works.
  if (getPendingHandoff(ctx.from.id, 'support_fix')) {
    await reply(ctx, "Thanks — we've already flagged this to the team.\n\nThey'll follow up here shortly.");
    return;
  }

  const category = CATEGORIES[state.categoryKey];
  const onboardingSession = getSession(ctx.from.id);
  const { description, ...otherAnswers } = state.answers;

  const lines = [
    `🎫 <b>Support Ticket — ${category.label}</b>`,
    '',
    `<b>Customer:</b> ${username(ctx)}`,
    ...Object.entries(otherAnswers).map(
      ([key, value]) => `<b>${escapeHtml(key[0].toUpperCase() + key.slice(1))}:</b> ${escapeHtml(value)}`
    ),
  ];

  if (state.followUpText) {
    lines.push('', '<b>Diagnostic steps already tried:</b>', state.followUpText);
  }

  if (onboardingSession) {
    lines.push(
      '',
      `<b>Plan on file:</b> ${onboardingSession.plan_tier ? planLabel(onboardingSession.plan_tier) : 'unknown'}`,
      `<b>Device on file:</b> ${onboardingSession.device_display_name ? escapeHtml(onboardingSession.device_display_name) : 'unknown'}`
    );
    if (onboardingSession.isp_input) {
      const flaggedNote = onboardingSession.isp_flagged ? ' (flagged)' : '';
      lines.push(`<b>ISP on file:</b> ${escapeHtml(onboardingSession.isp_input)}${flaggedNote}`);
    }
  }

  lines.push(
    '',
    "<b>Customer's description:</b>",
    escapeHtml(description),
    '',
    `Time: ${new Date().toISOString()}`,
    '',
    'Reply to <b>this message</b> with a fix — it will be forwarded to the customer as-is.'
  );

  const sent = await postToSupportTopic(ctx.telegram, lines.join('\n'));

  if (sent) {
    createAdminHandoff({
      adminMessageId: sent.message_id,
      kind: 'support_fix',
      telegramUserId: ctx.from.id,
      planTier: onboardingSession ? onboardingSession.plan_tier : null,
      deviceDisplayName: state.answers.device || null,
    });
  } else {
    console.warn(`[support] Admin group not configured — could not create a support_fix handoff for user ${ctx.from.id}.`);
  }

  await reply(ctx, "Thanks — we've flagged this to the team with your details.\n\nThey'll follow up here shortly.");
}

// The admin's reply is sent verbatim (HTML-escaped, not re-formatted) under
// a fixed header — it needs to reliably reflect what they actually typed.
// Attaches That worked / Still broken so the thread doesn't just dead-end
// after one reply.
async function handleSupportFixReply(ctx, handoff) {
  const fixText = ctx.message.text.trim();
  await sendHtml(
    ctx.telegram,
    handoff.telegram_user_id,
    `<b>Update from the team:</b>\n\n${escapeHtml(fixText)}`,
    fixResolutionKeyboard(handoff.admin_message_id)
  );
  markAdminHandoffFulfilled(handoff.admin_message_id);
  await reply(ctx, '✅ Sent to the customer.');
}

// Customer taps "Still broken" — reopen with a fresh reply-able ticket
// instead of dead-ending, so another reply goes through the same
// send-with-buttons cycle.
async function handleFixStillBroken(ctx, handoff) {
  await reply(ctx, "Sorry that didn't do it — we've flagged this to the team again. They'll follow up here.");

  // Telegram doesn't disable a button after one tap, so this could be
  // tapped repeatedly on the same message — don't reopen more than once
  // while a reopened ticket is still pending a reply.
  if (getPendingHandoff(handoff.telegram_user_id, 'support_fix')) {
    return;
  }

  const lines = [
    "⚠️ <b>Customer says this didn't work</b>",
    '',
    `<b>Customer:</b> ${username(ctx)}`,
  ];
  if (handoff.plan_tier) lines.push(`<b>Plan:</b> ${planLabel(handoff.plan_tier)}`);
  if (handoff.device_display_name) lines.push(`<b>Device:</b> ${escapeHtml(handoff.device_display_name)}`);
  lines.push('', 'Reply to <b>this message</b> with another fix — it will be forwarded to the customer as-is.');

  const sent = await postToSupportTopic(ctx.telegram, lines.join('\n'));
  if (sent) {
    createAdminHandoff({
      adminMessageId: sent.message_id,
      kind: 'support_fix',
      telegramUserId: handoff.telegram_user_id,
      planTier: handoff.plan_tier,
      deviceDisplayName: handoff.device_display_name,
    });
  } else {
    console.warn(`[support] Admin group not configured — could not reopen support_fix handoff for user ${handoff.telegram_user_id}.`);
  }
}

async function handleAdminHandoffReply(ctx) {
  const repliedTo = ctx.message.reply_to_message;
  const handoff = getAdminHandoffByMessageId(repliedTo.message_id);
  if (!handoff || handoff.status !== 'pending' || handoff.kind !== 'support_fix') {
    // Not a message we're tracking for reply-based handling — could be a
    // stray reply, or a second reply to an already-fulfilled ticket.
    return;
  }
  await handleSupportFixReply(ctx, handoff);
}

function register(bot) {
  // The admin group must never run the customer-facing flow — gate it once,
  // here, ahead of every other handler, rather than relying on each handler
  // (bot.start, bot.on('text'), ...) to individually remember to check. Only
  // a text reply to a pending support_fix handoff does anything; any other
  // text from that chat (commands like /start, stray messages) is ignored
  // outright. Button taps (callback_query updates have no ctx.message) pass
  // through untouched.
  bot.use(async (ctx, next) => {
    if (isAdminGroupMessage(ctx) && ctx.message && ctx.message.text) {
      if (ctx.message.reply_to_message) {
        await handleAdminHandoffReply(ctx);
        return;
      }
      // /outage is the one legitimate non-reply command from the admin
      // group — let it through to bot.command('outage', ...) below.
      // Everything else non-reply from that chat is dropped here.
      if (/^\/outage(?:@\S+)?\b/i.test(ctx.message.text)) {
        return next();
      }
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    if (startCooldown.isOnCooldown(ctx.from.id)) {
      return;
    }
    startCooldown.record(ctx.from.id);

    conversations.delete(ctx.from.id);
    await showCategoryMenu(ctx);
  });

  // Admin-only — gated both by the bot.use() middleware above (which drops
  // every non-reply admin-group message except this one) and by an
  // explicit isAdminGroupMessage check here, same defense-in-depth pattern
  // as the other admin-only actions.
  bot.command('outage', async (ctx) => {
    if (!isAdminGroupMessage(ctx)) return;

    const match = ctx.message.text.match(/^\/outage(?:@\S+)?\s+(on|off)(?:\s+"([^"]*)")?\s*$/i);
    if (!match) {
      await reply(ctx, 'Usage: /outage on "&lt;description&gt;" or /outage off');
      return;
    }

    const mode = match[1].toLowerCase();
    if (mode === 'off') {
      setOutageFlag(false, null);
      await reply(ctx, '✅ Outage flag turned OFF. Server down / Buffering back to normal.');
      return;
    }

    const description = (match[2] || '').trim();
    if (!description) {
      await reply(ctx, 'Please include a description: /outage on "&lt;description&gt;"');
      return;
    }
    setOutageFlag(true, description);
    await reply(
      ctx,
      `⚠️ Outage flag turned ON: "${escapeHtml(description)}". Server down / Buffering will auto-reply instead of opening tickets.`
    );
  });

  bot.on('text', async (ctx) => {
    const state = conversations.get(ctx.from.id);
    if (!state) {
      await showCategoryMenu(ctx);
      return;
    }

    if (state.awaitingResolution) {
      await reply(ctx, state.followUpText, resolutionKeyboard);
      return;
    }
    if (state.awaitingDescription) {
      await handleDescriptionAndEscalate(ctx, state);
      return;
    }
    if (state.ispAware) {
      await reply(ctx, 'Please tap one of the buttons above.', ispPatternKeyboard);
      return;
    }
    if (state.awaitingDeviceChoice) {
      await reply(ctx, 'Please tap one of the buttons above.', deviceChoiceKeyboard(state.devices));
      return;
    }
    if (state.awaitingDeviceText) {
      await handleDeviceText(ctx, state);
      return;
    }

    await handleAnswer(ctx, state);
  });

  Object.keys(CATEGORIES).forEach((key) => {
    bot.action(`sup_cat_${key}`, async (ctx) => {
      await ctx.answerCbQuery();
      await startCategory(ctx, key);
    });
  });

  bot.action(/^sup_device_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await handleDeviceChoice(ctx, Number(ctx.match[1]));
  });

  bot.action(/^supportfix_ok_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const handoff = getAdminHandoffByMessageId(Number(ctx.match[1]));
    // Verify the tapping customer actually owns this ticket — these
    // buttons are only ever sent to the customer's own chat, but don't
    // rely solely on that; check ownership explicitly rather than trusting
    // the callback_data's embedded id at face value.
    if (!handoff || handoff.telegram_user_id !== ctx.from.id) {
      await reply(ctx, "Thanks! If anything else comes up, just message us again.");
      return;
    }
    await reply(ctx, "Great — glad that fixed it! Thanks for confirming.");
    await postToSupportTopic(ctx.telegram, `✅ ${username(ctx)} confirmed the fix worked. Ticket closed.`);
  });

  bot.action(/^supportfix_bad_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const handoff = getAdminHandoffByMessageId(Number(ctx.match[1]));
    if (!handoff || handoff.telegram_user_id !== ctx.from.id) {
      await reply(ctx, "Sorry, I've lost track of this one — please message us again so we can help.");
      return;
    }
    await handleFixStillBroken(ctx, handoff);
  });

  bot.action('sup_isp_pattern_consistent', async (ctx) => {
    await ctx.answerCbQuery();
    await handleIspPattern(ctx, 'Consistently');
  });

  bot.action('sup_isp_pattern_intermittent', async (ctx) => {
    await ctx.answerCbQuery();
    await handleIspPattern(ctx, 'On and off');
  });

  bot.action('sup_resolved_yes', async (ctx) => {
    await ctx.answerCbQuery();
    conversations.delete(ctx.from.id);

    // Closing the loop: if they were sent here because their trial wasn't
    // working, resolving it here shouldn't leave them stranded — hand them
    // back to onboarding via a deep link instead of a dead end.
    const onboardingSession = getSession(ctx.from.id);
    if (onboardingSession && onboardingSession.status === 'handed_to_support') {
      updateSession(ctx.from.id, { status: 'trial_issue_resolved', step: 'trial_issue_resolved' });
      await reply(
        ctx,
        "Glad that's fixed! Since that was blocking your trial, let's pick up right where you left off.",
        Markup.inlineKeyboard([Markup.button.url('Continue setup', 'https://t.me/LumenOnboardingBot?start=resume')])
      );
      return;
    }

    await reply(ctx, "Glad that's fixed! Message us again anytime if something else comes up.");
  });

  bot.action('sup_resolved_no', async (ctx) => {
    await ctx.answerCbQuery();
    const state = conversations.get(ctx.from.id);
    if (!state) {
      await reply(ctx, 'Let’s start over. What can we help you with?', categoryKeyboard);
      return;
    }
    state.awaitingResolution = false;
    state.awaitingDescription = true;
    await reply(ctx, "Can you describe what's happening? The more detail, the faster we can help.");
  });
}

module.exports = register;
