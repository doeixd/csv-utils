/**
 * @fileoverview Utilities for data transformation, including header mapping and array processing
 */

import { get as getPath, set as setPath } from 'lodash';
import { CSVError } from './index';

/**
 * A path string using dot notation to access nested properties
 * @template T - The target object type
 */
export type Path<T = any> = string;

/**
 * A function used for custom header mapping operations
 * @template T - The target object type
 */
export type HeaderMapFn<T = any> = (
  target: T & Record<string, any>, 
  source: any, 
  key: string, 
  headers?: string[]
) => void;

/**
 * Configuration for mapping multiple CSV columns to a single array property
 * @template T - The target object type
 */
export interface CsvToArrayConfig<T = any> {
  /** Type identifier for the mapping configuration */
  _type: 'csvToTargetArray';
  
  /** The target array property path in dot notation */
  targetPath: Path<T>;
  
  /** Option A: Explicit list of CSV column names in order */
  sourceCsvColumns?: string[];
  
  /** Option B: A pattern for matching CSV column names */
  sourceCsvColumnPattern?: RegExp;
  
  /** How to sort columns when using a pattern */
  sortSourceColumnsBy?: (match: RegExpExecArray, headerName: string) => string | number;
  
  /** Filter values before adding to array */
  filterValue?: (value: any, sourceCsvColumn: string) => boolean;
  
  /** How to handle empty values */
  emptyValueStrategy?: 'skip' | 'pushNullOrUndefined';
}

/**
 * Configuration for mapping an array property to multiple CSV columns
 */
export interface ObjectArrayToCsvConfig {
  /** Type identifier for the mapping configuration */
  _type: 'targetArrayToCsv';
  
  /** Option A: Fixed list of CSV column names */
  targetCsvColumns?: string[];
  
  /** Option B: Generate CSV column names using a prefix and index */
  targetCsvColumnPrefix?: string;
  
  /** Maximum number of columns to generate when using prefix */
  maxColumns?: number;
  
  /** Value to use for empty array elements */
  emptyCellOutput?: string;
}

/**
 * The possible values for a HeaderMap entry
 * @template T - The target object type
 */
export type HeaderMapValue<T = any> =
  | Path<T>                   // Direct path like 'profile.name'
  | HeaderMapFn<T>            // Custom mapping function
  | CsvToArrayConfig<T>       // CSV columns -> object array property configuration
  | ObjectArrayToCsvConfig;   // Object array property -> CSV columns configuration

/**
 * Enhanced header map type that supports advanced mapping configurations
 * @template T - The target object type
 */
export type HeaderMap<T = any> = {
  [key: string | number]: HeaderMapValue<T> | (keyof T & string) | string;
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
 * 
 * // Example with array mapping
 * ```typescript
 * interface Product {
 *   id: string;
 *   name: string;
 *   images: string[];
 * }
 * 
 * const headerMap = {
 *   'sku': 'id',
 *   'name': 'name',
 *   '_images': {
 *     _type: 'csvToTargetArray',
 *     targetPath: 'images',
 *     sourceCsvColumnPattern: /^image_(\d+)$/,
 *     sortSourceColumnsBy: (match) => parseInt(match[1], 10)
 *   }
 * };
 * 
 * const { fromRowArr, toRowArr } = createHeaderMapFns<Product>(headerMap);
 * ```
 */
export function createHeaderMapFns<To, RowArr extends any[] = any[]>(
  headerMap: HeaderMap<To>,
  mergeFn?: MergeFn<To & Record<string, any>>
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
  
  // Helper function to ensure array exists at path
  const ensureArrayAtPath = (obj: any, path: string): any[] => {
    let current = obj;
    const parts = path.split('.');
    
    // Navigate to the parent object
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    // Create array if it doesn't exist
    const lastPart = parts[parts.length - 1];
    if (!current[lastPart]) {
      current[lastPart] = [];
    } else if (!Array.isArray(current[lastPart])) {
      // Convert to array if not already one
      current[lastPart] = [current[lastPart]];
    }
    
    return current[lastPart] as any[];
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
    fromRowArr: (rowArr: RowArr | Record<string, any>, allHeaders?: string[]): To & Record<string, any> => {
      const to = {} as To & Record<string, any>;
      const handledCsvHeaders = new Set<string | number>();
      
      // Convert array to object if needed and provide headers
      let rowObj: Record<string, any>;
      if (Array.isArray(rowArr)) {
        // If we're dealing with a header-based mapping but have array data,
        // convert the array to an object using header names
        const hasStringKeys = Object.keys(headerMap).some(k => isNaN(Number(k)));
        
        if (hasStringKeys && allHeaders) {
          rowObj = {};
          for (let i = 0; i < rowArr.length && i < allHeaders.length; i++) {
            rowObj[allHeaders[i]] = rowArr[i];
          }
        } else {
          // For numeric keys, keep as array
          rowObj = [...rowArr];
        }
      } else if (typeof rowArr === 'object' && rowArr !== null) {
        rowObj = rowArr;
      } else {
        throw new CSVError('Input must be an array or object');
      }
      
      // Process CsvToArrayConfig rules first to collect columns into arrays
      for (const ruleName in headerMap) {
        const rule = headerMap[ruleName];
        
        // Check if rule is a CsvToArrayConfig
        if (rule && typeof rule === 'object' && (rule as any)._type === 'csvToTargetArray') {
          const arrayRule = rule as CsvToArrayConfig<To>;
          const collectedItems: { value: any; sortKey?: string | number; sourceHeader: string | number }[] = [];
          
          // Determine which headers to scan for matches
          const headersToScan = arrayRule.sourceCsvColumns || allHeaders || Object.keys(rowObj);
          
          for (const sourceHeader of headersToScan) {
            // Skip if header doesn't exist in the row
            if (!Object.prototype.hasOwnProperty.call(rowObj, sourceHeader)) {
              continue;
            }
            
            let matches = false;
            let matchResult: RegExpExecArray | null = null;
            
            // Determine if this header matches our array mapping rule
            if (arrayRule.sourceCsvColumnPattern) {
              // Pattern-based matching
              const pattern = arrayRule.sourceCsvColumnPattern;
              const header = String(sourceHeader);
              pattern.lastIndex = 0; // Reset the regex
              matchResult = pattern.exec(header);
              matches = matchResult !== null;
            } else if (arrayRule.sourceCsvColumns) {
              // Explicit list-based matching
              matches = arrayRule.sourceCsvColumns.includes(String(sourceHeader));
            }
            
            if (matches) {
              const value = rowObj[sourceHeader];
              
              // Skip empty values if configured to do so
              if ((value === null || value === undefined || String(value).trim() === '') &&
                  arrayRule.emptyValueStrategy === 'skip') {
                continue;
              }
              
              // Apply filter if provided
              if (arrayRule.filterValue && !arrayRule.filterValue(value, String(sourceHeader))) {
                continue;
              }
              
              // Calculate sort key if needed
              let sortKey;
              if (matchResult && arrayRule.sortSourceColumnsBy) {
                sortKey = arrayRule.sortSourceColumnsBy(matchResult, String(sourceHeader));
              } else {
                sortKey = collectedItems.length; // Default to order of appearance
              }
              
              collectedItems.push({
                value,
                sortKey,
                sourceHeader
              });
              
              // Mark this header as handled
              handledCsvHeaders.add(sourceHeader);
            }
          }
          
          // Sort the collected items if needed
          if (collectedItems.length > 0 && 'sortKey' in collectedItems[0]) {
            collectedItems.sort((a, b) => {
              if (a.sortKey! < b.sortKey!) return -1;
              if (a.sortKey! > b.sortKey!) return 1;
              return 0;
            });
          }
          
          // Now add the items to the target array
          if (collectedItems.length > 0) {
            // Ensure the array exists at the target path
            const targetArray = ensureArrayAtPath(to, arrayRule.targetPath);
            
            // Add items to the array
            for (const item of collectedItems) {
              const processedValue = mergeFn 
                ? mergeFn(to, `${arrayRule.targetPath}[${targetArray.length}]`, item.value) 
                : item.value;
              
              targetArray.push(processedValue);
            }
          }
        }
      }
      
      // Process standard mappings for non-handled headers
      const processHeaderMapping = (sourceKey: string | number, value: any) => {
        // Skip headers that were already processed by array mappings
        if (handledCsvHeaders.has(sourceKey)) {
          return;
        }
        
        const mapping = headerMap[sourceKey];
        if (!mapping) {
          return; // No mapping for this key
        }
        
        if (typeof mapping === 'string') {
          // Direct string path mapping
          const processedValue = mergeFn ? mergeFn(to, mapping, value) : value;
          setPath(to, mapping, processedValue);
        } else if (typeof mapping === 'function') {
          // Function mapping
          (mapping as HeaderMapFn<To>)(to, rowObj, String(sourceKey), allHeaders);
        }
        // Skip other mapping types during fromRowArr
      };
      
      // Process all source keys
      if (Array.isArray(rowArr)) {
        for (let i = 0; i < rowArr.length; i++) {
          processHeaderMapping(i, rowArr[i]);
        }
      } else {
        for (const [key, value] of Object.entries(rowObj)) {
          processHeaderMapping(key, value);
        }
      }
      
      return to as To & Record<string, any>;
    },

    /**
     * Convert a structured object back to a row array or object
     * @param objAfterMapWasApplied - Structured object
     * @param headers - Array of header names in order (required for header-based mapping)
     * @param transformFn - Optional function to transform values when converting from object to row
     * @returns Row data as an array
     * @example
     * ```typescript
     * const user = { id: '123', profile: { firstName: 'John', lastName: 'Doe' } };
     * const row = toRowArr(user, ['user_id', 'first_name', 'last_name']);
     * // row = ['123', 'John', 'Doe']
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
      const rowObj: Record<string, any> = {};
      const handledPaths = new Set<string>();
      
      // Determine if mapping is index-based
      const isIndexBased = Object.keys(headerMap).every(k => !isNaN(Number(k)));
      
      // Process array-to-csv mappings first
      for (const objectPath in headerMap) {
        const mappingRule = headerMap[objectPath];
        
        // Handle array-to-csv mappings
        if (typeof mappingRule === 'object' && mappingRule !== null && (mappingRule as any)._type === 'targetArrayToCsv') {
          const arrayRule = mappingRule as ObjectArrayToCsvConfig;
          const sourceArray = getPath(objAfterMapWasApplied, objectPath);
          
          if (Array.isArray(sourceArray)) {
            if (arrayRule.targetCsvColumns) {
              // Fixed column names
              for (let i = 0; i < arrayRule.targetCsvColumns.length; i++) {
                const csvColName = arrayRule.targetCsvColumns[i];
                const value = i < sourceArray.length ? sourceArray[i] : null;
                const outputValue = value ?? arrayRule.emptyCellOutput ?? '';
                
                if (isIndexBased) {
                  // For index-based mapping, find the index of this column name
                  for (const [idx, headerName] of Object.entries(headers)) {
                    if (headerName === csvColName) {
                      row[Number(idx)] = outputValue;
                      break;
                    }
                  }
                } else {
                  rowObj[csvColName] = outputValue;
                }
              }
            } else if (arrayRule.targetCsvColumnPrefix) {
              // Dynamic column names with prefix
              const limit = arrayRule.maxColumns !== undefined 
                ? Math.min(arrayRule.maxColumns, sourceArray.length) 
                : sourceArray.length;
              
              for (let i = 0; i < limit; i++) {
                const csvColName = `${arrayRule.targetCsvColumnPrefix}${i + 1}`;
                const value = sourceArray[i];
                const outputValue = value ?? arrayRule.emptyCellOutput ?? '';
                
                if (isIndexBased) {
                  // For index-based mapping, find the index of this column name
                  for (const [idx, headerName] of Object.entries(headers)) {
                    if (headerName === csvColName) {
                      row[Number(idx)] = outputValue;
                      break;
                    }
                  }
                } else {
                  rowObj[csvColName] = outputValue;
                }
              }
            }
            
            handledPaths.add(objectPath);
          }
          
          continue;
        }
        
        // Skip non-array special rules during toRowArr
        if (typeof mappingRule === 'object' && mappingRule !== null && (mappingRule as any)._type === 'csvToTargetArray') {
          continue;
        }
        
        // Handle standard direct mappings and function mappings
        if (typeof mappingRule === 'string') {
          // Direct path mapping: Field path -> CSV header name
          const csvHeaderName = mappingRule;
          let value = getPath(objAfterMapWasApplied, objectPath);
          
          if (value !== undefined) {
            value = processValueForOutput(value, objectPath, transformFn);
            
            if (isIndexBased) {
              // For index-based mapping, find the numeric index of this column name
              for (const [idx, headerName] of Object.entries(headers)) {
                if (headerName === csvHeaderName) {
                  row[Number(idx)] = value;
                  break;
                }
              }
            } else {
              rowObj[csvHeaderName] = value;
            }
          }
          
          handledPaths.add(objectPath);
        } else if (typeof mappingRule === 'function') {
          // Function mapping
          if (isIndexBased) {
            // Pass the row array directly for index-based functions
            (mappingRule as HeaderMapFn<any>)(row, objAfterMapWasApplied, objectPath, headers);
          } else {
            // Pass the row object for header-based functions
            (mappingRule as HeaderMapFn<any>)(rowObj, objAfterMapWasApplied, objectPath, headers);
          }
          
          handledPaths.add(objectPath);
        }
      }
      
      // For header-based output, convert the object to an array
      if (!isIndexBased) {
        if (!headers || headers.length === 0) {
          throw new CSVError('Headers array is required for header-based mapping');
        }
        
        for (let i = 0; i < headers.length; i++) {
          const headerName = headers[i];
          row[i] = rowObj[headerName] !== undefined ? rowObj[headerName] : '';
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
export function arrayToObjArray<T>(
  data: any[],
  headerMap: HeaderMap<T>,
  headerRow?: string[],
  mergeFn?: MergeFn<T & Record<string, any>>
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
export function objArrayToArray<T>(
  data: (T & Record<string, any>)[],
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
export function groupByField<T>(
  data: (T & Record<string, any>)[],
  field: string
): Record<string, (T & Record<string, any>)[]> {
  return data.reduce((groups, item) => {
    const key = String(getPath(item, field) ?? 'undefined');
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
    return groups;
  }, {} as Record<string, (T & Record<string, any>)[]>);
}