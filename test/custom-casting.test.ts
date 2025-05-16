import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import CSV, { CSVError } from '../src';

// Simple mock for fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Simple mock for path
vi.mock('path', () => ({
  resolve: vi.fn(p => p),
}));

describe('Custom Casting Feature', () => {
  const csvContent = 'id,name,price,inStock\n1,Product A,100,true\n2,Product B,200,false\n3,Product C,300,true';
  
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.readFileSync).mockReturnValue(csvContent);
  });
  
  it('should cast numeric values to numbers', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        definitions: {
          number: {
            test: (value) => !isNaN(parseFloat(value)),
            parse: (value) => parseFloat(value)
          }
        },
        columnCasts: {
          'price': 'number'
        }
      }
    });
    
    const data = csv.toArray();
    expect(typeof data[0].price).toBe('number');
    expect(data[0].price).toBe(100);
    expect(typeof data[1].price).toBe('number');
    expect(data[1].price).toBe(200);
  });
  
  it('should cast boolean values to booleans', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        definitions: {
          boolean: {
            test: (value) => value.toLowerCase() === 'true' || value.toLowerCase() === 'false',
            parse: (value) => value.toLowerCase() === 'true'
          }
        },
        columnCasts: {
          'inStock': 'boolean'
        }
      }
    });
    
    const data = csv.toArray();
    expect(typeof data[0].inStock).toBe('boolean');
    expect(data[0].inStock).toBe(true);
    expect(typeof data[1].inStock).toBe('boolean');
    expect(data[1].inStock).toBe(false);
  });
  
  it('should handle multiple column casts', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        definitions: {
          number: {
            test: (value) => !isNaN(parseFloat(value)),
            parse: (value) => parseFloat(value)
          },
          boolean: {
            test: (value) => value.toLowerCase() === 'true' || value.toLowerCase() === 'false',
            parse: (value) => value.toLowerCase() === 'true'
          }
        },
        columnCasts: {
          'price': 'number',
          'inStock': 'boolean'
        }
      }
    });
    
    const data = csv.toArray();
    expect(typeof data[0].price).toBe('number');
    expect(data[0].price).toBe(100);
    expect(typeof data[0].inStock).toBe('boolean');
    expect(data[0].inStock).toBe(true);
  });
  
  it('should support custom casters directly', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        columnCasts: {
          'price': {
            test: (value) => !isNaN(parseFloat(value)),
            parse: (value) => `$${parseFloat(value).toFixed(2)}`
          }
        }
      }
    });
    
    const data = csv.toArray();
    expect(typeof data[0].price).toBe('string');
    expect(data[0].price).toBe('$100.00');
  });
  
  it('should support fallback casting options', () => {
    // Mock a CSV with mixed formats
    vi.mocked(fs.readFileSync).mockReturnValue(
      'id,name,price,inStock\n1,Product A,$100,true\n2,Product B,200,false\n3,Product C,300.00,true'
    );
    
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        columnCasts: {
          'price': [
            // Try dollar format first
            {
              test: (value) => value.startsWith('$'),
              parse: (value) => parseFloat(value.substring(1))
            },
            // Then regular number format
            {
              test: (value) => !isNaN(parseFloat(value)),
              parse: (value) => parseFloat(value)
            }
          ]
        }
      }
    });
    
    const data = csv.toArray();
    expect(typeof data[0].price).toBe('number');
    expect(data[0].price).toBe(100);
    expect(typeof data[1].price).toBe('number');
    expect(data[1].price).toBe(200);
  });
  
  it('should handle error policy: null', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        columnCasts: {
          'price': {
            test: () => true, // Always process
            parse: () => { throw new Error('Parse error'); }
          }
        },
        onCastError: 'null'
      }
    });
    
    const data = csv.toArray();
    expect(data[0].price).toBeNull();
  });
  
  it('should handle error policy: original', () => {
    const csv = CSV.fromFile('test.csv', {
      customCasts: {
        columnCasts: {
          'price': {
            test: () => true, // Always process
            parse: () => { throw new Error('Parse error'); }
          }
        },
        onCastError: 'original'
      }
    });
    
    const data = csv.toArray();
    expect(data[0].price).toBe('100');
  });
  
  it('should throw with error policy: error', () => {
    expect(() => {
      CSV.fromFile('test.csv', {
        customCasts: {
          columnCasts: {
            'price': {
              test: () => true, // Always process
              parse: () => { throw new Error('Parse error'); }
            }
          },
          onCastError: 'error'
        }
      });
    }).toThrow(CSVError);
  });
  
  it('should work with header mapping', () => {
    const csv = CSV.fromFile('test.csv', {
      headerMap: {
        'id': 'productId',
        'name': 'productName',
        'price': 'cost',
        'inStock': 'available'
      },
      customCasts: {
        definitions: {
          number: {
            test: (value) => !isNaN(parseFloat(value)),
            parse: (value) => parseFloat(value)
          },
          boolean: {
            test: (value) => value.toLowerCase() === 'true' || value.toLowerCase() === 'false',
            parse: (value) => value.toLowerCase() === 'true'
          }
        },
        columnCasts: {
          // Note: use the target field names after header mapping
          'cost': 'number',
          'available': 'boolean'
        }
      }
    });
    
    const data = csv.toArray();
    expect(data[0].productId).toBe('1');
    expect(data[0].productName).toBe('Product A');
    expect(typeof data[0].cost).toBe('number');
    expect(data[0].cost).toBe(100);
    expect(typeof data[0].available).toBe('boolean');
    expect(data[0].available).toBe(true);
  });
});