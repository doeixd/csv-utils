import { describe, it, expect, vi } from 'vitest';
import CSV from '../src';

vi.unmock('csv');
vi.unmock('node:stream');

describe('validation and casting behavior', () => {
  it('applies column transformations before sync and async row schemas', async () => {
    const column = { '~standard': { version: 1 as const, vendor: 'test', validate: (v: unknown) => ({ value: Number(v) }) } };
    const row = { '~standard': { version: 1 as const, vendor: 'test', validate: (v: any) => typeof v.amount === 'number' ? { value: { ...v, doubled: v.amount * 2 } } : { issues: [{ message: 'amount must be numeric' }] } } };
    const data = CSV.fromData([{ amount: '4' }]);
    const schema = { columnSchemas: { amount: column }, rowSchema: row };
    expect(data.validate(schema).toArray()).toEqual([{ amount: 4, doubled: 8 }]);
    expect((await data.validateAsync(schema)).toArray()).toEqual([{ amount: 4, doubled: 8 }]);
    expect(data.toArray()).toEqual([{ amount: '4' }]);
  });

  it('bounds async validation concurrency and preserves row order', async () => {
    let active = 0;
    let peak = 0;
    const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: async (row: any) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { value: row };
    } } };
    const data = CSV.fromData(Array.from({ length: 70 }, (_, id) => ({ id })));
    const result = await data.validateAsync({ rowSchema, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.toArray().map(row => row.id)).toEqual(Array.from({ length: 70 }, (_, id) => id));
    await expect(data.validateAsync({ rowSchema, concurrency: -1 })).rejects.toThrow('concurrency');
  });

  it('stops synchronous validation after the first failure in error mode', () => {
    let calls = 0;
    const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: () => { calls++; return { issues: [{ message: 'bad' }] }; } } };
    expect(() => CSV.fromData([{ id: 1 }, { id: 2 }]).validate({ rowSchema })).toThrow();
    expect(calls).toBe(1);
  });

  it('handles rejection from an async schema accidentally used synchronously', async () => {
    const rowSchema = { '~standard': { version: 1 as const, vendor: 'test', validate: async () => { throw new Error('async failed'); } } };
    expect(() => CSV.fromData([{ id: 1 }]).validate({ rowSchema })).toThrow('asynchronous');
    await new Promise(resolve => setImmediate(resolve));
  });

  it('casts nested mapped paths and keeps literal dotted headers distinct', () => {
    const csv = CSV.fromString('name,age\nAlice,42', {
      headerMap: { name: 'profile.name', age: 'profile.age' },
      customCasts: { columnCasts: { 'profile.age': 'number' } }
    });
    expect(csv.toArray()).toEqual([{ profile: { name: 'Alice', age: 42 } }]);
    const dotted = CSV.fromString('profile.age\n42', { customCasts: { columnCasts: { 'profile.age': 'number' } } });
    expect(dotted.toArray()).toEqual([{ 'profile.age': 42 }]);
  });

  it('trims string fields on later sparse rows and fills symbol keys', () => {
    const key = Symbol('value');
    const rows = [{ name: ' a ', [key]: null as number | null }, { name: 'b', extra: ' z ', [key]: 1 }];
    const csv = CSV.fromData(rows);
    expect(csv.trimWhitespace().toArray()[1].extra).toBe('z');
    expect(csv.fillMissingValues(key, 3).toArray()[0][key]).toBe(3);
    expect(() => CSV.fromData(null as any)).toThrow('Data must be an array');
  });
});
