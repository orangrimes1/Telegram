const { Markup } = require('telegraf');
const { getSession } = require('../db');
const { postToSupportTopic, isAdminGroupMessage } = require('../lib/adminGroup');
const { escapeHtml, reply } = require('../lib/html');

// Per-user conversation state. Support chats are short synchronous
// back-and-forths, not multi-day pauses like onboarding, so plain in-memory
// state (lost on restart) is enough for v1 — no SQLite table needed.
const conversations = new Map();

const CATEGORIES = {
  server: {
    label: 'Server down',
    questions: [{ key: 'device', prompt: 'Which device are you using?' }],
    followUp: 'Try restarting the app. Is it working now?',
    offerResolution: true,
    ispAware: true,
  },
  buffering: {
    label: 'Buffering',
    questions: [{ key: 'device', prompt: 'Which device are you using?' }],
    followUp: 'Try restarting the app. Is it still buffering?',
    offerResolution: true,
    ispAware: true,
  },
  login: {
    label: 'Login issue',
    questions: [{ key: 'device', prompt: 'Which device are you using?' }],
    followUp:
      "Double-check there's no extra space before or after your <b>username</b> or <b>password</b>, then try again.\n\nDid that fix it?",
    offerResolution: true,
  },
  download: {
    label: 'App download issue',
    questions: [{ key: 'device', prompt: 'Which device are you trying to install the app on?' }],
    followUp: 'Try the Downloader steps again using the code we sent. Did that fix it?',
    offerResolution: true,
  },
  other: {
    label: 'Other',
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

// Server down / Buffering, when the customer's onboarding session has a
// flagged ISP: skip the generic device question (device is already known
// from their onboarding record) and go straight to a targeted question,
// then straight to a ticket — restarting the app doesn't fix a known ISP
// issue, so there's no resolution offer on this path.
async function startCategory(ctx, key) {
  const category = CATEGORIES[key];
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
    state.awaitingResolution = true;
    await reply(ctx, category.followUp, resolutionKeyboard);
  } else {
    await logTicket(ctx, state);
    conversations.delete(ctx.from.id);
  }
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
      `<b>Device on file:</b> ${onboardingSession.device_display_name || 'unknown'}`
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

function register(bot) {
  bot.start(async (ctx) => {
    conversations.delete(ctx.from.id);
    await showCategoryMenu(ctx);
  });

  bot.on('text', async (ctx) => {
    if (isAdminGroupMessage(ctx)) return; // no admin-side flow for support tickets yet

    const state = conversations.get(ctx.from.id);
    if (!state || state.awaitingResolution || state.ispAware) {
      // Fresh conversation, or they typed instead of tapping the expected
      // buttons — just re-show the relevant prompt.
      if (state && state.awaitingResolution) {
        await reply(ctx, CATEGORIES[state.categoryKey].followUp, resolutionKeyboard);
        return;
      }
      if (state && state.ispAware) {
        await reply(ctx, 'Please tap one of the buttons above.', ispPatternKeyboard);
        return;
      }
      await showCategoryMenu(ctx);
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
    await reply(ctx, "Glad that's fixed! Message us again anytime if something else comes up.");
  });

  bot.action('sup_resolved_no', async (ctx) => {
    await ctx.answerCbQuery();
    const state = conversations.get(ctx.from.id);
    if (!state) {
      await reply(ctx, 'Let’s start over. What can we help you with?', categoryKeyboard);
      return;
    }
    await logTicket(ctx, state);
    conversations.delete(ctx.from.id);
  });
}

module.exports = register;
