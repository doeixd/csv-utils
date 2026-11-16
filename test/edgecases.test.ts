import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import fs from 'fs';
import CSV, { StandardSchemaV1 } from '../src';
import { createHeaderMapFns, HeaderMap, CsvToArrayConfig } from '../src/headers';

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    existsSync: vi.fn(),
    mkdtempSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
    }
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  }
}));

const positiveNumberSchema: StandardSchemaV1<unknown, number> = {
  '~standard': {
    version: 1,
    vendor: 'edgecase-tests',
    types: { input: undefined as unknown, output: 0 as number },
    validate: (value: unknown) => {
      const numeric = Number(value);
      if (Number.isNaN(numeric) || numeric <= 0) {
        return { issues: [{ message: 'Must be a positive number' }] };
      }
      return { value: numeric };
    }
  }
};

describe('Edge Cases and Combined Features', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handles preamble + header map + custom casts + schema filtering together', () => {
    const csvContent = [
      '# Generated: 2026-02-05',
      '# Source: UnitTest',
      'user_id,first_name,score,active,tag_1,tag_2',
      '1,Ada,42,true,alpha,beta',
      '2,Grace,not_a_number,false,,',
      '3,Alan,7,true,gamma,'
    ].join('\n');

    vi.mocked(fs.readFileSync).mockReturnValueOnce(csvContent);

    const headerMap: HeaderMap<any> = {
      'user_id': 'id',
      'first_name': 'firstName',
      'score': 'score',
      'active': 'active',
      '_tags': {
        _type: 'csvToTargetArray',
        targetPath: 'tags',
        sourceCsvColumnPattern: /^tag_(\d+)$/,
        sortSourceColumnsBy: (match) => parseInt(match[1], 10),
        emptyValueStrategy: 'skip'
      } as CsvToArrayConfig
    };

    const csv = CSV.fromFile('edgecases.csv', {
      saveAdditionalHeader: true,
      csvOptions: { from_line: '3' },
      headerMap,
      customCasts: {
        definitions: {
          number: {
            test: (value) => !isNaN(parseFloat(value)),
            parse: (value) => parseFloat(value)
          },
          boolean: {
            test: (value) => value === 'true' || value === 'false',
            parse: (value) => value === 'true'
          }
        },
        columnCasts: {
          score: 'number',
          active: 'boolean'
        }
      },
      schema: {
        columnSchemas: { score: positiveNumberSchema },
        validationMode: 'filter'
      }
    });

    expect(csv.additionalHeader).toBe('# Generated: 2026-02-05\n# Source: UnitTest\n');

    const rows = csv.toArray();
    expect(rows).toEqual([
      { id: '1', firstName: 'Ada', score: 42, active: true, tags: ['alpha', 'beta'] },
      { id: '3', firstName: 'Alan', score: 7, active: true, tags: ['gamma'] }
    ]);
  });

  it('supports bracket path mapping for arrays in header map', () => {
    const headerMap: HeaderMap<any> = {
      'item_1': 'items[0].label',
      'item_2': 'items[1].label',
      'item_2_qty': 'items[1].qty'
    };

    const { fromRowArr, toRowArr } = createHeaderMapFns(headerMap);
    const mapped = fromRowArr({ item_1: 'apple', item_2: 'orange', item_2_qty: '3' });

    expect(mapped).toEqual({
      items: [
        { label: 'apple' },
        { label: 'orange', qty: '3' }
      ]
    });

    const headers = ['item_1', 'item_2', 'item_2_qty'];
    const row = toRowArr(mapped, headers);
    expect(row).toEqual(['apple', 'orange', '3']);
  });

  it('supports bracket path mapping with quoted keys', () => {
    const headerMap: HeaderMap<any> = {
      'weird_col': "meta['weird_key'].value",
      'plain_col': 'meta.plain'
    };

    const { fromRowArr, toRowArr } = createHeaderMapFns(headerMap);
    const mapped = fromRowArr({ weird_col: 'x', plain_col: 'y' });

    expect(mapped).toEqual({
      meta: {
        weird_key: { value: 'x' },
        plain: 'y'
      }
    });

    const headers = ['weird_col', 'plain_col'];
    const row = toRowArr(mapped, headers);
    expect(row).toEqual(['x', 'y']);
  });

  it('does not extract preamble unless from_line is set beyond 1', () => {
    const csvContent = [
      '# Comment',
      'id,name',
      '1,Ada'
    ].join('\n');

    vi.mocked(fs.readFileSync).mockReturnValueOnce(csvContent);

    const csv = CSV.fromFile('no-preamble.csv', {
      saveAdditionalHeader: true,
      csvOptions: { from_line: 1, comment: '#' }
    });

    expect(csv.additionalHeader).toBe('');
    expect(csv.toArray()).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('throws when empty values remain after casting and allowEmptyValues is false', () => {
    const csvContent = 'id,score\n1,\n2,5';

    expect(() => {
      CSV.fromString(csvContent, {
        customCasts: {
          columnCasts: {
            score: {
              test: () => true,
              parse: (value) => (value.trim() === '' ? null : Number(value))
            }
          }
        },
        allowEmptyValues: false
      });
    }).toThrow(/empty value found/);
  });
});
