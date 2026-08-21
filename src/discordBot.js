require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { askClaude } = require('./claude');
const { getClientByDiscordChannel } = require('../config/clients');
const { appendNoteToPlaybook } = require('./memoryWriter');
const { fetchAllPayments } = require('./payraClient');
const { appendNewPayments } = require('./googleSheets');
const { generateDailyReport, formatReportEmbed, generateWeeklyReport, formatWeeklyReportEmbed } = require('./paymentReport');
const { scheduleDaily, scheduleWeekly } = require('./scheduler');
const { runZelleBackfill, runClientsBackfill, runMatchBackfill } = require('./paymentBackfill');

const PAYMENT_REPORT_CHANNEL_ID = process.env.PAYMENT_REPORT_CHANNEL_ID;
const REPORT_TIMEZONE = 'America/Chicago';
const WEEKLY_REPORT_CHANNEL_ID = '1533177235123601448';

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

/**
 * Groups incoming records into ~windowDays-sized chunks (by payment date,
 * not by API page) and flushes each chunk once the window is exceeded.
 * This is separate from the API's own page size and the rate-limit delay
 * between calls — this only controls how often we write to the sheet.
 */
function createDateWindowBatcher(windowDays, onFlush) {
  let buffer = [];
  let windowStartDate = null;

  function getRecordDate(record) {
    if (record.paid_on) return new Date(record.paid_on);
    if (record.updated_at) return new Date(record.updated_at);
    if (record.created_at) return new Date(record.created_at);
    return new Date();
  }

  async function addRecords(records) {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const recordDate = getRecordDate(record);

      if (!windowStartDate) {
        windowStartDate = recordDate;
      }

      const daysSinceWindowStart = Math.abs((recordDate - windowStartDate) / (1000 * 60 * 60 * 24));

      if (daysSinceWindowStart >= windowDays && buffer.length > 0) {
        await onFlush(buffer.slice());
        buffer = [];
        windowStartDate = recordDate;
      }

      buffer.push(record);
    }
  }

  async function flushRemaining() {
    if (buffer.length > 0) {
      await onFlush(buffer.slice());
      buffer = [];
    }
  }

  return { addRecords: addRecords, flushRemaining: flushRemaining };
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
    console.log('⚡ Discord bot (' + client.user.tag + ') is running');

    if (PAYMENT_REPORT_CHANNEL_ID) {
      scheduleDaily(21, 0, REPORT_TIMEZONE, async () => {
        try {
          const channel = await discordClient.channels.fetch(PAYMENT_REPORT_CHANNEL_ID);
          const report = await generateDailyReport(channel, REPORT_TIMEZONE);
          await channel.send({ embeds: [formatReportEmbed(report)] });
        } catch (err) {
          console.error('[scheduler] Daily payment report failed:', err.message);
        }
      });
    } else {
      console.log('Skipping daily payment report scheduler — PAYMENT_REPORT_CHANNEL_ID not set.');
    }

    scheduleWeekly(5, 9, 0, 'America/New_York', async () => {
      try {
        const channel = await discordClient.channels.fetch(WEEKLY_REPORT_CHANNEL_ID);
        const report = await generateWeeklyReport(channel, 'America/New_York');
        await channel.send({ embeds: [formatWeeklyReportEmbed(report)] });
      } catch (err) {
        console.error('[scheduler] Weekly payment report failed:', err.message);
      }
    });
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const clientConfig = getClientByDiscordChannel(message.channelId);
    if (!clientConfig) return;

    const contentWithoutMention = message.content.replace(/^<@!?\d+>\s*/, '').trim();

    if (contentWithoutMention.toLowerCase().startsWith('!remember ')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can add to my memory — flagging this request to her.");
        return;
      }

      const note = contentWithoutMention.slice('!remember '.length).trim();
      if (!note) {
        await message.reply('Usage: `!remember <what you want me to remember>`');
        return;
      }

      try {
        await appendNoteToPlaybook(clientConfig.knowledgeFile, note);
        await message.reply('Got it — added to the playbook. Redeploying now, takes about a minute to take effect.');
      } catch (err) {
        console.error('[discord] !remember failed:', err.message);
        await message.reply("Couldn't save that — " + err.message);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!sync-payments')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run a payment sync.");
        return;
      }

      appendHistory(message.channelId, 'user', message.content);

      const startMsg = 'Phase 1: pulling the last 30 days first, so recent payments show up fast...';
      await message.reply(startMsg);
      appendHistory(message.channelId, 'assistant', startMsg);

      try {
        let runningTotalFetched = 0;
        let runningTotalAdded = 0;
        let runningTotalSkipped = 0;
        let flushCount = 0;
        const WINDOW_DAYS = 60; // roughly 2 months

        const flushBatch = async (records) => {
          flushCount = flushCount + 1;
          const batchResult = await appendNewPayments(records);
          runningTotalAdded += batchResult.added;
          runningTotalSkipped += batchResult.skippedDuplicates;
          const flushMsg = 'Flush ' + flushCount + ': ' + records.length + ' records (~2 month window) — '
            + batchResult.added + ' new rows written, '
            + batchResult.skippedDuplicates + ' already existed. '
            + '(Running total: ' + runningTotalFetched + ' fetched, ' + runningTotalAdded + ' written.)';
          await message.channel.send(flushMsg);
          appendHistory(message.channelId, 'assistant', flushMsg);
        };

        const recentBatcher = createDateWindowBatcher(WINDOW_DAYS, flushBatch);
        const recentHandler = async (page, pageRecords, totalFetchedSoFar) => {
          runningTotalFetched += pageRecords.length;
          await recentBatcher.addRecords(pageRecords);
        };

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        await fetchAllPayments(recentHandler, thirtyDaysAgo);
        await recentBatcher.flushRemaining();

        const phase2Msg = 'Phase 1 done — recent payments are in the sheet. Phase 2: starting full historical backfill, writing in ~2 month chunks as it goes...';
        await message.channel.send(phase2Msg);
        appendHistory(message.channelId, 'assistant', phase2Msg);

        const historicalBatcher = createDateWindowBatcher(WINDOW_DAYS, flushBatch);
        const historicalHandler = async (page, pageRecords, totalFetchedSoFar) => {
          runningTotalFetched += pageRecords.length;
          await historicalBatcher.addRecords(pageRecords);
        };

        await fetchAllPayments(historicalHandler);
        await historicalBatcher.flushRemaining();

        const doneMsg = 'All done. Fetched ' + runningTotalFetched + ' payments from Payra total (across both phases) — '
          + 'added ' + runningTotalAdded + ' new rows, skipped ' + runningTotalSkipped + ' duplicates.';
        await message.reply(doneMsg);
        appendHistory(message.channelId, 'assistant', doneMsg);
      } catch (err) {
        console.error('[discord] !sync-payments failed:', err.message);
        const failMsg = "Sync failed — " + err.message + " (Any batches already written to the sheet before this error are safe — nothing to redo for those.)";
        await message.reply(failMsg);
        appendHistory(message.channelId, 'assistant', failMsg);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!debug-payments')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run this.");
        return;
      }

      try {
        const recent = await message.channel.messages.fetch({ limit: 10 });
        let report = 'Raw structure of last 10 messages:\n\n';
        let count = 0;
        recent.forEach((m) => {
          if (count >= 5) return; // keep it short enough to fit a Discord message
          count = count + 1;
          report += '--- Message from ' + m.author.username + ' (id: ' + m.author.id + ') ---\n';
          report += 'content: ' + JSON.stringify(m.content).slice(0, 300) + '\n';
          report += 'embeds count: ' + m.embeds.length + '\n';
          if (m.embeds.length > 0) {
            const e = m.embeds[0];
            report += 'embed.title: ' + JSON.stringify(e.title) + '\n';
            report += 'embed.description: ' + JSON.stringify((e.description || '').slice(0, 300)) + '\n';
            report += 'embed.fields count: ' + (e.fields ? e.fields.length : 0) + '\n';
            if (e.fields && e.fields.length > 0) {
              report += 'first field: ' + JSON.stringify(e.fields[0]) + '\n';
            }
          }
          report += '\n';
        });

        const chunks = splitMessage(report);
        for (let i = 0; i < chunks.length; i++) {
          await message.channel.send('```\n' + chunks[i] + '\n```');
        }
      } catch (err) {
        console.error('[discord] !debug-payments failed:', err.message);
        await message.reply("Debug failed — " + err.message);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!debug-channel')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run this.");
        return;
      }

      const parts = contentWithoutMention.split(/\s+/);
      const targetChannelId = parts[1];
      if (!targetChannelId) {
        await message.reply('Usage: `!debug-channel <channelId>` (optionally add a user ID to filter: `!debug-channel <channelId> <userId>`)');
        return;
      }
      const filterUserId = parts[2];

      try {
        const targetChannel = await discordClient.channels.fetch(targetChannelId);
        const recent = await targetChannel.messages.fetch({ limit: 50 });

        let report = 'Raw structure from channel ' + targetChannelId + (filterUserId ? ' (filtered to user ' + filterUserId + ')' : '') + ':\n\n';
        let count = 0;

        recent.forEach((m) => {
          if (count >= 5) return; // keep it short
          if (filterUserId && m.author.id !== filterUserId) return;
          count = count + 1;
          report += '--- Message from ' + m.author.username + ' (id: ' + m.author.id + ') ---\n';
          report += 'content: ' + JSON.stringify(m.content).slice(0, 500) + '\n';
          report += 'embeds count: ' + m.embeds.length + '\n';
          if (m.embeds.length > 0) {
            const e = m.embeds[0];
            report += 'embed.title: ' + JSON.stringify(e.title) + '\n';
            report += 'embed.description: ' + JSON.stringify((e.description || '').slice(0, 500)) + '\n';
            report += 'embed.footer: ' + JSON.stringify(e.footer || null) + '\n';
            report += 'embed.fields count: ' + (e.fields ? e.fields.length : 0) + '\n';
            if (e.fields && e.fields.length > 0) {
              report += 'fields: ' + JSON.stringify(e.fields).slice(0, 500) + '\n';
            }
          }
          report += '\n';
        });

        if (count === 0) {
          report += '(no matching messages found in the most recent 50)';
        }

        const chunks = splitMessage(report);
        for (let i = 0; i < chunks.length; i++) {
          await message.channel.send('```\n' + chunks[i] + '\n```');
        }
      } catch (err) {
        console.error('[discord] !debug-channel failed:', err.message);
        await message.reply("Debug failed — " + err.message);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!backfill-zelle')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run this.");
        return;
      }
      await message.reply('Step 1: scanning Zelle channel and writing payments directly to the sheet as they\'re found...');
      let latestStatus = 'Starting...';
      let stillRunning = true;
      const heartbeat = setInterval(async () => {
        if (!stillRunning) return;
        try { await message.channel.send('⏳ Still working — ' + latestStatus); } catch (e) {}
      }, 60000);
      try {
        const result = await runZelleBackfill(discordClient, async (status) => { latestStatus = status; });
        stillRunning = false;
        clearInterval(heartbeat);
        await message.channel.send('**Zelle backfill complete.** Found ' + result.found + ' confirmed payments, wrote ' + result.written + ' rows.');
      } catch (err) {
        stillRunning = false;
        clearInterval(heartbeat);
        console.error('[discord] !backfill-zelle failed:', err.message, err.stack);
        await message.reply("Failed — " + err.message + " (Rows already written before this error are safe.)");
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!backfill-clients')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run this.");
        return;
      }
      await message.reply('Step 2: scanning client setup channel and writing to "Backfill Clients" as records are found...');
      let latestStatus = 'Starting...';
      let stillRunning = true;
      const heartbeat = setInterval(async () => {
        if (!stillRunning) return;
        try { await message.channel.send('⏳ Still working — ' + latestStatus); } catch (e) {}
      }, 60000);
      try {
        const result = await runClientsBackfill(discordClient, async (status) => { latestStatus = status; });
        stillRunning = false;
        clearInterval(heartbeat);
        await message.channel.send('**Clients backfill complete.** Found ' + result.found + ' setup messages, wrote ' + result.written + ' rows.');
      } catch (err) {
        stillRunning = false;
        clearInterval(heartbeat);
        console.error('[discord] !backfill-clients failed:', err.message, err.stack);
        await message.reply("Failed — " + err.message + " (Rows already written before this error are safe.)");
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!backfill-match')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run this.");
        return;
      }
      await message.reply('Step 3: matching clients to payments and filling in enrichment columns — this is pure sheet reading/writing, no Discord scanning, should be fast...');
      try {
        const result = await runMatchBackfill(async (status) => {
          await message.channel.send(status);
        });
        await message.channel.send('**Matching complete.** Checked ' + result.totalRows + ' payment rows, enriched ' + result.enriched + '.');
      } catch (err) {
        console.error('[discord] !backfill-match failed:', err.message, err.stack);
        await message.reply("Failed — " + err.message);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!payment-report')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run the payment report manually.");
        return;
      }

      try {
        const report = await generateDailyReport(message.channel, REPORT_TIMEZONE);
        await message.channel.send({ embeds: [formatReportEmbed(report)] });
      } catch (err) {
        console.error('[discord] !payment-report failed:', err.message);
        await message.reply("Report generation failed — " + err.message);
      }
      return;
    }

    if (contentWithoutMention.toLowerCase().startsWith('!weekly-report')) {
      if (message.author.id !== process.env.ELISA_DISCORD_USER_ID) {
        await message.reply("Only Elisa can run the weekly report manually.");
        return;
      }

      try {
        const report = await generateWeeklyReport(message.channel, REPORT_TIMEZONE);
        await message.channel.send({ embeds: [formatWeeklyReportEmbed(report)] });
      } catch (err) {
        console.error('[discord] !weekly-report failed:', err.message);
        await message.reply("Report generation failed — " + err.message);
      }
      return;
    }

    const history = appendHistory(message.channelId, 'user', message.content);

    // If this message is a reply to an earlier one, pull the original in as
    // context — otherwise "what's the update on this?" has nothing to point at.
    let repliedToKiki = false;
    if (message.reference) {
      try {
        const repliedTo = await message.fetchReference();
        repliedToKiki = discordClient && repliedTo.author.id === discordClient.user.id;
        const quoted = 'Elisa is replying to this earlier message: "' + repliedTo.content + '"\n\nHer reply: ' + message.content;
        history[history.length - 1] = { role: 'user', content: quoted };
      } catch (err) {
        console.error('[discord] Could not fetch replied-to message:', err.message);
      }
    }

    // Only actually respond if Kiki was tagged, or this is a direct reply to
    // one of Kiki's own messages. Otherwise, stay silent but keep the message
    // in history above — so Kiki still has full context for when it IS asked
    // something, without replying to every unrelated conversation in the channel.
    const wasMentioned = discordClient && message.mentions.users.has(discordClient.user.id);
    if (!wasMentioned && !repliedToKiki) {
      return;
    }

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
