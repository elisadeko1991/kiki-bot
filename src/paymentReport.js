require('dotenv').config();

// Messages from this user are never counted — even if they happen to match
// the payment format (e.g. a bot re-posting or relaying messages).
const EXCLUDED_USER_ID = process.env.PAYMENT_REPORT_EXCLUDE_USER_ID || '1505731170585935872';

/**
 * Builds one combined text blob from a Discord message — its plain content
 * plus anything inside embeds (title, description, fields) — so the same
 * regex-based parser below works whether the message is:
 *   - typed manually by a team member (plain text), or
 *   - posted by an automation as a rich embed (like the LeadLab bot)
 */
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
    }
  }

  return text;
}

/**
 * Parses payment details out of a text blob (see getSearchableText above).
 * Returns { amount, paymentType, reportingDate } or null if it doesn't match.
 */
function parsePaymentMessage(content) {
  const amountMatch = content.match(/Amount Paid:\**\s*\$?([\d,]+(?:\.\d+)?)/i);
  const paymentTypeMatch = content.match(/Payment Type:\**\s*(.+?)\s*(?:\n|Lead Type:)/i);
  const dateMatch = content.match(/Reporting Date:\**\s*(\d{4}-\d{2}-\d{2})/i);

  if (!amountMatch || !paymentTypeMatch || !dateMatch) {
    return null;
  }

  const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;

  return {
    amount: amount,
    paymentType: paymentTypeMatch[1].trim(),
    reportingDate: dateMatch[1],
  };
}

function isSpanish(paymentType) {
  return paymentType.toLowerCase().includes('spanish');
}

/** Returns today's date as YYYY-MM-DD in the given IANA timezone. */
function getTodayInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Fetches recent message history from a channel and totals payments whose
 * Reporting Date matches todayStr (or an explicit override date). Reads
 * both plain-text messages and embeds. Skips EXCLUDED_USER_ID entirely.
 */
async function generateDailyReport(channel, timezone, overrideDate) {
  const todayStr = overrideDate || getTodayInTimezone(timezone);

  let totalEnglish = 0;
  let totalSpanish = 0;
  let countEnglish = 0;
  let countSpanish = 0;
  let matchedMessages = 0;

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
        return; // skip entirely, don't parse or count
      }

      const searchableText = getSearchableText(message);
      const parsed = parsePaymentMessage(searchableText);

      if (parsed) {
        if (parsed.reportingDate === todayStr) {
          matchedMessages = matchedMessages + 1;
          if (isSpanish(parsed.paymentType)) {
            totalSpanish += parsed.amount;
            countSpanish = countSpanish + 1;
          } else {
            totalEnglish += parsed.amount;
            countEnglish = countEnglish + 1;
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
  };
}

/** Plain-text version, kept for logging/fallback use. */
function formatReport(report) {
  return '**Daily Payment Report — ' + report.date + '**\n\n'
    + '**Total LTV - English:** $' + report.totalEnglish.toFixed(2) + ' (' + report.countEnglish + ' payments)\n'
    + '**Total LTV - Spanish:** $' + report.totalSpanish.toFixed(2) + ' (' + report.countSpanish + ' payments)\n\n'
    + 'Total payments matched: ' + report.matchedMessages;
}

/** Discord embed (JSON) version — this is what actually gets sent now. */
function formatReportEmbed(report) {
  const totalAmount = report.totalEnglish + report.totalSpanish;
  return {
    title: 'Daily Payment Report — ' + report.date,
    color: 5763719,
    description:
      '**Total Payments:** $' + totalAmount.toFixed(2) + ' (' + report.matchedMessages + ' payments)\n'
      + '**Total LTV - English:** $' + report.totalEnglish.toFixed(2) + ' (' + report.countEnglish + ' payments)\n'
      + '**Total LTV - Spanish:** $' + report.totalSpanish.toFixed(2) + ' (' + report.countSpanish + ' payments)',
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  parsePaymentMessage: parsePaymentMessage,
  getSearchableText: getSearchableText,
  isSpanish: isSpanish,
  getTodayInTimezone: getTodayInTimezone,
  generateDailyReport: generateDailyReport,
  formatReport: formatReport,
  formatReportEmbed: formatReportEmbed,
};
