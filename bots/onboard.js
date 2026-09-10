const { Markup } = require('telegraf');
const {
  ensureSession,
  getSession,
  updateSession,
  findStaleAwaitingDevicePurchase,
  createAdminHandoff,
  getAdminHandoffByMessageId,
  markAdminHandoffFulfilled,
} = require('../db');
const { lookupDevice } = require('../lib/deviceLookup');
const { lookupIsp } = require('../lib/ispLookup');
const { postToRequestTopic, postToPaymentTopic, isAdminGroupMessage } = require('../lib/adminGroup');
const { parseCredentials } = require('../lib/parseCredentials');
const { getSetupInstructions, getSetupLabel, PLAYLIST_NAME } = require('../lib/setupInstructions');
const { escapeHtml, escapeHtmlAttr, reply, sendHtml } = require('../lib/html');

const NUDGE_THRESHOLD_HOURS = 60; // ~2.5 days
const ABANDON_THRESHOLD_HOURS = 24 * 14; // 2 weeks
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

const RECOMMENDED_STICK = {
  key: 'fire_tv_stick_4k',
  displayName: 'Fire TV Stick 4K Max (recommended)',
  name: 'Fire TV Stick 4K Max', // for mid-sentence use
};

const continueButtonKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("I've got my device — continue", 'device_purchased_continue'),
]);

const PRICING = { 1: 110, 2: 180, 3: 220 }; // USD/yr, 12-month plan

const planKeyboard = Markup.inlineKeyboard(
  [
    Markup.button.callback(`1 device — $${PRICING[1]}/yr`, 'plan_1'),
    Markup.button.callback(`2 devices — $${PRICING[2]}/yr`, 'plan_2'),
    Markup.button.callback(`3 devices — $${PRICING[3]}/yr`, 'plan_3'),
  ],
  { columns: 1 }
);

const paidKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("I've paid — let us know", 'payment_confirmed'),
]);

const trialFeedbackKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('Yes, working', 'trial_working_yes'),
  Markup.button.callback('No, having issues', 'trial_working_no'),
]);

function username(ctx) {
  if (ctx.from.username) return `@${ctx.from.username}`;
  return `${escapeHtml(ctx.from.first_name || 'customer')} (id ${ctx.from.id})`;
}

function planLabel(tier) {
  return `${tier} device${tier === 1 ? '' : 's'}`;
}

function priceForTier(tier) {
  return PRICING[tier];
}

function serverUrlLine() {
  const url = process.env.XTREAM_SERVER_URL;
  return url ? `Server: <code>${escapeHtml(url)}</code>` : 'Server: (reach out to our team if you need the server URL again)';
}

function playlistNameLine() {
  return `Playlist Name: <code>${escapeHtml(PLAYLIST_NAME)}</code>`;
}

function groupInviteBlock() {
  const link = process.env.LUMEN_GROUP_INVITE_LINK;
  if (!link) return [];
  return [
    '',
    `You're all set. Join the <b>LUMEN</b> group here: <a href="${escapeHtmlAttr(link)}">Join LUMEN group</a>`,
    'Approval is manual, so it may take a bit.',
  ];
}

// ---- Device collection data model ------------------------------------------
//
// Every order — 1, 2, or 3 devices — is collected into devices_json as an
// array, one entry per device, filled in order via pending_device_index.
// This is the single source of truth; there's no special-cased "device 1"
// anymore now that plan/tier is picked before any device specifics.

function getDevicesArray(session) {
  if (!session || !session.devices_json) return null;
  try {
    return JSON.parse(session.devices_json);
  } catch {
    return null;
  }
}

function saveDevicesArray(telegramUserId, devices) {
  updateSession(telegramUserId, { devices_json: JSON.stringify(devices) });
}

function setDeviceSlot(telegramUserId, session, index, deviceObj) {
  const devices = getDevicesArray(session) || [];
  devices[index - 1] = deviceObj;
  saveDevicesArray(telegramUserId, devices);
}

function deviceObjectFromMatch(match, rawText) {
  return {
    input: rawText,
    key: match.id,
    display_name: match.display_name,
    compatible: 1,
    four_k: match['4k_supported'] ? 1 : 0,
    platform: match.platform,
    app_to_install: match.app_to_install,
    setup_steps_ref: match.setup_steps_ref,
    unmatched: 0,
    recommend_firestick: 0,
  };
}

function recommendStickDeviceObject() {
  return {
    input: null,
    key: RECOMMENDED_STICK.key,
    display_name: RECOMMENDED_STICK.displayName,
    compatible: 1,
    four_k: 1,
    platform: 'Fire OS',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'firestick_sideload',
    unmatched: 0,
    recommend_firestick: 1,
  };
}

function unmatchedDeviceObject(rawText) {
  return {
    input: rawText,
    key: null,
    display_name: null,
    compatible: null,
    four_k: null,
    platform: null,
    app_to_install: null,
    setup_steps_ref: null,
    unmatched: 1,
    recommend_firestick: 0,
  };
}

// "Device 1: X" / "Device 1: X; Device 2: Y" — used in admin notifications.
function deviceListLabel(session) {
  const devices = getDevicesArray(session);
  if (!devices || devices.length === 0) return 'unknown';
  return devices
    .map((d, i) => {
      const fourKNote = d.four_k === 0 ? ' (HD/FHD only, not 4K)' : '';
      return `Device ${i + 1}: ${d.display_name || 'unknown'}${fourKNote}`;
    })
    .join('; ');
}

// One "Setup — X" section per unique platform among all the session's
// devices (deduped, so two Firesticks only get one section).
function buildMultiDeviceSetupBlock(session) {
  const devices = getDevicesArray(session) || [];
  const seenRefs = new Set();
  const blocks = [];
  for (const d of devices) {
    if (!d.setup_steps_ref || seenRefs.has(d.setup_steps_ref)) continue;
    seenRefs.add(d.setup_steps_ref);
    const instructions = getSetupInstructions(d.setup_steps_ref);
    if (!instructions) continue;
    blocks.push('', `<b>Setup — ${getSetupLabel(d.setup_steps_ref)}:</b>`, instructions);
  }
  return blocks;
}

// ---- Step 1: welcome + device count / pricing ------------------------------

async function sendWelcome(ctx) {
  await reply(ctx, "Welcome to <b>LUMEN</b>! Let's get you set up.");
  await reply(
    ctx,
    'How many devices do you want to set up? We support <b>Firestick</b>/<b>Android TV</b> sticks, <b>PC/Laptop</b>, and <b>Android/iPhone</b>.',
    planKeyboard
  );
}

// ---- Step 2: ISP (asked right after plan/tier is picked) ------------------

async function handleIspText(ctx, session, rawText) {
  const matchedIsp = lookupIsp(rawText);
  updateSession(session.telegram_user_id, {
    isp_input: rawText,
    isp_flagged: matchedIsp ? 1 : 0,
  });
  if (matchedIsp) {
    await reply(ctx, matchedIsp.note);
  } else {
    await reply(ctx, 'Got it — thanks.');
  }
  updateSession(session.telegram_user_id, { pending_device_index: 1 });
  await askDeviceForSlot(ctx, getSession(session.telegram_user_id));
}

// ---- Step 3: device-by-device compatibility check --------------------------

async function askDeviceForSlot(ctx, session) {
  updateSession(session.telegram_user_id, { step: 'await_device_text' });
  await reply(
    ctx,
    `What's the make and model for <b>device ${session.pending_device_index}</b>?\n\nFor example: <b>Fire TV Stick 4K</b>, <b>iPhone 14</b>, or <b>NVIDIA Shield</b>.\n\nIf you're not sure, check Settings on your device for the model number and we'll run a compatibility check.`
  );
}

async function handleDeviceSlotText(ctx, session, rawText) {
  const match = lookupDevice(rawText);
  const idx = session.pending_device_index;

  if (!match) {
    setDeviceSlot(session.telegram_user_id, session, idx, unmatchedDeviceObject(rawText));
    await reply(
      ctx,
      `We don't have "${escapeHtml(rawText)}" in our device list yet for <b>device ${idx}</b>.\n\nWe've flagged it for the team to check — we'll confirm compatibility before moving ahead.`
    );
    const sent = await postToRequestTopic(
      ctx.telegram,
      [
        `⚠️ <b>Unknown device</b> (Device ${idx}) reported by ${username(ctx)} (id ${ctx.from.id})`,
        `"${escapeHtml(rawText)}"`,
        '',
        'Please check compatibility and add it to data/devices.json.',
        '',
        `Reply to <b>this message</b> with exactly <code>compatible</code> or <code>incompatible</code> to unblock their onboarding.`,
      ].join('\n')
    );
    if (sent) {
      createAdminHandoff({
        adminMessageId: sent.message_id,
        kind: 'device_review',
        telegramUserId: session.telegram_user_id,
        rawDeviceInput: rawText,
        deviceSlotIndex: idx,
      });
    } else {
      console.warn(
        `[onboard] Admin group not configured — could not create a device-review handoff for user ${session.telegram_user_id} (Device ${idx}). Set ADMIN_GROUP_CHAT_ID in .env.`
      );
    }
    updateSession(session.telegram_user_id, { status: 'awaiting_device_review', step: 'awaiting_device_review' });
    return;
  }

  if (!match.compatible) {
    setDeviceSlot(session.telegram_user_id, session, idx, recommendStickDeviceObject());
    await reply(
      ctx,
      `<b>${match.display_name}</b> can't sideload apps directly, so our player app won't run on it.\n\nWe recommend the <b>${RECOMMENDED_STICK.name}</b> instead for <b>device ${idx}</b>.`
    );
  } else {
    setDeviceSlot(session.telegram_user_id, session, idx, deviceObjectFromMatch(match, rawText));
    if (match['4k_supported']) {
      await reply(ctx, `Got it — <b>device ${idx}: ${match.display_name}</b>. That's fully compatible, including 4K.`);
    } else {
      await reply(
        ctx,
        `Got it — <b>device ${idx}: ${match.display_name}</b>. That's compatible, though it supports HD/FHD only (not 4K).`
      );
    }
    if (match.note) {
      await reply(ctx, match.note);
    }
  }

  await advanceToNextDeviceOrFinalize(ctx, getSession(session.telegram_user_id));
}

async function advanceToNextDeviceOrFinalize(ctx, session) {
  const nextIndex = session.pending_device_index + 1;
  if (nextIndex <= session.plan_tier) {
    updateSession(session.telegram_user_id, { pending_device_index: nextIndex });
    await askDeviceForSlot(ctx, getSession(session.telegram_user_id));
  } else {
    await finalizeDevicesAndProceed(ctx, session);
  }
}

async function finalizeDevicesAndProceed(ctx, session) {
  const devices = getDevicesArray(session) || [];
  const anyRecommendFirestick = devices.some((d) => d.recommend_firestick);
  if (anyRecommendFirestick) {
    await pauseForDevicePurchase(ctx, session);
  } else {
    await requestTrialCredentials(ctx, session);
  }
}

// ---- Purchase-wait pause (only when a Firestick was recommended) ----------

async function pauseForDevicePurchase(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'awaiting_device_purchase',
    step: 'awaiting_device_purchase',
    awaiting_device_since: new Date().toISOString(),
    device_nudge_sent_at: null,
  });
  await reply(
    ctx,
    `Once you've got your <b>${RECOMMENDED_STICK.name}</b>, tap the button below.\n\nWe'll set you up with a 24-hour trial — no need to start over.`,
    continueButtonKeyboard
  );
}

// ---- Trial request / trial credentials / "is it working?" ------------------

async function requestTrialCredentials(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'awaiting_trial_credentials',
    step: 'awaiting_trial_credentials',
  });

  const ispNote = session.isp_flagged ? ' ⚠️ <b>flagged ISP</b>' : '';

  const adminText = [
    `🆓 <b>24-Hour Trial</b> requested by ${username(ctx)}`,
    '',
    `<b>Plan:</b> ${planLabel(session.plan_tier)}`,
    `<b>Devices:</b> ${deviceListLabel(session)}`,
    `<b>ISP:</b> ${escapeHtml(session.isp_input) || 'not provided'}${ispNote}`,
    '',
    `Reply to <b>this message</b> with the trial Xtream credentials, e.g.:`,
    '<code>username: john123</code>',
    '<code>password: xk29fa</code>',
  ].join('\n');

  const sent = await postToRequestTopic(ctx.telegram, adminText);
  updateSession(session.telegram_user_id, { admin_message_id: sent ? sent.message_id : null });

  if (sent) {
    createAdminHandoff({
      adminMessageId: sent.message_id,
      kind: 'trial_credential',
      telegramUserId: session.telegram_user_id,
      planTier: session.plan_tier,
    });
  } else {
    console.warn(
      `[onboard] Admin group not configured — could not create a trial-credential handoff for user ${session.telegram_user_id}. Set ADMIN_GROUP_CHAT_ID in .env.`
    );
  }

  await reply(ctx, "Thanks — we're setting up a 24-hour trial account for you now.\n\nYou'll hear from us here shortly.");
}

async function handleTrialCredentialReply(ctx, handoff) {
  const creds = parseCredentials(ctx.message.text);
  if (!creds) {
    await reply(
      ctx,
      "I couldn't parse credentials from that reply.\n\nExpected format:\n<code>username: value</code>\n<code>password: value</code>"
    );
    return;
  }

  const session = getSession(handoff.telegram_user_id);
  const lines = [
    '🆓 <b>24-Hour Trial</b> — your login is ready.',
    '',
    playlistNameLine(),
    serverUrlLine(),
    `Username: <code>${escapeHtml(creds.username)}</code>`,
    `Password: <code>${escapeHtml(creds.password)}</code>`,
    '',
    'This trial is active for the next 24 hours.',
    ...buildMultiDeviceSetupBlock(session),
  ];

  await sendHtml(ctx.telegram, handoff.telegram_user_id, lines.join('\n'));
  markAdminHandoffFulfilled(handoff.admin_message_id);
  updateSession(handoff.telegram_user_id, { status: 'awaiting_trial_feedback', step: 'awaiting_trial_feedback' });
  await sendHtml(ctx.telegram, handoff.telegram_user_id, 'Is everything working okay?', trialFeedbackKeyboard);

  await reply(ctx, '✅ Trial credentials sent to the customer.');
}

async function handleTrialWorking(ctx, session) {
  await requestPaymentLink(ctx, session);
}

async function handleTrialNotWorking(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'handed_to_support',
    step: 'handed_to_support',
  });
  await reply(
    ctx,
    "Sorry to hear that.\n\nPlease message <b>@LumenTVSupportBot</b> and they'll help you troubleshoot. We've already flagged this to the team so they have context."
  );
  await postToRequestTopic(
    ctx.telegram,
    [
      `⚠️ <b>Trial issue</b> reported by ${username(ctx)}`,
      '',
      `<b>Device(s):</b> ${deviceListLabel(session)}`,
      `<b>ISP:</b> ${escapeHtml(session.isp_input) || 'not provided'}`,
      '',
      'Customer was directed to the support bot — flagged here for context if they reach out.',
    ].join('\n')
  );
}

// ---- Payment link request/reply (per-order, manual) / paid credential handoff

async function requestPaymentLink(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'awaiting_payment_link',
    step: 'awaiting_payment_link',
  });

  const priceLabel = `${planLabel(session.plan_tier)} — $${priceForTier(session.plan_tier)}/yr`;
  const adminText = [
    `💰 <b>Payment Link</b> requested by ${username(ctx)}`,
    '',
    `<b>Plan:</b> ${priceLabel}`,
    '',
    `Reply to <b>this message</b> with the PayLio payment link for this order.`,
  ].join('\n');

  const sent = await postToPaymentTopic(ctx.telegram, adminText);
  updateSession(session.telegram_user_id, { admin_message_id: sent ? sent.message_id : null });

  if (sent) {
    createAdminHandoff({
      adminMessageId: sent.message_id,
      kind: 'payment_link',
      telegramUserId: session.telegram_user_id,
      planTier: session.plan_tier,
    });
  } else {
    console.warn(
      `[onboard] Admin group not configured — could not create a payment-link handoff for user ${session.telegram_user_id}. Set ADMIN_GROUP_CHAT_ID in .env.`
    );
  }

  await reply(ctx, "Great — glad it's working! We're getting your payment link ready.\n\nYou'll hear from us here shortly.");
}

async function handlePaymentLinkReply(ctx, handoff) {
  const link = ctx.message.text.trim();
  if (!/^https?:\/\//i.test(link)) {
    await reply(ctx, "Couldn't find a valid link in that reply.\n\nExpected a URL starting with <code>http://</code> or <code>https://</code>.");
    return;
  }

  const priceLabel = `${planLabel(handoff.plan_tier)} — $${priceForTier(handoff.plan_tier)}/yr`;
  await sendHtml(
    ctx.telegram,
    handoff.telegram_user_id,
    `Great news — here's your payment link for the <b>12-month plan</b>: <b>${priceLabel}</b>.\n\n<a href="${escapeHtmlAttr(link)}">Pay now</a>\n\nOnce you've completed payment, tap the button below.`,
    paidKeyboard
  );
  markAdminHandoffFulfilled(handoff.admin_message_id);
  updateSession(handoff.telegram_user_id, { status: 'awaiting_payment', step: 'awaiting_payment' });

  await reply(ctx, '✅ Payment link sent to the customer.');
}

async function handlePaymentConfirmed(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'awaiting_credentials',
    step: 'awaiting_credentials',
  });

  const ispNote = session.isp_flagged ? ' ⚠️ <b>flagged ISP</b>' : '';

  const adminText = [
    `💳 <b>12-Month Payment</b> confirmed by ${username(ctx)}`,
    '',
    `<b>Plan:</b> ${planLabel(session.plan_tier)}`,
    `<b>Devices:</b> ${deviceListLabel(session)}`,
    `<b>ISP:</b> ${escapeHtml(session.isp_input) || 'not provided'}${ispNote}`,
    '',
    `Reply to <b>this message</b> with the new 12-month Xtream credentials, e.g.:`,
    '<code>username: john123</code>',
    '<code>password: xk29fa</code>',
  ].join('\n');

  const sent = await postToRequestTopic(ctx.telegram, adminText);

  updateSession(session.telegram_user_id, {
    admin_message_id: sent ? sent.message_id : null,
  });

  if (sent) {
    createAdminHandoff({
      adminMessageId: sent.message_id,
      kind: 'credential',
      telegramUserId: session.telegram_user_id,
      planTier: session.plan_tier,
    });
  } else {
    console.warn(
      `[onboard] Admin group not configured — could not create a handoff record for user ${session.telegram_user_id}. Set ADMIN_GROUP_CHAT_ID in .env.`
    );
  }

  await reply(ctx, "Thanks — your payment is being confirmed.\n\nYou'll receive your new login details here shortly.");
}

async function handleCredentialHandoffReply(ctx, handoff) {
  const creds = parseCredentials(ctx.message.text);
  if (!creds) {
    await reply(
      ctx,
      "I couldn't parse credentials from that reply.\n\nExpected format:\n<code>username: value</code>\n<code>password: value</code>"
    );
    return;
  }

  const session = getSession(handoff.telegram_user_id);
  const lines = [
    "💳 <b>12-Month Plan</b> — your login is ready.",
    '',
    playlistNameLine(),
    serverUrlLine(),
    `Username: <code>${escapeHtml(creds.username)}</code>`,
    `Password: <code>${escapeHtml(creds.password)}</code>`,
    ...buildMultiDeviceSetupBlock(session),
    ...groupInviteBlock(),
  ];

  await sendHtml(ctx.telegram, handoff.telegram_user_id, lines.join('\n'));
  markAdminHandoffFulfilled(handoff.admin_message_id);
  updateSession(handoff.telegram_user_id, { status: 'completed', step: 'completed' });

  await reply(ctx, '✅ Credentials sent to the customer.');
}

// ---- Admin-group reply routing ---------------------------------------------

// Minimal ctx-like wrapper so we can reuse the customer-facing flow
// functions (which call ctx.reply / ctx.from) from inside the admin-group
// handler, where the real ctx points at the admin chat, not the customer's.
function customerCtx(telegram, telegramUserId, telegramUsername) {
  return {
    telegram,
    from: { id: telegramUserId, username: telegramUsername },
    reply: (text, extra) => sendHtml(telegram, telegramUserId, text, extra),
  };
}

async function handleAdminHandoffReply(ctx) {
  const repliedTo = ctx.message.reply_to_message;
  const handoff = getAdminHandoffByMessageId(repliedTo.message_id);
  if (!handoff || handoff.status !== 'pending') {
    // Could be a stray reply to an unrelated admin-group message, or a
    // second reply to an already-fulfilled handoff — both fine to ignore.
    // Logged (not silent) so a genuinely lost/missing handoff is visible
    // instead of looking identical to "not our message."
    console.warn(
      `[onboard] Admin reply to message_id=${repliedTo.message_id} matched ${
        handoff ? `an already-${handoff.status} handoff` : 'no admin_handoffs row'
      } — ignoring.`
    );
    return;
  }

  if (handoff.kind === 'device_review') {
    await handleDeviceReviewReply(ctx, handoff);
  } else if (handoff.kind === 'trial_credential') {
    await handleTrialCredentialReply(ctx, handoff);
  } else if (handoff.kind === 'payment_link') {
    await handlePaymentLinkReply(ctx, handoff);
  } else {
    await handleCredentialHandoffReply(ctx, handoff);
  }
}

async function handleDeviceReviewReply(ctx, handoff) {
  const decision = ctx.message.text.trim().toLowerCase();
  const session = getSession(handoff.telegram_user_id);
  if (!session) {
    await reply(ctx, 'No onboarding session found for that customer.');
    return;
  }

  if (decision !== 'compatible' && decision !== 'incompatible') {
    await reply(
      ctx,
      'Reply with exactly <code>compatible</code> or <code>incompatible</code> to resolve this device review.'
    );
    return;
  }

  const fakeCtx = customerCtx(ctx.telegram, handoff.telegram_user_id, session.telegram_username);
  const slotIndex = handoff.device_slot_index;

  if (decision === 'compatible') {
    const devices = getDevicesArray(session) || [];
    const existing = devices[slotIndex - 1] || {};
    devices[slotIndex - 1] = { ...existing, unmatched: 0 };
    saveDevicesArray(handoff.telegram_user_id, devices);
    await fakeCtx.reply(
      `Good news — we've confirmed "${escapeHtml(handoff.raw_device_input)}" is compatible for <b>device ${slotIndex}</b>. Let's continue.`
    );
  } else {
    setDeviceSlot(handoff.telegram_user_id, session, slotIndex, recommendStickDeviceObject());
    await fakeCtx.reply(
      `After review, "${escapeHtml(handoff.raw_device_input)}" isn't compatible for <b>device ${slotIndex}</b>.\n\nWe recommend the <b>${RECOMMENDED_STICK.name}</b> instead.`
    );
  }

  markAdminHandoffFulfilled(handoff.admin_message_id);
  await advanceToNextDeviceOrFinalize(fakeCtx, getSession(handoff.telegram_user_id));
  await reply(ctx, `✅ Marked ${decision} — Device ${slotIndex} resolved, customer flow resumed.`);
}

// ---- Resume / abandoned handling -------------------------------------------

async function resumeFromAbandoned(ctx, session) {
  updateSession(session.telegram_user_id, { status: 'active' });
  await reply(ctx, 'Welcome back — picking up right where we left off.');
  await requestTrialCredentials(ctx, getSession(session.telegram_user_id));
}

// ---- Wiring -----------------------------------------------------------------

function register(bot) {
  bot.start(async (ctx) => {
    ensureSession(ctx.from.id, ctx.from.username);
    updateSession(ctx.from.id, { step: 'await_plan' });
    await sendWelcome(ctx);
  });

  bot.on('text', async (ctx) => {
    if (isAdminGroupMessage(ctx)) {
      if (ctx.message.reply_to_message) {
        await handleAdminHandoffReply(ctx);
      }
      return;
    }

    const session = ensureSession(ctx.from.id, ctx.from.username);
    const text = ctx.message.text.trim();

    if (session.status === 'abandoned') {
      await resumeFromAbandoned(ctx, session);
      return;
    }

    switch (session.step) {
      case 'new':
        updateSession(ctx.from.id, { step: 'await_plan' });
        await sendWelcome(ctx);
        break;

      case 'await_plan':
        await reply(ctx, 'Please choose a number of devices using the buttons above.', planKeyboard);
        break;

      case 'await_isp':
        await handleIspText(ctx, session, text);
        break;

      case 'await_device_text':
        await handleDeviceSlotText(ctx, session, text);
        break;

      case 'awaiting_device_review':
        await reply(
          ctx,
          "We're still checking your device with the team.\n\nWe'll follow up here as soon as it's confirmed."
        );
        break;

      case 'awaiting_device_purchase':
        await reply(ctx, "Once you've got your device, tap the button above to continue.", continueButtonKeyboard);
        break;

      case 'awaiting_trial_credentials':
        await reply(ctx, "We're setting up your trial account.\n\nHang tight — this won't take long.");
        break;

      case 'awaiting_trial_feedback':
        await reply(ctx, 'Just checking — is everything working okay with your trial?', trialFeedbackKeyboard);
        break;

      case 'handed_to_support':
        await reply(ctx, "For help with this, please message <b>@LumenTVSupportBot</b> — they'll pick up from here.");
        break;

      case 'awaiting_payment_link':
        await reply(ctx, "We're getting your payment link ready.\n\nHang tight — this won't take long.");
        break;

      case 'awaiting_payment':
        await reply(ctx, "Once you've completed payment, tap the button above to let us know.", paidKeyboard);
        break;

      case 'awaiting_credentials':
        await reply(ctx, "Your account is being set up.\n\nHang tight — this won't take long.");
        break;

      case 'completed':
        await reply(ctx, "You're all set! For any issues, message <b>@LumenTVSupportBot</b>.");
        break;

      default:
        updateSession(ctx.from.id, { step: 'await_plan' });
        await sendWelcome(ctx);
    }
  });

  bot.action(/^plan_([123])$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_plan') {
      await reply(ctx, 'Please choose a number of devices using the buttons above.', planKeyboard);
      return;
    }
    const tier = Number(ctx.match[1]);
    updateSession(ctx.from.id, {
      plan_tier: tier,
      devices_json: JSON.stringify([]),
      step: 'await_isp',
    });
    await reply(ctx, 'Which internet provider (ISP) are you on?');
  });

  bot.action('device_purchased_continue', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || (session.status !== 'awaiting_device_purchase' && session.status !== 'abandoned')) {
      await reply(ctx, "You're already past this step.");
      return;
    }
    await requestTrialCredentials(ctx, session);
  });

  bot.action('trial_working_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'awaiting_trial_feedback') {
      await reply(ctx, "This step is already complete, or hasn't been reached yet.");
      return;
    }
    await handleTrialWorking(ctx, session);
  });

  bot.action('trial_working_no', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'awaiting_trial_feedback') {
      await reply(ctx, "This step is already complete, or hasn't been reached yet.");
      return;
    }
    await handleTrialNotWorking(ctx, session);
  });

  bot.action('payment_confirmed', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'awaiting_payment') {
      await reply(ctx, "This step is already complete, or hasn't been reached yet.");
      return;
    }
    await handlePaymentConfirmed(ctx, session);
  });

  runNudgeAndAbandonSweep(bot);
  setInterval(() => runNudgeAndAbandonSweep(bot), SWEEP_INTERVAL_MS);
}

// ---- Re-engagement nudge + abandonment sweep -------------------------------

async function runNudgeAndAbandonSweep(bot) {
  const { nudgeCandidates, abandonCandidates } = findStaleAwaitingDevicePurchase({
    nudgeThresholdHours: NUDGE_THRESHOLD_HOURS,
    abandonThresholdHours: ABANDON_THRESHOLD_HOURS,
  });

  for (const session of nudgeCandidates) {
    try {
      await sendHtml(
        bot.telegram,
        session.telegram_user_id,
        `Just checking in — once you've got your <b>${RECOMMENDED_STICK.name}</b>, tap below and we'll set up your trial.`,
        continueButtonKeyboard
      );
      updateSession(session.telegram_user_id, { device_nudge_sent_at: new Date().toISOString() });
    } catch (err) {
      console.warn(`[onboard] Failed to send nudge to ${session.telegram_user_id}:`, err.message);
    }
  }

  for (const session of abandonCandidates) {
    updateSession(session.telegram_user_id, { status: 'abandoned' });
    await postToRequestTopic(
      bot.telegram,
      `ℹ️ Onboarding session for ${session.telegram_username ? '@' + session.telegram_username : 'id ' + session.telegram_user_id} marked <b>abandoned</b> after 2 weeks of no response — still resumable if they message again.`
    );
  }
}

module.exports = register;
