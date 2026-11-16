const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

function extractReleaseNotes(changelog, tag) {
  const version = tag.replace(/^v/, '');
  if (!version) throw new Error('A release version is required.');

  const lines = changelog.split(/\r?\n/);
  const headings = [];
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = lines[index].match(/^#{2,3}\s+\[([^\]]+)\](?:\([^)]*\))?(?:\s.*)?$/);
    if (heading) headings.push({ version: heading[1].replace(/^v/, ''), index });
  }
  const matches = headings.filter(heading => heading.version === version);
  if (matches.length !== 1) throw new Error(`Expected one changelog entry for ${version}; found ${matches.length}.`);
  const start = matches[0].index;
  const next = headings.find(heading => heading.index > start);
  const notes = lines.slice(start + 1, next ? next.index : lines.length).join('\n').trim();
  if (!notes) throw new Error(`Changelog entry for ${version} is empty.`);
  return notes;
}

if (require.main === module) {
  try {
    const notes = extractReleaseNotes(readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), process.argv[2] || '');
    if (process.env.GITHUB_OUTPUT) {
      const delimiter = `release_notes_${randomBytes(16).toString('hex')}`;
      appendFileSync(process.env.GITHUB_OUTPUT, `changelog<<${delimiter}\n${notes}\n${delimiter}\n`);
    } else {
      console.log(notes);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractReleaseNotes };
