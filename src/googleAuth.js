require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

/**
 * Single source of truth for Google service-account auth.
 *
 * WHY THIS EXISTS
 * ---------------
 * `error:1E08010C:DECODER routines::unsupported` is NOT a load, timing, or
 * concurrency problem — a valid key signs fine under arbitrary load, and the
 * short-lived !sync-payments path re-signs the same env key reliably for hours.
 * The error is thrown by OpenSSL exclusively when the private-key STRING handed
 * to the JWT signer is malformed at parse time. The common real-world causes
 * (verified by reproduction) are:
 *   - the value pasted into the host's env UI keeping its surrounding quotes
 *     (Railway does NOT strip quotes the way a .env file does),
 *   - "\n" escapes not converted to real newlines,
 *   - CRLF vs LF mismatches.
 *
 * The permanent fix is to normalize the key ONCE, then VALIDATE it up front via
 * crypto.createPrivateKey — which fails fast with a clear, actionable message at
 * startup instead of surfacing an opaque DECODER error deep inside a Sheets API
 * call after the process has been running for a while. Re-exporting the parsed
 * key yields a canonical PEM that OpenSSL is guaranteed to accept thereafter.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function normalizePrivateKey(raw) {
  let key = String(raw).trim();

  // Strip a single pair of surrounding quotes (Railway/host env-UI quirk).
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Convert escaped newlines (\r\n / \n) and any literal CRLF to plain LF.
  key = key
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  // Validate + canonicalize. Throws here (at startup / first use) with a clear
  // message if the key is genuinely unusable — instead of an opaque DECODER
  // error mid-request. A successful parse guarantees every later sign works.
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(key);
  } catch (err) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not a valid private key (' + err.message + '). ' +
      'Check the value in your host env vars: it must NOT be wrapped in quotes, ' +
      'must include the -----BEGIN/END PRIVATE KEY----- lines, and its newlines ' +
      'must be either real newlines or "\\n" escapes.'
    );
  }
  return keyObject.export({ type: 'pkcs8', format: 'pem' }).toString();
}

let cachedAuth = null;
let cachedSheets = null;

function getAuth() {
  if (cachedAuth) return cachedAuth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in environment.');
  }

  const privateKey = normalizePrivateKey(rawKey);
  cachedAuth = new google.auth.JWT(email, null, privateKey, SCOPES);
  return cachedAuth;
}

/** Returns a cached, ready-to-use Sheets v4 client backed by the validated key. */
function getSheetsClient() {
  if (cachedSheets) return cachedSheets;
  cachedSheets = google.sheets({ version: 'v4', auth: getAuth() });
  return cachedSheets;
}

/**
 * Optional startup self-check: validates the key and confirms the JWT can mint
 * an access token. Call once on boot to fail fast instead of on first backfill.
 */
async function verifyAuth() {
  await getAuth().authorize();
}

module.exports = {
  getSheetsClient: getSheetsClient,
  getAuth: getAuth,
  verifyAuth: verifyAuth,
  normalizePrivateKey: normalizePrivateKey,
};
