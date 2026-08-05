require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { askClaude } = require('./claude');
const { getClientByDiscordChannel } = require('../config/clients');

const historyByChannel = new Map();
const MAX_TURNS = 20;

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

module.exports = { start };
