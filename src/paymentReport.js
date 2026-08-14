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
    }
  }

  return text;
}

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

function getTodayInTimezone(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

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

function formatReport(report) {
  return '**Daily Payment Report — ' + report.date + '**\n\n'
    + '**Total LTV - English:** $' + report.totalEnglish.toFixed(2) + ' (' + report.countEnglish + ' payments)\n'
    + '**Total LTV - Spanish:** $' + report.totalSpanish.toFixed(2) + ' (' + report.countSpanish + ' payments)\n\n'
    + 'Total payments matched: ' + report.matchedMessages;
}

function formatReportEmbed(report) {
  return {
    title: 'Daily Payment Report — ' + report.date,
    color: 5763719,
    fields: [
      {
        name: 'Total LTV - English',
        value: '$' + report.totalEnglish.toFixed(2) + ' (' + report.countEnglish + ' payments)',
        inline: true,
      },
      {
        name: 'Total LTV - Spanish',
        value: '$' + report.totalSpanish.toFixed(2) + ' (' + report.countSpanish + ' payments)',
        inline: true,
      },
      {
        name: 'Total Payments Matched',
        value: String(report.matchedMessages),
        inline: false,
      },
    ],
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
