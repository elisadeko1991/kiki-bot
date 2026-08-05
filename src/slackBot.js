require('dotenv').config();
const { App } = require('@slack/bolt');
const { askClaude } = require('./claude');
const { getClientBySlackChannel } = require('../config/clients');

// In-memory conversation history per channel. Fine for a single-process bot;
// swap for a real store (Redis, a DB row per channel) once you need persistence
// across restarts or multiple client channels at real volume.
const historyByChannel = new Map();
const MAX_TURNS = 20; // trim history to keep token usage sane

function appendHistory(channelId, role, content) {
  const history = historyByChannel.get(channelId) || [];
  history.push({ role, content });
  historyByChannel.set(channelId, history.slice(-MAX_TURNS));
  return historyByChannel.get(channelId);
}

function start() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true, // no public URL / webhook needed
  });

  // Respond to any message in a channel the bot's been added to.
  // Swap this for `app.event('app_mention', ...)` if you only want it to
  // reply when explicitly mentioned, rather than on every message.
  app.message(async ({ message, say }) => {
    if (message.subtype) return; // ignore edits, joins, etc.

    const clientConfig = getClientBySlackChannel(message.channel);
    if (!clientConfig) {
      // Channel isn't mapped to a client yet — stay silent rather than
      // guessing which client this belongs to.
      return;
    }

    const history = appendHistory(message.channel, 'user', message.text);

    try {
      const reply = await askClaude({ history, clientConfig });
      appendHistory(message.channel, 'assistant', reply);
      await say(reply);
    } catch (err) {
      console.error(`[slack] ${clientConfig.label} error:`, err.message);
      await say("Sorry, I ran into an error processing that — I've logged it.");
    }
  });

  app.error((error) => {
    console.error('[slack] app error:', error);
  });

  app.start().then(() => {
    console.log(`⚡ Slack bot (${process.env.BOT_DISPLAY_NAME || 'Custom Bot'}) is running`);
  });
}

module.exports = { start };
