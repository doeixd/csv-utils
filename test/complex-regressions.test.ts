import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import CSV, { createHeaderMapFns, csvGenerator, csvBatchGenerator } from '../src';
import { reduceAsync as standaloneReduceAsync } from '../src/standalone';

vi.unmock('node:fs');
vi.unmock('node:path');
vi.unmock('node:stream');
vi.unmock('csv');

describe('complex I/O and mapping regressions', () => {
  it('rejects prototype paths in scalar and array mappings', () => {
    expect(() => createHeaderMapFns({ a: '__proto__.csvPolluted' }).fromRowArr({ a: 'yes' })).toThrow();
    expect(() => createHeaderMapFns({ a: 'constructor.prototype.csvPolluted' }).fromRowArr({ a: 'yes' })).toThrow();
    const mapper = createHeaderMapFns({ config: { _type: 'csvToTargetArray', targetPath: '__proto__.csvPolluted', sourceCsvColumns: ['a'] } });
    expect(() => mapper.fromRowArr({ a: 'yes' })).toThrow();
    expect(({} as any).csvPolluted).toBeUndefined();
  });

  it('validates asynchronously and preserves rows in fromStream and fromFileAsync', async () => {
    const schema = { '~standard': { version: 1 as const, vendor: 'test', validate: async (value: any) => value.name === 'bad' ? { issues: [{ message: 'bad' }] } : { value } } };
    const options = { schema: { rowSchema: schema, useAsync: true, validationMode: 'filter' as const } };
    const csv = await CSV.fromStream(Readable.from(['name\nAlice\nbad\n']), options);
    expect(csv.toArray()).toEqual([{ name: 'Alice' }]);
    const dir = mkdtempSync(join(tmpdir(), 'csv-review-'));
    try {
      const file = join(dir, 'input.csv');
      writeFileSync(file, 'name\nAlice\nbad\n');
      const result = await CSV.fromFileAsync(file, { schema: { rowSchema: schema, validationMode: 'filter' } });
      expect(result.toArray()).toEqual([{ name: 'Alice' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects source stream and missing file errors', async () => {
    const failing = new Readable({ read() { this.destroy(new Error('source failed')); } });
    await expect(CSV.fromStream(failing)).rejects.toThrow('Failed to parse CSV stream');
    await expect(CSV.fromFileAsync(join(tmpdir(), 'csv-utils-missing-file-6b2d.csv'))).rejects.toThrow();
  });

  it('applies library options without explicit csvOptions', async () => {
    const csv = await CSV.fromStream(Readable.from(['name\nAlice\n']), { headerMap: { name: 'person' } });
    expect(csv.toArray()).toEqual([{ person: 'Alice' }]);
    const simple = await CSV.fromStream(Readable.from(['name\nAlice\n']), { columns: false });
    expect(simple.toArray()).toEqual([['name'], ['Alice']]);
  });

  it('completes synchronous writes even with the legacy streaming option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-review-'));
    try {
      const file = join(dir, 'output.csv');
      CSV.fromData([{ id: '1' }, { id: '2' }]).writeToFile(file, { streaming: true, streamingThreshold: 1, headerMap: { id: 'ID' } });
      expect(readFileSync(file, 'utf8')).toBe('ID\n1\n2');
      expect(() => CSV.fromData([{ id: 1 }]).writeToFile(join(dir, 'missing', 'out.csv'), { streaming: true, streamingThreshold: 0 })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reduces rows in order with the legacy mapreduce option', async () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const reducer = async (total: number, row: { n: number }) => total + row.n;
    expect(await CSV.fromData(rows).reduceAsync(reducer, 10, { strategy: 'mapreduce', batchSize: 2 })).toBe(16);
    expect(await standaloneReduceAsync(rows, reducer, 10, { strategy: 'mapreduce', batchSize: 2 })).toBe(16);
  });

  it('streams mapped rows and batches and handles early termination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-review-'));
    try {
      const file = join(dir, 'input.csv');
      writeFileSync(file, 'id,name\n1,A\n2,B\n3,C\n');
      const rows = [];
      for await (const row of csvGenerator(file, { headerMap: { id: 'key', name: 'label' } })) rows.push(row);
      expect(rows).toEqual([{ key: '1', label: 'A' }, { key: '2', label: 'B' }, { key: '3', label: 'C' }]);
      const batches = [];
      for await (const batch of csvBatchGenerator(file, { batchSize: 2 })) batches.push(batch);
      expect(batches.map(batch => batch.length)).toEqual([2, 1]);
      for await (const row of csvGenerator(file)) { expect(row.id).toBe('1'); break; }
      await expect(async () => { for await (const _ of csvGenerator(join(dir, 'missing.csv'))) { /* consume */ } }).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
