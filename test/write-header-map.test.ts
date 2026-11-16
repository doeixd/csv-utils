import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('csv');
vi.unmock('node:stream');
import CSV from '../src';


describe('writing with header maps', () => {
  const users = CSV.fromData([
    { id: '1', profile: { firstName: 'John', lastName: 'Doe' }, tags: ['one', 'two'] },
    { id: '2', profile: { firstName: 'Jane', lastName: 'Smith' }, tags: ['three'] },
  ]);
  const headerMap = { id: 'ID', 'profile.firstName': 'First Name', 'profile.lastName': 'Last Name' };
  const expected = 'ID,First Name,Last Name\n1,John,Doe\n2,Jane,Smith';

  it('maps nested paths in strings and files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      const file = join(dir, 'users.csv');
      expect(users.toString({ headerMap })).toBe(expected);
      users.writeToFile(file, { headerMap });
      expect(readFileSync(file, 'utf8')).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects header order and combines scalar and array mappings', () => {
    expect(users.toString({
      headerMap: { id: 'ID', tags: { _type: 'targetArrayToCsv', targetCsvColumns: ['Tag 1', 'Tag 2'] } },
      stringifyOptions: { header: ['Tag 2', 'ID', 'Tag 1'] },
    })).toBe('two,1,one\n,2,three');
  });

  it('maps rows in asynchronous file writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      const file = join(dir, 'users.csv');
      await users.writeToFileAsync(file, { headerMap });
      expect(readFileSync(file, 'utf8').trimEnd()).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors CSV formatting options and escapes record delimiters', () => {
    const data = CSV.fromData([{ text: 'a;b', note: 'line\r\nbreak' }]);
    const options = {
      headerMap: { text: 'Text', note: 'Note' },
      stringifyOptions: { header: true, delimiter: ';', record_delimiter: '\r\n' },
    };
    const expectedOutput = 'Text;Note\r\n"a;b";"line\r\nbreak"';
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      const file = join(dir, 'formatted.csv');
      expect(data.toString(options)).toBe(expectedOutput);
      data.writeToFile(file, options);
      expect(readFileSync(file, 'utf8')).toBe(expectedOutput);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses explicit header order without emitting a header in async writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      const file = join(dir, 'ordered.csv');
      await users.writeToFileAsync(file, { headerMap, stringifyOptions: { header: ['Last Name', 'ID'] } });
      expect(readFileSync(file, 'utf8').trimEnd()).toBe('Doe,1\nSmith,2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses ordered headers without a map across string and file writers', async () => {
    const data = CSV.fromData([{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
    const stringifyOptions = { header: ['name', 'id'] };
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      const syncFile = join(dir, 'sync.csv');
      const asyncFile = join(dir, 'async.csv');
      expect(data.toString({ stringifyOptions }).trimEnd()).toBe('Alice,1\nBob,2');
      data.writeToFile(syncFile, { stringifyOptions });
      await data.writeToFileAsync(asyncFile, { stringifyOptions });
      expect(readFileSync(syncFile, 'utf8').trimEnd()).toBe('Alice,1\nBob,2');
      expect(readFileSync(asyncFile, 'utf8').trimEnd()).toBe('Alice,1\nBob,2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid mapping before opening an asynchronous output file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      await expect(users.writeToFileAsync(join(dir, 'missing', 'output.csv'), { headerMap: {} })).rejects.toThrow();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects asynchronous writes when mapping fails', async () => {
    const circular: any = {};
    circular.self = circular;
    const data = CSV.fromData([{ value: circular }]);
    const dir = mkdtempSync(join(tmpdir(), 'csv-utils-'));
    try {
      await expect(data.writeToFileAsync(join(dir, 'error.csv'), { headerMap: { value: 'Value' } })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});



