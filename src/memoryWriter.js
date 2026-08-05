require('dotenv').config();

const GITHUB_API_BASE = 'https://api.github.com';
const NOTES_HEADER = '## Learned notes (added via !remember)';

async function appendNoteToPlaybook(playbookPath, note) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    throw new Error('Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN in environment.');
  }

  const fileUrl = GITHUB_API_BASE + '/repos/' + owner + '/' + repo + '/contents/' + playbookPath + '?ref=' + branch;

  const getResponse = await fetch(fileUrl, {
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!getResponse.ok) {
    const errText = await getResponse.text();
    throw new Error('Failed to fetch current playbook: ' + getResponse.status + ' ' + errText);
  }

  const fileData = await getResponse.json();
  const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');

  let updatedContent;
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const newLine = '- [' + timestamp + '] ' + note;

  if (currentContent.includes(NOTES_HEADER)) {
    updatedContent = currentContent.trim() + '\n' + newLine + '\n';
  } else {
    updatedContent = currentContent.trim() + '\n\n' + NOTES_HEADER + '\n' + newLine + '\n';
  }

  const putResponse = await fetch(fileUrl.split('?')[0], {
    method: 'PUT',
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Add learned note via !remember',
      content: Buffer.from(updatedContent, 'utf8').toString('base64'),
      sha: fileData.sha,
      branch: branch,
    }),
  });

  if (!putResponse.ok) {
    const errText = await putResponse.text();
    throw new Error('Failed to update playbook: ' + putResponse.status + ' ' + errText);
  }

  return true;
}

module.exports = { appendNoteToPlaybook: appendNoteToPlaybook };
