import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import CSV, { CSVStreamProcessor, csvBatchGenerator } from '../src';

vi.unmock('node:fs');
vi.unmock('node:path');
vi.unmock('node:stream');
vi.unmock('csv');

describe('combined CSV workflows', () => {
  it('reads nested data, casts and validates it, then writes and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const source = join(dir, 'source.csv');
      const output = join(dir, 'output.csv');
      writeFileSync(source, 'id,first,amount,tag1,tag2\n1,"Alice, A",10.5,red,blue\n2,Bob,invalid,green,\n3,Carol,5,yellow,orange\n');
      const inputMap = {
        id: 'id', first: 'profile.name', amount: 'profile.amount',
        _tags: { _type: 'csvToTargetArray' as const, targetPath: 'tags', sourceCsvColumns: ['tag1', 'tag2'], emptyValueStrategy: 'skip' as const },
      };
      const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: async (value: any) =>
        Number.isFinite(value.profile.amount) ? { value: { ...value, valid: true } } : { issues: [{ message: 'bad amount' }] },
      } };
      const users = await CSV.fromFileAsync(source, {
        headerMap: inputMap,
        customCasts: { columnCasts: { 'profile.amount': 'number' } },
        schema: { rowSchema, validationMode: 'filter', concurrency: 2 },
      });
      expect(users.toArray()).toEqual([
        { id: '1', profile: { name: 'Alice, A', amount: 10.5 }, tags: ['red', 'blue'], valid: true },
        { id: '3', profile: { name: 'Carol', amount: 5 }, tags: ['yellow', 'orange'], valid: true },
      ]);
      const writeMap = {
        id: 'ID', 'profile.name': 'Name', 'profile.amount': 'Amount',
        tags: { _type: 'targetArrayToCsv' as const, targetCsvColumns: ['Tag 1', 'Tag 2'], emptyCellOutput: '-' },
      };
      await users.writeToFileAsync(output, { headerMap: writeMap, stringifyOptions: { header: true, delimiter: ';' } });
      expect(readFileSync(output, 'utf8').trimEnd()).toBe('ID;Name;Amount;Tag 1;Tag 2\n1;Alice, A;10.5;red;blue\n3;Carol;5;yellow;orange');
      const back = await CSV.fromFileAsync(output, {
        csvOptions: { delimiter: ';' },
        headerMap: { ID: 'id', Name: 'profile.name', Amount: 'profile.amount', _tags: { _type: 'csvToTargetArray', targetPath: 'tags', sourceCsvColumns: ['Tag 1', 'Tag 2'] } },
        customCasts: { columnCasts: { 'profile.amount': 'number' } },
      });
      expect(back.toArray()).toEqual(users.toArray().map(({ valid, ...row }) => row));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('streams transformed rows into mapped output and batches the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const source = join(dir, 'source.csv');
      const output = join(dir, 'output.csv');
      writeFileSync(source, 'id,name,active\n1,Alice,yes\n2,Bob,no\n3,Carol,yes\n');
      await CSV.streamFromFile<{ id: string; name: string; active: string }>(source)
        .filter(async row => row.active === 'yes')
        .map(async row => ({ id: row.id, info: { name: row.name }, tags: [row.name, row.id] }))
        .prepareToFile(output, { headerMap: { id: 'ID', 'info.name': 'Name', tags: { _type: 'targetArrayToCsv', targetCsvColumns: ['Tag 1', 'Tag 2'] } } }).run();
      const batches = [];
      for await (const batch of csvBatchGenerator(output, { batchSize: 1, headerMap: { ID: 'id', Name: 'name', 'Tag 1': 'tag' } })) batches.push(batch);
      expect(batches).toEqual([[{ id: '1', name: 'Alice', tag: 'Alice' }], [{ id: '3', name: 'Carol', tag: 'Carol' }]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('combines streaming header maps, nested casts, async validation, filtering and output mapping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const input = join(dir, 'source.csv');
      const output = join(dir, 'output.csv');
      writeFileSync(input, 'id,amount\n1,3\n2,bad\n3,5\n');
      const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: async (row: any) =>
        Number.isFinite(row.profile.amount) ? { value: { ...row, doubled: row.profile.amount * 2 } } : { issues: [{ message: 'invalid amount' }] },
      } };
      await CSV.streamFromFile(input, {
        headerMap: { id: 'id', amount: 'profile.amount' },
        customCasts: { columnCasts: { 'profile.amount': 'number' } },
        schema: { rowSchema, validationMode: 'filter' },
      }).prepareToFile(output, { headerMap: { id: 'ID', 'profile.amount': 'Amount', doubled: 'Double' } }).run();
      expect(readFileSync(output, 'utf8').replace(/^\uFEFF/, '').trimEnd()).toBe('ID,Amount,Double\n1,3,6\n3,5,10');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('applies empty-value validation when it is the only fromStream option', async () => {
    const input = Readable.from(['id,name\n1,\n']);
    await expect(CSV.fromStream(input, { allowEmptyValues: false })).rejects.toThrow();
  });

  it('uses async validation by default for mapped and cast fromStream rows', async () => {
    const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: async (row: any) =>
      row.score > 0 ? { value: { ...row, doubled: row.score * 2 } } : { issues: [{ message: 'non-positive' }] },
    } };
    const result = await CSV.fromStream(Readable.from(['ID,Score\n1,4\n2,-1\n']), {
      headerMap: { ID: 'id', Score: 'score' },
      customCasts: { columnCasts: { score: 'number' } },
      schema: { rowSchema, validationMode: 'filter' },
    });
    expect(result.toArray()).toEqual([{ id: '1', score: 4, doubled: 8 }]);
    expect(result.validationResults?.map(item => item.valid)).toEqual([true, false]);
  });

  it('honors keep and error modes when streaming cast failures into validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const input = join(dir, 'source.csv');
      writeFileSync(input, 'id,amount\n1,3\n2,bad\n');
      const caster = { test: () => true, parse: (value: string) => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error('not a number');
        return number;
      } };
      const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: (row: any) =>
        row.amount === null ? { issues: [{ message: 'missing amount' }] } : { value: { ...row, valid: true } },
      } };
      const options = { customCasts: { columnCasts: { amount: caster }, onCastError: 'null' as const } };
      const kept = [];
      for await (const row of CSV.streamFromFile(input, { ...options, schema: { rowSchema, validationMode: 'keep' } })) kept.push(row);
      expect(kept).toEqual([{ id: '1', amount: 3, valid: true }, { id: '2', amount: null }]);
      const fail = CSV.streamFromFile(input, { ...options, schema: { rowSchema, validationMode: 'error' } }).prepareCollect();
      await expect(fail.run()).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('missing amount') }) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('propagates failures from asynchronous stream transforms through file writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const source = join(dir, 'source.csv');
      const output = join(dir, 'output.csv');
      writeFileSync(source, 'id\n1\n2\n3\n');
      const pipeline = CSV.streamFromFile<{ id: string }>(source).map(async row => {
        if (row.id === '2') throw new Error('bad row');
        return row;
      });
      await expect(pipeline.prepareToFile(output, { headerMap: { id: 'ID' } }).run()).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves boundary whitespace consistently across sync and async readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const file = join(dir, 'spaces.csv');
      const input = ' label,amount\n Alice, 12 \n';
      writeFileSync(file, input);
      const expected = [{ ' label': ' Alice', amount: ' 12 ' }];
      expect(CSV.fromString(input).toArray()).toEqual(expected);
      expect(CSV.fromFile(file).toArray()).toEqual(expected);
      expect((await CSV.fromFileAsync(file)).toArray()).toEqual(expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads BOM-prefixed files consistently and respects an explicit BOM override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const file = join(dir, 'bom.csv');
      const input = '\uFEFFid,name\n1,Alice\n';
      writeFileSync(file, input);
      expect(CSV.fromString(input).toArray()).toEqual([{ id: '1', name: 'Alice' }]);
      expect(CSV.fromFile(file).toArray()).toEqual([{ id: '1', name: 'Alice' }]);
      expect((await CSV.fromFileAsync(file)).toArray()).toEqual([{ id: '1', name: 'Alice' }]);
      const streamed = [];
      for await (const row of CSV.streamFromFile(file)) streamed.push(row);
      expect(streamed).toEqual([{ id: '1', name: 'Alice' }]);
      expect(CSV.fromString(input, { csvOptions: { bom: false } }).toArray()).toEqual([{ '\uFEFFid': '1', name: 'Alice' }]);
      expect(CSV.fromFile(file, { csvOptions: { bom: false } }).toArray()).toEqual([{ '\uFEFFid': '1', name: 'Alice' }]);
      expect((await CSV.fromFileAsync(file, { csvOptions: { bom: false } })).toArray()).toEqual([{ '\uFEFFid': '1', name: 'Alice' }]);
      const unstripped = [];
      for await (const row of CSV.streamFromFile(file, { csvOptions: { bom: false } })) unstripped.push(row);
      expect(unstripped).toEqual([{ '\uFEFFid': '1', name: 'Alice' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('round-trips a preamble, BOM, custom delimiter, and mapped nested values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-combined-'));
    try {
      const data = CSV.fromData([{ id: '1', profile: { name: 'Alice; A' } }]);
      const mapping = { id: 'ID', 'profile.name': 'Name' };
      const readMapping = { ID: 'id', Name: 'profile.name' };
      for (const mode of ['sync', 'async', 'stream'] as const) {
        const file = join(dir, `${mode}.csv`);
        const options = { additionalHeader: 'report\n', headerMap: mapping, stringifyOptions: { bom: true, header: true, delimiter: ';' } };
        if (mode === 'async') await data.writeToFileAsync(file, options);
        else if (mode === 'stream') await new CSVStreamProcessor(() => Readable.from(data.toArray())).prepareToFile(file, options).run();
        else data.writeToFile(file, options);
        expect(readFileSync(file, 'utf8')).toMatch(/^\uFEFFreport\nID;Name/);
        const result = CSV.fromFile(file, { saveAdditionalHeader: 1, csvOptions: { delimiter: ';' }, headerMap: readMapping });
        expect(result.toArray()).toEqual([{ id: '1', profile: { name: 'Alice; A' } }]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
