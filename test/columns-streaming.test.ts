import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import CSV, { CSVStreamProcessor } from '../src';
import { castColumnType } from '../src/standalone';

vi.unmock('node:fs');
vi.unmock('node:path');
vi.unmock('node:stream');
vi.unmock('csv');

describe('column and streaming behavior', () => {
  it('preserves each row’s extra and symbol properties when reordering', () => {
    const symbol = Symbol('extra');
    const rows = [{ id: 1, name: 'first' }, { id: 2, name: 'second', extra: true, [symbol]: 'value' }];
    const result = CSV.fromData(rows).reorderColumns(['name', 'extra']).toArray();
    expect(Object.keys(result[0])).toEqual(['name', 'id']);
    expect(Object.keys(result[1])).toEqual(['name', 'extra', 'id']);
    expect(result[1].extra).toBe(true);
    expect(result[1][symbol]).toBe('value');
  });

  it('returns no unpivoted rows without value columns and an empty tail for zero', () => {
    const data = CSV.fromData([{ id: 1, value: 'a' }]);
    expect(data.tail(0).toArray()).toEqual([]);
    expect(data.unpivot(['id'], []).toArray()).toEqual([]);
    expect(data.unpivot([], []).toArray()).toEqual([]);
  });

  it('casts values while preserving other columns', () => {
    const values = [{ price: '3', id: 'A' }, { price: 'bad', id: 'B' }];
    expect(castColumnType(values, 'price', 'number')).toEqual([{ price: 3, id: 'A' }, { price: null, id: 'B' }]);
  });

  it('applies header mappings when writing a stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-stream-'));
    try {
      const file = join(dir, 'source.csv');
      const out = join(dir, 'output.csv');
      writeFileSync(file, 'id,name\n1,Alice\n2,Bob\n');
      await CSV.streamFromFile<{ id: string; name: string }>(file)
        .map(row => ({ id: row.id, profile: { name: row.name } }))
        .prepareToFile(out, { headerMap: { id: 'ID', 'profile.name': 'Name' } }).run();
      expect(readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trimEnd()).toBe('ID,Name\n1,Alice\n2,Bob');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes fixed-size array mappings and honors pipe end options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-stream-'));
    try {
      const file = join(dir, 'source.csv');
      const out = join(dir, 'output.csv');
      writeFileSync(file, 'id\n1\n2\n');
      const source = CSV.streamFromFile<{ id: string }>(file);
      await source.map(row => ({ id: row.id, values: [row.id, 'x'] }))
        .prepareToFile(out, { headerMap: { id: 'ID', values: { _type: 'targetArrayToCsv', targetCsvColumnPrefix: 'V', maxColumns: 2 } } }).run();
      expect(readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trimEnd()).toBe('ID,V1,V2\n1,1,x\n2,2,x');

      const rows: unknown[] = [];
      const destination = new Writable({ objectMode: true, write(row, _enc, callback) { rows.push(row); callback(); } });
      await source.preparePipeTo(destination, { end: false }).run();
      expect(rows).toEqual([{ id: '1' }, { id: '2' }]);
      expect(destination.writableEnded).toBe(false);
      destination.end();
      await expect(source.map(row => ({ values: [row.id] }))
        .prepareToFile(out, { headerMap: { values: { _type: 'targetArrayToCsv', targetCsvColumnPrefix: 'V' } } }).run())
        .rejects.toThrow('requires maxColumns');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves every row under backpressure and cancels upstream on early exit', async () => {
    const rows = Array.from({ length: 2500 }, (_, id) => ({ id }));
    const all = new CSVStreamProcessor(() => Readable.from(rows, { objectMode: true })).map(row => row);
    let count = 0;
    for await (const row of all) {
      expect(row.id).toBe(count++);
      if (count % 200 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    expect(count).toBe(rows.length);

    const input = Readable.from(rows, { objectMode: true });
    const partial = new CSVStreamProcessor(() => input).filter(() => true).map(row => row);
    for await (const _row of partial) break;
    await new Promise(resolve => setImmediate(resolve));
    expect(input.destroyed).toBe(true);
  });

  it('samples without changing the original rows', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const input = CSV.fromData([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
      expect(input.sample(2).toArray()).toEqual([{ n: 3 }, { n: 1 }]);
      expect(input.toArray()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    } finally { random.mockRestore(); }
  });
});
