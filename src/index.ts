/**
 * @fileoverview A production-ready TypeScript library for CSV manipulation,
 * featuring robust error handling, strong typing, and a fluent interface.
 */


import fs from 'unenv/runtime/node/fs/index';
import path from 'unenv/runtime/node/path/index';
import { parse as parseCSV, stringify as stringifyCSV } from 'csv/sync';
import { parse as parseCSVAsync, stringify as stringifyCSVAsync } from 'csv';
import { distance as levenshteinDistance } from 'fastest-levenshtein';
import {  get as lodashGet} from 'lodash';
import { createHeaderMapFns, HeaderMap, RetryOptions } from './headers'
import { Readable, Transform } from 'unenv/runtime/node/stream/index';
import { type Transform as NodeTransform } from 'node:stream'

export * from './headers'

export * from './standalone'

/**
 * Error class for CSV-related operations
 */
export class CSVError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CSVError';
    
    // Maintains proper stack trace for where the error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CSVError);
    }
  }
}

/**
 * CSV reading options
 */
export interface CSVReadOptions<T> {
  /** File system options for reading the file */
  fsOptions?: {
    encoding?: BufferEncoding;
    flag?: string;
    mode?: number;
    autoClose?: boolean;
    emitClose?: boolean;
    start?: number;
    end?: number;
    highWaterMark?: number;
  };
  csvOptions?: Parameters<typeof parseCSV>[1];
  /** Optional transform function to apply to raw file content */
  transform?: (content: string) => string;
  /** Flag to indicate the input is raw data rather than a filename */
  rawData?: boolean;
  /** Optional header mapping configuration */
  headerMap?: HeaderMap<T>;
  /** Options for retrying failed operations */
  retry?: RetryOptions;
  /** Enable validation of data against expected schema */
  validateData?: boolean;
  allowEmptyValues?: boolean;
}

/**
 * CSV writing options
 */
export interface CSVWriteOptions<T = any> {
  /** Additional header content to prepend to the CSV */
  additionalHeader?: string;
  /** Options for stringifying the CSV */
  stringifyOptions?: Parameters<typeof stringifyCSV>[1];
  /** Whether to use streaming for large files */
  streaming?: boolean;
  /** Optional header mapping configuration */
  headerMap?: HeaderMap<T>;
  /** Threshold for using streaming (number of rows) */
  streamingThreshold?: number;
  /** Options for retrying failed operations */
  retry?: RetryOptions;
}

/**
 * Options for working with CSV streams and generators
 */
export interface CSVStreamOptions<T> {
  /** CSV parsing options */
  csvOptions?: Parameters<typeof parseCSVAsync>[0];
  /** Options for transforming rows */
  transform?: (row: any) => T;
  /** Batch size for processing */
  batchSize?: number;
  /** Optional header mapping configuration */
  headerMap?: HeaderMap<T>;
  /** Options for retrying failed operations */
  retry?: RetryOptions;
  /** Buffers rows before yielding to improve performance with very large files */
  useBuffering?: boolean;
  /** Buffer size when useBuffering is true */
  bufferSize?: number;
}

/**
 * Result type for similarity matches
 */
export interface SimilarityMatch<T> {
  row: T;
  dist: number;
}

// Type definitions for callbacks
export type ComparisonCallback<T> = (row: T) => boolean;
export type ModificationCallback<T> = (row: T) => Partial<T>;
export type TransformCallback<T, R> = (row: T) => R;
export type EqualityCallback<T> = (a: T, b: T) => boolean;
export type MergeCallback<T, E> = (a: T, b: E) => T;

// Aggregation and sorting types
export type AggregateOperation = 'sum' | 'avg' | 'min' | 'max' | 'count';
export type SortDirection = 'asc' | 'desc';

/**
 * Core class for CSV data manipulation with a fluent interface
 */
export class CSV<T extends Record<string, any>> {
  private constructor(private readonly data: T[]) {}

  /**
   * Helper function to implement retry logic
   * @param operation - Function to retry
   * @param errorMessage - Error message if all retries fail
   * @param retryOptions - Retry configuration
   * @returns Result of the operation
   * @throws {CSVError} If operation fails after all retries
   */
  private static async retryOperation<R>(
    operation: () => Promise<R>,
    errorMessage: string,
    retryOptions?: RetryOptions
  ): Promise<R> {
    const maxRetries = retryOptions?.maxRetries ?? 3;
    const baseDelay = retryOptions?.baseDelay ?? 100;
    const logRetries = retryOptions?.logRetries ?? false;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          // Calculate delay with exponential backoff
          const delay = Math.pow(2, attempt) * baseDelay;
          
          if (logRetries) {
            console.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
          }
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new CSVError(`${errorMessage} after ${maxRetries} attempts`, lastError);
  }
  
  /**
   * Synchronous version of retry operation
   * @param operation - Function to retry
   * @param errorMessage - Error message if all retries fail
   * @param retryOptions - Retry configuration
   * @returns Result of the operation
   * @throws {CSVError} If operation fails after all retries
   */
  private static retryOperationSync<R>(
    operation: () => R,
    errorMessage: string,
    retryOptions?: RetryOptions
  ): R {
    const maxRetries = retryOptions?.maxRetries ?? 3;
    const baseDelay = retryOptions?.baseDelay ?? 100;
    const logRetries = retryOptions?.logRetries ?? false;
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          // Calculate delay with exponential backoff
          const delay = Math.pow(2, attempt) * baseDelay;
          
          if (logRetries) {
            console.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
          }
        }
      }
    }
    
    throw new CSVError(`${errorMessage} after ${maxRetries} attempts`, lastError);
  }
  
  /**
   * Create a CSV instance from a file
   * @param filename - Path to the CSV file
   * @param options - Reading options
   * @returns A new CSV instance
   * @throws {CSVError} If file reading or parsing fails after retries
   * @example
   * ```typescript
   * // Basic usage
   * const users = CSV.fromFile<User>('users.csv');
   * 
   * // With header mapping
   * const users = CSV.fromFile<User>('users.csv', {
   *   headerMap: {
   *     'user_id': 'id',
   *     'first_name': 'profile.firstName'
   *   }
   * });
   * 
   * // With retry options
   * const users = CSV.fromFile<User>('users.csv', {
   *   retry: { maxRetries: 5, logRetries: true }
   * });
   * ```
   */
  static fromFile<T extends Record<string, any>>(
    filename: string,
    options: CSVReadOptions<T> = {}
  ): CSV<T> {
    const operation = () => {
      const resolvedPath = path.resolve(filename);
      const fileData = fs.readFileSync(
        resolvedPath,
        options.fsOptions?.encoding as BufferEncoding || 'utf-8'
      );
      
      const content = options.transform 
        ? options.transform(fileData.toString().trim())
        : fileData.toString().trim();
      
      let parsedData: T[];
      if (options.headerMap) {
        // Use header mapping
        const csvOptions = { 
          ...(options.csvOptions || {}), 
          columns: true 
        };
        
        // Parse the CSV first
        const rawData = parseCSV(content, csvOptions) as any[];
        
        // Apply header mapping
        const { fromRowArr } = createHeaderMapFns<T>(options.headerMap);
        parsedData = rawData.map(row => fromRowArr(row));
      } else {
        // Standard parsing
        parsedData = parseCSV(
          content,
          options.csvOptions || { columns: true }
        ) as T[];
      }
      
      // Validate data if requested
      if (options.validateData && parsedData.length > 0) {
        const sampleKeys = Object.keys(parsedData[0]);
        for (let i = 0; i < parsedData.length; i++) {
          const row = parsedData[i];
          const rowKeys = Object.keys(row);
          
          // Check if row has the same keys as the first row
          if (rowKeys.length !== sampleKeys.length) {
            throw new CSVError(`Row ${i + 1} has inconsistent column count`);
          }
        }
      }
      
      return new CSV<T>(parsedData);
    };
    
    // Use retry logic if configured
    if (options.retry) {
      return this.retryOperationSync(
        operation,
        `Failed to read or parse CSV file: ${filename}`,
        options.retry
      );
    } else {
      try {
        return operation();
      } catch (error) {
        throw new CSVError(
          `Failed to read or parse CSV file: ${filename}`,
          error
        );
      }
    }
  }

  /**
   * Create a CSV instance from raw data
   * @param data - Array of objects representing CSV rows
   * @returns A new CSV instance
   */
  static fromData<T extends Record<string, any>>(data: T[]): CSV<T> {
    return new CSV<T>(Array.isArray(data) ? [...data] : []);
  }

  /**
   * Create a CSV instance from a string
   * @param csvString - CSV content as a string
   * @param options - CSV parsing options
   * @returns A new CSV instance
   * @throws {CSVError} If parsing fails
   */
  static fromString<T extends Record<string, any>>(
    csvString: string,
    options: Parameters<typeof parseCSV>[1] = { columns: true }
  ): CSV<T> {
    try {
      const parsedData = parseCSV(csvString, options) as T[];
      return new CSV<T>(parsedData);
    } catch (error) {
      throw new CSVError('Failed to parse CSV string', error);
    }
  }
  
  /**
   * Create a CSV instance from a readable stream
   * @param stream - Readable stream containing CSV data
   * @param options - CSV parsing options
   * @returns Promise resolving to a new CSV instance
   * @throws {CSVError} If parsing fails
   */
  static async fromStream<T extends Record<string, any>>(
    stream: NodeJS.ReadableStream,
    options: { columns?: boolean } = { columns: true }
  ): Promise<CSV<T>> {
    try {
      return new Promise((resolve, reject) => {
        const data: T[] = [];
        const parser = parseCSVAsync(options);
        
        parser.on('readable', () => {
          let record;
          while ((record = parser.read()) !== null) {
            data.push(record as T);
          }
        });
        
        parser.on('error', (err) => {
          reject(new CSVError('Failed to parse CSV stream', err));
        });
        
        parser.on('end', () => {
          resolve(new CSV<T>(data));
        });
        
        stream.pipe(parser);
      });
    } catch (error) {
      throw new CSVError('Failed to parse CSV stream', error);
    }
  }
  
  /**
   * Create a CSV instance from a file asynchronously using streams
   * @param filename - Path to the CSV file
   * @param options - Reading options
   * @returns Promise resolving to a new CSV instance
   * @throws {CSVError} If file reading or parsing fails
   */
  static async fromFileAsync<T extends Record<string, any>>(
    filename: string,
    options: CSVReadOptions<T> = {}
  ): Promise<CSV<T>> {
    try {
      const resolvedPath = path.resolve(filename);
      const stream = fs.createReadStream(resolvedPath, options.fsOptions);
      return CSV.fromStream<T>(stream, { columns: options.csvOptions?.columns === false ? false : true });
    } catch (error) {
      throw new CSVError(
        `Failed to read or parse CSV file asynchronously: ${filename}`,
        error
      );
    }
  }

  /**
   * Write the current data to a CSV file
   * @param filename - Destination file path
   * @param options - Writing options
   * @throws {CSVError} If writing fails after retries
   * @example
   * ```typescript
   * // Basic writing
   * users.writeToFile('users_export.csv');
   * 
   * // With header mapping
   * users.writeToFile('users_export.csv', {
   *   headerMap: {
   *     'id': 'ID',
   *     'profile.firstName': 'First Name',
   *     'profile.lastName': 'Last Name'
   *   }
   * });
   * 
   * // With streaming for large files
   * users.writeToFile('users_export.csv', { 
   *   streaming: true,
   *   streamingThreshold: 500 // Default is 1000
   * });
   * ```
   */
  writeToFile(filename: string, options: CSVWriteOptions<T> = {}): void {
    const operation = () => {
      const outputPath = filename.endsWith('.csv') 
        ? filename 
        : `${filename}.csv`;
      
      const streamingThreshold = options.streamingThreshold || 1000;
      
      // Apply header mapping if provided
      if (options.headerMap) {
        const stringifyOptions = options.stringifyOptions || { header: true };
        const headers = Array.isArray(stringifyOptions.header) 
          ? stringifyOptions.header 
          : Object.keys(this.data[0] || {});
        
        const { toRowArr } = createHeaderMapFns<T>(options.headerMap);
        
        // Transform the data through the header map
        const rows = this.data.map(item => toRowArr(item, headers));
        
        // Add headers as the first row if needed
        if (stringifyOptions.header === true) {
          rows.unshift(headers);
        }
        
        // Use a custom stringifier without the header option since we've manually handled it
        const csvString = rows.map(row => 
          row.map(cell => {
            if (cell === null || cell === undefined) return '';
            return typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))
              ? `"${cell.replace(/"/g, '""')}"`
              : String(cell);
          }).join(',')
        ).join('\n');
        
        fs.writeFileSync(
          outputPath,
          (options.additionalHeader || '') + csvString,
          'utf-8'
        );
        return;
      }
      
      // Standard CSV writing without header mapping
      if (options.streaming && this.data.length > streamingThreshold) {
        // Use streaming for large datasets
        const stringifier = stringifyCSVAsync(
          options.stringifyOptions || { header: true }
        );
        
        const readable = Readable.from(this.data);
        const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
        
        if (options.additionalHeader) {
          writable.write(options.additionalHeader);
        }
        
        readable.pipe(stringifier).pipe(writable);
      } else {
        // Use synchronous version for smaller datasets
        const csvString = stringifyCSV(
          this.data,
          options.stringifyOptions || { header: true }
        );
        
        fs.writeFileSync(
          outputPath,
          (options.additionalHeader || '') + csvString,
          'utf-8'
        );
      }
    };
    
    // Use retry logic if configured
    if (options.retry) {
      CSV.retryOperationSync(
        operation,
        `Failed to write CSV to file: ${filename}`,
        options.retry
      );
    } else {
      try {
        operation();
      } catch (error) {
        throw new CSVError(
          `Failed to write CSV to file: ${filename}`,
          error
        );
      }
    }
  }
  
  /**
   * Write CSV data to a file asynchronously
   * @param filename - Destination file path
   * @param options - Writing options
   * @returns Promise that resolves when writing is complete
   */
  async writeToFileAsync(filename: string, options: CSVWriteOptions = {}): Promise<void> {
    try {
      const outputPath = filename.endsWith('.csv') 
        ? filename 
        : `${filename}.csv`;
      
      return new Promise((resolve, reject) => {
        const stringifier = stringifyCSVAsync(
          options.stringifyOptions || { header: true }
        );
        
        const readable = Readable.from(this.data);
        const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
        
        if (options.additionalHeader) {
          writable.write(options.additionalHeader);
        }
        
        writable.on('finish', resolve);
        writable.on('error', reject);
        
        readable.pipe(stringifier).pipe(writable);
      });
    } catch (error) {
      throw new CSVError(
        `Failed to write CSV to file asynchronously: ${filename}`,
        error
      );
    }
  }

  /**
   * Convert the current data to a CSV string
   * @param options - Stringify options
   * @returns CSV content as a string
   * @throws {CSVError} If stringification fails
   */
  toString(options: Parameters<typeof stringifyCSV>[1] = { header: true }): string {
    try {
      return stringifyCSV(this.data, options);
    } catch (error) {
      throw new CSVError('Failed to convert data to CSV string', error);
    }
  }

  /**
   * Get the data as an array
   * @returns Copy of the underlying data array
   */
  toArray(): T[] {
    return [...this.data];
  }

  /**
   * Get the number of rows
   * @returns Row count
   */
  count(): number {
    return this.data.length;
  }

  /**
   * Creates a base row with the structure of the CSV data
   * @param defaults - Optional default values
   * @returns A new object with the CSV structure
   * @throws {CSVError} If the CSV has no rows
   */
  getBaseRow<R extends { [K in keyof T]?: any } = { [K in keyof T]?: undefined }>(
    defaults?: Partial<T>
  ): R {
    if (this.data.length === 0) {
      throw new CSVError('Cannot create base row from empty data');
    }

    const baseRow = Object.fromEntries(
      Object.entries(this.data[0]).map(([key]) => [key, undefined])
    ) as { [K in keyof T]: undefined };

    return defaults ? { ...baseRow, ...defaults } as R : baseRow as R;
  }

  /**
   * Create a new row with the CSV structure
   * @param data - The data to populate the row with
   * @returns A new object with all CSV fields
   */
  createRow(data: Partial<T> = {}): T {
    return { ...this.getBaseRow(), ...data };
  }

  /**
   * Find the first row where column matches value exactly
   * @param value - The value to match
   * @param column - The column to check (default: 'id')
   * @returns The matching row or undefined
   */
  findRow(value: any, column: keyof T = 'id' as keyof T): T | undefined {
    return this.data.find(row => 
      String(row[column]).trim() === String(value).trim()
    );
  }

  /**
   * Find rows that match a regular expression
   * @param regex - The pattern to match
   * @param column - The column to check (default: 'id')
   * @returns The matching row or undefined
   */
  findRowByRegex(regex: RegExp, column: keyof T = 'id' as keyof T): T | undefined {
    return this.data.find(row => 
      regex.test(String(row[column]).trim())
    );
  }

  /**
   * Find rows by similarity to a string value
   * @param str - The string to compare with
   * @param column - The column to check
   * @returns Array of matches with similarity scores
   */
  findSimilarRows(str: string, column: keyof T): SimilarityMatch<T>[] {
    return [...this.data]
      .map(row => ({
        row,
        dist: levenshteinDistance(str, String(row[column]))
      }))
      .sort((a, b) => a.dist - b.dist);
  }

  /**
   * Find the most similar row to a string value
   * @param str - The string to compare with
   * @param column - The column to check
   * @returns The best match or undefined
   */
  findMostSimilarRow(str: string, column: keyof T): SimilarityMatch<T> | undefined {
    const matches = this.findSimilarRows(str, column);
    return matches.length > 0 ? matches[0] : undefined;
  }

  /**
   * Find all rows containing a value
   * @param value - The value to search for
   * @param column - The column to check (default: 'id')
   * @returns Array of matching rows
   */
  findRows(value: any, column: keyof T = 'id' as keyof T): T[] {
    return this.data.filter(row => 
      String(row[column]).includes(String(value))
    );
  }

  /**
   * Find the first row matching a condition
   * @param predicate - Function to test each row
   * @returns The first matching row or undefined
   */
  findRowWhere(predicate: ComparisonCallback<T>): T | undefined {
    return this.data.find(predicate);
  }

  /**
   * Find all rows matching a condition
   * @param predicate - Function to test each row
   * @returns Array of matching rows
   */
  findRowsWhere(predicate: ComparisonCallback<T>): T[] {
    return this.data.filter(predicate);
  }

  /**
   * Group rows by values in a column
   * @param column - The column to group by
   * @returns Object with groups of rows
   */
  groupBy(column: keyof T): Record<string, T[]> {
    return this.data.reduce((acc, row) => {
      const key = String(row[column]);
      if (!acc[key]) acc[key] = [];
      acc[key].push({ ...row });
      return acc;
    }, {} as Record<string, T[]>);
  }

  /**
   * Update all rows with new values
   * @param modifications - Object with new values or function that returns them
   * @returns A new CSV instance with modified data
   */
  update<E extends Partial<T> = T>(modifications: (Partial<T> | ModificationCallback<T>) & E): CSV<T> {
    const newData = this.data.map(row => {
      const changes = typeof modifications === 'function' 
        ? modifications(row) 
        : modifications;
      return { ...row, ...changes };
    });
    return new CSV<T>(newData);
  }

  /**
   * Update rows that match a condition
   * @param condition - The condition to match
   * @param modifications - Object with new values or function that returns them
   * @returns A new CSV instance with modified data
   */
  updateWhere(
    condition: ComparisonCallback<T>,
    modifications: Partial<T> | ModificationCallback<T>
  ): CSV<T> {
    const newData = this.data.map(row => {
      if (!condition(row)) return { ...row };
      
      const changes = typeof modifications === 'function' 
        ? modifications(row) 
        : modifications;
      return { ...row, ...changes };
    });
    return new CSV<T>(newData);
  }

  /**
   * Update a specific column for all rows
   * @param column - The column to update
   * @param value - New value or function to calculate it
   * @returns A new CSV instance with modified data
   */
  updateColumn<K extends keyof T>(
    column: K,
    value: T[K] | ((current: T[K], row: T) => T[K])
  ): CSV<T> {
    const newData = this.data.map(row => ({
      ...row,
      [column]: typeof value === 'function' 
        ? (value as Function)(row[column], row) 
        : value
    }));
    return new CSV<T>(newData);
  }

  /**
   * Transform rows into a different structure
   * @param transformer - Function to transform each row
   * @returns A new CSV instance with transformed data
   */
  transform<R extends Record<string, any>>(
    transformer: TransformCallback<T, R>
  ): CSV<R> {
    return new CSV<R>(this.data.map(transformer));
  }

  /**
   * Remove rows matching a condition
   * @param condition - The condition to match
   * @returns A new CSV instance without matching rows
   */
  removeWhere(condition: ComparisonCallback<T>): CSV<T> {
    return new CSV<T>(this.data.filter(row => !condition(row)));
  }

  /**
   * Add new rows to the data
   * @param rows - The rows to add
   * @returns A new CSV instance with added rows
   */
  append(...rows: T[]): CSV<T> {
    return new CSV<T>([...this.data, ...rows]);
  }

  /**
   * Sort rows by a column
   * @param column - The column to sort by
   * @param direction - Sort direction (default: 'asc')
   * @returns A new CSV instance with sorted data
   */
  sortBy<K extends keyof T>(
    column: K,
    direction: SortDirection = 'asc'
  ): CSV<T> {
    const newData = [...this.data].sort((a, b) => {
      const aVal = a[column];
      const bVal = b[column];
      
      // Handle numeric values
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      
      // Default string comparison
      const aStr = String(aVal);
      const bStr = String(bVal);
      const comparison = aStr.localeCompare(bStr);
      return direction === 'asc' ? comparison : -comparison;
    });
    
    return new CSV<T>(newData);
  }

  /**
   * Calculate aggregate values for a column
   * @param column - The column to aggregate
   * @param operation - The aggregation operation
   * @returns The calculated value
   * @throws {CSVError} For unknown operations or inappropriate data
   */
  aggregate<K extends keyof T>(
    column: K,
    operation: AggregateOperation = 'sum'
  ): number {
    const values = this.data
      .map(row => Number(row[column]))
      .filter(val => !isNaN(val));

    if (values.length === 0) {
      if (operation === 'count') return 0;
      throw new CSVError(`No numeric values found in column "${String(column)}"`);
    }

    switch (operation) {
      case 'sum':
        return values.reduce((sum, val) => sum + val, 0);
      case 'avg':
        return values.reduce((sum, val) => sum + val, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'count':
        return values.length;
      default:
        throw new CSVError(`Unknown aggregation operation: ${operation}`);
    }
  }

  /**
   * Get unique values from a column
   * @param column - The column to get values from
   * @returns Array of unique values
   */
  distinct<K extends keyof T>(column: K): Array<T[K]> {
    return [...new Set(this.data.map(row => row[column]))];
  }

  /**
   * Create a pivot table from the data
   * @param rowColumn - Column for row labels
   * @param colColumn - Column for column labels
   * @param valueColumn - Column for values
   * @returns Pivot table as nested object
   */
  pivot(
    rowColumn: keyof T,
    colColumn: keyof T,
    valueColumn: keyof T
  ): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};

    this.data.forEach(row => {
      const rowKey = String(row[rowColumn]);
      const colKey = String(row[colColumn]);
      const value = row[valueColumn];

      if (!result[rowKey]) result[rowKey] = {};
      result[rowKey][colKey] = value;
    });

    return result;
  }

/**
 * Merge with another dataset
 * @param other - The data to merge with
 * @param equalityFn - Function to determine equality
 * @param mergeFn - Function to merge equal rows
 * @returns A new CSV instance with merged data
 */
mergeWith<E extends Record<string, any>>(
  other: E[] | CSV<E>,
  equalityFn: (a: T, b: E) => boolean,
  mergeFn: (a: T, b: E) => T
): CSV<T> {
  const otherData = other instanceof CSV ? other.toArray() : other;
  const processedA = new Set<unknown>();
  const processedB = new Set<unknown>();
  const result: T[] = [];
  
  // Find and merge matching rows
  for (const itemA of this.data) {
    for (const itemB of otherData) {
      if (processedB.has(itemB)) continue;
      
      if (equalityFn(itemA, itemB)) {
        result.push(mergeFn(itemA, itemB));
        processedA.add(itemA);
        processedB.add(itemB);
        break;
      }
    }
  }
  
  // Add remaining rows from this dataset
  for (const itemA of this.data) {
    if (!processedA.has(itemA)) {
      result.push({ ...itemA });
    }
  }
  
  // Add remaining rows from other dataset
  for (const itemB of otherData) {
    if (!processedB.has(itemB)) {
      result.push({ ...(itemB as unknown as T) });
    }
  }
  
  return new CSV<T>(result);
}

  /**
   * Process rows with a callback
   * @param callback - Function to process each row
   */
  forEach(callback: (row: T, index: number) => void): void {
    this.data.forEach(callback);
  }
  
  /**
   * Process rows with an async callback
   * @param callback - Async function to process each row
   * @returns Promise that resolves when processing is complete
   */
  async forEachAsync(callback: (row: T, index: number) => Promise<void>): Promise<void> {
    for (let i = 0; i < this.data.length; i++) {
      await callback(this.data[i], i);
    }
  }

  /**
   * Map over rows to create a new array
   * @param callback - Function to map each row
   * @returns Array of mapped values
   */
  map<R>(callback: (row: T, index: number) => R): R[] {
    return this.data.map(callback);
  }
  
  /**
   * Map over rows asynchronously
   * @param callback - Async function to map each row
   * @returns Promise resolving to array of mapped values
   */
  async mapAsync<R>(callback: (row: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < this.data.length; i++) {
      results.push(await callback(this.data[i], i));
    }
    return results;
  }

  /**
   * Reduce the rows to a single value
   * @param callback - Reducer function
   * @param initialValue - Starting value
   * @returns Reduced value
   */
  reduce<R>(
    callback: (accumulator: R, row: T, index: number) => R,
    initialValue: R
  ): R {
    return this.data.reduce(callback, initialValue);
  }
  
  /**
   * Reduce the rows asynchronously
   * @param callback - Async reducer function
   * @param initialValue - Starting value
   * @returns Promise resolving to reduced value
   */
  async reduceAsync<R>(
    callback: (accumulator: R, row: T, index: number) => Promise<R>,
    initialValue: R
  ): Promise<R> {
    let result = initialValue;
    for (let i = 0; i < this.data.length; i++) {
      result = await callback(result, this.data[i], i);
    }
    return result;
  }

  /**
   * Sample rows from the data
   * @param count - Number of rows to sample (default: 1)
   * @returns A new CSV instance with sampled rows
   */
  sample(count: number = 1): CSV<T> {
    if (count <= 0) return new CSV<T>([]);
    if (count >= this.data.length) return new CSV<T>([...this.data]);

    const shuffled = [...this.data].sort(() => 0.5 - Math.random());
    return new CSV<T>(shuffled.slice(0, count));
  }

  /**
   * Get the first n rows
   * @param count - Number of rows to get
   * @returns A new CSV instance with the first rows
   */
  head(count: number = 10): CSV<T> {
    return new CSV<T>([...this.data.slice(0, count)]);
  }

  /**
   * Get the last n rows
   * @param count - Number of rows to get
   * @returns A new CSV instance with the last rows
   */
  tail(count: number = 10): CSV<T> {
    return new CSV<T>([...this.data.slice(-count)]);
  }
}

/**
 * Static utility functions for working with CSV data
 */
export const CSVUtils = {
  /**
   * Merge two arrays of objects
   * @param arrayA - First array
   * @param arrayB - Second array
   * @param equalityFn - Function to determine equality
   * @param mergeFn - Function to merge equal items
   * @returns A new array with merged items
   */
  mergeRows<T extends Record<string, any>, E extends T & Record<string, any>>(
    arrayA: T[],
    arrayB: E[],
    equalityFn: EqualityCallback<T | E>,
    mergeFn: MergeCallback<T,E>
  ): T[] {
    return CSV.fromData(arrayA)
      .mergeWith(arrayB, equalityFn, mergeFn)
      .toArray();
  },

  /**
   * Deep clone an object
   * @param obj - The object to clone
   * @returns A deep copy of the object
   */
  clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  },

  /**
   * Simple utility to check if a string is valid CSV
   * @param str - String to validate
   * @returns True if the string appears to be valid CSV
   */
  isValidCSV(str: string): boolean {
    try {
      parseCSV(str, { to: 5 });
      return true;
    } catch {
      return false;
    }
  },
  
  /**
   * Write data to a CSV file
   * @param filename - Destination file path
   * @param data - Array of objects to write
   * @param options - Writing options
   * @returns void
   */
  writeCSV<T extends Record<string, any>>(
    filename: string,
    data: T[],
    options: CSVWriteOptions = {}
  ): void {
    CSV.fromData(data).writeToFile(filename, options);
  },
  
  /**
   * Write data to a CSV file asynchronously
   * @param filename - Destination file path
   * @param data - Array of objects to write
   * @param options - Writing options
   * @returns Promise that resolves when writing is complete
   */
  async writeCSVAsync<T extends Record<string, any>>(
    filename: string,
    data: T[],
    options: CSVWriteOptions = {}
  ): Promise<void> {
    await CSV.fromData(data).writeToFileAsync(filename, options);
  },
  
  /**
   * Create a CSV transformer stream for processing data
   * @param transform - Function to transform each row
   * @returns Transform stream
   */
  createTransformer<T, R>(transform: (row: T) => R): NodeTransform {
    return new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        try {
          const transformed = transform(chunk);
          callback(null, transformed);
        } catch (error) {
          callback(error);
        }
      }
    });
  }
};

/**
 * Process CSV data with an async generator and header mapping
 * @param filename - Path to the CSV file
 * @param options - Stream options
 * @returns Async generator yielding rows
 */
export async function* csvGenerator<T extends Record<string, any>>(
  filename: string,
  options: CSVStreamOptions<T> = {}
): AsyncGenerator<T, void, undefined> {
  const resolvedPath = path.resolve(filename);
  const stream = fs.createReadStream(resolvedPath);
  const parser = parseCSVAsync({
    ...options.csvOptions,
    columns: true // Ensure we get objects, not arrays
  });
  
  stream.pipe(parser);
  
  const headerMap = options.headerMap;
  const transformFn = options.transform;
  
  if (headerMap) {
    // Use header mapping
    const { fromRowArr } = createHeaderMapFns<T>(headerMap);
    
    for await (const record of parser) {
      const mappedRecord = fromRowArr(record);
      yield transformFn ? transformFn(mappedRecord) : mappedRecord;
    }
  } else {
    // Standard processing without header mapping
    for await (const record of parser) {
      yield transformFn ? transformFn(record) : record as T;
    }
  }
}

/**
 * Process CSV data in batches with an async generator
 * @param filename - Path to the CSV file
 * @param options - Stream options
 * @returns Async generator yielding batches of rows
 */
export async function* csvBatchGenerator<T extends Record<string, any>>(
  filename: string,
  options: CSVStreamOptions<T> = { batchSize: 100 }
): AsyncGenerator<T[], void, undefined> {
  const batchSize = options.batchSize || 100;
  let batch: T[] = [];
  
  for await (const record of csvGenerator<T>(filename, options)) {
    batch.push(record);
    
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  
  if (batch.length > 0) {
    yield batch;
  }
}

/**
 * Write CSV data using an async generator with optional header mapping
 * @param filename - Destination file path
 * @param generator - Async generator yielding rows
 * @param options - Writing options
 * @returns Promise that resolves when writing is complete
 */
export async function writeCSVFromGenerator<T extends Record<string, any>>(
  filename: string,
  generator: AsyncGenerator<T, void, undefined>,
  options: CSVWriteOptions = {}
): Promise<void> {
  const outputPath = filename.endsWith('.csv') 
    ? filename 
    : `${filename}.csv`;
    
  return new Promise((resolve, reject) => {
    try {
      const stringifyOptions = options.stringifyOptions || { header: true };
      const stringifier = stringifyCSVAsync(stringifyOptions);
      
      const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
      
      if (options.additionalHeader) {
        writable.write(options.additionalHeader);
      }
      
      writable.on('finish', resolve);
      writable.on('error', reject);
      
      if (options.headerMap) {
        // With header mapping
        (async () => {
          try {
            // Get headers
            const headers = Array.isArray(stringifyOptions.header) 
              ? stringifyOptions.header 
              : [];
            
            const headerMap = options.headerMap as { [x: string]: string | keyof T; [x: number]: string | keyof T };
            const { toRowArr } = createHeaderMapFns<T>(headerMap);
            
            // Create a transform stream that applies the header mapping
            const transformer = new Transform({
              objectMode: true,
              transform(chunk, encoding, callback) {
                try {
                  const mappedRow = toRowArr(chunk, headers);
                  callback(null, mappedRow);
                } catch (error) {
                  callback(error);
                }
              }
            });
            
            transformer.pipe(stringifier).pipe(writable);
            
            for await (const row of generator) {
              transformer.write(row);
            }
            
            transformer.end();
          } catch (error) {
            reject(new CSVError('Failed to write CSV from generator with header mapping', error));
          }
        })();
      } else {
        // Without header mapping
        (async () => {
          try {
            stringifier.pipe(writable);
            
            for await (const row of generator) {
              stringifier.write(row);
            }
            
            stringifier.end();
          } catch (error) {
            reject(new CSVError('Failed to write CSV from generator', error));
          }
        })();
      }
    } catch (error) {
      reject(new CSVError('Failed to set up CSV writing from generator', error));
    }
  });
}

/**
 * Additional utility functions for working with arrays and objects
 */
export const CSVArrayUtils = {
  /**
   * Transforms an array of arrays or objects into an array of structured objects
   * @template T - The type of the target object
   * @param data - Array of arrays or objects to transform
   * @param headerMap - Mapping between array indices or header names and object properties
   * @param headerRow - Optional header row for object input (if headerMap uses header names)
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
   * const products = CSVArrayUtils.arrayToObjArray<Product>(
   *   csvData.slice(1), // Skip header row
   *   { 0: 'id', 1: 'details.name', 2: 'details.price' }
   * );
   * ```
   */
  arrayToObjArray<T extends Record<string, any>>(
    data: any[],
    headerMap: HeaderMap<T>,
    headerRow?: string[]
  ): T[] {
    if (!Array.isArray(data)) {
      throw new CSVError('Data must be an array');
    }
    
    if (data.length === 0) {
      return [];
    }
    
    const { fromRowArr } = createHeaderMapFns<T>(headerMap);
    
    // If first item is an array but keys are strings, we need header row
    const firstItem = data[0];
    const isArrayData = Array.isArray(firstItem);
    const hasStringKeys = Object.keys(headerMap).some(k => isNaN(Number(k)));
    
    if (isArrayData && hasStringKeys && !headerRow) {
      throw new CSVError('Header row is required for string-keyed header map with array data');
    }
    
    return data.map(row => {
      // If working with arrays and string header maps, convert to object first
      if (isArrayData && hasStringKeys && headerRow) {
        const objRow: Record<string, any> = {};
        for (let i = 0; i < row.length && i < headerRow.length; i++) {
          objRow[headerRow[i]] = row[i];
        }
        return fromRowArr(objRow);
      }
      
      return fromRowArr(row);
    });
  },

  /**
   * Transforms an array of structured objects into an array of arrays
   * @template T - The type of the source object
   * @param data - Array of structured objects to transform
   * @param headerMap - Mapping between object properties and array indices or header names
   * @param headers - Optional array of headers (required for header-based mapping)
   * @param includeHeaders - Whether to include headers as the first row
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
   * const csvData = CSVArrayUtils.objArrayToArray<Product>(
   *   products,
   *   { 'id': 0, 'details.name': 1, 'details.price': 2 },
   *   ['SKU', 'NAME', 'PRICE'],
   *   true
   * );
   * ```
   */
  objArrayToArray<T extends Record<string, any>>(
    data: T[],
    headerMap: HeaderMap,
    headers: string[] = [],
    includeHeaders: boolean = false
  ): any[][] {
    if (!Array.isArray(data)) {
      throw new CSVError('Data must be an array');
    }
    
    if (data.length === 0) {
      return includeHeaders && headers.length > 0 ? [headers] : [];
    }
    
    const inverseMap: { [x: string]: string; [x: number]: string } = {};
    for (const [key, value] of Object.entries(headerMap)) {
      if (typeof value === 'string') {
        inverseMap[value] = key;
      }
    }
    
    const { toRowArr } = createHeaderMapFns(inverseMap);
    
    const rows = data.map(obj => toRowArr(obj, headers));
    
    if (includeHeaders && headers.length > 0) {
      return [headers, ...rows];
    }
    
    return rows;
  },

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
   * const byCustomer = CSVArrayUtils.groupByField(orders, 'customer.id');
   * ```
   */
  groupByField<T extends Record<string, any>>(
    data: T[],
    field: string
  ): Record<string, T[]> {
    return data.reduce((groups, item) => {
      const key = String(lodashGet(item, field) || 'undefined');
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(item);
      return groups;
    }, {} as Record<string, T[]>);
  }
};


// Default export for easier imports
export default CSV;