require('dotenv').config();
const { extractJSON } = require('./extractor');
const { getExistingRows, needsEnrichment, updateRowEnrichment, appendRows } = require('./backfillSheet');

const ZELLE_CHANNEL_ID = '1263960214126854174';
const ZELLE_USER_ID = '1505731170585935872';
const CLIENT_SETUP_CHANNEL_ID = '1463959734687105096';

const ZELLE_EXTRACTION_PROMPT = 'Extract payment details from this Discord message as JSON with this exact shape: '
  + '{"customerName": string, "amount": number, "date": string in YYYY-MM-DD format or null, "productName": string or null}. '
  + 'customerName is the person or company who paid. amount is a plain number (no $ or commas). '
  + 'date is when the payment happened, converted to YYYY-MM-DD if given in a different format (e.g. "2026-08-16" as-is, or "8/16" assume year 2026). '
  + 'productName is a short description of what was purchased if mentioned (e.g. "aged leads", "100 aged leads"), otherwise null.';

const CLIENT_SETUP_EXTRACTION_PROMPT = 'Extract client setup details from this text as JSON with this exact shape: '
  + '{"name": string, "email": string or null, "packageSelected": string or null, "targetAreas": string or null, '
  + '"states": string or null, "numberOfLeads": string or null, "typesOfLeads": string or null, "startDate": string or null}. '
  + 'This text is messy and inconsistently formatted — the same field may appear under different labels or with no label at all. '
  + 'numberOfLeads and typesOfLeads are often combined in the raw text as one phrase like "25 Spanish OTP IUL" — split the leading '
  + 'number into numberOfLeads and the rest into typesOfLeads. startDate may appear as "Launch Date:", "launch date is", or similar '
  + 'phrasing — extract it as plain text (e.g. "August 17" or "Monday, August 17") without normalizing to a strict date format, '
  + 'since it is often approximate. If a field is genuinely not present anywhere in the text, use null.';

function normalizeNameForMatch(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function namesMatch(a, b) {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function findBestClientMatch(customerName, customerEmail, clientSetups) {
  if (customerEmail) {
    const emailMatch = clientSetups.find((c) => c.email && c.email.toLowerCase() === customerEmail.toLowerCase());
    if (emailMatch) return emailMatch;
  }
  if (customerName) {
    const nameMatch = clientSetups.find((c) => namesMatch(c.name, customerName));
    if (nameMatch) return nameMatch;
  }
  return null;
}

async function fetchAllChannelMessages(channel, onProgress) {
  const allMessages = [];
  let lastId = null;
  let batches = 0;
  const MAX_BATCHES = 200;

  while (batches < MAX_BATCHES) {
    batches = batches + 1;
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    messages.forEach((m) => {
      allMessages.push(m);
      lastId = m.id;
    });

    if (onProgress) {
      await onProgress(allMessages.length);
    }

    if (messages.size < 100) break;
  }

  return allMessages;
}

async function extractZellePayments(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(ZELLE_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, onProgress);

  const confirmedMessages = allMessages.filter((m) => {
    return m.author.id === ZELLE_USER_ID && m.content.includes('✅ Added to revenue');
  });

  const payments = [];
  for (let i = 0; i < confirmedMessages.length; i++) {
    const extracted = await extractJSON(ZELLE_EXTRACTION_PROMPT, confirmedMessages[i].content);
    if (extracted && extracted.customerName && extracted.amount != null) {
      payments.push(extracted);
    }
  }
  return payments;
}

async function extractClientSetups(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(CLIENT_SETUP_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, onProgress);

  const setupMessages = allMessages.filter((m) => {
    return m.embeds && m.embeds.length > 0 && m.embeds[0].title && m.embeds[0].title.indexOf('Agent Set Up') === 0;
  });

  const setups = [];
  for (let i = 0; i < setupMessages.length; i++) {
    const embed = setupMessages[i].embeds[0];
    const text = (embed.title || '') + '\n' + (embed.description || '');
    const extracted = await extractJSON(CLIENT_SETUP_EXTRACTION_PROMPT, text);
    if (extracted && extracted.name) {
      setups.push(extracted);
    }
  }
  return setups;
}

async function runBackfill(discordClient, dryRun, onProgress) {
  const report = { zellePaymentsFound: 0, clientSetupsFound: 0, rowsEnriched: 0, rowsAppended: 0, unmatchedZelle: [] };

  if (onProgress) await onProgress('Scanning Zelle payment channel...');
  const zellePayments = await extractZellePayments(discordClient, async (count) => {
    if (onProgress) await onProgress('Zelle channel: ' + count + ' messages scanned so far...');
  });
  report.zellePaymentsFound = zellePayments.length;

  if (onProgress) await onProgress('Found ' + zellePayments.length + ' confirmed Zelle payments. Scanning client setup channel...');
  const clientSetups = await extractClientSetups(discordClient, async (count) => {
    if (onProgress) await onProgress('Client setup channel: ' + count + ' messages scanned so far...');
  });
  report.clientSetupsFound = clientSetups.length;

  if (onProgress) await onProgress('Found ' + clientSetups.length + ' client setup records. Matching against existing sheet rows...');

  const existingRows = await getExistingRows();
  for (let i = 0; i < existingRows.length; i++) {
    const row = existingRows[i];
    if (!needsEnrichment(row)) continue;

    const match = findBestClientMatch(row.customerName, row.customerEmail, clientSetups);
    if (match) {
      if (!dryRun) {
        await updateRowEnrichment(row.rowNumber, match);
      }
      report.rowsEnriched = report.rowsEnriched + 1;
    }
  }

  const newRows = zellePayments.map((payment) => {
    const match = findBestClientMatch(payment.customerName, null, clientSetups);
    if (!match) report.unmatchedZelle.push(payment.customerName);
    return {
      timestamp: payment.date || '',
      customerName: payment.customerName,
      customerEmail: match ? match.email : '',
      amount: payment.amount,
      productName: payment.productName || '',
      status: 'Confirmed',
      paymentType: 'Zelle',
      packageSelected: match ? match.packageSelected : '',
      targetAreas: match ? match.targetAreas : '',
      states: match ? match.states : '',
      numberOfLeads: match ? match.numberOfLeads : '',
      typesOfLeads: match ? match.typesOfLeads : '',
      startDate: match ? match.startDate : '',
    };
  });

  if (!dryRun && newRows.length > 0) {
    await appendRows(newRows);
  }
  report.rowsAppended = newRows.length;
  report.newRowsPreview = newRows;

  return report;
}

module.exports = { runBackfill: runBackfill };
