require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { askClaude } = require('./claude');
const { getClientByDiscordChannel } = require('../config/clients');

const historyByChannel = new Map();
const MAX_TURNS = 20;

// Kept so other modules (like the webhook server) can send DMs through the
// same running bot connection, instead of creating a second login.
let discordClient = null;

function appendHistory(channelId, role, content) {
  const history = historyByChannel.get(channelId) || [];
  history.push({ role, content });
  historyByChannel.set(channelId, history.slice(-MAX_TURNS));
  return historyByChannel.get(channelId);
}

function start() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once('ready', () => {
    discordClient = client;
    console.log(`⚡ Discord bot (${client.user.tag}) is running`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const clientConfig = getClientByDiscordChannel(message.channelId);
    if (!clientConfig) return; // channel not mapped to a client yet

    const history = appendHistory(message.channelId, 'user', message.content);

    try {
      await message.channel.sendTyping();
      const reply = await askClaude({ history, clientConfig });
      appendHistory(message.channelId, 'assistant', reply);

      // Discord has a 2000-char message limit; split long replies.
      for (const chunk of splitMessage(reply)) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error(`[discord] ${clientConfig.label} error:`, err.message);
      await message.reply("Sorry, I ran into an error processing that — I've logged it.");
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN);
}

function splitMessage(text, limit = 1990) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length ? chunks : [text];
}

/**
 * Send a direct message to a specific Discord user. Used by the webhook
 * server to deliver real-time automation-failure alerts. Returns true/false
 * rather than throwing, so a bad webhook payload never crashes the server.
 */
async function sendDirectMessage(userId, message) {
  if (!discordClient) {
    console.error('[discord] Cannot send DM — bot is not ready yet.');
    return false;
  }
  if (!userId) {
    console.error('[discord] Cannot send DM — no target user ID configured.');
    return false;
  }
  try {
    const user = await discordClient.users.fetch(userId);
    for (const chunk of splitMessage(message)) {
      await user.send(chunk);
    }
    return true;
  } catch (err) {
    console.error('[discord] Failed to send DM:', err.message);
    return false;
  }
}

module.exports = { start, sendDirectMessage };
