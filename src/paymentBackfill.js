require('dotenv').config();
const { extractJSON } = require('./extractor');
const { getExistingRows, needsEnrichment, updateRowEnrichmentBatch, appendRows } = require('./backfillSheet');
const { appendClientRows, getAllClientRows } = require('./clientsSheet');

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

// Format a Date as YYYY-MM-DD (local), matching the sheet's timestamp format.
function formatYMD(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

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

    if (onProgress) await onProgress(allMessages.length);
    if (messages.size < 100) break;
  }

  return allMessages;
}

/**
 * STEP 1: Scan the Zelle channel, extract each confirmed payment, and write
 * each one straight to "Backfill: Successful Payments & Clients" — no
 * matching, no dependency on the other channel. Fully independent.
 */
async function runZelleBackfill(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(ZELLE_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, async (count) => {
    if (onProgress) await onProgress('Zelle channel: ' + count + ' messages scanned so far...');
  });

  // Diagnostic counts, in case the filter still misses something unexpected —
  // shown in the final summary so we can see where messages are getting lost.
  const fromZelleUser = allMessages.filter((m) => m.author.id === ZELLE_USER_ID);
  const confirmedMessages = fromZelleUser.filter((m) => m.content.includes('Added to revenue'));

  if (onProgress) {
    await onProgress(
      'Diagnostic — total messages: ' + allMessages.length
      + ', from Zelle user: ' + fromZelleUser.length
      + ', containing "Added to revenue": ' + confirmedMessages.length
    );
  }

  if (onProgress) await onProgress('Found ' + confirmedMessages.length + ' confirmed Zelle payments — extracting and writing each one now...');

  let written = 0;
  for (let i = 0; i < confirmedMessages.length; i++) {
    const extracted = await extractJSON(ZELLE_EXTRACTION_PROMPT, confirmedMessages[i].content);
    if (!extracted || !extracted.customerName || extracted.amount == null) continue;

    // Zelle confirmations are posted when the payment is added to revenue, so
    // the message's sent date is the transaction date. Use it whenever the
    // extractor didn't pull an explicit date from the message text.
    const messageDate = formatYMD(confirmedMessages[i].createdAt);

    await appendRows([{
      timestamp: extracted.date || messageDate,
      customerName: extracted.customerName,
      amount: extracted.amount,
      productName: extracted.productName || '',
      status: 'Confirmed',
      paymentType: 'Zelle',
    }]);
    written = written + 1;

    if (onProgress && written % 3 === 0) {
      await onProgress('Zelle: ' + written + '/' + confirmedMessages.length + ' payments written to the sheet...');
    }
  }

  return { found: confirmedMessages.length, written: written };
}

/**
 * STEP 2: Scan the client-setup channel, extract each "Agent Set Up" record,
 * and write each one straight to the "Backfill Clients" tab. Independent —
 * doesn't touch the payments sheet at all.
 */
async function runClientsBackfill(discordClient, onProgress) {
  const channel = await discordClient.channels.fetch(CLIENT_SETUP_CHANNEL_ID);
  const allMessages = await fetchAllChannelMessages(channel, async (count) => {
    if (onProgress) await onProgress('Client setup channel: ' + count + ' messages scanned so far...');
  });

  const setupMessages = allMessages.filter((m) => {
    return m.embeds && m.embeds.length > 0 && m.embeds[0].title && m.embeds[0].title.indexOf('Agent Set Up') === 0;
  });

  if (onProgress) await onProgress('Found ' + setupMessages.length + ' client setup messages — extracting and writing each one now...');

  let written = 0;
  for (let i = 0; i < setupMessages.length; i++) {
    const embed = setupMessages[i].embeds[0];
    const text = (embed.title || '') + '\n' + (embed.description || '');
    const extracted = await extractJSON(CLIENT_SETUP_EXTRACTION_PROMPT, text);
    if (!extracted || !extracted.name) continue;

    await appendClientRows([extracted]);
    written = written + 1;

    if (onProgress && written % 3 === 0) {
      await onProgress('Client setups: ' + written + '/' + setupMessages.length + ' records written to the sheet...');
    }
  }

  return { found: setupMessages.length, written: written };
}

/**
 * STEP 3: Pure sheet-to-sheet matching — reads both tabs (no Discord
 * scanning, no Claude calls), matches payments to clients, and fills in the
 * enrichment columns on matching payment rows. Fast and safe to re-run.
 */
async function runMatchBackfill(onProgress) {
  if (onProgress) await onProgress('Reading client records from Backfill Clients...');
  const clientSetups = await getAllClientRows();

  if (onProgress) await onProgress('Found ' + clientSetups.length + ' client records. Reading payment rows...');
  const existingRows = await getExistingRows();

  // Collect all matches first (no API writes here), then flush them in one
  // batched request. Writing one request per row blows the Sheets
  // 60-per-minute write quota on a tab this large (~11k rows).
  const pending = [];
  for (let i = 0; i < existingRows.length; i++) {
    const row = existingRows[i];
    if (!needsEnrichment(row)) continue;

    const match = findBestClientMatch(row.customerName, row.customerEmail, clientSetups);
    if (match) {
      pending.push({ rowNumber: row.rowNumber, enrichment: match });
      if (onProgress && pending.length % 20 === 0) {
        await onProgress('Matched ' + pending.length + ' rows so far (checked ' + (i + 1) + '/' + existingRows.length + ')...');
      }
    }
  }

  if (onProgress) await onProgress('Found ' + pending.length + ' rows to enrich. Writing in batched requests...');
  await updateRowEnrichmentBatch(pending, onProgress);

  return { totalRows: existingRows.length, enriched: pending.length };
}

module.exports = {
  runZelleBackfill: runZelleBackfill,
  runClientsBackfill: runClientsBackfill,
  runMatchBackfill: runMatchBackfill,
};
