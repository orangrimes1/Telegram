require('dotenv').config();
const { Telegraf } = require('telegraf');
const registerOnboardBot = require('./bots/onboard');
const registerSupportBot = require('./bots/support');

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
        console.error(`[onboard] Unhandled error processing update ${ctx.update.update_id}:`, err);
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
        console.error(`[support] Unhandled error processing update ${ctx.update.update_id}:`, err);
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
