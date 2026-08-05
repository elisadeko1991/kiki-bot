require('dotenv').config();

const PAGE_DELAY_MS = 150000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllPayments(onProgress) {
  const baseUrl = process.env.PAYRA_API_URL;
  const token = process.env.PAYRA_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Missing PAYRA_API_URL or PAYRA_API_TOKEN in environment.');
  }

  const allRecords = [];
  let cursor = new Date(0).toISOString();
  let previousCursor = null;
  const MAX_PAGES = 500;
  let page = 0;

  while (page < MAX_PAGES) {
    page = page + 1;

    const url = baseUrl + '?updated_after=' + encodeURIComponent(cursor);

    console.log('[payra] Fetching page ' + page + ': ' + url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-access-token': token,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[payra] Request failed. Status: ' + response.status + ' ' + response.statusText + '. Body: ' + errText + '. URL: ' + url);
      throw new Error('Payra API error ' + response.status + ' (' + response.statusText + '): ' + errText);
    }

    const data = await response.json();
    const records = data.records || [];

    console.log('[payra] Page ' + page + ' returned ' + records.length + ' records. records_matched=' + data.records_matched);

    for (let i = 0; i < records.length; i++) {
      allRecords.push(records[i]);
    }

    if (onProgress) {
      try {
        await onProgress(page, records.length, allRecords.length);
      } catch (progressErr) {
        console.error('[payra] onProgress callback error (non-fatal):', progressErr.message);
      }
    }

    const nextCursor = data.next_updated_after;

    if (records.length === 0 || !nextCursor || nextCursor === previousCursor) {
      break;
    }

    previousCursor = cursor;
    cursor = nextCursor;

    console.log('[payra] Waiting ' + (PAGE_DELAY_MS / 1000) + 's before next page...');
    await wait(PAGE_DELAY_MS);
  }

  return allRecords;
}

module.exports = { fetchAllPayments: fetchAllPayments };
