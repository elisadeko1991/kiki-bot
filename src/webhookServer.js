require('dotenv').config();
const express = require('express');
const { sendDirectMessage } = require('./discordBot');

/**
 * Starts a small HTTP server with one job: receive a POST from Zapier's or
 * Make's error-notification setup, and immediately DM Elisa on Discord.
 * This is push-based (the automation platform tells Kiki the moment
 * something fails) rather than Kiki having to poll for errors — which is
 * what actually delivers "real-time" alerting.
 */
function start() {
  const app = express();
  app.use(express.json());

  app.post('/webhook/automation-error', async (req, res) => {
    // Simple shared-secret check so random internet traffic can't spam DMs.
    // Zapier/Make send this as a header we configure on their end.
    const providedSecret = req.header('x-webhook-secret');
    if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
      console.warn('[webhook] Rejected request with missing/incorrect secret.');
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Expected payload shape (adjust field names to match what you send from
    // Zapier/Make — see README for exact setup):
    // { source: "zapier" | "make", automation: "New Lead -> CRM Sync", error: "...", timestamp: "..." }
    const { source, automation, error, timestamp } = req.body || {};

    if (!automation || !error) {
      console.warn('[webhook] Rejected malformed payload:', JSON.stringify(req.body));
      return res.status(400).json({ error: 'missing automation or error field' });
    }

    const platformLabel = source === 'make' ? 'Make' : source === 'zapier' ? 'Zapier' : 'An automation';
    const when = timestamp || new Date().toISOString();

    const message = `⚠️ ${platformLabel} automation failed\n\n**Automation:** ${automation}\n**Error:** ${error}\n**Time:** ${when}\n\nNot touching it — flagging for you.`;

    const sent = await sendDirectMessage(process.env.ELISA_DISCORD_USER_ID, message);

    if (sent) {
      return res.status(200).json({ status: 'delivered' });
    }
    // Still return 200 so Zapier/Make don't endlessly retry a delivery
    // failure that's actually a config problem on our end — but log it loudly.
    console.error('[webhook] Alert received but DM delivery failed — check ELISA_DISCORD_USER_ID and bot readiness.');
    return res.status(200).json({ status: 'received_but_delivery_failed' });
  });

  // Simple health check — useful for confirming the server is reachable at all.
  app.get('/webhook/health', (req, res) => res.status(200).json({ status: 'ok' }));

  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`⚡ Webhook server listening on port ${port}`);
  });
}

module.exports = { start };
