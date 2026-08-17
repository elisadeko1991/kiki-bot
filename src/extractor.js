require('dotenv').config();

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

async function extractJSON(instructions, text) {
  const systemPrompt = instructions + '\n\nRespond with ONLY the JSON object — no markdown code fences, no explanation, no preamble.';

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Extraction API error ' + response.status + ': ' + errText);
  }

  const data = await response.json();
  const textBlocks = data.content.filter((block) => block.type === 'text').map((block) => block.text);
  let rawText = textBlocks.join('').trim();

  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(rawText);
  } catch (err) {
    console.error('[extractor] Failed to parse JSON from:', rawText.slice(0, 200));
    return null;
  }
}

module.exports = { extractJSON: extractJSON };
