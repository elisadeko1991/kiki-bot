require('dotenv').config();

async function fetchAllPayments() {
  const baseUrl = process.env.PAYRA_API_URL;
  const token = process.env.PAYRA_API_TOKEN;

  if (!baseUrl || !token) {
    throw new Error('Missing PAYRA_API_URL or PAYRA_API_TOKEN in environment.');
  }

  const allRecords = [];
  let updatedAfter = '1970-01-01T00:00:00.000Z';
  let previousCursor = null;
  const MAX_PAGES = 500;
  let page = 0;

  while (page < MAX_PAGES) {
    page = page + 1;

    const url = baseUrl + '?updated_after=' + encodeURIComponent(updatedAfter);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-access-token': token,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error('Payra API error ' + response.status + ': ' + errText);
    }

    const data = await response.json();
    const records = data.records || [];

    for (let i = 0; i < records.length; i++) {
      allRecords.push(records[i]);
    }

    const nextCursor = data.next_updated_after;

    if (records.length === 0 || !nextCursor || nextCursor === previousCursor) {
      break;
    }

    previousCursor = updatedAfter;
    updatedAfter = nextCursor;
  }

  return allRecords;
}

module.exports = { fetchAllPayments: fetchAllPayments };
