require('dotenv').config();
const { getFullSystemPrompt } = require('../config/clients');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

/**
 * Send a conversation to Claude on behalf of a specific client and get back
 * a plain-text reply. `history` is an array of { role: 'user'|'assistant', content: string }.
 * `clientConfig` supplies the system prompt (+ playbook) and the tools this client can use.
 */
async function askClaude({ history, clientConfig }) {
  const body = {
    model: MODEL,
    max_tokens: 1500,
    system: getFullSystemPrompt(clientConfig),
    messages: history,
  };

  if (clientConfig.mcpServers?.length) {
    // Only send connectors that actually have a URL configured — lets you
    // leave tool access unconfigured (or partially configured) without
    // breaking the bot. Add real URLs/tokens to .env whenever you're ready.
    const configuredServers = clientConfig.mcpServers.filter((server) => !!server.url);
    if (configuredServers.length) {
      body.mcp_servers = configuredServers;
    }
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      // Required header to use the mcp_servers connector feature:
      'anthropic-beta': 'mcp-client-2025-04-04',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // A response can contain multiple blocks (text, tool use, tool results).
  // For a chat bot we just want the text Claude wrote back.
  const textBlocks = data.content.filter((block) => block.type === 'text').map((block) => block.text);

  return textBlocks.join('\n\n').trim() || '(no text response)';
}

module.exports = { askClaude };
