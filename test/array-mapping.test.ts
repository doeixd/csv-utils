import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { HeaderMap, createHeaderMapFns, CsvToArrayConfig, ObjectArrayToCsvConfig } from '../src/headers';
import CSV, { CSVError } from '../src';

// Simple mock for fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('Array Mapping Feature', () => {
  describe('CSV to array mapping', () => {
    it('should map multiple CSV columns to a single array using pattern matching', () => {
      // Mock CSV data with image columns
      const csvData = {
        'id': 'P123',
        'name': 'Test Product',
        'image_1': 'img1.jpg',
        'image_2': 'img2.jpg',
        'image_3': 'img3.jpg',
        'category': 'Electronics'
      };

      // Define the header map with array mapping
      const headerMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        'category': 'category',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumnPattern: /^image_(\d+)$/,
          sortSourceColumnsBy: (match) => parseInt(match[1], 10)
        } as CsvToArrayConfig
      };

      // Create the mapping functions
      const { fromRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const result = fromRowArr(csvData);
      
      // Verify results
      expect(result.id).toBe('P123');
      expect(result.name).toBe('Test Product');
      expect(result.category).toBe('Electronics');
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images).toHaveLength(3);
      expect(result.images[0]).toBe('img1.jpg');
      expect(result.images[1]).toBe('img2.jpg');
      expect(result.images[2]).toBe('img3.jpg');
    });

    it('should map multiple CSV columns to a single array using explicit column list', () => {
      // Mock CSV data with image columns
      const csvData = {
        'id': 'P123',
        'name': 'Test Product',
        'main_image': 'main.jpg',
        'thumbnail': 'thumb.jpg',
        'banner_image': 'banner.jpg'
      };

      // Define the header map with array mapping
      const headerMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumns: ['main_image', 'thumbnail', 'banner_image']
        } as CsvToArrayConfig
      };

      // Create the mapping functions
      const { fromRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const result = fromRowArr(csvData);
      
      // Verify results
      expect(result.id).toBe('P123');
      expect(result.name).toBe('Test Product');
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images).toHaveLength(3);
      expect(result.images[0]).toBe('main.jpg');
      expect(result.images[1]).toBe('thumb.jpg');
      expect(result.images[2]).toBe('banner.jpg');
    });

    it('should handle empty values according to the emptyValueStrategy', () => {
      // Mock CSV data with empty image values
      const csvData = {
        'id': 'P123',
        'name': 'Test Product',
        'image_1': 'img1.jpg',
        'image_2': '',
        'image_3': null,
        'image_4': 'img4.jpg'
      };

      // Test with 'skip' strategy
      const skipHeaderMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumnPattern: /^image_(\d+)$/,
          sortSourceColumnsBy: (match) => parseInt(match[1], 10),
          emptyValueStrategy: 'skip'
        } as CsvToArrayConfig
      };

      const { fromRowArr: skipEmptyFn } = createHeaderMapFns(skipHeaderMap);
      const skipResult = skipEmptyFn(csvData);
      
      expect(skipResult.images).toHaveLength(2);
      expect(skipResult.images[0]).toBe('img1.jpg');
      expect(skipResult.images[1]).toBe('img4.jpg');

      // Test with 'pushNullOrUndefined' strategy
      const pushNullHeaderMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumnPattern: /^image_(\d+)$/,
          sortSourceColumnsBy: (match) => parseInt(match[1], 10),
          emptyValueStrategy: 'pushNullOrUndefined'
        } as CsvToArrayConfig
      };

      const { fromRowArr: pushNullFn } = createHeaderMapFns(pushNullHeaderMap);
      const pushNullResult = pushNullFn(csvData);
      
      expect(pushNullResult.images).toHaveLength(4);
      expect(pushNullResult.images[0]).toBe('img1.jpg');
      expect(pushNullResult.images[1]).toBe('');
      expect(pushNullResult.images[2]).toBe(null);
      expect(pushNullResult.images[3]).toBe('img4.jpg');
    });

    it('should filter values according to the provided filter function', () => {
      // Mock CSV data with image columns
      const csvData = {
        'id': 'P123',
        'name': 'Test Product',
        'image_1': 'img1.jpg',
        'image_2': 'invalid',
        'image_3': 'img3.jpg',
        'image_4': 'skip-this.jpg'
      };

      // Define the header map with array mapping and filtering
      const headerMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumnPattern: /^image_(\d+)$/,
          sortSourceColumnsBy: (match) => parseInt(match[1], 10),
          filterValue: (value, columnName) => {
            return value.endsWith('.jpg') && !value.startsWith('skip-');
          }
        } as CsvToArrayConfig
      };

      // Create the mapping functions
      const { fromRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const result = fromRowArr(csvData);
      
      // Verify results
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images).toHaveLength(2);
      expect(result.images[0]).toBe('img1.jpg');
      expect(result.images[1]).toBe('img3.jpg');
    });

    it('should work with array inputs and header rows', () => {
      // Mock array CSV data with header row
      const headers = ['id', 'name', 'image_1', 'image_2', 'image_3'];
      const csvRow = ['P123', 'Test Product', 'img1.jpg', 'img2.jpg', 'img3.jpg'];

      // Define the header map with array mapping
      const headerMap: HeaderMap<any> = {
        'id': 'id',
        'name': 'name',
        '_images': {
          _type: 'csvToTargetArray',
          targetPath: 'images',
          sourceCsvColumnPattern: /^image_(\d+)$/,
          sortSourceColumnsBy: (match) => parseInt(match[1], 10)
        } as CsvToArrayConfig
      };

      // Create the mapping functions
      const { fromRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping with headers
      const result = fromRowArr(csvRow, headers);
      
      // Verify results
      expect(result.id).toBe('P123');
      expect(result.name).toBe('Test Product');
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images).toHaveLength(3);
      expect(result.images[0]).toBe('img1.jpg');
      expect(result.images[1]).toBe('img2.jpg');
      expect(result.images[2]).toBe('img3.jpg');
    });
  });

  describe('Array to CSV mapping', () => {
    it('should map an array to multiple CSV columns using fixed column names', () => {
      // Mock object with array
      const product = {
        id: 'P123',
        name: 'Test Product',
        images: ['img1.jpg', 'img2.jpg', 'img3.jpg']
      };

      // Define the header map with array-to-columns mapping
      const headerMap: HeaderMap<any> = {
        'id': 'product_id',
        'name': 'product_name',
        'images': {
          _type: 'targetArrayToCsv',
          targetCsvColumns: ['main_image', 'thumbnail', 'banner_image']
        } as ObjectArrayToCsvConfig
      };

      // Create the mapping functions
      const { toRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const headers = ['product_id', 'product_name', 'main_image', 'thumbnail', 'banner_image'];
      const result = toRowArr(product, headers);
      
      // Verify results
      expect(result).toHaveLength(5);
      expect(result[0]).toBe('P123');
      expect(result[1]).toBe('Test Product');
      expect(result[2]).toBe('img1.jpg');
      expect(result[3]).toBe('img2.jpg');
      expect(result[4]).toBe('img3.jpg');
    });

    it('should map an array to multiple CSV columns using a prefix', () => {
      // Mock object with array
      const product = {
        id: 'P123',
        name: 'Test Product',
        images: ['img1.jpg', 'img2.jpg', 'img3.jpg']
      };

      // Define the header map with array-to-columns mapping
      const headerMap: HeaderMap<any> = {
        'id': 'product_id',
        'name': 'product_name',
        'images': {
          _type: 'targetArrayToCsv',
          targetCsvColumnPrefix: 'image_'
        } as ObjectArrayToCsvConfig
      };

      // Create the mapping functions
      const { toRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const headers = ['product_id', 'product_name', 'image_1', 'image_2', 'image_3'];
      const result = toRowArr(product, headers);
      
      // Verify results
      expect(result).toHaveLength(5);
      expect(result[0]).toBe('P123');
      expect(result[1]).toBe('Test Product');
      expect(result[2]).toBe('img1.jpg');
      expect(result[3]).toBe('img2.jpg');
      expect(result[4]).toBe('img3.jpg');
    });

    it('should handle missing array elements with emptyCellOutput', () => {
      // Mock object with short array
      const product = {
        id: 'P123',
        name: 'Test Product',
        images: ['img1.jpg']
      };

      // Define the header map with array-to-columns mapping
      const headerMap: HeaderMap<any> = {
        'id': 'product_id',
        'name': 'product_name',
        'images': {
          _type: 'targetArrayToCsv',
          targetCsvColumns: ['main_image', 'thumbnail', 'banner_image'],
          emptyCellOutput: '[NO IMAGE]'
        } as ObjectArrayToCsvConfig
      };

      // Create the mapping functions
      const { toRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const headers = ['product_id', 'product_name', 'main_image', 'thumbnail', 'banner_image'];
      const result = toRowArr(product, headers);
      
      // Verify results
      expect(result).toHaveLength(5);
      expect(result[0]).toBe('P123');
      expect(result[1]).toBe('Test Product');
      expect(result[2]).toBe('img1.jpg');
      expect(result[3]).toBe('[NO IMAGE]');
      expect(result[4]).toBe('[NO IMAGE]');
    });

    it('should respect maxColumns when using prefix', () => {
      // Mock object with long array
      const product = {
        id: 'P123',
        name: 'Test Product',
        images: ['img1.jpg', 'img2.jpg', 'img3.jpg', 'img4.jpg', 'img5.jpg']
      };

      // Define the header map with array-to-columns mapping and max columns
      const headerMap: HeaderMap<any> = {
        'id': 'product_id',
        'name': 'product_name',
        'images': {
          _type: 'targetArrayToCsv',
          targetCsvColumnPrefix: 'image_',
          maxColumns: 3
        } as ObjectArrayToCsvConfig
      };

      // Create the mapping functions
      const { toRowArr } = createHeaderMapFns(headerMap);
      
      // Apply the mapping
      const headers = ['product_id', 'product_name', 'image_1', 'image_2', 'image_3', 'image_4', 'image_5'];
      const result = toRowArr(product, headers);
      
      // Verify results
      expect(result).toHaveLength(7);
      expect(result[0]).toBe('P123');
      expect(result[1]).toBe('Test Product');
      expect(result[2]).toBe('img1.jpg');
      expect(result[3]).toBe('img2.jpg');
      expect(result[4]).toBe('img3.jpg');
      expect(result[5]).toBe(''); // Should be empty because maxColumns is 3
      expect(result[6]).toBe(''); // Should be empty because maxColumns is 3
    });
  });

  describe('Integration with CSV class', () => {
    const csvContent = 'id,name,image_1,image_2,image_3\nP123,Test Product,img1.jpg,img2.jpg,img3.jpg';
    
    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(fs.readFileSync).mockReturnValue(csvContent);
    });
    
    it('should work with CSV.fromFile for reading arrays', () => {
      const csv = CSV.fromFile('test.csv', {
        headerMap: {
          'id': 'id',
          'name': 'name',
          '_images': {
            _type: 'csvToTargetArray',
            targetPath: 'images',
            sourceCsvColumnPattern: /^image_(\d+)$/,
            sortSourceColumnsBy: (match) => parseInt(match[1], 10)
          } as CsvToArrayConfig
        }
      });
      
      const data = csv.toArray();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('P123');
      expect(data[0].name).toBe('Test Product');
      expect(Array.isArray(data[0].images)).toBe(true);
      expect(data[0].images).toHaveLength(3);
      expect(data[0].images[0]).toBe('img1.jpg');
    });
    
    it('should work for writing arrays to CSV', () => {
      const mockWriteFileSync = vi.mocked(fs.writeFileSync);
      
      // Create a CSV instance with array data
      const data = [
        {
          id: 'P123',
          name: 'Test Product',
          images: ['img1.jpg', 'img2.jpg', 'img3.jpg']
        }
      ];
      
      const csv = CSV.fromData(data);
      
      // Write to file with array-to-csv mapping
      csv.writeToFile('output.csv', {
        headerMap: {
          'id': 'id',
          'name': 'name',
          'images': {
            _type: 'targetArrayToCsv',
            targetCsvColumnPrefix: 'image_'
          } as ObjectArrayToCsvConfig
        }
      });
      
      // Check if writeFileSync was called
      expect(mockWriteFileSync).toHaveBeenCalled();
      
      // Verify header mapping was applied
      const lastCallArgs = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1];
      const fileContent = lastCallArgs[1] as string;
      expect(fileContent).toContain('id,name,image_1,image_2,image_3');
      expect(fileContent).toContain('P123,Test Product,img1.jpg,img2.jpg,img3.jpg');
    });
  });
});