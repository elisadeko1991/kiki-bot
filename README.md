# Custom AI Bot (Slack + Discord)

A single bot, running under your own name and branding, powered by the Claude API.
One config file maps channels to clients — each client gets its own system prompt,
conversation history, and (once wired up) its own tool access.

Neither the Slack nor the Discord side needs a public URL or webhook server — both
connect outbound (Slack via Socket Mode, Discord via its gateway), which is what
keeps hosting simple. See "Hosting" at the bottom.

## 1. Install

```bash
npm install
cp .env.example .env
```

## 2. Get a Claude API key

- Go to console.anthropic.com → API Keys → Create Key
- Put it in `.env` as `ANTHROPIC_API_KEY`
- This is billed pay-as-you-go by token — no Claude.ai subscription (Pro/Team/Enterprise)
  is needed for this bot to work.

## 3. Create the Slack app

1. Go to api.slack.com/apps → Create New App → From scratch
2. Name it whatever you want your clients to see (this is your custom branding)
3. **Socket Mode**: turn it on (Settings → Socket Mode). Generate an app-level token
   with the `connections:write` scope → this is `SLACK_APP_TOKEN`
4. **OAuth & Permissions**: add bot token scopes `chat:write`, `channels:history`,
   `channels:read`, `im:history`, `im:write`. Install to workspace → copy the
   `xoxb-...` Bot User OAuth Token → this is `SLACK_BOT_TOKEN`
5. **Event Subscriptions**: subscribe to bot events `message.channels` (and
   `message.im` if you want DMs to work)
6. Copy the Signing Secret from Basic Information → `SLACK_SIGNING_SECRET`
7. Invite the bot to each client's channel (`/invite @YourBotName`)

## 4. Create the Discord bot

1. Go to discord.com/developers/applications → New Application → name it
2. Bot tab → Add Bot → customize name/avatar here (this is your branding)
3. Enable **Message Content Intent** (Bot tab → Privileged Gateway Intents)
4. Copy the token → `DISCORD_BOT_TOKEN` in `.env`
5. OAuth2 → URL Generator → scope `bot`, permissions `Send Messages`, `Read Message History`
   → open the generated URL to invite it into each client's server

## 5. Map channels to clients

Edit `config/clients.js`. For each client, add their Slack channel ID
(right-click channel → View channel details) and/or Discord channel ID
(enable Developer Mode in Discord → right-click channel → Copy Channel ID)
under `slackChannelIds` / `discordChannelIds`.

The bot only responds in channels that are mapped. Anything unmapped is
ignored on purpose — that's the isolation boundary between clients.

## 6. Run it

```bash
npm start
```

Both bots start in one process if credentials for both are present in `.env`.
You can also run just one: `npm run start:slack` or `npm run start:discord`.

## Connecting client tools (Gmail, Make, Zapier)

Important distinction: the Gmail/Make/Zapier connectors you use inside
**claude.ai** are tied to your logged-in claude.ai account's own OAuth session —
they aren't reusable as-is from a raw API call like this bot makes. To give a
client's agent real tool access here, you have two paths:

- **Remote MCP servers with OAuth**: Zapier and Make both publish MCP server
  endpoints (you saw the Zapier one earlier) that support OAuth token auth.
  You'd complete that OAuth flow once per client, store the resulting token,
  and pass it in `clientConfig.mcpServers` (there's a commented example in
  `config/clients.js`).
- **Direct APIs**: for Gmail specifically, using the Gmail API directly with a
  service account or per-client OAuth token is often more reliable than going
  through MCP, since you get full control over scopes (read-only, send, etc.).

Either way, this is real per-client credential management — treat each
client's tokens as sensitive, store them in your host's secret manager (not
committed `.env` files), and default to read-only scopes unless a client's
workflow needs write access.

## Training / tuning the bot's behavior

There's no fine-tuning step here — you shape behavior through the prompt and
reference material, and it takes effect immediately (no retraining wait).

- **`systemPrompt`** in `config/clients.js` — the base rules: role, tone,
  tool-use boundaries, escalation policy. Keep this fairly stable per client.
- **`clients/<name>/playbook.md`** — the living document. Client-specific
  facts, known quirks, standing instructions, and 1-3 example exchanges
  showing the exact tone/format you want. This is what you'll actually edit
  week to week. Restart the bot after changing it (playbooks are cached).
- **Examples beat descriptions.** If a reply comes back wrong, the fastest
  fix is usually adding a short example of the right answer to the playbook,
  not writing a longer abstract rule.
- **Review real transcripts.** Once a client channel is live, periodically
  read back what the bot actually said. Patterns of mistakes go into the
  playbook as explicit rules or examples — that's the whole feedback loop.
- Add a playbook for a new client by creating `clients/<name>/playbook.md`
  and setting `knowledgeFile: 'clients/<name>/playbook.md'` in their config
  block.

## Real-time failure alerts (Zapier/Make → instant DM)

This is the actual "alert me in real time" piece — separate from the MCP
tool access above, and more reliable for this specific job, since it's
push-based instead of Kiki having to poll for errors.

### How it works
Kiki runs a small webhook endpoint (`/webhook/automation-error`). You
configure one small Zap and one Make error handler to POST to it the
moment something fails. Kiki DMs you immediately — no polling, no MCP
limitations, no delay.

### 1. Get your Discord user ID
In Discord: User Settings → Advanced → enable **Developer Mode**. Then
right-click your own name/profile anywhere → **Copy User ID**. Put this in
`.env` / Railway as `ELISA_DISCORD_USER_ID`.

### 2. Set a webhook secret
Put any random string in `.env` / Railway as `WEBHOOK_SECRET` — this is
yours to invent, not something Zapier/Make gives you. It's just there so
random internet traffic can't trigger fake alerts. A password generator
output works fine.

### 3. Expose the webhook publicly on Railway
1. Railway → your service → **Settings** → **Networking**
2. Click **Generate Domain** — Railway gives you a public URL like
   `https://kiki-bot-production.up.railway.app`
3. Your webhook endpoint is that domain + `/webhook/automation-error`,
   e.g. `https://kiki-bot-production.up.railway.app/webhook/automation-error`
4. Test it's reachable: visit `<your-domain>/webhook/health` in a browser —
   should show `{"status":"ok"}`

### 4. Zapier — create the alert Zap
1. New Zap → Trigger: search for **Zapier Manager** → event **New Zap Error**
   (fires whenever any Zap you own errors)
2. Action: **Webhooks by Zapier** → **POST**
3. URL: your webhook endpoint from step 3
4. Headers: add `x-webhook-secret` = the value you put in `WEBHOOK_SECRET`
5. Data (JSON body):
   ```json
   {
     "source": "zapier",
     "automation": "{{zap_title}}",
     "error": "{{error_message}}",
     "timestamp": "{{error_time}}"
   }
   ```
   (exact field names available depend on what Zapier Manager exposes —
   check the test data it pulls in and map accordingly)
6. Test the step, turn the Zap on

### 5. Make — attach an error handler per scenario
Make doesn't have one global "any scenario fails" trigger — error handling
is per-scenario. For each scenario you want monitored:
1. Open the scenario → right-click the module most likely to fail → **Add
   error handler**
2. Inside the error route, add a module: **HTTP → Make a request**
3. URL: your webhook endpoint
4. Method: POST, Headers: `x-webhook-secret` = your secret, Body type: JSON
   ```json
   {
     "source": "make",
     "automation": "<scenario name>",
     "error": "{{error message from the bundle}}",
     "timestamp": "{{now}}"
   }
   ```
5. Save, make sure the scenario is active

### 6. Test it for real
Temporarily break something on purpose (bad test data, disconnect a
connection briefly) to trigger a real error, and confirm the DM actually
arrives. Don't skip this — untested alerting is worse than no alerting,
since it creates false confidence.

## Hosting (simple options, cheapest first)


Since neither bot needs an inbound public URL, you just need something that
stays running 24/7 and can make outbound connections:

- **Railway or Render** — connect this repo, set the env vars in their
  dashboard, deploy as a "worker"/background service. No server management,
  free or ~$5/mo tier is enough for this workload.
- **Fly.io** — similar, slightly more control, still no ops overhead.
- **A cheap VPS** (Hetzner, DigitalOcean, ~$5/mo) — run with `pm2 start src/index.js`
  so it restarts automatically. More setup, but full control and easiest to
  scale if you add heavier per-client logic later.

Start with Railway or Render — you can be running in under 15 minutes, and
migrate to a VPS later only if you need to.
