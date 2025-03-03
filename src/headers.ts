/**
 * @fileoverview Utilities for data transformation, including header mapping and array processing
 */

import { get as getPath, set as setPath } from 'lodash';
import { CSVError } from './index';

/**
 * Type for header mapping configurations
 * Maps source fields to target fields with support for nested paths
 * @template T - Optional type for the target object structure
 */
export type HeaderMap<T = any> = { 
  [K in string | number]: keyof T | string 
};

/**
 * Type for the merge function that transforms values during mapping
 * @template T - The type of the target object
 */
export type MergeFn<T> = (obj: Partial<T>, key: string, value: any) => any;

/**
 * Options for retry logic
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Base delay in milliseconds between retries (will be multiplied by 2^attempt for exponential backoff) */
  baseDelay?: number;
  /** Whether to log retry attempts */
  logRetries?: boolean;
}

/**
 * Creates functions to map between row arrays and structured objects
 * @template T - The type of the target object
 * @param headerMap - Mapping between array indices or header names and object properties
 * @param mergeFn - Optional function to customize how values are merged into the target object
 * @returns Object containing mapping functions
 * @example
 * ```typescript
 * interface User {
 *   id: string;
 *   profile: { firstName: string; lastName: string };
 * }
 * 
 * const headerMap = {
 *   'user_id': 'id',
 *   'first_name': 'profile.firstName',
 *   'last_name': 'profile.lastName'
 * };
 * 
 * // With custom merge function to trim strings
 * const { fromRowArr, toRowArr } = createHeaderMapFns<User>(
 *   headerMap,
 *   (obj, key, value) => typeof value === 'string' ? value.trim() : value
 * );
 * ```
 */
export function createHeaderMapFns<To extends Record<string, any>, RowArr extends any[] = any[]>(
  headerMap: HeaderMap<To>,
  mergeFn?: MergeFn<To>
) {
  // Validate the header map
  const validateHeaderMap = () => {
    if (!headerMap || typeof headerMap !== 'object') {
      throw new CSVError('Header map must be a non-null object');
    }
    
    if (Object.keys(headerMap).length === 0) {
      throw new CSVError('Header map cannot be empty');
    }
  };
  
  // Validate once during creation
  validateHeaderMap();
  
  return {
    /**
     * Convert a row array or object to a structured object
     * @param rowArr - Row data as an array or object
     * @returns Structured object
     * @example
     * ```typescript
     * const row = { user_id: '123', first_name: 'John', last_name: 'Doe' };
     * const user = fromRowArr(row);
     * // user = { id: '123', profile: { firstName: 'John', lastName: 'Doe' } }
     * ```
     */
    fromRowArr: (rowArr: RowArr | Record<string, any>): To => {
      const to = {} as To;
      
      if (Array.isArray(rowArr)) {
        // Handle array input
        for (let i = 0; i < rowArr.length; i++) {
          const toKey = headerMap[i];
          if (toKey) {
            const targetPath = String(toKey); // Ensure it's a string
            const value = mergeFn ? mergeFn(to, targetPath, rowArr[i]) : rowArr[i];
            setPath(to, targetPath, value);
          }
        }
      } else if (typeof rowArr === 'object' && rowArr !== null) {
        // Handle object input
        for (let [key, value] of Object.entries(rowArr)) {
          const toKey = headerMap[key];
          if (toKey) {
            const targetPath = String(toKey); // Ensure it's a string
            const processedValue = mergeFn ? mergeFn(to, targetPath, value) : value;
            setPath(to, targetPath, processedValue);
          }
        }
      } else {
        throw new CSVError('Input must be an array or object');
      }
      
      return to;
    },

    /**
     * Convert a structured object back to a row array
     * @param objAfterMapWasApplied - Structured object
     * @param headers - Array of header names in order (required for header-based mapping)
     * @param transformFn - Optional function to transform values when converting from object to row
     * @returns Row data as an array
     * @example
     * ```typescript
     * const user = { id: '123', profile: { firstName: 'John', lastName: 'Doe' } };
     * const row = toRowArr(user, ['user_id', 'first_name', 'last_name']);
     * // row = ['123', 'John', 'Doe']
     * 
     * // With transform function
     * const csvRow = toRowArr(user, ['user_id', 'first_name', 'last_name'], 
     *   (value) => typeof value === 'string' ? value.toUpperCase() : value);
     * // csvRow = ['123', 'JOHN', 'DOE']
     * ```
     */
    toRowArr: (
      objAfterMapWasApplied: To, 
      headers: string[] = [], 
      transformFn?: (value: any, key: string) => any
    ): RowArr => {
      // Validate input
      if (!objAfterMapWasApplied || typeof objAfterMapWasApplied !== 'object') {
        throw new CSVError('Object must be a non-null object');
      }
      
      const row: any[] = [];
      const isIndexBased = Object.keys(headerMap).every(k => !isNaN(Number(k)));
      
      if (isIndexBased) {
        // Index-based mapping
        for (let [rowIdx, path] of Object.entries(headerMap)) {
          const targetPath = String(path);
          let value = getPath(objAfterMapWasApplied, targetPath);
          
          if (typeof value !== 'undefined') {
            // Process value
            value = processValueForOutput(value, targetPath, transformFn);
            row[parseInt(rowIdx)] = value;
          }
        }
      } else {
        // Header-based mapping
        if (!headers || headers.length === 0) {
          throw new CSVError('Headers array is required for header-based mapping');
        }
        
        for (let i = 0; i < headers.length; i++) {
          const headerName = headers[i];
          const path = headerMap[headerName];
          
          if (path) {
            const targetPath = String(path);
            let value = getPath(objAfterMapWasApplied, targetPath);
            
            if (typeof value !== 'undefined') {
              // Process value
              value = processValueForOutput(value, targetPath, transformFn);
              row[i] = value;
            }
          }
        }
      }
      
      return row as RowArr;
    }
  };
}

/**
 * Helper function to process values for output, handling special cases
 * @param value - The value to process
 * @param key - The key or path associated with the value
 * @param transformFn - Optional function to transform the value
 * @returns Processed value
 */
function processValueForOutput(
  value: any, 
  key: string,
  transformFn?: (value: any, key: string) => any
): any {
  // Apply custom transformation if provided
  if (transformFn) {
    return transformFn(value, key);
  }
  
  // Handle special types
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  
  return value;
}

/**
 * Helper function to convert array row to object row using headers
 * @param row - Array of values
 * @param headerRow - Array of header names
 * @returns Object with header names as keys
 */
function arrayRowToObjectRow(row: any[], headerRow: string[]): Record<string, any> {
  const objRow: Record<string, any> = {};
  for (let i = 0; i < row.length && i < headerRow.length; i++) {
    objRow[headerRow[i]] = row[i];
  }
  return objRow;
}

/**
 * Transforms an array of arrays or objects into an array of structured objects
 * @template T - The type of the target object
 * @param data - Array of arrays or objects to transform
 * @param headerMap - Mapping between array indices or header names and object properties
 * @param headerRow - Optional header row for object input (if headerMap uses header names)
 * @param mergeFn - Optional function to customize how values are merged into the target object
 * @returns Array of structured objects
 * @example
 * ```typescript
 * interface Product {
 *   id: string;
 *   details: { name: string; price: number };
 * }
 * 
 * const csvData = [
 *   ['SKU', 'NAME', 'PRICE'],
 *   ['A123', 'Laptop', '999.99'],
 *   ['B456', 'Mouse', '49.99']
 * ];
 * 
 * const products = arrayToObjArray<Product>(
 *   csvData.slice(1), // Skip header row
 *   { 0: 'id', 1: 'details.name', 2: 'details.price' }
 * );
 * 
 * // With custom merge function to convert price to number
 * const productsWithPriceAsNumber = arrayToObjArray<Product>(
 *   csvData.slice(1),
 *   { 0: 'id', 1: 'details.name', 2: 'details.price' },
 *   undefined,
 *   (obj, key, value) => {
 *     if (key === 'details.price') {
 *       return parseFloat(value);
 *     }
 *     return value;
 *   }
 * );
 * ```
 */
export function arrayToObjArray<T extends Record<string, any>>(
  data: any[],
  headerMap: HeaderMap<T>,
  headerRow?: string[],
  mergeFn?: MergeFn<T>
): T[] {
  if (!Array.isArray(data)) {
    throw new CSVError('Data must be an array');
  }
  
  if (data.length === 0) {
    return [];
  }
  
  const { fromRowArr } = createHeaderMapFns<T>(headerMap, mergeFn);
  
  // Check if we need to validate header row
  validateHeadersIfNeeded(data, headerMap, headerRow);
  
  return data.map(row => {
    // If working with arrays and string header maps, convert to object first
    const isArrayData = Array.isArray(row);
    const hasStringKeys = Object.keys(headerMap).some(k => isNaN(Number(k)));
    
    if (isArrayData && hasStringKeys && headerRow) {
      const objRow = arrayRowToObjectRow(row, headerRow);
      return fromRowArr(objRow);
    }
    
    return fromRowArr(row);
  });
}

/**
 * Validates that header row is provided when needed
 * @param data - The data array
 * @param headerMap - The header mapping configuration
 * @param headerRow - The header row (optional)
 */
function validateHeadersIfNeeded<T>(
  data: any[], 
  headerMap: HeaderMap<T>, 
  headerRow?: string[]
): void {
  const firstItem = data[0];
  const isArrayData = Array.isArray(firstItem);
  const hasStringKeys = Object.keys(headerMap).some(k => isNaN(Number(k)));
  
  if (isArrayData && hasStringKeys && !headerRow) {
    throw new CSVError('Header row is required for string-keyed header map with array data');
  }
}

/**
 * Transforms an array of structured objects into an array of arrays
 * @template T - The type of the source object
 * @param data - Array of structured objects to transform
 * @param headerMap - Mapping between object properties and array indices or header names
 * @param headers - Optional array of headers (required for header-based mapping)
 * @param includeHeaders - Whether to include headers as the first row
 * @param transformFn - Optional function to transform values when converting to rows
 * @returns Array of arrays
 * @example
 * ```typescript
 * interface Product {
 *   id: string;
 *   details: { name: string; price: number };
 * }
 * 
 * const products = [
 *   { id: 'A123', details: { name: 'Laptop', price: 999.99 } },
 *   { id: 'B456', details: { name: 'Mouse', price: 49.99 } }
 * ];
 * 
 * const csvData = objArrayToArray<Product>(
 *   products,
 *   { 'id': 0, 'details.name': 1, 'details.price': 2 },
 *   ['SKU', 'NAME', 'PRICE'],
 *   true
 * );
 * ```
 */
export function objArrayToArray<T extends Record<string, any>>(
  data: T[],
  headerMap: HeaderMap,
  headers: string[] = [],
  includeHeaders: boolean = false,
  transformFn?: (value: any, key: string) => any
): any[][] {
  if (!Array.isArray(data)) {
    throw new CSVError('Data must be an array');
  }
  
  if (data.length === 0) {
    return includeHeaders && headers.length > 0 ? [headers] : [];
  }
  
  // Create an inverse header map
  const inverseMap: HeaderMap<T> = {};
  for (const [key, value] of Object.entries(headerMap)) {
    if (typeof value === 'string' || typeof value === 'number') {
      inverseMap[value] = key;
    }
  }
  
  const { toRowArr } = createHeaderMapFns<T>(inverseMap);
  
  const rows = data.map(obj => toRowArr(obj, headers, transformFn));
  
  if (includeHeaders && headers.length > 0) {
    return [headers, ...rows];
  }
  
  return rows;
}

/**
 * Groups an array of objects by the values of a specified field
 * @template T - The type of the objects in the array
 * @param data - Array of objects to group
 * @param field - The field to group by (can be a nested path like 'user.id')
 * @returns Object with groups of items
 * @example
 * ```typescript
 * const orders = [
 *   { id: 1, customer: { id: 'A', name: 'Alice' }, total: 100 },
 *   { id: 2, customer: { id: 'B', name: 'Bob' }, total: 200 },
 *   { id: 3, customer: { id: 'A', name: 'Alice' }, total: 150 }
 * ];
 * 
 * const byCustomer = groupByField(orders, 'customer.id');
 * // Result:
 * // {
 * //   'A': [
 * //     { id: 1, customer: { id: 'A', name: 'Alice' }, total: 100 },
 * //     { id: 3, customer: { id: 'A', name: 'Alice' }, total: 150 }
 * //   ],
 * //   'B': [
 * //     { id: 2, customer: { id: 'B', name: 'Bob' }, total: 200 }
 * //   ]
 * // }
 * ```
 */
export function groupByField<T extends Record<string, any>>(
  data: T[],
  field: string
): Record<string, T[]> {
  return data.reduce((groups, item) => {
    const key = String(getPath(item, field) ?? 'undefined');
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}