/**
 * Headless backfill runner. Runs the same three backfill steps the Discord
 * !backfill-* commands do, but from the terminal — useful for one-off or
 * scheduled runs. Credentials come from .env (the same as the bot); the key is
 * normalized/validated by src/googleAuth.
 *
 * Usage:
 *   npm run backfill            # all three steps (default)
 *   npm run backfill auth       # verify Google auth + sheet access only
 *   npm run backfill zelle      # step 1 only  (Zelle payments)
 *   npm run backfill clients    # step 2 only  (client setups)
 *   npm run backfill match      # step 3 only  (match + enrich, no Discord)
 */
require('dotenv').config();
const { verifyAuth, getSheetsClient } = require('../src/googleAuth');
const {
  runZelleBackfill,
  runClientsBackfill,
  runMatchBackfill,
} = require('../src/paymentBackfill');

const log = (s) => console.log('  ' + s);

async function bootDiscord() {
  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });
  await new Promise((resolve, reject) => {
    // 'ready' on discord.js v14; 'clientReady' once it moves to v15.
    client.once('ready', resolve);
    client.once('clientReady', resolve);
    client.login(process.env.DISCORD_BOT_TOKEN).catch(reject);
  });
  console.log('Discord connected as', client.user.tag);
  return client;
}

async function authGate() {
  try {
    await verifyAuth();
    console.log('Auth OK — service account:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  } catch (err) {
    console.error('Auth failed:', (err.message || err).split('\n')[0]);
    process.exit(2);
  }
  try {
    const sheets = getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, fields: 'properties.title' });
    console.log('Sheet OK —', '"' + meta.data.properties.title + '"');
  } catch (err) {
    console.error('Sheet access failed:', (err.message || err).split('\n')[0]);
    process.exit(3);
  }
}

async function main() {
  const mode = (process.argv[2] || 'full').toLowerCase();
  console.log('Backfill runner — mode:', mode);
  await authGate();
  if (mode === 'auth') return;

  let client = null;
  const needsDiscord = mode === 'full' || mode === 'zelle' || mode === 'clients';
  if (needsDiscord) client = await bootDiscord();

  try {
    if (mode === 'full' || mode === 'zelle') {
      console.log('\n=== STEP 1: Zelle payments -> "Backfill: Successful Payments & Clients" ===');
      const z = await runZelleBackfill(client, async (s) => log(s));
      console.log('STEP 1 done: found ' + z.found + ', wrote ' + z.written);
    }
    if (mode === 'full' || mode === 'clients') {
      console.log('\n=== STEP 2: Client setups -> "Backfill Clients" ===');
      const c = await runClientsBackfill(client, async (s) => log(s));
      console.log('STEP 2 done: found ' + c.found + ', wrote ' + c.written);
    }
    if (mode === 'full' || mode === 'match') {
      console.log('\n=== STEP 3: Match + enrich payment rows (batched writes) ===');
      const m = await runMatchBackfill(async (s) => log(s));
      console.log('STEP 3 done: ' + m.enriched + ' of ' + m.totalRows + ' rows enriched');
    }
  } finally {
    if (client) await client.destroy();
  }
  console.log('\nBackfill complete.');
}

main().catch((e) => { console.error('backfill crashed:', e); process.exit(1); });
