require('dotenv').config();
const { Telegraf } = require('telegraf');
const registerOnboardBot = require('./bots/onboard');
const registerSupportBot = require('./bots/support');

// Never log the full error object here — Telegraf's TelegramError carries
// the original outgoing API call (method + payload, i.e. the message text)
// on err.on, so `console.error(..., err)` would print credentials/message
// content straight into Railway's logs whenever a send fails (e.g. a
// customer blocks the bot right after receiving trial credentials). Log
// only the message and enough context to find the update, never the error
// object itself.
function logBotError(label, err, ctx) {
  const chatId = ctx.chat ? ctx.chat.id : 'unknown';
  const userId = ctx.from ? ctx.from.id : 'unknown';
  const updateType = ctx.updateType || 'unknown';
  console.error(`${label} update ${ctx.update.update_id} (type=${updateType}, chat=${chatId}, user=${userId}): ${err.message}`);
}

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null; // 'onboard' | 'support' | null (both)

const activeBots = [];

async function main() {
  if (only !== 'support') {
    if (!process.env.ONBOARD_BOT_TOKEN) {
      console.warn('ONBOARD_BOT_TOKEN not set in .env — onboarding bot not started.');
    } else {
      const onboardBot = new Telegraf(process.env.ONBOARD_BOT_TOKEN);
      registerOnboardBot(onboardBot);
      onboardBot.catch((err, ctx) => {
        logBotError('[onboard] Unhandled error processing', err, ctx);
      });
      activeBots.push(onboardBot);
      // launch() doesn't resolve until the bot stops (it awaits the polling
      // loop internally) — don't await it, just catch fatal errors.
      onboardBot.launch().catch((err) => {
        console.error('[onboard] bot crashed:', err.message);
      });
      console.log('LumenOnboardBot is running (long polling).');
    }
  }

  if (only !== 'onboard') {
    if (!process.env.SUPPORT_BOT_TOKEN) {
      console.warn('SUPPORT_BOT_TOKEN not set in .env — support bot not started.');
    } else {
      const supportBot = new Telegraf(process.env.SUPPORT_BOT_TOKEN);
      registerSupportBot(supportBot);
      supportBot.catch((err, ctx) => {
        logBotError('[support] Unhandled error processing', err, ctx);
      });
      activeBots.push(supportBot);
      supportBot.launch().catch((err) => {
        console.error('[support] bot crashed:', err.message);
      });
      console.log('LumenSupportBot is running (long polling).');
    }
  }

  if (activeBots.length === 0) {
    console.error('No bot tokens configured — set ONBOARD_BOT_TOKEN and/or SUPPORT_BOT_TOKEN in .env.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function shutdown(signal) {
  return () => {
    console.log(`\nReceived ${signal}, stopping bot(s)...`);
    activeBots.forEach((bot) => bot.stop(signal));
    process.exit(0);
  };
}

process.once('SIGINT', shutdown('SIGINT'));
process.once('SIGTERM', shutdown('SIGTERM'));
