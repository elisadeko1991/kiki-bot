require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { askClaude } = require('./claude');
const { getClientByDiscordChannel } = require('../config/clients');

const historyByChannel = new Map();
const MAX_TURNS = 20;

let discordClient = null;

function appendHistory(channelId, role, content) {
  const history = historyByChannel.get(channelId) || [];
  history.push({ role: role, content: content });
  historyByChannel.set(channelId, history.slice(-MAX_TURNS));
  return historyByChannel.get(channelId);
}

function splitMessage(text, limit) {
  limit = limit || 1990;
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length ? chunks : [text];
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
    console.log('? Discord bot (' + client.user.tag + ') is running');
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const clientConfig = getClientByDiscordChannel(message.channelId);
    if (!clientConfig) return;

    const history = appendHistory(message.channelId, 'user', message.content);

    try {
      await message.channel.sendTyping();
      const reply = await askClaude({ history: history, clientConfig: clientConfig });
      appendHistory(message.channelId, 'assistant', reply);

      const chunks = splitMessage(reply);
      for (let i = 0; i < chunks.length; i++) {
        await message.reply(chunks[i]);
      }
    } catch (err) {
      console.error('[discord] ' + clientConfig.label + ' error:', err.message);
      await message.reply("Sorry, I ran into an error processing that — I've logged it.");
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN);
}

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
    const chunks = splitMessage(message);
    for (let i = 0; i < chunks.length; i++) {
      await user.send(chunks[i]);
    }
    return true;
  } catch (err) {
    console.error('[discord] Failed to send DM:', err.message);
    return false;
  }
}

async function sendChannelMessage(channelId, message) {
  if (!discordClient) {
    console.error('[discord] Cannot post to channel — bot is not ready yet.');
    return false;
  }
  if (!channelId) {
    console.error('[discord] Cannot post to channel — no channel ID configured.');
    return false;
  }
  try {
    const channel = await discordClient.channels.fetch(channelId);
    const chunks = splitMessage(message);
    for (let i = 0; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
    return true;
  } catch (err) {
    console.error('[discord] Failed to post to channel:', err.message);
    return false;
  }
}

module.exports = { start: start, sendDirectMessage: sendDirectMessage, sendChannelMessage: sendChannelMessage };
