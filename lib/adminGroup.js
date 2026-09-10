let warnedMissingConfig = false;

function getAdminChatId() {
  const chatId = process.env.ADMIN_GROUP_CHAT_ID;
  if (!chatId) {
    if (!warnedMissingConfig) {
      console.warn(
        '[adminGroup] ADMIN_GROUP_CHAT_ID is not set in .env — admin notifications will be skipped and logged to console instead.'
      );
      warnedMissingConfig = true;
    }
    return null;
  }
  return chatId;
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
    console.log(`[adminGroup] (no ADMIN_GROUP_CHAT_ID configured) would have posted:\n${text}`);
    return null;
  }
  return telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...extra,
  });
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

function isAdminGroupMessage(ctx) {
  const chatId = process.env.ADMIN_GROUP_CHAT_ID;
  if (!chatId) return false;
  return String(ctx.chat && ctx.chat.id) === String(chatId);
}

module.exports = { postToAdminGroup, postToRequestTopic, postToSupportTopic, isAdminGroupMessage };
