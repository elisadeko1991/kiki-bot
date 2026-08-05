require('dotenv').config();
const { google } = require('googleapis');

const SHEET_RANGE = "'Successful Payments'!A:M"; // Payment ID, External ID, Type, Sub Type, Display Name, Last 4, Total, Tip, Tax, Fee, Paid On, Status, Transaction Type
const HEADER_ROW = [
  'Payment ID',
  'External ID',
  'Payment Type',
  'Payment Sub Type',
  'Display Name',
  'Last 4',
  'Total',
  'Tip',
  'Tax',
  'Fee',
  'Paid On',
  'Status',
  'Transaction Type',
];

function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in environment.');
  }

  const privateKey = rawKey.replace(/\\n/g, '\n');

  return new google.auth.JWT(
    email,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function paymentToRow(payment) {
  return [
    payment._id || '',
    payment.external_id || '',
    payment.payment_type || '',
    payment.payment_sub_type || '',
    payment.display_name || '',
    payment.last_4 || '',
    payment.total || '',
    payment.tip || '',
    payment.tax || '',
    payment.fee || '',
    payment.paid_on || '',
    payment.status || '',
    payment.transaction_type || '',
  ];
}

async function appendNewPayments(payments) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    throw new Error('Missing GOOGLE_SHEET_ID in environment.');
  }

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: auth });

  const existingResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: SHEET_RANGE,
  });

  const existingRows = existingResponse.data.values || [];
  const hasHeader = existingRows.length > 0 && existingRows[0][0] === 'Payment ID';
  const dataRows = hasHeader ? existingRows.slice(1) : existingRows;

  const existingIds = new Set();
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (row[0]) existingIds.add(String(row[0]));
    if (row[1]) existingIds.add(String(row[1]));
  }

  const newPayments = payments.filter((payment) => {
    const idMatch = payment._id && existingIds.has(String(payment._id));
    const externalMatch = payment.external_id && existingIds.has(String(payment.external_id));
    return !idMatch && !externalMatch;
  });

  const rowsToAppend = newPayments.map(paymentToRow);

  if (existingRows.length === 0 && rowsToAppend.length > 0) {
    rowsToAppend.unshift(HEADER_ROW);
  }

  if (rowsToAppend.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowsToAppend },
    });
  }

  return {
    totalFetched: payments.length,
    added: newPayments.length,
    skippedDuplicates: payments.length - newPayments.length,
  };
}

module.exports = { appendNewPayments: appendNewPayments };
