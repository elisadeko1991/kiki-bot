require('dotenv').config();

const EXCLUDED_USER_ID = process.env.PAYMENT_REPORT_EXCLUDE_USER_ID || '1505731170585935872';

function getSearchableText(message) {
  let text = message.content || '';

  if (message.embeds && message.embeds.length) {
    for (let i = 0; i < message.embeds.length; i++) {
      const embed = message.embeds[i];
      if (embed.title) text += '\n' + embed.title;
      if (embed.description) text += '\n' + embed.description;
      if (embed.fields && embed.fields.length) {
        for (let j = 0; j < embed.fields.length; j++) {
          text += '\n' + embed.fields[j].name + ': ' + embed.fields[j].value;
        }
      }
      if (embed.footer && embed.footer.text) text += '\n' + embed.footer.text;
      if (embed.author && embed.author.name) text += '\n' + embed.author.name;
    }
  }

  return text;
}

function parsePaymentMessage(content) {
  const amountMatch = content.match(/Amount Paid:\**\s*\$?([\d,]+(?:\.\d+)?)/i);
  const paymentTypeMatch = content.match(/Payment Type:\**\s*(.+?)\s*(?:\n|Lead Type:)/i);
  const dateMatch = content.match(/Reporting Date:\**\s*(\d{4}-\d{2}-\d{2})/i);
  const agentMatch = content.match(/New Payment Collected by\**\s*([^\n]+)/i);

  if (!amountMatch || !paymentTypeMatch || !dateMatch) {
    return null;
  }

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;

  return {
    amount: amount,
    paymentType: paymentTypeMatch[1].trim(),
    reportingDate: dateMatch[1],
    agent: agentMatch ? agentMatch[1].trim() : 'Unknown',
  };
}

function isSpanish(paymentType) {
  return paymentType.toLowerCase().includes('spanish');
}

function getTodayInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function addToAgentBucket(bucket, agent, amount) {
  if (!bucket[agent]) {
    bucket[agent] = { count: 0, total: 0 };
  }
  bucket[agent].count = bucket[agent].count + 1;
  bucket[agent].total += amount;
}

async function generateDailyReport(channel, timezone, overrideDate) {
  const todayStr = overrideDate || getTodayInTimezone(timezone);

  let totalEnglish = 0;
  let totalSpanish = 0;
  let countEnglish = 0;
  let countSpanish = 0;
  let matchedMessages = 0;
  const englishByAgent = {};
  const spanishByAgent = {};

  let lastId = null;
  const MAX_BATCHES = 20;
  let batches = 0;
  let keepGoing = true;

  while (keepGoing && batches < MAX_BATCHES) {
    batches = batches + 1;

    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    let oldestInBatchTooOld = true;

    messages.forEach((message) => {
      lastId = message.id;

      if (message.author && message.author.id === EXCLUDED_USER_ID) {
        return;
      }

      const searchableText = getSearchableText(message);
      const parsed = parsePaymentMessage(searchableText);

      if (parsed) {
        if (parsed.reportingDate === todayStr) {
          matchedMessages = matchedMessages + 1;
          if (isSpanish(parsed.paymentType)) {
            totalSpanish += parsed.amount;
            countSpanish = countSpanish + 1;
            addToAgentBucket(spanishByAgent, parsed.agent, parsed.amount);
          } else {
            totalEnglish += parsed.amount;
            countEnglish = countEnglish + 1;
            addToAgentBucket(englishByAgent, parsed.agent, parsed.amount);
          }
          oldestInBatchTooOld = false;
        } else if (parsed.reportingDate > todayStr) {
          oldestInBatchTooOld = false;
        }
      }
    });

    if (oldestInBatchTooOld && matchedMessages > 0) {
      keepGoing = false;
    }
    if (messages.size < 100) {
      keepGoing = false;
    }
  }

  return {
    date: todayStr,
    totalEnglish: totalEnglish,
    totalSpanish: totalSpanish,
    countEnglish: countEnglish,
    countSpanish: countSpanish,
    matchedMessages: matchedMessages,
    englishByAgent: englishByAgent,
    spanishByAgent: spanishByAgent,
  };
}

function getMostRecentWeeklyBoundary(hour, timezone) {
  const now = new Date();
  const nowString = now.toLocaleString('en-US', { timeZone: timezone });
  const nowAsUtc = new Date(nowString);
  const offsetMs = now.getTime() - nowAsUtc.getTime();

  const FRIDAY = 5;
  const currentDay = nowAsUtc.getDay();
  const daysSinceFriday = (currentDay - FRIDAY + 7) % 7;

  let candidateWallClock = new Date(
    nowAsUtc.getFullYear(), nowAsUtc.getMonth(), nowAsUtc.getDate() - daysSinceFriday, hour, 0, 0
  );
  let candidateReal = new Date(candidateWallClock.getTime() + offsetMs);

  if (candidateReal.getTime() > now.getTime()) {
    candidateWallClock = new Date(
      candidateWallClock.getFullYear(), candidateWallClock.getMonth(), candidateWallClock.getDate() - 7, hour, 0, 0
    );
    candidateReal = new Date(candidateWallClock.getTime() + offsetMs);
  }

  return candidateReal;
}

function formatDateInTimezone(date, timezone) {
  return date.toLocaleString('en-US', {
    timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

async function generateWeeklyReport(channel, timezone) {
  const hour = 9;
  const end = getMostRecentWeeklyBoundary(hour, timezone);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  let totalEnglish = 0;
  let totalSpanish = 0;
  let countEnglish = 0;
  let countSpanish = 0;
  let matchedMessages = 0;
  const englishByAgent = {};
  const spanishByAgent = {};

  let lastId = null;
  const MAX_BATCHES = 50;
  let batches = 0;
  let keepGoing = true;

  while (keepGoing && batches < MAX_BATCHES) {
    batches = batches + 1;

    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    let allOlderThanStart = true;

    messages.forEach((message) => {
      lastId = message.id;

      const created = message.createdAt;
      if (created < start) return;
      allOlderThanStart = false;
      if (created > end) return;

      if (message.author && message.author.id === EXCLUDED_USER_ID) return;

      const searchableText = getSearchableText(message);
      const parsed = parsePaymentMessage(searchableText);

      if (parsed) {
        matchedMessages = matchedMessages + 1;
        if (isSpanish(parsed.paymentType)) {
          totalSpanish += parsed.amount;
          countSpanish = countSpanish + 1;
          addToAgentBucket(spanishByAgent, parsed.agent, parsed.amount);
        } else {
          totalEnglish += parsed.amount;
          countEnglish = countEnglish + 1;
          addToAgentBucket(englishByAgent, parsed.agent, parsed.amount);
        }
      }
    });

    if (allOlderThanStart) keepGoing = false;
    if (messages.size < 100) keepGoing = false;
  }

  return {
    rangeLabel: formatDateInTimezone(start, timezone) + ' – ' + formatDateInTimezone(end, timezone),
    totalEnglish: totalEnglish,
    totalSpanish: totalSpanish,
    countEnglish: countEnglish,
    countSpanish: countSpanish,
    matchedMessages: matchedMessages,
    englishByAgent: englishByAgent,
    spanishByAgent: spanishByAgent,
  };
}

/** Builds a sorted array of { agent, deals, aov, revenue } from a bucket map. */
function buildAgentRows(bucket) {
  const rows = Object.keys(bucket).map((agent) => {
    const data = bucket[agent];
    return {
      agent: agent,
      deals: data.count,
      aov: data.total / data.count,
      revenue: data.total,
    };
  });
  rows.sort((a, b) => b.revenue - a.revenue);
  return rows;
}

function padRight(str, len) {
  str = String(str);
  while (str.length < len) str = str + ' ';
  return str;
}

function padLeft(str, len) {
  str = String(str);
  while (str.length < len) str = ' ' + str;
  return str;
}

/** Renders a monospace leaderboard table for a code block. Top row (by
 * revenue, already sorted) gets a medal emoji next to the closer's name. */
function formatSection(label, rows, totalAmount) {
  let out = '**Total LTV - ' + label + ':** $' + totalAmount.toFixed(2) + ' (' + rows.reduce((sum, r) => sum + r.deals, 0) + ' payments)\n';

  if (rows.length === 0) {
    return out + '_no payments today_';
  }

  out += '```\n';
  out += padRight('#', 3) + padRight('Closer', 20) + padLeft('Deals', 6) + padLeft('Rev', 10) + '\n';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const closerLabel = (i === 0 ? '🥇 ' : '') + r.agent;
    out += padRight(String(i + 1), 3)
      + padRight(closerLabel, 20)
      + padLeft(String(r.deals), 6)
      + padLeft('$' + r.revenue.toFixed(0), 10)
      + '\n';
  }
  out += '```';
  return out;
}

function formatReportEmbed(report) {
  const totalAmount = report.totalEnglish + report.totalSpanish;
  const englishRows = buildAgentRows(report.englishByAgent);
  const spanishRows = buildAgentRows(report.spanishByAgent);

  const description =
    '**Total Payments:** $' + totalAmount.toFixed(2) + ' (' + report.matchedMessages + ' payments)\n\n'
    + formatSection('English', englishRows, report.totalEnglish) + '\n\n'
    + formatSection('Spanish', spanishRows, report.totalSpanish);

  return {
    title: 'Daily Payment Report — ' + report.date,
    color: 5763719,
    description: description,
    timestamp: new Date().toISOString(),
  };
}

function formatWeeklyReportEmbed(report) {
  const totalAmount = report.totalEnglish + report.totalSpanish;
  const englishRows = buildAgentRows(report.englishByAgent);
  const spanishRows = buildAgentRows(report.spanishByAgent);

  const description =
    '**Total Payments:** $' + totalAmount.toFixed(2) + ' (' + report.matchedMessages + ' payments)\n\n'
    + formatSection('English', englishRows, report.totalEnglish) + '\n\n'
    + formatSection('Spanish', spanishRows, report.totalSpanish);

  return {
    title: 'Weekly Payment Report — ' + report.rangeLabel,
    color: 5763719,
    description: description,
    timestamp: new Date().toISOString(),
  };
}

/** Plain-text fallback, kept for logging/debug use. */
function formatReport(report) {
  return 'Daily Payment Report — ' + report.date + '\n'
    + 'Total Payments: $' + (report.totalEnglish + report.totalSpanish).toFixed(2) + ' (' + report.matchedMessages + ' payments)\n'
    + 'English: $' + report.totalEnglish.toFixed(2) + ' (' + report.countEnglish + ')\n'
    + 'Spanish: $' + report.totalSpanish.toFixed(2) + ' (' + report.countSpanish + ')';
}

module.exports = {
  parsePaymentMessage: parsePaymentMessage,
  getSearchableText: getSearchableText,
  isSpanish: isSpanish,
  getTodayInTimezone: getTodayInTimezone,
  generateDailyReport: generateDailyReport,
  generateWeeklyReport: generateWeeklyReport,
  formatReport: formatReport,
  formatReportEmbed: formatReportEmbed,
  formatWeeklyReportEmbed: formatWeeklyReportEmbed,
};
