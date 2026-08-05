require('dotenv').config();

const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

// Start whichever platforms have credentials configured.
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  require('./slackBot').start();
} else {
  console.log('Skipping Slack bot — SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set.');
}

if (process.env.DISCORD_BOT_TOKEN) {
  require('./discordBot').start();
} else {
  console.log('Skipping Discord bot — DISCORD_BOT_TOKEN not set.');
}
