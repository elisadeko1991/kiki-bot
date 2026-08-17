/**
 * Standalone Google Sheets auth reproduction harness.
 *
 * Exercises the EXACT auth code path used by src/backfillSheet.js,
 * src/clientsSheet.js and src/googleSheets.js:
 *
 *     new google.auth.JWT(email, null, privateKey, [scope]).authorize()
 *
 * The `error:1E08010C:DECODER routines::unsupported` error is thrown during
 * LOCAL JWT signing (jws.sign -> crypto.createSign().sign(key)), BEFORE the
 * network POST to Google's token endpoint. So we can detect a key-decode
 * failure without valid Google credentials: if authorize() fails with a
 * DECODER error, signing broke; if it fails with an HTTP/network error from
 * Google, signing SUCCEEDED and the key decoded fine.
 *
 * Usage:
 *   node scripts/testSheetsAuth.js now      # authorize immediately
 *   node scripts/testSheetsAuth.js load     # saturate crypto+event loop first
 *   node scripts/testSheetsAuth.js delay    # wait, then authorize
 *   node scripts/testSheetsAuth.js loop 50  # authorize N times in a row
 */
require('dotenv').config();
const crypto = require('crypto');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const PLACEHOLDER = 'REPLACE_WITH_PRIVATE_KEY_ONE_LINE';

function resolveKey() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const looksReal = rawKey.includes('BEGIN') && rawKey.length > 200;
  if (looksReal) {
    return { source: '.env (real key)', email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: rawKey };
  }
  // Fall back to a throwaway, in-memory generated key so the crypto/signing
  // path can still be exercised. This will fail at Google's token endpoint
  // (expected) but proves whether LOCAL key decoding works.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = privateKey;
  return {
    source: 'THROWAWAY test key (env key is placeholder "' + PLACEHOLDER + '")',
    email: 'test@example.iam.gserviceaccount.com',
    key: key,
  };
}

function classify(err) {
  const msg = (err && err.message) || String(err);
  if (/DECODER routines|unsupported|1E08010C/i.test(msg)) return 'KEY_DECODE_FAILURE (the bug)';
  if (/ERR_OSSL|PEM|asn1|bad decrypt|wrong tag/i.test(msg)) return 'KEY_DECODE_FAILURE (openssl)';
  if (/invalid_grant|invalid_client|400|401|Invalid JWT|token|ENOTFOUND|network|getaddrinfo|ETIMEDOUT/i.test(msg)) {
    return 'SIGNING_OK (rejected downstream — key decoded fine)';
  }
  return 'OTHER: ' + msg;
}

async function authorizeOnce(email, key) {
  const privateKey = key.replace(/\\n/g, '\n'); // identical to the bot code
  const auth = new google.auth.JWT(email, null, privateKey, SCOPES);
  await auth.authorize();
  return 'AUTHORIZED (unexpected with throwaway key)';
}

// Simulate a long-running, loaded process: heavy concurrent crypto signing +
// event-loop saturation, similar to a bot doing lots of async work.
function heavyLoad(ms) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    let ops = 0;
    function burst() {
      for (let i = 0; i < 200; i++) {
        crypto.pbkdf2Sync('x' + i, 'salt', 100, 32, 'sha256');
        ops++;
      }
      if (Date.now() < end) setImmediate(burst);
      else resolve(ops);
    }
    // also fire concurrent async sign operations
    burst();
  });
}

async function main() {
  const mode = process.argv[2] || 'now';
  const { source, email, key } = resolveKey();
  console.log('=== Google Sheets auth repro ===');
  console.log('Node:', process.version, '| OpenSSL:', process.versions.openssl);
  console.log('google-auth-library:', require('google-auth-library/package.json').version);
  console.log('Key source:', source);
  console.log('Mode:', mode);
  console.log('');

  async function attempt(label) {
    const t0 = Date.now();
    try {
      const r = await authorizeOnce(email, key);
      console.log('[' + label + '] ' + r + ' (' + (Date.now() - t0) + 'ms)');
    } catch (err) {
      console.log('[' + label + '] result: ' + classify(err));
      console.log('           message: ' + (err.message || err));
    }
  }

  if (mode === 'now') {
    await attempt('immediate');
  } else if (mode === 'delay') {
    console.log('waiting 15s...');
    await new Promise((r) => setTimeout(r, 15000));
    await attempt('after-delay');
  } else if (mode === 'load') {
    console.log('running heavy concurrent crypto + event-loop load for 20s...');
    const ops = await heavyLoad(20000);
    console.log('load done (' + ops + ' pbkdf2 ops). Now authorizing...');
    await attempt('after-load');
  } else if (mode === 'loop') {
    const n = parseInt(process.argv[3] || '50', 10);
    for (let i = 0; i < n; i++) {
      // interleave load between attempts
      await heavyLoad(300);
      await attempt('loop-' + (i + 1));
    }
  }
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
