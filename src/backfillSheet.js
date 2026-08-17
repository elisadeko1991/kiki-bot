require('dotenv').config();
const { getSheetsClient } = require('./googleAuth');

const TAB_NAME = 'Backfill: Successful Payments & Clients';
const FULL_RANGE = "'" + TAB_NAME + "'!A:P";
const ENRICHMENT_START_COL = 'K';

const HEADER_ROW = [
  'Timestamp', 'Customer Name', 'Customer Email', 'Customer Phone',
  'Amount', 'Fees', 'Net Amount', 'Product Name', 'Status', 'Payment Type',
  'Package Selected', 'Target Areas for Marketing', 'States',
  'Number of Leads', 'Types of Leads', 'Start Date',
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thin resilience wrapper for genuinely transient HTTP failures (5xx, socket
// resets). The private-key decode error this used to "retry" is now impossible
// at call time — googleAuth validates and canonicalizes the key up front — so
// there is nothing to mask here anymore.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('[backfillSheet] Call failed, retrying once in 5s:', err.message);
    await wait(5000);
    return await fn();
  }
}

async function getExistingRows() {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const response = await withRetry(async () => {
    const sheets = getSheetsClient();
    return sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: FULL_RANGE });
  });

  const values = response.data.values || [];
  const hasHeader = values.length > 0 && values[0][0] === 'Timestamp';
  const dataRows = hasHeader ? values.slice(1) : values;
  const headerOffset = hasHeader ? 2 : 1;

  return dataRows.map((row, index) => {
    return {
      rowNumber: headerOffset + index,
      timestamp: row[0] || '',
      customerName: row[1] || '',
      customerEmail: row[2] || '',
      packageSelected: row[10] || '',
      targetAreas: row[11] || '',
      states: row[12] || '',
      numberOfLeads: row[13] || '',
      typesOfLeads: row[14] || '',
      startDate: row[15] || '',
    };
  });
}

function needsEnrichment(row) {
  return !row.packageSelected && !row.targetAreas && !row.states && !row.numberOfLeads && !row.typesOfLeads && !row.startDate;
}

async function updateRowEnrichment(rowNumber, enrichment) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = "'" + TAB_NAME + "'!" + ENRICHMENT_START_COL + rowNumber + ':P' + rowNumber;

  await withRetry(async () => {
    const sheets = getSheetsClient();
    return sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          enrichment.packageSelected || '',
          enrichment.targetAreas || '',
          enrichment.states || '',
          enrichment.numberOfLeads || '',
          enrichment.typesOfLeads || '',
          enrichment.startDate || '',
        ]],
      },
    });
  });
}

async function appendRows(rows) {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const existingResponse = await withRetry(async () => {
    const sheets = getSheetsClient();
    return sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: FULL_RANGE });
  });
  const existingRows = existingResponse.data.values || [];

  const rowsToAppend = rows.map((r) => [
    r.timestamp || '', r.customerName || '', r.customerEmail || '', r.customerPhone || '',
    r.amount != null ? r.amount : '', r.fees || '', r.netAmount || '', r.productName || '',
    r.status || 'Confirmed', r.paymentType || '',
    r.packageSelected || '', r.targetAreas || '', r.states || '',
    r.numberOfLeads || '', r.typesOfLeads || '', r.startDate || '',
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

module.exports = {
  getExistingRows: getExistingRows,
  needsEnrichment: needsEnrichment,
  updateRowEnrichment: updateRowEnrichment,
  appendRows: appendRows,
};
