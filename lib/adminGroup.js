let warnedMissingConfig = false;

function getAdminChatId() {
  const raw = process.env.ADMIN_GROUP_CHAT_ID;
  if (!raw) {
    if (!warnedMissingConfig) {
      console.warn(
        '[adminGroup] ADMIN_GROUP_CHAT_ID is not set in .env — admin notifications will be skipped and logged to console instead.'
      );
      warnedMissingConfig = true;
    }
    return null;
  }
  // Telegram supergroup/channel chat ids are always negative (-100...), but
  // some hosting UIs (Railway's variable field, at least) refuse to keep a
  // leading "-" no matter how it's entered — normalize here instead of
  // fighting the UI: treat an unsigned value as the same chat with the sign
  // stripped, and restore it.
  const trimmed = raw.trim();
  return trimmed.startsWith('-') ? trimmed : `-${trimmed}`;
}

function topicExtra(envVarName) {
  const topicId = process.env[envVarName];
  return topicId ? { message_thread_id: Number(topicId) } : {};
}

// Posts a message to the admin group. `telegram` is a Telegraf Telegram
// instance (ctx.telegram or bot.telegram — both expose sendMessage).
// Returns the sent Telegram message object (so callers can store
// message_id for reply-based handoffs), or null if the admin group isn't
// configured yet. Pass `extra.message_thread_id` to target a specific
// topic — see postToRequestTopic / postToSupportTopic below for the two
// topics this project actually uses.
async function postToAdminGroup(telegram, text, extra = {}) {
  const chatId = getAdminChatId();
  if (!chatId) {
    // Never log `text` here — it can carry customer PII (ISP, device,
    // free-text ticket descriptions) or, via a future call site, more
    // sensitive content. Log that a post was skipped and which topic, not
    // what it said.
    const topicNote = extra.message_thread_id ? ` (topic ${extra.message_thread_id})` : '';
    console.log(`[adminGroup] ADMIN_GROUP_CHAT_ID not configured — skipped posting to admin group${topicNote}.`);
    return null;
  }
  try {
    return await telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...extra,
    });
  } catch (err) {
    // A bad chat/topic id, the bot losing group membership, etc. shouldn't
    // take down the customer's flow — every call site already treats a
    // null return as "admin post failed, but keep going."
    console.error(`[adminGroup] Failed to post to admin group (chat ${chatId}):`, err.message);
    return null;
  }
}

// Onboarding notifications (device review, trial/paid credential requests,
// abandoned sessions, etc.) — the "Request" topic.
function postToRequestTopic(telegram, text, extra = {}) {
  return postToAdminGroup(telegram, text, { ...topicExtra('ADMIN_REQUEST_TOPIC_ID'), ...extra });
}

// Support bot tickets — the "Support" topic.
function postToSupportTopic(telegram, text, extra = {}) {
  return postToAdminGroup(telegram, text, { ...topicExtra('ADMIN_SUPPORT_TOPIC_ID'), ...extra });
}

// Per-order payment-link requests — the "Payment" topic.
function postToPaymentTopic(telegram, text, extra = {}) {
  return postToAdminGroup(telegram, text, { ...topicExtra('ADMIN_PAYMENT_TOPIC_ID'), ...extra });
}

function isAdminGroupMessage(ctx) {
  const chatId = getAdminChatId();
  if (!chatId) return false;
  return String(ctx.chat && ctx.chat.id) === chatId;
}

module.exports = {
  postToAdminGroup,
  postToRequestTopic,
  postToSupportTopic,
  postToPaymentTopic,
  isAdminGroupMessage,
};
