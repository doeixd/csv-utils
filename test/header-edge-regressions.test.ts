import { describe, it, expect, vi } from 'vitest';
import CSV, { CSVArrayUtils } from '../src';
import { createHeaderMapFns, objArrayToArray } from '../src/headers';
vi.unmock('csv');
vi.unmock('node:stream');

describe('header mapping edge cases', () => {
  it('fills configured array columns even when values or the array are missing', () => {
    const map = { values: { _type: 'targetArrayToCsv' as const, targetCsvColumns: ['A', 'B'], emptyCellOutput: 'missing' } };
    const rows = CSV.fromData([{ values: ['one'] }, { values: [] }, {}]);
    expect(rows.toString({ headerMap: map })).toBe('A,B\none,missing\nmissing,missing\nmissing,missing');
    expect(objArrayToArray(rows.toArray(), map, ['A', 'B'], true)).toEqual([
      ['A', 'B'], ['one', 'missing'], ['missing', 'missing'], ['missing', 'missing'],
    ]);
    expect(CSVArrayUtils.objArrayToArray(rows.toArray(), map, ['A', 'B'])).toEqual([
      ['one', 'missing'], ['missing', 'missing'], ['missing', 'missing'],
    ]);
  });

  it('fills only requested prefixed columns and handles large numeric suffixes', () => {
    const mapper = createHeaderMapFns({ values: { _type: 'targetArrayToCsv', targetCsvColumnPrefix: 'V', emptyCellOutput: '-' } });
    expect(mapper.toRowArr({ values: ['x'] }, ['V1', 'V999999999', 'V2'])).toEqual(['x', '-', '-']);
    expect(mapper.toRowArr({}, ['V1', 'V2'])).toEqual(['-', '-']);
  });

  it('maps special CSV header names without invoking prototype properties', () => {
    const headerMap = JSON.parse('{"__proto__":"first","constructor":"second"}');
    const mapper = createHeaderMapFns(headerMap);
    expect(mapper.fromRowArr(['a', 'b'], ['__proto__', 'constructor'])).toEqual({ first: 'a', second: 'b' });
    expect(createHeaderMapFns({ a: 'value' }).fromRowArr({ constructor: 'not a mapped column', a: 'x' })).toEqual({ value: 'x' });
    const writer = createHeaderMapFns({ values: { _type: 'targetArrayToCsv', targetCsvColumns: ['__proto__'] } });
    expect(writer.toRowArr({ values: ['ok'] }, ['__proto__'])).toEqual(['ok']);
  });

  it('handles numeric and named columns alongside array rules', () => {
    const rows = [{ id: 7, info: { name: 'A' }, tags: ['x'] }];
    const map = { id: 0, 'info.name': 'Name', tags: { _type: 'targetArrayToCsv' as const, targetCsvColumns: ['Tag', 'Other'], emptyCellOutput: '-' } };
    const expected = [[7, 'A', 'x', '-']];
    expect(objArrayToArray(rows, map, ['ID', 'Name', 'Tag', 'Other'])).toEqual(expected);
    expect(CSVArrayUtils.objArrayToArray(rows, map, ['ID', 'Name', 'Tag', 'Other'])).toEqual(expected);
  });
});
