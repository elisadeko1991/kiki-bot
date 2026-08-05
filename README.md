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
