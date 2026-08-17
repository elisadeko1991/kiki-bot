require('dotenv').config();
const { getSheetsClient } = require('./googleAuth');

const TAB_NAME = 'Backfill Clients';
const FULL_RANGE = "'" + TAB_NAME + "'!A:H";

const HEADER_ROW = [
  'Name', 'Email', 'Package Selected', 'Target Areas for Marketing',
  'States', 'Number of Leads', 'Types of Leads', 'Start Date',
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See googleAuth.js — the key is validated/canonicalized once at first use, so
// this wrapper only guards against transient HTTP failures now, not decode errors.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('[clientsSheet] Call failed, retrying once in 5s:', err.message);
    await wait(5000);
    return await fn();
  }
}

async function appendClientRows(rows) {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const existingResponse = await withRetry(async () => {
    const sheets = getSheetsClient();
    return sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: FULL_RANGE });
  });
  const existingRows = existingResponse.data.values || [];

  const rowsToAppend = rows.map((r) => [
    r.name || '', r.email || '', r.packageSelected || '', r.targetAreas || '',
    r.states || '', r.numberOfLeads || '', r.typesOfLeads || '', r.startDate || '',
  ]);

  if (existingRows.length === 0 && rowsToAppend.length > 0) {
    rowsToAppend.unshift(HEADER_ROW);
  }

  if (rowsToAppend.length > 0) {
    await withRetry(async () => {
      const sheets = getSheetsClient();
      return sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: FULL_RANGE,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAppend },
      });
    });
  }

  return rowsToAppend.length;
}

async function getAllClientRows() {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const response = await withRetry(async () => {
    const sheets = getSheetsClient();
    return sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: FULL_RANGE });
  });

  const values = response.data.values || [];
  const hasHeader = values.length > 0 && values[0][0] === 'Name';
  const dataRows = hasHeader ? values.slice(1) : values;

  return dataRows.map((row) => {
    return {
      name: row[0] || '',
      email: row[1] || '',
      packageSelected: row[2] || '',
      targetAreas: row[3] || '',
      states: row[4] || '',
      numberOfLeads: row[5] || '',
      typesOfLeads: row[6] || '',
      startDate: row[7] || '',
    };
  });
}

module.exports = {
  appendClientRows: appendClientRows,
  getAllClientRows: getAllClientRows,
};
