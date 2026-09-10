// Telegram HTML formatting helpers. Bold copy requires parse_mode: 'HTML' on
// every send — these wrappers make that the default instead of something
// each call site has to remember.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function reply(ctx, text, extra = {}) {
  return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

function sendHtml(telegram, chatId, text, extra = {}) {
  return telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
}

module.exports = { escapeHtml, escapeHtmlAttr, reply, sendHtml };
