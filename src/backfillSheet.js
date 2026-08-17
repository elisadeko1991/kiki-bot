require('dotenv').config();
const { google } = require('googleapis');

const TAB_NAME = 'Backfill: Successful Payments & Clients';
const FULL_RANGE = "'" + TAB_NAME + "'!A:P";
const ENRICHMENT_START_COL = 'K';

const HEADER_ROW = [
  'Timestamp', 'Customer Name', 'Customer Email', 'Customer Phone',
  'Amount', 'Fees', 'Net Amount', 'Product Name', 'Status', 'Payment Type',
  'Package Selected', 'Target Areas for Marketing', 'States',
  'Number of Leads', 'Types of Leads', 'Start Date',
];

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.');
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');
  return new google.auth.JWT(email, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

async function getExistingRows() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: FULL_RANGE,
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
  const sheets = getSheetsClient();

  const range = "'" + TAB_NAME + "'!" + ENRICHMENT_START_COL + rowNumber + ':P' + rowNumber;

  await sheets.spreadsheets.values.update({
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
}

async function appendRows(rows) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = getSheetsClient();

  const existingResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: FULL_RANGE,
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
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: FULL_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowsToAppend },
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
