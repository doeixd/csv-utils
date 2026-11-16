import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import fs, { PathLike, ReadStream } from 'fs';
import path from 'path';
import * as os from 'os';
import CSV, {
  CSVError,
  CSVUtils,
  CSVArrayUtils,
  csvGenerator,
  csvBatchGenerator,
  writeCSVFromGenerator
} from '../src';
import { createHeaderMapFns } from '../src/headers';

// Mock fs for unit tests (integration tests will use real fs)
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

// Mock path for unit tests
vi.mock('path', () => ({
  default: {
    resolve: vi.fn((p) => p),
    join: vi.fn((dir, file) => `${dir}/${file}`),
  },
  resolve: vi.fn((p) => p),
  join: vi.fn((dir, file) => `${dir}/${file}`),
}));

  const mockCreateReadStreamImplementation = ((filename: string) => {
    const events: Record<string, any> = {};
    const mockStream = {
      pipe: vi.fn().mockReturnValue({
        on: vi.fn().mockImplementation((event, callback) => {
          events[event] = callback;
          return this;
        }),
        emit: vi.fn().mockImplementation((event, data) => {
          if (events[event]) events[event](data);
          return true;
        }),
        read: vi.fn().mockImplementation(() => {
          if (mockData.length > 0) {
            return mockData.shift();
          }
          return null;
        })
      }),
      on: vi.fn().mockImplementation((event, callback) => {
        events[event] = callback;
        return mockStream;
      }),
      emit: vi.fn().mockImplementation((event, data) => {
        if (events[event]) events[event](data);
        return true;
      })
    };
    
    // Simulate some data after a timeout
    const mockData = [
      { id: '1', name: 'Product A', price: '100' },
      { id: '2', name: 'Product B', price: '200' },
      { id: '3', name: 'Product C', price: '300' }
    ];
    
    setTimeout(() => {
      for (const item of mockData) {
        mockStream.emit('data', item);
      }
      mockStream.emit('end');
    }, 10);
    
    return mockStream;
  }) as unknown as typeof fs.createReadStream
  
  // Helper to collect generator outputs
  async function collectGenerator<T>(generator: AsyncGenerator<T, void, undefined>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of generator) {
      results.push(item);
    }
    return results;
  }
// Mocks are defined in setup.ts

describe('CSV Class', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const sampleData = [
    { id: '1', name: 'Product A', price: '100', inStock: 'true' },
    { id: '2', name: 'Product B', price: '200', inStock: 'false' },
    { id: '3', name: 'Product C', price: '300', inStock: 'true' }
  ];

  const csvContent = 'id,name,price,inStock\n1,Product A,100,true\n2,Product B,200,false\n3,Product C,300,true';

  describe('Static Factory Methods', () => {
    it('fromData creates a CSV instance', () => {
      const csv = CSV.fromData(sampleData);
      expect(csv.count()).toBe(3);
      expect(csv.toArray()).toEqual(sampleData);
    });

    it('fromFile reads and parses CSV file', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(csvContent);

      const csv = CSV.fromFile('test.csv');
      expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve('test.csv'), expect.anything());
      expect(csv.count()).toBe(3);
      expect(csv.toArray()).toEqual(sampleData);
    });

    it('fromFile throws CSVError on read failure', () => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error('File not found');
      });

      expect(() => CSV.fromFile('nonexistent.csv')).toThrow(CSVError);
    });

    it('fromString parses CSV string', () => {
      const csv = CSV.fromString(csvContent);
      expect(csv.count()).toBe(3);
      expect(csv.toArray()).toEqual(sampleData);
    });

    it('fromFile with header mapping transforms data', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(csvContent);
      
      const headerMap = {
        'id': 'productId',
        'name': 'productName',
        'price': 'cost',
        'inStock': 'available'
      };
      
      const expectedOutput = [
        { productId: '1', productName: 'Product A', cost: '100', available: 'true' },
        { productId: '2', productName: 'Product B', cost: '200', available: 'false' },
        { productId: '3', productName: 'Product C', cost: '300', available: 'true' }
      ];
      
      const csv = CSV.fromFile('test.csv', { headerMap });
      expect(csv.toArray()).toEqual(expectedOutput);
    });
    
    it('applies custom casting to CSV data', () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce(csvContent);
      
      const csv = CSV.fromFile('test.csv', {
        customCasts: {
          definitions: {
            number: {
              test: (value: string) => !isNaN(parseFloat(value)),
              parse: (value: string) => parseFloat(value)
            },
            boolean: {
              test: (value: string) => value.toLowerCase() === 'true' || value.toLowerCase() === 'false',
              parse: (value: string) => value.toLowerCase() === 'true'
            }
          },
          columnCasts: {
            'price': 'number',
            'inStock': 'boolean'
          }
        }
      });
      
      const data = csv.toArray();
      
      // Verify that the price is now a number and inStock is a boolean
      expect(typeof data[0].price).toBe('number');
      expect(data[0].price).toBe(100);
      expect(typeof data[0].inStock).toBe('boolean');
      expect(data[0].inStock).toBe(true);
    });
  });

  describe('Writing Methods', () => {
    it('writeToFile writes CSV to file', () => {
      const csv = CSV.fromData(sampleData);
      csv.writeToFile('output.csv');
      
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        'output.csv',
        expect.any(String),
        'utf-8'
      );
    });

    it('writeToFile with header mapping transforms output', () => {
      const csv = CSV.fromData(sampleData);
      
      const headerMap = {
        'id': 'Product ID',
        'name': 'Product Name',
        'price': 'Price',
        'inStock': 'Stock Status'
      };
      
      csv.writeToFile('output.csv', { headerMap });
      
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        'output.csv',
        expect.stringContaining('Product ID,Product Name,Price,Stock Status'),
        'utf-8'
      );
    });

    it('toString converts data to CSV string', () => {
      const csv = CSV.fromData([
        { id: '1', name: 'Test' }
      ]);
      
      const result = csv.toString();
      expect(result).toContain('id,name');
      expect(result).toContain('1,Test');
    });
  });

  describe('Query Methods', () => {
    const data = CSV.fromData([
      { id: '1', category: 'Electronics', price: '100', inStock: 'true' },
      { id: '2', category: 'Clothing', price: '50', inStock: 'true' },
      { id: '3', category: 'Electronics', price: '200', inStock: 'false' },
      { id: '4', category: 'Books', price: '30', inStock: 'true' }
    ]);
    
    it('findRow returns matching row', () => {
      const row = data.findRow('2', 'id');
      expect(row).toEqual({ id: '2', category: 'Clothing', price: '50', inStock: 'true' });
    });
    
    it('findRowWhere returns matching row', () => {
      const row = data.findRowWhere(item => item.price === '200');
      expect(row).toEqual({ id: '3', category: 'Electronics', price: '200', inStock: 'false' });
    });
    
    it('findRowsWhere returns matching rows', () => {
      const rows = data.findRowsWhere(item => item.category === 'Electronics');
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('1');
      expect(rows[1].id).toBe('3');
    });
    
    it('findRowByRegex returns matching row', () => {
      const row = data.findRowByRegex(/^[12]$/, 'id');
      expect(row).toEqual({ id: '1', category: 'Electronics', price: '100', inStock: 'true' });
    });
    
    it('groupBy groups rows by column', () => {
      const grouped = data.groupBy('category');
      expect(Object.keys(grouped)).toEqual(['Electronics', 'Clothing', 'Books']);
      expect(grouped['Electronics']).toHaveLength(2);
      expect(grouped['Clothing']).toHaveLength(1);
      expect(grouped['Books']).toHaveLength(1);
    });
  });

  describe('Transformation Methods', () => {
    const data = CSV.fromData([
      { id: '1', name: 'Product A', price: '100', inStock: 'true', status: 'Available' },
      { id: '2', name: 'Product B', price: '200', inStock: 'false' },
      { id: '3', name: 'Product C', price: '300', inStock: 'true' }
    ]);
    
    it('update applies changes to all rows', () => {
      const updated = data.update<Record<string, any>>({ currency: 'USD' });
      expect(updated.toArray()[0]).toHaveProperty('currency', 'USD');
      expect(updated.count()).toBe(3);
    });
    
    it('updateWhere applies changes to matching rows', () => {
      const updated = data.updateWhere(
        row => row.inStock === 'true',
        { status: 'Available' }
      );
      
      const available = updated.findRowsWhere(row => row.status === 'Available');
      expect(available).toHaveLength(2);
      expect(available[0].id).toBe('1');
      expect(available[1].id).toBe('3');
      
      const unavailable = updated.findRow('2', 'id');
      expect(unavailable).not.toHaveProperty('status');
    });
    
    it('updateColumn updates specific column', () => {
      const updated = data.updateColumn('price', value => `$${value}`);
      expect(updated.toArray()[0].price).toBe('$100');
      expect(updated.toArray()[1].price).toBe('$200');
      expect(updated.toArray()[2].price).toBe('$300');
    });
    
    it('transform converts rows to new format', () => {
      interface SimplifiedProduct {
        productId: string;
        displayName: string;
      }
      
      const transformed = data.transform<SimplifiedProduct>(row => ({
        productId: row.id,
        displayName: `${row.name} ($${row.price})`
      }));
      
      expect(transformed.toArray()[0]).toEqual({
        productId: '1',
        displayName: 'Product A ($100)'
      });
    });
    
    it('removeWhere removes matching rows', () => {
      const filtered = data.removeWhere(row => row.inStock === 'false');
      expect(filtered.count()).toBe(2);
      expect(filtered.toArray()[0].id).toBe('1');
      expect(filtered.toArray()[1].id).toBe('3');
    });
    
    it('append adds new rows', () => {
      const newRow = { id: '4', name: 'Product D', price: '400', inStock: 'true' };
      const expanded = data.append(newRow);
      
      expect(expanded.count()).toBe(4);
      expect(expanded.toArray()[3]).toEqual(newRow);
    });
    
    it('sortBy sorts rows by column', () => {
      const sorted = data.sortBy('price', 'desc');
      expect(sorted.toArray()[0].price).toBe('300');
      expect(sorted.toArray()[1].price).toBe('200');
      expect(sorted.toArray()[2].price).toBe('100');
    });
  });

  describe('Aggregation Methods', () => {
    const numericalData = CSV.fromData([
      { id: '1', value: 10, category: 'A' },
      { id: '2', value: 20, category: 'B' },
      { id: '3', value: 30, category: 'A' },
      { id: '4', value: 40, category: 'C' }
    ]);
    
    it('aggregate calculates sum correctly', () => {
      const sum = numericalData.aggregate('value', 'sum');
      expect(sum).toBe(100);
    });
    
    it('aggregate calculates average correctly', () => {
      const avg = numericalData.aggregate('value', 'avg');
      expect(avg).toBe(25);
    });
    
    it('aggregate finds minimum correctly', () => {
      const min = numericalData.aggregate('value', 'min');
      expect(min).toBe(10);
    });
    
    it('aggregate finds maximum correctly', () => {
      const max = numericalData.aggregate('value', 'max');
      expect(max).toBe(40);
    });
    
    it('aggregate counts correctly', () => {
      const count = numericalData.aggregate('value', 'count');
      expect(count).toBe(4);
    });
    
    it('distinct returns unique values', () => {
      const categories = numericalData.distinct('category');
      expect(categories).toHaveLength(3);
      expect(categories).toContain('A');
      expect(categories).toContain('B');
      expect(categories).toContain('C');
    });
    
    it('pivot creates pivot table', () => {
      const pivotData = CSV.fromData([
        { product: 'A', month: 'Jan', sales: 100 },
        { product: 'A', month: 'Feb', sales: 120 },
        { product: 'B', month: 'Jan', sales: 200 },
        { product: 'B', month: 'Feb', sales: 240 }
      ]);
      
      const pivoted = pivotData.pivot('product', 'month', 'sales');
      expect(pivoted['A']['Jan']).toBe(100);
      expect(pivoted['A']['Feb']).toBe(120);
      expect(pivoted['B']['Jan']).toBe(200);
      expect(pivoted['B']['Feb']).toBe(240);
    });
  });

  describe('Utility Methods', () => {
    const data = CSV.fromData(sampleData);
    
    it('count returns correct row count', () => {
      expect(data.count()).toBe(3);
    });
    
    it('toArray returns copy of data', () => {
      const array = data.toArray();
      expect(array).toEqual(sampleData);
      expect(array).not.toBe(sampleData); // Should be a copy
    });
    
    it('getBaseRow creates empty template row', () => {
      const baseRow = data.getBaseRow();
      expect(Object.keys(baseRow)).toEqual(['id', 'name', 'price', 'inStock']);
      expect(baseRow.id).toBeUndefined();
      expect(baseRow.name).toBeUndefined();
    });
    
    it('createRow creates new row with defaults', () => {
      const newRow = data.createRow({ id: '4', name: 'Product D' });
      expect(newRow).toEqual({
        id: '4',
        name: 'Product D',
        price: undefined,
        inStock: undefined
      });
    });
    
    it('head returns first n rows', () => {
      expect(data.head(2).count()).toBe(2);
      expect(data.head(2).toArray()[0].id).toBe('1');
      expect(data.head(2).toArray()[1].id).toBe('2');
    });
    
    it('tail returns last n rows', () => {
      expect(data.tail(2).count()).toBe(2);
      expect(data.tail(2).toArray()[0].id).toBe('2');
      expect(data.tail(2).toArray()[1].id).toBe('3');
    });
    
    it('sample returns random sample', () => {
      const sampled = data.sample(2);
      expect(sampled.count()).toBe(2);
    });
    
    it('mergeWith merges with another dataset', () => {
      const datasetA = CSV.fromData([
        { id: '1', name: 'Product A', stock: 10 },
        { id: '2', name: 'Product B', stock: 20 }
      ]);
      
      const datasetB = [
        { id: '2', name: 'Product B', price: 200 },
        { id: '3', name: 'Product C', price: 300 }
      ];
      
      const merged = datasetA.mergeWith(
        datasetB,
        (a, b) => a.id === b.id,
        (a, b) => ({ ...a, ...b })
      );
      
      expect(merged.count()).toBe(3);
      expect(merged.findRow('1', 'id')).toEqual({ id: '1', name: 'Product A', stock: 10 });
      expect(merged.findRow('2', 'id')).toEqual({ id: '2', name: 'Product B', stock: 20, price: 200 });
      expect(merged.findRow('3', 'id')).toEqual({ id: '3', name: 'Product C', price: 300 });
    });
  });
  
  describe('Iteration Methods', () => {
    const data = CSV.fromData(sampleData);
    
    it('forEach iterates over rows', () => {
      const ids: string[] = [];
      data.forEach((row) => {
        ids.push(row.id);
      });
      
      expect(ids).toEqual(['1', '2', '3']);
    });
    
    it('map transforms rows', () => {
      const names = data.map(row => row.name);
      expect(names).toEqual(['Product A', 'Product B', 'Product C']);
    });
    
    it('reduce aggregates values', () => {
      const concatenated = data.reduce(
        (result, row) => result + row.name.charAt(row.name.length - 1),
        ''
      );
      
      expect(concatenated).toBe('ABC');
    });
    
    it('forEachAsync processes rows asynchronously', async () => {
      const ids: string[] = [];
      await data.forEachAsync(async (row) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        ids.push(row.id);
      });
      
      expect(ids).toEqual(['1', '2', '3']);
    });
    
    it('mapAsync transforms rows asynchronously', async () => {
      const result = await data.mapAsync(async (row) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return `${row.name}: $${row.price}`;
      });
      
      expect(result).toEqual([
        'Product A: $100',
        'Product B: $200',
        'Product C: $300'
      ]);
    });
    
    it('reduceAsync aggregates values asynchronously', async () => {
      const total = await data.reduceAsync(
        async (sum, row) => {
          await new Promise(resolve => setTimeout(resolve, 1));
          return sum + parseInt(row.price);
        },
        0
      );
      
      expect(total).toBe(600);
    });
  });
});

describe('Header Mapping Functions', () => {
  it('createHeaderMapFns creates mapping functions', () => {
    interface User {
      id: string;
      profile: {
        firstName: string;
        lastName: string;
      };
    }
    
    const headerMap = {
      'user_id': 'id',
      'first_name': 'profile.firstName',
      'last_name': 'profile.lastName'
    };
    
    const { fromRowArr, toRowArr } = createHeaderMapFns<User>(headerMap);
    
    // Test fromRowArr
    const row = { user_id: '123', first_name: 'John', last_name: 'Doe' };
    const user = fromRowArr(row);
    
    expect(user).toEqual({
      id: '123',
      profile: {
        firstName: 'John',
        lastName: 'Doe'
      }
    });
    
    // Test toRowArr
    const headers = ['user_id', 'first_name', 'last_name'];
    const rowArray = toRowArr(user, headers);
    
    expect(rowArray).toEqual(['123', 'John', 'Doe']);
  });
  
  it('createHeaderMapFns handles index-based mapping', () => {
    interface Product {
      id: string;
      name: string;
      details: {
        price: number;
        stock: number;
      };
    }
    
    const headerMap = {
      0: 'id',
      1: 'name',
      2: 'details.price',
      3: 'details.stock'
    };
    
    const { fromRowArr, toRowArr } = createHeaderMapFns<Product>(headerMap);
    
    // Test fromRowArr with array
    const rowArray = ['P001', 'Laptop', 999.99, 10];
    const product = fromRowArr(rowArray);
    
    expect(product).toEqual({
      id: 'P001',
      name: 'Laptop',
      details: {
        price: 999.99,
        stock: 10
      }
    });
    
    // Test toRowArr with index mapping
    const result = toRowArr(product);
    
    expect(result[0]).toBe('P001');
    expect(result[1]).toBe('Laptop');
    expect(result[2]).toBe(999.99);
    expect(result[3]).toBe(10);
  });
  
  it('handles nested objects correctly', () => {
    interface DeepNested {
      level1: {
        level2: {
          level3: {
            value: string;
          };
        };
      };
    }
    
    const headerMap = {
      'deep_value': 'level1.level2.level3.value'
    };
    
    const { fromRowArr } = createHeaderMapFns<DeepNested>(headerMap);
    
    const row = { deep_value: 'nested value' };
    const result = fromRowArr(row);
    
    expect(result).toEqual({
      level1: {
        level2: {
          level3: {
            value: 'nested value'
          }
        }
      }
    });
  });
  
  it('validates inputs', () => {
    // Empty header map
    expect(() => createHeaderMapFns({})).toThrow(CSVError);
    
    // Valid map but invalid inputs
    const { fromRowArr, toRowArr } = createHeaderMapFns({ a: 'b' });
    
    // fromRowArr with null
    expect(() => fromRowArr(null as any)).toThrow(CSVError);
    
    // toRowArr with null
    expect(() => toRowArr(null as any)).toThrow(CSVError);
    
    // toRowArr with missing headers for header-based mapping
    expect(() => toRowArr({ b: 'value' })).not.toThrow();
  });
});

describe('CSVUtils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  it('mergeRows merges two arrays', () => {
    const arrayA = [{ id: '1', name: 'A', stock: 10 }];
    const arrayB = [{ id: '1', name: 'A', price: 100 }];
    
    const merged = CSVUtils.mergeRows<Record<string, any>, Record<string, any>>(
      arrayA,
      arrayB,
      (a, b) => a.id === b.id,
      (a, b) => ({ ...a, ...b })
    );
    
    expect(merged).toEqual([{ id: '1', name: 'A', stock: 10, price: 100 }]);
  });
  
  it('clone creates deep copy', () => {
    const original = { a: 1, b: { c: 2 } };
    const cloned = CSVUtils.clone(original);
    
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.b).not.toBe(original.b);
  });
  
  it('isValidCSV checks if string is valid CSV', () => {
    expect(CSVUtils.isValidCSV('a,b,c\n1,2,3')).toBe(true);
    expect(CSVUtils.isValidCSV('not csv')).toBe(false);
  });
  
  it('writeCSV writes data to file', () => {
    CSVUtils.writeCSV('test.csv', [
      { id: 'id', name: 'Patrick' }
    ]);
    
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
  
  it('createTransformer creates transform stream', () => {
    const transformer = CSVUtils.createTransformer((row: any) => ({
      ...row,
      transformed: true
    }));
    
    expect(transformer).toHaveProperty('_transform');
    
    // Test transformation
    const callback = vi.fn();
    transformer._transform({ id: '1' }, 'utf8', callback);
    
    expect(callback).toHaveBeenCalledWith(null, { id: '1', transformed: true });
  });
});

describe('CSVArrayUtils', () => {
  const products = [
    { id: 'A123', details: { name: 'Laptop', price: 999.99 } },
    { id: 'B456', details: { name: 'Mouse', price: 49.99 } }
  ];
  
  const csvData = [
    ['SKU', 'NAME', 'PRICE'],
    ['A123', 'Laptop', '999.99'],
    ['B456', 'Mouse', '49.99']
  ];
  
  it('arrayToObjArray transforms arrays to objects', () => {
    type Product = typeof products[0];
    
    const headerMap = {
      0: 'id',
      1: 'details.name',
      2: 'details.price'
    };
    
    const transformed = CSVArrayUtils.arrayToObjArray<Product>(
      csvData.slice(1), // Skip header row
      headerMap
    );
    
    expect(transformed).toHaveLength(2);
    expect(transformed[0].id).toBe('A123');
    expect(transformed[0].details.name).toBe('Laptop');
    expect(transformed[0].details.price).toBe('999.99');
  });
  
  it('arrayToObjArray handles header-based mapping', () => {
    type Product = typeof products[0];
    
    const headerMap = {
      'SKU': 'id',
      'NAME': 'details.name',
      'PRICE': 'details.price'
    };
    
    const transformed = CSVArrayUtils.arrayToObjArray<Product>(
      csvData.slice(1), // Skip header row
      headerMap,
      csvData[0] // Headers
    );
    
    expect(transformed).toHaveLength(2);
    expect(transformed[0].id).toBe('A123');
    expect(transformed[0].details.name).toBe('Laptop');
    expect(transformed[0].details.price).toBe('999.99');
  });
  
  it('objArrayToArray transforms objects to arrays', () => {
    const headerMap = {
      'id': 0,
      'details.name': 1,
      'details.price': 2
    };
    
    const headers = ['SKU', 'NAME', 'PRICE'];
    
    const transformed = CSVArrayUtils.objArrayToArray(
      products,
      headerMap,
      headers,
      true // Include headers
    );
    
    expect(transformed).toHaveLength(3); // Headers + 2 rows
    expect(transformed[0]).toEqual(headers);
    expect(transformed[1][0]).toBe('A123');
    expect(transformed[1][1]).toBe('Laptop');
    expect(transformed[1][2]).toBe(999.99);
  });
  
  it('objArrayToArray transforms without headers', () => {
    const headerMap = {
      'id': 0,
      'details.name': 1,
      'details.price': 2
    };
    
    const transformed = CSVArrayUtils.objArrayToArray(
      products,
      headerMap
    );
    
    expect(transformed).toHaveLength(2);
    expect(transformed[0][0]).toBe('A123');
    expect(transformed[0][1]).toBe('Laptop');
    expect(transformed[0][2]).toBe(999.99);
  });
  
  it('groupByField groups items by field', () => {
    const data = [
      { id: '1', category: 'A', value: 10 },
      { id: '2', category: 'B', value: 20 },
      { id: '3', category: 'A', value: 30 }
    ];
    
    const grouped = CSVArrayUtils.groupByField(data, 'category');
    
    expect(Object.keys(grouped)).toEqual(['A', 'B']);
    expect(grouped['A']).toHaveLength(2);
    expect(grouped['B']).toHaveLength(1);
    expect(grouped['A'][0].id).toBe('1');
    expect(grouped['A'][1].id).toBe('3');
  });
  
  it('groupByField handles nested paths', () => {
    const data = [
      { id: '1', meta: { category: 'A' }, value: 10 },
      { id: '2', meta: { category: 'B' }, value: 20 },
      { id: '3', meta: { category: 'A' }, value: 30 }
    ];
    
    const grouped = CSVArrayUtils.groupByField(data, 'meta.category');
    
    expect(Object.keys(grouped)).toEqual(['A', 'B']);
    expect(grouped['A']).toHaveLength(2);
    expect(grouped['B']).toHaveLength(1);
  });
});

describe('Async Generators', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  it('writeCSVFromGenerator writes to a file', async () => {
    const mockWritable = {
      write: vi.fn().mockReturnValue(true),
      on: vi.fn().mockImplementation((event, callback) => {
        if (event === 'finish') {
          setTimeout(callback, 10);
        }
        return mockWritable;
      }),
      end: vi.fn()
    };

    vi.mocked(fs.createWriteStream).mockReturnValue(mockWritable as any);

    // Create generator function that yields a few items
    async function* generateData() {
      yield { id: '1', name: 'Product A', price: 100 };
      yield { id: '2', name: 'Product B', price: 200 };
      yield { id: '3', name: 'Product C', price: 300 };
    }

    // Test writing from generator
    await writeCSVFromGenerator('output.csv', generateData());

    expect(fs.writeFileSync).toHaveBeenCalledWith('output.csv', expect.anything(), 'utf-8');
  });

  it('writeCSVFromGenerator applies header mapping', async () => {
    const mockWritable = {
      write: vi.fn().mockReturnValue(true),
      on: vi.fn().mockImplementation((event, callback) => {
        if (event === 'finish') {
          setTimeout(callback, 10);
        }
        return mockWritable;
      }),
      end: vi.fn()
    };

    vi.mocked(fs.createWriteStream).mockReturnValue(mockWritable as any);

    // Create generator function
    async function* generateData() {
      yield { productId: '1', productName: 'Product A', cost: 100 };
      yield { productId: '2', productName: 'Product B', cost: 200 };
    }

    // Header map for transformation
    const headerMap = {
      'productId': 'id',
      'productName': 'name',
      'cost': 'price'
    };

    // Test writing with header mapping
    await writeCSVFromGenerator('output.csv', generateData(), { 
      headerMap,
    });

    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('CSVError includes cause information', () => {
    const originalError = new Error('Original error');
    const csvError = new CSVError('CSV processing failed', originalError);
    
    expect(csvError.message).toBe('CSV processing failed');
    expect(csvError.name).toBe('CSVError');
    expect(csvError.cause).toBe(originalError);
  });

  it('fromFile handles file read errors', () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error('File not found');
    });

    expect(() => CSV.fromFile('invalid.csv')).toThrow(CSVError);
  });

  it('writeToFile handles write errors', () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('Write error');
    });
    
    const csv = CSV.fromData([
      { id: 1, name: 'Patrick' }
    ]);
    
    expect(() => csv.writeToFile('error.csv')).toThrow(CSVError);
  });

  it('retries operations with retry options', () => {
    // First two calls fail, third succeeds
    vi.mocked(fs.readFileSync)
      .mockImplementationOnce(() => { throw new Error('Temporary error'); })
      .mockImplementationOnce(() => { throw new Error('Temporary error'); })
      .mockReturnValueOnce('id,name,price,inStock\n1,Product A,100,true\n2,Product B,200,false\n3,Product C,300,true');
    
    const csv = CSV.fromFile('test.csv', {
      retry: {
        maxRetries: 2,
        baseDelay: 10,
        logRetries: true
      }
    });
    
    expect(csv.count()).toBe(3);
    expect(fs.readFileSync).toHaveBeenCalledTimes(3);
  });

  it('gives up after max retries', () => {
    // All calls fail
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Persistent error');
    });
    
    expect(() => CSV.fromFile('test.csv', {
      retry: {
        maxRetries: 2,
        baseDelay: 10
      }
    })).toThrow(/after 2 attempts/);
    
    expect(fs.readFileSync).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('validates data structure when requested', () => {
    const inconsistentCsvContent = 'id,name,price\n1,Product A,100\n2,Product B';
    
    vi.mocked(fs.readFileSync).mockReturnValueOnce(inconsistentCsvContent);
    
    expect(() => CSV.fromFile('inconsistent.csv', {
      validateData: true
    })).toThrow(/inconsistent column count/);
  });
  
  it('validates for empty string values', () => {
    const emptyValuesCsv = 'id,name,price\n1,,100\n2,Product B,';
    
    vi.mocked(fs.readFileSync).mockReturnValueOnce(emptyValuesCsv);
    
    expect(() => CSV.fromFile('empty.csv', {
      validateData: true,
      allowEmptyValues: false
    })).toThrow(/empty value found/);
  });
});

