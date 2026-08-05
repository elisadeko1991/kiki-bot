require('dotenv').config();
const express = require('express');
const { sendChannelMessage } = require('./discordBot');
const { clients } = require('../config/clients');

function start() {
  const app = express();
  app.use(express.json());

  const alertChannelId = clients.agentleadlab && clients.agentleadlab.discordChannelIds
    ? clients.agentleadlab.discordChannelIds[0]
    : undefined;

  app.post('/webhook/automation-error', async (req, res) => {
    const providedSecret = req.header('x-webhook-secret');
    if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
      console.warn('[webhook] Rejected request with missing/incorrect secret.');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const source = (req.body || {}).source;
    const automation = (req.body || {}).automation;
    const error = (req.body || {}).error;
    const timestamp = (req.body || {}).timestamp;
    const logUrl = (req.body || {}).logUrl;

    if (!automation || !error) {
      console.warn('[webhook] Rejected malformed payload:', JSON.stringify(req.body));
      return res.status(400).json({ error: 'missing automation or error field' });
    }

    var platformLabel = 'An automation';
    if (source === 'make') platformLabel = 'Make';
    if (source === 'zapier') platformLabel = 'Zapier';

    var when = timestamp || new Date().toISOString();
    var logLine = logUrl ? ('\n**Log:** ' + logUrl) : '';

    var message = '⚠️ ' + platformLabel + ' automation failed\n\n'
      + '**Automation:** ' + automation + '\n'
      + '**Error:** ' + error + '\n'
      + '**Time:** ' + when
      + logLine
      + '\n\nNot touching it — flagging for review.';

    const sent = await sendChannelMessage(alertChannelId, message);

    if (sent) {
      return res.status(200).json({ status: 'delivered' });
    }
    console.error('[webhook] Alert received but channel post failed — check discordChannelIds and bot readiness.');
    return res.status(200).json({ status: 'received_but_delivery_failed' });
  });

  app.get('/webhook/health', (req, res) => res.status(200).json({ status: 'ok' }));

  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log('⚡ Webhook server listening on port ' + port);
  });
}

module.exports = { start };
