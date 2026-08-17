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

/** True if two names plausibly refer to the same person/company. */
function namesMatch(a, b) {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Also match if one contains the other as whole words (handles "Jaden Doolittle" vs "Doolittle LLC" partially,
  // though company-vs-person matches like that will often need manual review regardless).
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

/**
 * Fetches full channel history (oldest to newest not required — we just
 * need everything), paginating backward from most recent.
 */
async function fetchAllChannelMessages(channel, onProgress) {
  const allMessages = [];
  let lastId = null;
  let batches = 0;
  const MAX_BATCHES = 200; // generous cap for "since the beginning" scans

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

/** Scans the Zelle channel and extracts every confirmed payment. */
async function extractZellePayments(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(ZELLE_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, async (count) => {
    if (onProgress) await onProgress('Zelle channel: ' + count + ' messages scanned so far...');
  });

  const confirmedMessages = allMessages.filter((m) => {
    return m.author.id === ZELLE_USER_ID && m.content.includes('✅ Added to revenue');
  });

  if (onProgress) await onProgress('Zelle: found ' + confirmedMessages.length + ' confirmed payment messages — extracting details now...');

  const payments = [];
  for (let i = 0; i < confirmedMessages.length; i++) {
    const extracted = await extractJSON(ZELLE_EXTRACTION_PROMPT, confirmedMessages[i].content);
    if (extracted && extracted.customerName && extracted.amount != null) {
      payments.push(extracted);
    }
    if (onProgress && (i + 1) % 5 === 0) {
      await onProgress('Zelle: extracted ' + (i + 1) + '/' + confirmedMessages.length + ' payments...');
    }
  }
  return payments;
}

/** Scans the client-setup channel and extracts every "Agent Set Up" record. */
async function extractClientSetups(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(CLIENT_SETUP_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, async (count) => {
    if (onProgress) await onProgress('Client setup channel: ' + count + ' messages scanned so far...');
  });

  const setupMessages = allMessages.filter((m) => {
    return m.embeds && m.embeds.length > 0 && m.embeds[0].title && m.embeds[0].title.indexOf('Agent Set Up') === 0;
  });

  if (onProgress) await onProgress('Client setups: found ' + setupMessages.length + ' setup messages — extracting details now...');

  const setups = [];
  for (let i = 0; i < setupMessages.length; i++) {
    const embed = setupMessages[i].embeds[0];
    const text = (embed.title || '') + '\n' + (embed.description || '');
    const extracted = await extractJSON(CLIENT_SETUP_EXTRACTION_PROMPT, text);
    if (extracted && extracted.name) {
      setups.push(extracted);
    }
    if (onProgress && (i + 1) % 5 === 0) {
      await onProgress('Client setups: extracted ' + (i + 1) + '/' + setupMessages.length + ' records...');
    }
  }
  return setups;
}

/**
 * Full pipeline: extract both sources, match, enrich existing sheet rows,
 * and append new rows for the Zelle payments. dryRun=true skips all writes
 * and just returns what would have happened.
 */
async function runBackfill(discordClient, dryRun, onProgress) {
  const report = { zellePaymentsFound: 0, clientSetupsFound: 0, rowsEnriched: 0, rowsAppended: 0, unmatchedZelle: [] };

  if (onProgress) await onProgress('Scanning Zelle payment channel...');
  const zellePayments = await extractZellePayments(discordClient, onProgress);
  report.zellePaymentsFound = zellePayments.length;

  if (onProgress) await onProgress('Found ' + zellePayments.length + ' confirmed Zelle payments. Scanning client setup channel...');
  const clientSetups = await extractClientSetups(discordClient, onProgress);
  report.clientSetupsFound = clientSetups.length;

  if (onProgress) await onProgress('Found ' + clientSetups.length + ' client setup records. Matching against existing sheet rows...');

  // 1. Enrich existing rows (manually-added Payra payments) that are missing package/lead details.
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

  // 2. Build and append brand-new rows for the Zelle payments.
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
