import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractReleaseNotes } from '../scripts/release-notes.cjs';

vi.unmock('node:fs');
vi.unmock('node:path');
vi.unmock('node:stream');

const sample = [
  '# Changelog',
  '## [3.0.0](https://example.com) (2026-01-01)',
  '### Breaking changes',
  '* First change',
  '```md',
  '### [not-a-release]',
  'EOF',
  '```',
  '### [2.9.1](https://example.com) (2025-12-01)',
  '### Bug Fixes',
  '* Patch change',
  '### [2.9.0](https://example.com) (2025-11-01)',
  '* Older change',
].join('\n');

describe('GitHub release notes', () => {
  it('extracts major and patch entries without including adjacent releases', () => {
    expect(extractReleaseNotes(sample, 'v3.0.0')).toBe('### Breaking changes\n* First change\n```md\n### [not-a-release]\nEOF\n```');
    expect(extractReleaseNotes(sample.replace(/\n/g, '\r\n'), 'v2.9.1')).toBe('### Bug Fixes\n* Patch change');
  });

  it('rejects missing, duplicate, and empty entries', () => {
    expect(() => extractReleaseNotes(sample, 'v9.0.0')).toThrow('found 0');
    expect(() => extractReleaseNotes('## [1.0.0]\nfirst\n## [1.0.0]\nsecond', 'v1.0.0')).toThrow('found 2');
    expect(() => extractReleaseNotes('### [1.0.0]\n\n## [0.9.0]\nold', 'v1.0.0')).toThrow('empty');
  });

  it('writes the current release notes as a multiline GitHub Actions output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-release-notes-'));
    const output = join(dir, 'output');
    try {
      const version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
      const expected = extractReleaseNotes(readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8'), version);
      execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'release-notes.cjs'), `v${version}`], { env: { ...process.env, GITHUB_OUTPUT: output } });
      const content = readFileSync(output, 'utf8');
      const [first] = content.split('\n');
      expect(first).toMatch(/^changelog<<release_notes_[a-f0-9]{32}$/);
      const delimiter = first.slice('changelog<<'.length);
      expect(content).toBe(`${first}\n${expected}\n${delimiter}\n`);
    } finally {
      unlinkSync(output);
      rmdirSync(dir);
    }
  });
});
