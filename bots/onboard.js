const { Markup } = require('telegraf');
const {
  ensureSession,
  resetSession,
  getSession,
  updateSession,
  findStaleAwaitingDevicePurchase,
  createAdminHandoff,
  getAdminHandoffByMessageId,
  markAdminHandoffFulfilled,
} = require('../db');
const { lookupIsp } = require('../lib/ispLookup');
const { postToRequestTopic, postToPaymentTopic, isAdminGroupMessage } = require('../lib/adminGroup');
const { parseCredentials } = require('../lib/parseCredentials');
const { getSetupInstructions, getSetupLabel, PLAYLIST_NAME } = require('../lib/setupInstructions');
const { escapeHtml, escapeHtmlAttr, reply, sendHtml } = require('../lib/html');

const NUDGE_THRESHOLD_HOURS = 60; // ~2.5 days
const ABANDON_THRESHOLD_HOURS = 24 * 14; // 2 weeks
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

// The category picker is the single device-selection flow for everyone —
// no more free-text model question or compatibility-check pipeline behind
// it. Firestick/Android TV stick relies on a self-check note instead of
// verification (see sendCategoryConfirmation); the other categories
// always work regardless of specific model, so they resolve immediately.
// No PS4/PS5 — there's no proper Xtream Codes app on PlayStation's store.
const deviceCategoryKeyboard = Markup.inlineKeyboard(
  [
    Markup.button.callback('Firestick/Android TV stick', 'pick_stick'),
    Markup.button.callback('Phone', 'pick_phone'),
    Markup.button.callback('Desktop/Mac', 'pick_desktop'),
    Markup.button.callback('iPad/Tablet', 'pick_tablet'),
    Markup.button.callback('Xbox', 'pick_xbox'),
  ],
  { columns: 1 }
);

const hasStickNowKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('Yes', 'pick_stick_yes'),
  Markup.button.callback('No', 'pick_stick_no'),
]);

const phoneOsKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('Android', 'pick_phone_android'),
  Markup.button.callback('iPhone', 'pick_phone_iphone'),
]);

const tabletOsKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('iPad', 'pick_tablet_ipad'),
  Markup.button.callback('Android tablet', 'pick_tablet_android'),
]);

const continueButtonKeyboard = Markup.inlineKeyboard([
  Markup.button.callback("I've got my device — continue", 'device_purchased_continue'),
]);

const PRICING = { 1: 110, 2: 160, 3: 190 }; // USD/yr, 12-month plan

const planKeyboard = Markup.inlineKeyboard(
  [
    Markup.button.callback(`1 device — $${PRICING[1]}/yr`, 'plan_1'),
    Markup.button.callback(`2 devices — $${PRICING[2]}/yr`, 'plan_2'),
    Markup.button.callback(`3 devices — $${PRICING[3]}/yr`, 'plan_3'),
  ],
  { columns: 1 }
);

// Shown instead of planKeyboard when device 1 is Phone/Desktop-Mac/iPad-
// Tablet rather than a Firestick/Android stick — those orders cap at 2.
const planKeyboardRestricted = Markup.inlineKeyboard(
  [
    Markup.button.callback(`1 device — $${PRICING[1]}/yr`, 'plan_1'),
    Markup.button.callback(`2 devices — $${PRICING[2]}/yr`, 'plan_2'),
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

// Device 1 resolved as Phone/Desktop-Mac/iPad-Tablet has a device_key
// ending in "_direct" (the stick's key does not) — those orders are capped
// at 2 devices; stick orders still get all three tiers.
function isDirectResolvedDevice(session) {
  return typeof session.device_key === 'string' && session.device_key.endsWith('_direct');
}

function planKeyboardFor(session) {
  return isDirectResolvedDevice(session) ? planKeyboardRestricted : planKeyboard;
}

function serverUrlLine() {
  const url = process.env.XTREAM_SERVER_URL;
  return url ? `Server: <code>${escapeHtml(url)}</code>` : 'Server: (reach out to our team if you need the server URL again)';
}

function playlistNameLine() {
  return `Playlist Name: <code>${escapeHtml(PLAYLIST_NAME)}</code>`;
}

// ---- Device collection data model ------------------------------------------
//
// Device 1 is resolved before plan/tier is even known, so it lives in the
// legacy top-level session.device_* columns until tier is picked — at that
// point it's folded into devices_json as slot 1, and devices 2/3 (if any)
// are collected the same way via the same category picker.

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

function deviceOneFromSessionFields(session) {
  return {
    input: session.device_input,
    key: session.device_key,
    display_name: session.device_display_name,
    compatible: session.device_compatible,
    four_k: session.device_4k_supported,
    platform: session.device_platform,
    app_to_install: session.device_app_to_install,
    setup_steps_ref: session.device_setup_steps_ref,
    unmatched: session.device_unmatched,
    recommend_firestick: session.recommend_firestick,
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

// ---- Device category resolvers ---------------------------------------------
//
// No compatibility verification — a category is enough to know which app
// and walkthrough to use. Only the stick category needs a self-check note
// (sideloading support varies by exact model); the others always work.

function syntheticFirestick() {
  return {
    key: 'firestick_category',
    display_name: 'Firestick / Android TV Stick',
    four_k: 1,
    platform: 'Fire OS',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'firestick_sideload',
  };
}

function syntheticAndroidPhone() {
  return {
    key: 'android_phone_direct',
    display_name: 'Android Phone',
    four_k: 1,
    platform: 'Android',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'android_app_store_install',
  };
}

function syntheticIphone() {
  return {
    key: 'iphone_direct',
    display_name: 'iPhone',
    four_k: 1,
    platform: 'iOS',
    app_to_install: 'GSE Smart IPTV',
    setup_steps_ref: 'ios_app_store_install',
  };
}

function syntheticDesktopMac() {
  return {
    key: 'desktop_mac_direct',
    display_name: 'Desktop / Mac',
    four_k: 1,
    platform: 'Desktop',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'desktop_install',
  };
}

function syntheticIpad() {
  return {
    key: 'ipad_direct',
    display_name: 'iPad',
    four_k: 1,
    platform: 'iPadOS',
    app_to_install: 'GSE Smart IPTV',
    setup_steps_ref: 'ios_app_store_install',
  };
}

function syntheticAndroidTablet() {
  return {
    key: 'android_tablet_direct',
    display_name: 'Android Tablet',
    four_k: 1,
    platform: 'Android',
    app_to_install: 'IPTV Smarters Pro',
    setup_steps_ref: 'android_app_store_install',
  };
}

// Covers Xbox One and Series X/S the same way — no need to distinguish.
function syntheticXbox() {
  return {
    key: 'xbox_direct',
    display_name: 'Xbox',
    four_k: 1,
    platform: 'Xbox',
    app_to_install: 'MyIPTV Player',
    setup_steps_ref: 'xbox_install',
  };
}

// null while resolving device 1 (pre-count, legacy fields); the device
// index (2 or 3) once plan_tier is set and we're collecting extra devices.
function currentDeviceIndex(session) {
  return session.plan_tier ? session.pending_device_index : null;
}

async function askDeviceCategory(ctx, session) {
  const index = currentDeviceIndex(session);
  updateSession(session.telegram_user_id, { step: 'await_device_category' });
  const question = index ? `What will you be watching on for <b>device ${index}</b>?` : 'What will you be watching on?';
  const prompt = `${question} We recommend a TV stick — it's portable and easy to set up anywhere.`;
  await reply(ctx, prompt, deviceCategoryKeyboard);
}

async function askStickDecisionNow(ctx, session) {
  updateSession(session.telegram_user_id, { step: 'await_stick_decision_now' });
  await reply(ctx, 'Do you already have one?', hasStickNowKeyboard);
}

async function sendCategoryConfirmation(ctx, deviceObj, index) {
  const label = index ? `device ${index}: ${deviceObj.display_name}` : deviceObj.display_name;
  if (deviceObj.key === 'firestick_category') {
    await reply(
      ctx,
      `Got it — <b>${label}</b>.\n\nBefore setting up, find your device's model in Settings and search online to confirm it supports sideloading (installing apps outside the official app store) — most sticks and boxes do, but it's worth double-checking your specific model.`
    );
  } else {
    await reply(ctx, `Got it — <b>${label}</b>. That's fully compatible, including 4K.`);
  }
}

async function resolveDeviceCategory(ctx, session, deviceObj) {
  const index = currentDeviceIndex(session);

  if (!index) {
    updateSession(session.telegram_user_id, {
      device_input: null,
      device_key: deviceObj.key,
      device_display_name: deviceObj.display_name,
      device_compatible: 1,
      device_4k_supported: deviceObj.four_k,
      device_platform: deviceObj.platform,
      device_app_to_install: deviceObj.app_to_install,
      device_setup_steps_ref: deviceObj.setup_steps_ref,
      device_unmatched: 0,
      recommend_firestick: 0,
    });
    await sendCategoryConfirmation(ctx, deviceObj, null);
    await askDeviceCount(ctx, getSession(session.telegram_user_id));
  } else {
    setDeviceSlot(session.telegram_user_id, session, index, {
      input: null,
      key: deviceObj.key,
      display_name: deviceObj.display_name,
      compatible: 1,
      four_k: deviceObj.four_k,
      platform: deviceObj.platform,
      app_to_install: deviceObj.app_to_install,
      setup_steps_ref: deviceObj.setup_steps_ref,
      unmatched: 0,
      recommend_firestick: 0,
    });
    await sendCategoryConfirmation(ctx, deviceObj, index);
    await advanceToNextDeviceOrFinalize(ctx, getSession(session.telegram_user_id));
  }
}

// ---- "No stick yet" purchase-wait pause ------------------------------------

async function showStickPurchaseRecommendation(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'awaiting_device_purchase',
    step: 'awaiting_stick_decision',
    awaiting_device_since: new Date().toISOString(),
    device_nudge_sent_at: null,
  });
  await reply(
    ctx,
    "You should get a <b>Firestick</b> or <b>Onn streaming device</b> to run this — grab one, check it supports sideloading, then come back and hit continue.\n\nYou can also just use what you've already got — desktop, Mac, iPhone, iPad, etc.",
    continueButtonKeyboard
  );
}

// ---- Device count / pricing (asked once device 1 is resolved) -------------

async function askDeviceCount(ctx, session) {
  updateSession(session.telegram_user_id, { status: 'active', step: 'await_plan' });
  await reply(
    ctx,
    "You can add a secondary device too — laptop, iPhone, iPad, etc.\n\nHow many devices do you want to add?",
    planKeyboardFor(session)
  );
}

async function advanceToNextDeviceOrFinalize(ctx, session) {
  const nextIndex = session.pending_device_index + 1;
  if (nextIndex <= session.plan_tier) {
    updateSession(session.telegram_user_id, { pending_device_index: nextIndex });
    await askDeviceCategory(ctx, getSession(session.telegram_user_id));
  } else {
    await askIsp(ctx, session);
  }
}

// ---- ISP / VPN note (asked once every device is collected) ----------------

async function askIsp(ctx, session) {
  updateSession(session.telegram_user_id, { step: 'await_isp' });
  await reply(ctx, 'Which internet provider are you on?');
}

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
  await requestTrialCredentials(ctx, getSession(session.telegram_user_id));
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

// The trial credentials are the customer's ongoing login — nothing new is
// issued after payment. "I've paid" is self-reported by the customer (no
// admin gate before the group invite goes out); the admin group just gets
// a heads-up so Oran can manually reconcile against PayLio, with a button
// to flag it back to the customer if the payment didn't actually land.
function unpaidKeyboard(telegramUserId) {
  return Markup.inlineKeyboard([
    Markup.button.callback('⚠️ Not received — flag as unpaid', `mark_unpaid_${telegramUserId}`),
  ]);
}

async function sendGroupInviteMessage(ctx, telegramUserId) {
  const link = process.env.LUMEN_GROUP_INVITE_LINK;
  const lines = link
    ? [
        `You're all set — here's the <b>LUMEN</b> group, join us: <a href="${escapeHtmlAttr(link)}">Join LUMEN group</a>`,
        'Approval is manual, so it may take a bit.',
      ]
    : ["You're all set!"];
  await sendHtml(ctx.telegram, telegramUserId, lines.join('\n'));
}

async function handlePaymentConfirmed(ctx, session) {
  updateSession(session.telegram_user_id, {
    status: 'completed',
    step: 'completed',
  });

  const ispNote = session.isp_flagged ? ' ⚠️ <b>flagged ISP</b>' : '';

  const adminText = [
    `💳 <b>Payment reported</b> by ${username(ctx)}`,
    '',
    `<b>Plan:</b> ${planLabel(session.plan_tier)}`,
    `<b>Devices:</b> ${deviceListLabel(session)}`,
    `<b>ISP:</b> ${escapeHtml(session.isp_input) || 'not provided'}${ispNote}`,
    '',
    "Customer was sent the LUMEN group invite. Please confirm payment landed — if it didn't, flag it below.",
  ].join('\n');

  await postToPaymentTopic(ctx.telegram, adminText, unpaidKeyboard(session.telegram_user_id));

  await sendGroupInviteMessage(ctx, session.telegram_user_id);
}

// ---- Admin-group reply routing ---------------------------------------------

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

  if (handoff.kind === 'trial_credential') {
    await handleTrialCredentialReply(ctx, handoff);
  } else if (handoff.kind === 'payment_link') {
    await handlePaymentLinkReply(ctx, handoff);
  } else {
    console.warn(`[onboard] Admin reply to message_id=${repliedTo.message_id} has unrecognized handoff kind "${handoff.kind}" — ignoring.`);
  }
}

// ---- Resume / abandoned handling -------------------------------------------

async function resumeFromAbandoned(ctx, session) {
  updateSession(session.telegram_user_id, { status: 'active' });
  await reply(ctx, 'Welcome back — picking up right where we left off.');
  await askDeviceCategory(ctx, getSession(session.telegram_user_id));
}

// Fallback for the /start?start=resume deep link (sent from the support bot
// after a trial-blocking issue is resolved) when the session unexpectedly
// isn't in the resolved-trial-issue state — re-prompt wherever they
// actually are instead of restarting from scratch or erroring.
async function resumeAtCurrentStep(ctx, session) {
  switch (session.step) {
    case 'await_device_category':
      await askDeviceCategory(ctx, session);
      break;
    case 'await_stick_decision_now':
      await reply(ctx, 'Do you already have one?', hasStickNowKeyboard);
      break;
    case 'await_phone_os':
      await reply(ctx, 'Android or iPhone?', phoneOsKeyboard);
      break;
    case 'await_tablet_os':
      await reply(ctx, 'iOS (iPad) or Android tablet?', tabletOsKeyboard);
      break;
    case 'awaiting_stick_decision':
      await reply(ctx, "Once you've got your device, tap the button above to continue.", continueButtonKeyboard);
      break;
    case 'await_plan':
      await reply(ctx, 'Please choose a number of devices using the buttons above.', planKeyboardFor(session));
      break;
    case 'await_isp':
      await reply(ctx, 'Which internet provider are you on?');
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
    case 'completed':
      await reply(ctx, "You're all set! For any issues, message <b>@LumenTVSupportBot</b>.");
      break;
    default:
      await sendWelcome(ctx, session);
  }
}

// ---- Step 1: welcome + device category --------------------------------------

async function sendWelcome(ctx, session) {
  await reply(ctx, "Welcome to <b>LUMEN</b>! Let's get you set up.");
  await askDeviceCategory(ctx, session);
}

// ---- Wiring -----------------------------------------------------------------

function register(bot) {
  // The admin group must never run the customer-facing flow — gate it once,
  // here, ahead of every other handler, rather than relying on each handler
  // (bot.start, bot.on('text'), ...) to individually remember to check. Only
  // a text reply to a pending handoff does anything; any other text from
  // that chat (commands like /start, stray messages) is ignored outright.
  // Button taps (callback_query updates have no ctx.message) pass through
  // untouched — admin-facing buttons like the payment "unpaid" flag still
  // need to work from inside the admin group.
  bot.use(async (ctx, next) => {
    if (isAdminGroupMessage(ctx) && ctx.message && ctx.message.text) {
      if (ctx.message.reply_to_message) {
        await handleAdminHandoffReply(ctx);
      }
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    const payload = (ctx.message.text.split(' ')[1] || '').trim();

    if (payload === 'resume') {
      const session = ensureSession(ctx.from.id, ctx.from.username);
      if (session.status === 'trial_issue_resolved') {
        await reply(ctx, "Welcome back! Let's get your payment sorted.");
        await requestPaymentLink(ctx, session);
      } else {
        await resumeAtCurrentStep(ctx, session);
      }
      return;
    }

    // Plain /start always begins a brand new session — any prior
    // in-progress state (e.g. from earlier testing, or a customer
    // restarting mid-flow) is wiped rather than resumed.
    const session = resetSession(ctx.from.id, ctx.from.username);
    await sendWelcome(ctx, session);
  });

  bot.on('text', async (ctx) => {
    const session = ensureSession(ctx.from.id, ctx.from.username);
    const text = ctx.message.text.trim();

    if (session.status === 'abandoned') {
      await resumeFromAbandoned(ctx, session);
      return;
    }

    switch (session.step) {
      case 'new':
        await sendWelcome(ctx, session);
        break;

      case 'await_device_category':
        await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
        break;

      case 'await_stick_decision_now':
        await reply(ctx, 'Please tap Yes or No above.', hasStickNowKeyboard);
        break;

      case 'await_phone_os':
        await reply(ctx, 'Please tap Android or iPhone above.', phoneOsKeyboard);
        break;

      case 'await_tablet_os':
        await reply(ctx, 'Please tap iPad or Android tablet above.', tabletOsKeyboard);
        break;

      case 'awaiting_stick_decision':
        await reply(ctx, "Once you've got your device, tap the button above to continue.", continueButtonKeyboard);
        break;

      case 'await_plan':
        await reply(ctx, 'Please choose a number of devices using the buttons above.', planKeyboardFor(session));
        break;

      case 'await_isp':
        await handleIspText(ctx, session, text);
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
        await sendWelcome(ctx, session);
    }
  });

  bot.action('pick_stick', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_device_category') {
      await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
      return;
    }
    await askStickDecisionNow(ctx, session);
  });

  bot.action('pick_stick_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_stick_decision_now') {
      await reply(ctx, 'Please tap one of the buttons above.', hasStickNowKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticFirestick());
  });

  bot.action('pick_stick_no', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_stick_decision_now') {
      await reply(ctx, 'Please tap one of the buttons above.', hasStickNowKeyboard);
      return;
    }
    await showStickPurchaseRecommendation(ctx, session);
  });

  bot.action('pick_phone', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_device_category') {
      await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
      return;
    }
    updateSession(ctx.from.id, { step: 'await_phone_os' });
    await reply(ctx, 'Android or iPhone?', phoneOsKeyboard);
  });

  bot.action('pick_desktop', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_device_category') {
      await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticDesktopMac());
  });

  bot.action('pick_xbox', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_device_category') {
      await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticXbox());
  });

  bot.action('pick_tablet', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_device_category') {
      await reply(ctx, 'Please tap one of the buttons above.', deviceCategoryKeyboard);
      return;
    }
    updateSession(ctx.from.id, { step: 'await_tablet_os' });
    await reply(ctx, 'iOS (iPad) or Android tablet?', tabletOsKeyboard);
  });

  bot.action('pick_phone_android', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_phone_os') {
      await reply(ctx, 'Please tap one of the buttons above.', phoneOsKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticAndroidPhone());
  });

  bot.action('pick_phone_iphone', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_phone_os') {
      await reply(ctx, 'Please tap one of the buttons above.', phoneOsKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticIphone());
  });

  bot.action('pick_tablet_ipad', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_tablet_os') {
      await reply(ctx, 'Please tap one of the buttons above.', tabletOsKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticIpad());
  });

  bot.action('pick_tablet_android', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_tablet_os') {
      await reply(ctx, 'Please tap one of the buttons above.', tabletOsKeyboard);
      return;
    }
    await resolveDeviceCategory(ctx, session, syntheticAndroidTablet());
  });

  bot.action('device_purchased_continue', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || (session.status !== 'awaiting_device_purchase' && session.status !== 'abandoned')) {
      await reply(ctx, "You're already past this step.");
      return;
    }
    updateSession(ctx.from.id, { status: 'active' });
    await askDeviceCategory(ctx, getSession(ctx.from.id));
  });

  bot.action(/^plan_([123])$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (!session || session.step !== 'await_plan') {
      await reply(
        ctx,
        'Please choose a number of devices using the buttons above.',
        session ? planKeyboardFor(session) : planKeyboard
      );
      return;
    }
    const tier = Number(ctx.match[1]);
    if (tier === 3 && isDirectResolvedDevice(session)) {
      await reply(ctx, 'This order is limited to 1 or 2 devices — please choose one of the buttons above.', planKeyboardRestricted);
      return;
    }
    updateSession(ctx.from.id, {
      plan_tier: tier,
      devices_json: JSON.stringify([deviceOneFromSessionFields(session)]),
    });

    if (tier === 1) {
      await askIsp(ctx, getSession(ctx.from.id));
      return;
    }

    updateSession(ctx.from.id, { pending_device_index: 2 });
    await askDeviceCategory(ctx, getSession(ctx.from.id));
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

  // Admin taps this in the Payment topic when a customer's "I've paid" tap
  // doesn't actually check out against PayLio — flags it back to the
  // customer and re-opens the paid step so they can re-confirm once it's
  // sorted out.
  bot.action(/^mark_unpaid_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramUserId = Number(ctx.match[1]);
    const session = getSession(telegramUserId);
    if (!session) {
      await reply(ctx, "Couldn't find that customer's session.");
      return;
    }
    updateSession(telegramUserId, { status: 'awaiting_payment', step: 'awaiting_payment' });
    await sendHtml(
      ctx.telegram,
      telegramUserId,
      "Hey — we haven't been able to confirm your payment yet. Could you double check and let us know once it's gone through?",
      paidKeyboard
    );
    await reply(ctx, '⚠️ Customer notified — flagged as unpaid, they can re-confirm once resolved.');
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
        "Just checking in — have you had a chance to grab a Firestick or Onn device?\n\nTap below once you're ready.",
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
