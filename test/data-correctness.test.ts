import { describe, it, expect, vi } from 'vitest';
import CSV, { CSVArrayUtils, CSVUtils } from '../src';
import { groupByField } from '../src/headers';
import { forEachAsync, mapAsync, merge } from '../src/standalone';

vi.unmock('node:stream');
vi.unmock('csv');

describe('data transformation correctness', () => {
  it('groups and pivots keys that are inherited object properties', () => {
    const rows = [{ key: '__proto__', column: 'constructor', value: 1 }, { key: 'toString', column: '__proto__', value: 2 }];
    const data = CSV.fromData(rows);
    expect(data.groupBy('key')['__proto__']).toEqual([rows[0]]);
    expect(data.groupBy('key').toString).toEqual([rows[1]]);
    expect(data.pivot('key', 'column', 'value')['__proto__'].constructor).toBe(1);
    expect(data.pivot('key', 'column', 'value').toString['__proto__']).toBe(2);
    expect(CSVArrayUtils.groupByField([{ n: 0 }, { n: false }, { n: '' }], 'n')['0']).toEqual([{ n: 0 }]);
    expect(groupByField(rows, 'key')['__proto__']).toEqual([rows[0]]);
  });

  it('deduplicates without conflating types, separators, or missing keys', () => {
    const rows = [
      { a: 1, b: 'x' }, { a: '1', b: 'x' },
      { a: 'x||::||y', b: 'z' }, { a: 'x', b: 'y||::||z' },
      { a: 1, b: 'x' },
    ];
    expect(CSV.fromData(rows).deduplicate(['a', 'b']).count()).toBe(4);
    expect(CSV.fromData([{ a: undefined }, {}]).deduplicate().count()).toBe(2);
  });

  it('aggregates large datasets without argument-count limits', () => {
    const data = CSV.fromData(Array.from({ length: 200_000 }, (_, n) => ({ n })));
    expect(data.aggregate('n', 'min')).toBe(0);
    expect(data.aggregate('n', 'max')).toBe(199_999);
    expect(data.aggregate('n', 'avg')).toBe(99_999.5);
  });

  it('preserves duplicate occurrences in merge input', () => {
    const right = { id: 1, right: true };
    const result = CSV.fromData([{ id: 1, left: true }]).mergeWith([right, right], (a, b) => a.id === b.id, a => a).toArray();
    expect(result).toEqual([{ id: 1, left: true }, right]);
    expect(CSVUtils.mergeRows([{ id: 1 }], [{ id: 2, other: true }], (a, b) => a.id === b.id, a => a)).toEqual([{ id: 1 }, { id: 2, other: true }]);
    expect(merge([{ id: 1 }], [{ id: 2, other: true }], (a, b) => a.id === b.id, a => a)).toHaveLength(2);
  });

  it('validates batch limits and preserves result order and indexes', async () => {
    const data = CSV.fromData([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
    await expect(data.mapAsync(async r => r.n, { batchSize: -1 })).rejects.toThrow('batchSize');
    await expect(data.forEachAsync(async () => {}, { batchConcurrency: 0 })).rejects.toThrow('batchConcurrency');
    await expect(forEachAsync([{ n: 1 }], async () => {}, { batchSize: 1.2 })).rejects.toThrow('batchSize');
    await expect(mapAsync([{ n: 1 }], async r => r.n, { batchSize: -1 })).rejects.toThrow('batchSize');
    expect(await data.mapAsync(async (r, i) => `${i}:${r.n}`, { batchSize: 2, batchConcurrency: 2 })).toEqual(['0:1','1:2','2:3','3:4','4:5']);
  });

  it('does not mutate source rows during sync or async schema validation', async () => {
    const original = [{ value: '3' }];
    const data = CSV.fromData(original);
    const column = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value: Number(value) }) } };
    const schema = { columnSchemas: { value: column } };
    expect(data.validate(schema).toArray()).toEqual([{ value: 3 }]);
    expect(data.toArray()).toEqual([{ value: '3' }]);
    expect((await data.validateAsync(schema)).toArray()).toEqual([{ value: 3 }]);
    expect(data.toArray()).toEqual([{ value: '3' }]);
    expect(original).toEqual([{ value: '3' }]);
  });

  it('sorts using closures and retains row identity when workers are used', async () => {
    const data = CSV.fromData([{ n: 2 }, { n: 3 }, { n: 1 }]);
    const original = data.toArray();
    const factor = -1;
    const closure = await data.sortByAsync((a, b) => (a.n - b.n) * factor, 'asc', { workerThreshold: 0, maxWorkers: 2 });
    expect(closure.toArray().map(row => row.n)).toEqual([3, 2, 1]);
    const warn = vi.spyOn(console, 'warn');
    try {
      const sorted = await data.sortByAsync('n', 'asc', { workerThreshold: 0, maxWorkers: 2 });
      expect(sorted.toArray()).toEqual([original[2], original[0], original[1]]);
      expect(sorted.toArray()[0]).toBe(original[2]);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
    await expect(data.sortByAsync('n', 'asc', { workerThreshold: 0, maxWorkers: -1 })).rejects.toThrow('maxWorkers');
  });
});
