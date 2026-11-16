import { describe, expect, it, vi } from 'vitest';
import CSV, { createHeaderMapFns } from '../src';
import { getPathValue, setPathValue, setPathValueCopy } from '../src/path-utils';
import os from 'node:os';
vi.unmock('csv');
vi.unmock('node:os');

describe('mapping and casting behavior under optimized paths', () => {
  it('preserves explicit order and optional regex-based sorting', () => {
    const row = { image_2: 'b', image_1: 'a', image_3: 'c' };
    const explicit = createHeaderMapFns({ images: { _type: 'csvToTargetArray', targetPath: 'images', sourceCsvColumns: ['image_3', 'image_1', 'image_2'] } });
    expect(explicit.fromRowArr(row)).toEqual({ images: ['c', 'a', 'b'] });
    const sorted = createHeaderMapFns({ images: { _type: 'csvToTargetArray', targetPath: 'images', sourceCsvColumns: ['image_3', 'image_1', 'image_2'], sourceCsvColumnPattern: /^image_(\d+)$/, sortSourceColumnsBy: match => Number(match[1]) } });
    expect(sorted.fromRowArr(row)).toEqual({ images: ['a', 'b', 'c'] });
  });

  it('preserves caster order and context for direct and nested fields', () => {
    const seen: Array<[string, number]> = [];
    const labelCaster = { test: () => true, parse: (value: string, ctx: any) => { seen.push([ctx.column, ctx.index]); return value.toUpperCase(); } };
    const scoreCaster = { test: () => true, parse: (value: string, ctx: any) => { seen.push([ctx.column, ctx.index]); return Number(value); } };
    const data = CSV.fromString('id,score,label\n1,3,foo', {
      headerMap: { id: 'id', score: 'profile.score', label: 'label' },
      customCasts: { columnCasts: { 'profile.score': scoreCaster, label: labelCaster } },
    });
    expect(data.toArray()).toEqual([{ id: '1', profile: { score: 3 }, label: 'FOO' }]);
    expect(seen).toEqual([['label', 2], ['profile.score', -1]]);
  });

  it('preserves input-column order with many configured casters', () => {
    const names = Array.from({ length: 12 }, (_, index) => `c${index}`);
    const seen: Array<[string, number]> = [];
    const caster = { test: () => true, parse: (value: string, ctx: any) => { seen.push([ctx.column, ctx.index]); return Number(value); } };
    const columnCasts = Object.fromEntries([...names].reverse().map(name => [name, caster]));
    const result = CSV.fromString(`${names.join(',')}\n${names.map((_, index) => index).join(',')}`, { customCasts: { columnCasts } });
    expect(seen).toEqual(names.map((name, index) => [name, index]));
    expect(Object.values(result.toArray()[0])).toEqual(names.map((_, index) => index));
  });

  it('keeps cached nested and bracket paths correct through eviction', () => {
    const row = { profile: { names: [{ value: 'first' }] } };
    expect(getPathValue(row, 'profile.names[0].value')).toBe('first');
    for (let i = 0; i < 600; i++) getPathValue(row, `unused${i}.value`);
    setPathValue(row, 'profile.names[0].value', 'updated');
    expect(getPathValue(row, 'profile.names[0].value')).toBe('updated');
    const copy = setPathValueCopy(row, 'profile.names[0].value', 'copy');
    expect(copy.profile.names[0].value).toBe('copy');
    expect(row.profile.names[0].value).toBe('updated');
    for (let i = 0; i < 2; i++) expect(() => setPathValue({}, '__proto__.polluted', true)).toThrow('Unsafe');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('returns the same best match as the full ranking, including ties and empty data', () => {
    const data = CSV.fromData([{ name: 'bat' }, { name: 'cat' }, { name: 'cut' }]);
    expect(data.findMostSimilarRow('hat', 'name')).toEqual(data.findSimilarRows('hat', 'name')[0]);
    expect(data.findMostSimilarRow('hat', 'name')?.row.name).toBe('bat');
    expect(CSV.fromData<{ name: string }>([]).findMostSimilarRow('hat', 'name')).toBeUndefined();
  });

  it('avoids CPU discovery when a worker sort cannot be used', async () => {
    const cpus = vi.spyOn(os, 'cpus');
    try {
      const data = CSV.fromData([{ value: 2 }, { value: 1 }]);
      expect((await data.sortByAsync('value')).toArray()).toEqual([{ value: 1 }, { value: 2 }]);
      expect((await data.sortByAsync((a, b) => a.value - b.value, 'asc', { workerThreshold: 0 })).toArray()).toEqual([{ value: 1 }, { value: 2 }]);
      expect(cpus).not.toHaveBeenCalled();
      await expect(data.sortByAsync('value', 'asc', { maxWorkers: 0 })).rejects.toThrow('maxWorkers');
    } finally { cpus.mockRestore(); }
  });
});
