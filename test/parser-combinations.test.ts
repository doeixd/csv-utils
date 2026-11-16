import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import CSV from '../src';

vi.unmock('node:fs');
vi.unmock('node:path');
vi.unmock('node:stream');
vi.unmock('csv');

describe('parser option and mapping combinations', () => {
  it('maps headerless indexed rows, casts nested values, and validates across readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combo-'));
    try {
      const content = '1,3\n2,5\n';
      const file = join(dir, 'data.csv');
      writeFileSync(file, content);
      const schema = { '~standard': { version: 1 as const, vendor: 'test', validate: (row: any) =>
        typeof row.metrics.score === 'number' ? { value: { ...row, doubled: row.metrics.score * 2 } } : { issues: [{ message: 'score must be a number' }] },
      } };
      const options = { csvOptions: { columns: false as const }, headerMap: { 0: 'id', 1: 'metrics.score' }, customCasts: { columnCasts: { 'metrics.score': 'number' as const } }, schema: { rowSchema: schema } };
      const expected = [{ id: '1', metrics: { score: 3 }, doubled: 6 }, { id: '2', metrics: { score: 5 }, doubled: 10 }];
      expect(CSV.fromString(content, options).toArray()).toEqual(expected);
      expect(CSV.fromFile(file, options).toArray()).toEqual(expected);
      expect((await CSV.fromStream(Readable.from([content]), options)).toArray()).toEqual(expected);
      expect((await CSV.fromFileAsync(file, options)).toArray()).toEqual(expected);
      const streamed = [];
      for await (const row of CSV.streamFromFile(file, options)) streamed.push(row);
      expect(streamed).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses explicitly supplied column names with header mapping across readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combo-'));
    try {
      const content = '1;Alice\n2;Bob\n';
      const file = join(dir, 'data.csv');
      writeFileSync(file, content);
      const options = { csvOptions: { columns: ['sourceId', 'sourceName'], delimiter: ';' }, headerMap: { sourceId: 'id', sourceName: 'user.name' } };
      const expected = [{ id: '1', user: { name: 'Alice' } }, { id: '2', user: { name: 'Bob' } }];
      expect(CSV.fromString(content, options).toArray()).toEqual(expected);
      expect(CSV.fromFile(file, options).toArray()).toEqual(expected);
      const streamed = [];
      for await (const row of CSV.streamFromFile(file, options)) streamed.push(row);
      expect(streamed).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats to_line as a physical line limit with multiline quoted records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combo-'));
    try {
      const content = 'id,description\n1,"first\nsecond"\n2,third\n3,fourth\n';
      const file = join(dir, 'data.csv');
      writeFileSync(file, content);
      const options = { csvOptions: { to_line: 3 }, headerMap: { id: 'id', description: 'description' } };
      const expected = [{ id: '1', description: 'first\nsecond' }];
      expect(CSV.fromString(content, options).toArray()).toEqual(expected);
      expect(CSV.fromFile(file, options).toArray()).toEqual(expected);
      expect((await CSV.fromFileAsync(file, options)).toArray()).toEqual(expected);
      const streamed = [];
      for await (const row of CSV.streamFromFile(file, options)) streamed.push(row);
      expect(streamed).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats from as a record limit rather than a line number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combo-'));
    try {
      const content = '1,"first\nsecond"\n2,third\n3,fourth\n';
      const file = join(dir, 'data.csv');
      writeFileSync(file, content);
      const options = { csvOptions: { columns: ['id', 'description'], from: 3 }, headerMap: { id: 'id', description: 'text' } };
      const expected = [{ id: '3', text: 'fourth' }];
      expect(CSV.fromString(content, options).toArray()).toEqual(expected);
      expect(CSV.fromFile(file, options).toArray()).toEqual(expected);
      expect((await CSV.fromFileAsync(file, options)).toArray()).toEqual(expected);
      const streamed = [];
      for await (const row of CSV.streamFromFile(file, options)) streamed.push(row);
      expect(streamed).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves a configured collect action through typed async transformations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combo-'));
    try {
      const file = join(dir, 'data.csv');
      writeFileSync(file, 'score\n2\n3\n');
      const collection = CSV.streamFromFile<{ score: string }>(file).prepareCollect()
        .addColumn('score', async row => Number(row.score))
        .filter(row => row.score > 2)
        .map(row => ({ result: row.score * 2 }));
      expect((await collection.run()).toArray()).toEqual([{ result: 6 }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
