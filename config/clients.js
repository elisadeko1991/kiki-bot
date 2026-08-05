// One entry per client. This is the whole "per-client agent" model:
// each client is isolated by (a) which Slack/Discord channel routes to them
// and (b) which mcpServers array gets sent to the API on their behalf.
//
// Add a new client by copying the "acme" block and changing the values.
// Nothing else in the codebase needs to change.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Simple in-memory cache so we don't re-read playbook files on every message.
// Restart the bot after editing a playbook to pick up changes.
const playbookCache = new Map();

function loadPlaybook(relativePath) {
  if (!relativePath) return '';
  if (playbookCache.has(relativePath)) return playbookCache.get(relativePath);
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    playbookCache.set(relativePath, content);
    return content;
  } catch (err) {
    console.warn(`[clients] Could not read playbook at ${relativePath}: ${err.message}`);
    return '';
  }
}

const clients = {
  agentleadlab: {
    label: 'Agent Lead Lab',

    systemPrompt: `Your name is Kiki. You are a technical assistant supporting Elisa's work for Agent Lead Lab (agentleadlab.com), a lead-generation company for life insurance agents.
You are NOT Agent Lead Lab's customer support — you support Elisa, the integrator who built and maintains their Make and Zapier automations.
Never identify yourself as Claude or Anthropic.
Follow the hard rules and escalation policy in the reference material below exactly — they are not suggestions.`,

    // Fill these in once the channels exist.
    slackChannelIds: [
      // 'C0123ABCDEF',
    ],
    discordChannelIds: [
      // '1526976343177170955',
    ],

    // Zapier + Make access — see .env.example for how tokens are generated.
    // Zapier's connect endpoint takes the token as a Bearer header.
    // Make's URL already has the token embedded in the path itself.
    mcpServers: [
      {
        type: 'url',
        url: process.env.AGENTLEADLAB_ZAPIER_MCP_URL,
        name: 'agentleadlab-zapier',
        authorization_token: process.env.AGENTLEADLAB_ZAPIER_MCP_TOKEN,
      },
      {
        type: 'url',
        url: process.env.AGENTLEADLAB_MAKE_MCP_URL,
        name: 'agentleadlab-make',
      },
    ],

    knowledgeFile: 'clients/agentleadlab/playbook.md',
  },

  acme: {
    // Shown to Claude as context, not shown to the end user
    label: 'Acme Corp',

    // The base behavior/rules. Client-specific facts and examples live in
    // the playbook file instead — see knowledgeFile below.
    systemPrompt: `You are the dedicated assistant for Acme Corp, operating under your company's brand (not identified as Claude or Anthropic to the client).
Be concise, professional, and only take actions using the tools you've been given.
If you're not confident about something, say so rather than guessing.
If asked to do something outside your access (e.g. an integration you don't have), say you'll flag it for a human on the team.`,

    // Optional: path (relative to project root) to a markdown file with
    // client-specific facts, tone examples, and escalation rules. This gets
    // appended to systemPrompt automatically. Edit the .md file to update
    // the agent's behavior without touching code.
    knowledgeFile: 'clients/acme/playbook.md',

    // Which channels route to this client's config.
    // Fill these in once the channels exist — see README for how to find IDs.
    slackChannelIds: [
      // 'C0123ABCDEF',
    ],
    discordChannelIds: [
      // '123456789012345678',
    ],

    // Tools this client's agent can use. Empty array = chat only, no tool access yet.
    // See README "Connecting client tools" before populating this.
    mcpServers: [
      // Example shape once you have a real MCP endpoint + token for this client:
      // {
      //   type: 'url',
      //   url: process.env.ACME_GMAIL_MCP_URL,
      //   name: 'acme-gmail',
      //   authorization_token: process.env.ACME_GMAIL_MCP_TOKEN,
      // },
    ],
  },

  // Add more clients here, e.g.:
  // globex: {
  //   label: 'Globex Inc',
  //   systemPrompt: `...`,
  //   slackChannelIds: [],
  //   discordChannelIds: [],
  //   mcpServers: [],
  // },
};

/** Find a client config by Slack channel ID. Returns undefined if none match. */
function getClientBySlackChannel(channelId) {
  return Object.values(clients).find((c) => c.slackChannelIds?.includes(channelId));
}

/** Find a client config by Discord channel ID. Returns undefined if none match. */
function getClientByDiscordChannel(channelId) {
  return Object.values(clients).find((c) => c.discordChannelIds?.includes(channelId));
}

/** Builds the full system prompt: base instructions + playbook file, if any. */
function getFullSystemPrompt(clientConfig) {
  const playbook = loadPlaybook(clientConfig.knowledgeFile);
  if (!playbook) return clientConfig.systemPrompt;
  return `${clientConfig.systemPrompt}\n\n---\nClient-specific reference material:\n\n${playbook}`;
}

module.exports = {
  clients,
  getClientBySlackChannel,
  getClientByDiscordChannel,
  getFullSystemPrompt,
};
