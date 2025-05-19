/**
 * @fileoverview A production-ready TypeScript library for CSV manipulation,
 * featuring robust error handling, strong typing, and a fluent interface.
 */


import fs from 'node:fs';
import path from 'node:path';
import { parse as parseCSV, stringify as stringifyCSV } from 'csv/sync';
import { parse as parseCSVAsync, stringify as stringifyCSVAsync } from 'csv';
import { distance as levenshteinDistance } from 'fastest-levenshtein';
import { get as lodashGet } from 'lodash';
import { createHeaderMapFns, HeaderMap, RetryOptions } from './headers'
import { StandardSchemaV1, tryValidateStandardSchemaSync, tryValidateStandardSchemaAsync, CSVSchemaConfig, RowValidationResult } from './schema'
import { Readable, Transform, Writable, pipeline as streamPipeline } from 'node:stream';
import { type Transform as NodeTransform } from 'node:stream'
import { promisify } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

export * from './headers'
export * from './schema'
export * from './standalone'

/**
 * Options for creating a CSV instance from pre-existing data.
 */
export interface CSVFromDataOptions<T extends Record<string, any>> {
  /**
   * Schema to validate the provided data objects against.
   * If schema validation fails and mode is 'error', an error will be thrown.
   * If mode is 'filter', invalid objects will be removed.
   * If mode is 'keep', validationResults will be populated on the CSV instance.
   */
  schema?: CSVSchemaConfig<T>;
  // We are deliberately OMITTING customCasts here for fromData
  // as their primary design is for string inputs from CSV parsing.
  // Coercion of existing object properties should ideally be handled by
  // the schema itself (e.g., Zod's coerce) or a separate transformation step.
}

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

export type CsvParseOptions = Parameters<typeof parseCSV>[1];
type CsvParseInternalOptions = Exclude<Parameters<typeof parseCSV>[1], null | undefined>

export type CsvStringifyOptions<T = any> = Parameters<typeof stringifyCSV>[1] | {
  stringifyOptions?: Parameters<typeof stringifyCSV>[1];
  headerMap?: HeaderMap<T>;
};

/**
 * Context for casting functions, similar to csv-parse's CastingContext
 */
export interface CastingContext {
  /** Column name or index */
  column: string | number;
  /** Is it the header row? (Usually false for custom casting stage) */
  header: boolean;
  /** Index of the field in the record */
  index: number;
  /** Line number in the source */
  lines: number;
  /** Number of records parsed so far */
  records: number;
  /** Count of empty lines */
  empty_lines: number;
  /** Count of rows with inconsistent field lengths */
  invalid_field_length: number;
  /** Is the field quoted? */
  quoting: boolean;
}

/**
 * Functions for testing if a value should be cast and performing the casting
 */
export type CastTestFunction = (value: string, context: CastingContext) => boolean;
export type CastParseFunction<TargetType> = (value: string, context: CastingContext) => TargetType;

/**
 * Definition of a caster that converts string values to a target type
 */
export interface Caster<TargetType> {
  /**
   * Tests if a string value is a candidate for this caster
   * @param value The string value from the CSV cell (after csv-parse's initial processing)
   * @param context An object containing column name, line number, etc.
   * @returns True if this caster should attempt to parse the value
   */
  test: CastTestFunction;
  /**
   * Parses the string value into the target type
   * Called only if `test` returns true
   * @param value The string value to parse
   * @param context An object containing column name, line number, etc.
   * @returns The parsed value of TargetType
   * @throws If parsing fails and strict error handling is desired
   */
  parse: CastParseFunction<TargetType>;
}

/**
 * Set of type-specific casters to apply to CSV values
 */
export interface CustomCastDefinition {
  string?: Caster<string>;
  number?: Caster<number>;
  boolean?: Caster<boolean>;
  date?: Caster<Date>;
  object?: Caster<object>;
  array?: Caster<any[]>;
  null?: Caster<null>;
}

/**
 * Configuration for column-specific casting 
 */
export type ColumnCastConfig<T extends Record<string, any>> = {
  [K in keyof T]?: keyof CustomCastDefinition | Caster<T[K]> | (keyof CustomCastDefinition | Caster<any>)[];
} | {
  [columnName: string]: keyof CustomCastDefinition | Caster<any> | (keyof CustomCastDefinition | Caster<any>)[];
};

/**
 * CSV reading options
 */
export interface CSVReadOptions<T extends Record<string, any>> {
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
  /** Enable basic validation of data against expected schema */
  validateData?: boolean;
  /** Enable standard schema validation of data */
  schema?: CSVSchemaConfig<T>;
  allowEmptyValues?: boolean;
  /**
   * Controls the extraction of initial lines as an "additional header" (preamble).
   * These lines are stored in `csvInstance.additionalHeader`.
   *
   * - If `number > 0`: Specifies the exact number of lines to extract as the preamble.
   *   Data parsing will start after these lines, unless `csvOptions.from_line` (or `from`)
   *   is set and points to an even later line.
   *
   * - If `true`: Enables preamble extraction *if* `csvOptions.from_line` (or `from`)
   *   is set to a value greater than 1. The preamble will consist of `csvOptions.from_line - 1` lines.
   *   If `csvOptions.from_line` is not set or is 1, no preamble is extracted with `true`.
   *
   * - If `false`, `0`, or `undefined`: No preamble is extracted.
   */
  saveAdditionalHeader?: boolean | number;
  /**
   * Optional CSV parsing options specifically for the preamble (additional header) lines.
   * If provided, these options will be used when parsing the preamble.
   * If not provided, relevant low-level parsing options (like delimiter, quote, escape)
   * might be inherited from the main `csvOptions` by default (see implementation for details),
   * or a very basic parsing configuration will be used.
   *
   * **Important:** Options like `columns`, `from_line`, `to_line` will be overridden
   * internally for preamble extraction. You should primarily use this for options
   * like `delimiter`, `quote`, `escape`, `record_delimiter`, `ltrim`, `rtrim`, `bom`.
   */
  additionalHeaderParseOptions?: Parameters<typeof parseCSV>[1];
  /**
   * Custom type casting options that are applied after csv-parse's built-in casting
   * but before data validation
   */
  customCasts?: {
    /** 
     * A global set of custom casting definitions.
     * These are tried if a column doesn't have a specific rule in `columnCasts`.
     */
    definitions?: CustomCastDefinition;
    /**
     * Per-column casting rules. The key is the column name (after initial parsing and header mapping).
     * The value can be:
     * - A string key of a caster defined in `definitions` (e.g., 'number', 'date').
     * - A custom Caster object `{ test, parse }`.
     * - An array of the above, tried in order until one succeeds.
     * If not specified for a column, or if all rules fail, the value remains as parsed by `csv-parse`.
     */
    columnCasts?: ColumnCastConfig<T>;
    /** 
     * What to do if a specific cast's `parse` function throws an error.
     * - 'error': Propagate the error, failing the CSV loading. (default)
     * - 'null': Set the value to null.
     * - 'original': Keep the original string value (as received by the custom caster).
     */
    onCastError?: 'error' | 'null' | 'original';
  };
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
  /** Validation results if schema validation was used with 'keep' mode */
  readonly validationResults?: RowValidationResult<T>[];

  private constructor(
    private readonly data: T[],
    readonly additionalHeader?: string,
    validationResults?: RowValidationResult<T>[]
  ) {
    this.validationResults = validationResults;
  }

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

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

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

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

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
   * Validates data using a standard schema configuration.
   * This method can validate at both row and column levels.
   *
   * @param data - The data to validate
   * @param schemaConfig - The schema configuration
   * @param baseLineNumber - The base line number for error reporting
   * @returns A tuple containing: [validatedData, validationResults]
   * @private
   */
  /**
   * Validates data synchronously using a standard schema configuration.
   * This method throws an error if the schema is configured for async validation.
   *
   * @param data - The data to validate
   * @param schemaConfig - The schema configuration
   * @param baseLineNumber - The base line number for error reporting
   * @returns A tuple containing: [validatedData, validationResults]
   * @private
   */
  private static _validateWithSchemaSync<T extends Record<string, any>>(
    data: Record<string, any>[],
    schemaConfig: CSVSchemaConfig<T>,
    baseLineNumber: number = 1
  ): [T[], RowValidationResult<T>[]] {
    const { rowSchema, columnSchemas, validationMode = 'error', useAsync = false } = schemaConfig;

    // If schema is configured for async validation, throw an error in this sync method
    if (useAsync) {
      throw new CSVError(
        "Asynchronous schema validation is not supported in synchronous CSV methods. Use an async method (e.g., fromFileAsync, validateAsync) or set useAsync: false."
      );
    }

    const validationResults: RowValidationResult<T>[] = [];
    const validatedData: T[] = [];

    // Function to validate a row synchronously
    const validateRowSync = (row: Record<string, any>, index: number): RowValidationResult<T> => {
      const result: RowValidationResult<T> = {
        originalRow: row,
        valid: true
      };

      // Validate row using row schema if provided
      if (rowSchema) {
        const rowValidation = tryValidateStandardSchemaSync(rowSchema, row);
        if (rowValidation.issues) {
          result.valid = false;
          result.rowIssues = [...rowValidation.issues];
        } else {
          result.validatedRow = rowValidation.value as T;
        }
      } else {
        // If no row schema, original row is the validated row
        result.validatedRow = row as T;
      }

      // Validate individual columns if provided
      if (columnSchemas) {
        result.columnIssues = {};

        for (const [column, schema] of Object.entries(columnSchemas)) {
          if (!schema) continue;

          const columnValidation = tryValidateStandardSchemaSync(schema, row[column]);
          if (columnValidation.issues) {
            result.valid = false;
            result.columnIssues[column] = [...columnValidation.issues];

            // If row validation succeeded but column validation failed, update the column value in validated row
            if (result.validatedRow && !result.rowIssues) {
              if ('value' in columnValidation) {
                (result.validatedRow as any)[column] = columnValidation.value;
              } else {
                // Column validation failed, set to null/undefined or keep original
                (result.validatedRow as any)[column] = null;
              }
            }
          } else if (result.validatedRow) {
            // Update the validated value in the result
            (result.validatedRow as any)[column] = columnValidation.value;
          }
        }

        // If no column issues, remove the empty object
        if (Object.keys(result.columnIssues).length === 0) {
          delete result.columnIssues;
        }
      }

      return result;
    };

    // Process each row synchronously
    const results = data.map(validateRowSync);

    // Process validation results
    for (const result of results) {
      validationResults.push(result);

      if (result.valid && result.validatedRow) {
        validatedData.push(result.validatedRow);
      } else if (validationMode === 'error') {
        // Collect all validation issues for better error reporting
        const issues: string[] = [];

        if (result.rowIssues) {
          issues.push(`Row validation issues: ${result.rowIssues.map(i => i.message).join(', ')}`);
        }

        if (result.columnIssues) {
          for (const [column, columnIssues] of Object.entries(result.columnIssues)) {
            issues.push(`Column '${column}' validation issues: ${columnIssues.map(i => i.message).join(', ')}`);
          }
        }

        throw new CSVError(`CSV validation failed: ${issues.join('; ')}`);
      } else if (validationMode === 'filter') {
        // Skip invalid rows - don't add to validatedData
        continue;
      } else if (validationMode === 'keep' && !result.valid) {
        // Keep even invalid rows in the resulting dataset
        validatedData.push(result.originalRow as T);
      }
    }

    return [validatedData, validationResults];
  }

  /**
   * For backward compatibility - redirects to the appropriate sync or async validation method
   * @private
   */
  private static _validateWithSchema<T extends Record<string, any>>(
    data: Record<string, any>[],
    schemaConfig: CSVSchemaConfig<T>,
    baseLineNumber: number = 1
  ): [T[], RowValidationResult<T>[]] {
    // For backward compatibility, if useAsync is true, we'll still return empty results
    // as this was the previous behavior. The async method will need to be called afterward.
    if (schemaConfig.useAsync) {
      return [[], []];
    } else {
      return this._validateWithSchemaSync(data, schemaConfig, baseLineNumber);
    }
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
   * 
   * // With schema validation using Zod
   * import { z } from 'zod';
   * 
   * const userSchema = z.object({
   *   id: z.string().min(1),
   *   name: z.string().min(1),
   *   email: z.string().email().optional()
   * });
   * 
   * // TypeScript type derived from the schema
   * type User = z.infer<typeof userSchema>;
   * 
   * const users = CSV.fromFile<User>('users.csv', {
   *   schema: {
   *     rowSchema: userSchema,
   *     columnSchemas: {
   *       email: z.string().email()
   *     },
   *     validationMode: 'filter'
   *   }
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
      const rawFullContent = fileData.toString();

      let fileAdditionalHeader = '';

      const getCsvFromLineValue = (csvOpts?: CsvParseOptions): number | undefined => {
        if (!csvOpts) return undefined;
        const fromVal = csvOpts.from ?? csvOpts.from_line ?? csvOpts.fromLine;
        return typeof fromVal === 'number' && fromVal >= 1 ? fromVal : undefined;
      };

      let numPreambleLinesToExtract: number | undefined = undefined;
      const userSpecifiedFromForData = getCsvFromLineValue(options.csvOptions);

      if (typeof options.saveAdditionalHeader === 'number' && options.saveAdditionalHeader > 0) {
        numPreambleLinesToExtract = options.saveAdditionalHeader;
      } else if (options.saveAdditionalHeader === true && userSpecifiedFromForData && userSpecifiedFromForData > 1) {
        numPreambleLinesToExtract = userSpecifiedFromForData - 1;
      }

      if (numPreambleLinesToExtract && numPreambleLinesToExtract > 0) {
        const basePreambleOpts: CsvParseInternalOptions = options.additionalHeaderParseOptions
          ? { ...options.additionalHeaderParseOptions } : {};
        if (!options.additionalHeaderParseOptions && options.csvOptions) {
          const RELEVANT_LOW_LEVEL_KEYS: (keyof CsvParseInternalOptions)[] = ['delimiter', 'quote', 'escape', 'record_delimiter', 'recordDelimiter', 'ltrim', 'rtrim', 'trim', 'bom'];
          RELEVANT_LOW_LEVEL_KEYS.forEach(key => {
            let valueToInherit: any = undefined;
            if (options.csvOptions) {
              if (key === 'record_delimiter' || key === 'recordDelimiter') { valueToInherit = options.csvOptions.record_delimiter ?? options.csvOptions.recordDelimiter; }
              else { valueToInherit = options.csvOptions[key as keyof typeof options.csvOptions]; }
            }
            if (valueToInherit !== undefined && !(key in basePreambleOpts)) { (basePreambleOpts as any)[key] = valueToInherit; }
          });
        }
        const finaladditionalHeaderParseOptions: CsvParseInternalOptions = { /* ... as before ... */
          ...basePreambleOpts, columns: false, to: numPreambleLinesToExtract,
          from: undefined, from_line: undefined, fromLine: undefined, to_line: undefined, toLine: undefined,
          skip_empty_lines: undefined, skipEmptyLines: undefined, skip_records_with_error: undefined, skipRecordsWithError: undefined,
          skip_records_with_empty_values: undefined, skipRecordsWithEmptyValues: undefined, comment: undefined,
          on_record: undefined, onRecord: undefined, auto_parse: undefined, autoParse: undefined, cast: undefined,
          cast_date: undefined, castDate: undefined, objname: undefined, info: undefined, raw: undefined,
          relax_column_count: undefined, relaxColumnCount: undefined, relax_column_count_less: undefined, relaxColumnCountLess: undefined,
          relax_column_count_more: undefined, relaxColumnCountMore: undefined,
        };
        Object.keys(finaladditionalHeaderParseOptions).forEach(k => (finaladditionalHeaderParseOptions as any)[k] === undefined && delete (finaladditionalHeaderParseOptions as any)[k]);
        const parsedPreambleRows: unknown[][] = parseCSV(rawFullContent, finaladditionalHeaderParseOptions);
        const actualPreambleHasContent = parsedPreambleRows.some((row: unknown[]) => Array.isArray(row) && row.some((cell: unknown) => cell !== null && cell !== undefined && String(cell).trim().length > 0));
        if (actualPreambleHasContent) { /* ... stringify preamble ... */
          let tempPreamble = stringifyCSV(parsedPreambleRows);
          const originalTotalLines = rawFullContent.split('\n').length;
          if (numPreambleLinesToExtract >= originalTotalLines) {
            if (tempPreamble.endsWith('\n') && !rawFullContent.endsWith('\n')) tempPreamble = tempPreamble.slice(0, -1);
            else if (!tempPreamble.endsWith('\n') && rawFullContent.endsWith('\n') && rawFullContent.length > 0) tempPreamble += '\n';
          } else if (tempPreamble.length > 0 && !tempPreamble.endsWith('\n')) tempPreamble += '\n';
          fileAdditionalHeader = tempPreamble;
        }
      }

      const contentForMainParsing = options.transform ? options.transform(rawFullContent.trim()) : rawFullContent.trim();
      // Explicitly set columns: true as the default, then spread user options for clarity and consistency
      // This ensures the desired default behavior while still allowing user overrides if needed
      const finalMainParserOptions: CsvParseInternalOptions = {
        columns: true,
        ...(options.csvOptions || {})
      };

      const fromLineForData = getCsvFromLineValue(options.csvOptions);
      if (fromLineForData !== undefined) { finalMainParserOptions.from_line = fromLineForData; }
      delete finalMainParserOptions.from; delete finalMainParserOptions.fromLine;

      if (numPreambleLinesToExtract && numPreambleLinesToExtract > 0) {
        const startDataAfterPreamble = numPreambleLinesToExtract + 1;
        if (!finalMainParserOptions.from_line || finalMainParserOptions.from_line < startDataAfterPreamble) {
          finalMainParserOptions.from_line = startDataAfterPreamble;
        }
      }
      if (finalMainParserOptions.from_line !== undefined && finalMainParserOptions.from_line < 1) {
        delete finalMainParserOptions.from_line;
      }

      const toLineForData = finalMainParserOptions.to_line ?? finalMainParserOptions.toLine;
      if (toLineForData !== undefined && finalMainParserOptions.to === undefined) { finalMainParserOptions.to = toLineForData; }
      delete finalMainParserOptions.to_line; delete finalMainParserOptions.toLine;

      // If headerMap is provided, ensure columns is true
      if (options.headerMap) {
        finalMainParserOptions.columns = true; // headerMap requires objects from csv-parse
      }
      // We've already set columns: true as default in finalMainParserOptions

      // Initial parsing of the data
      const dataAfterCsvParse = parseCSV(contentForMainParsing, finalMainParserOptions) as any[];

      // Process the data with the shared function (apply header mapping and custom casting)
      const baseLineNumber = finalMainParserOptions.from_line || 1;
      const parsedData = this.processCSVData<T>(dataAfterCsvParse, options as CSVReadOptions<T & Record<string, any>>, baseLineNumber);

      // Basic structural validation
      if (options.validateData && parsedData.length > 0) {
        const firstDataRowActualLine = finalMainParserOptions.from_line || 1;
        if (finalMainParserOptions.columns !== false) {
          if (!(parsedData[0] && typeof parsedData[0] === 'object')) {
            throw new CSVError(`Expected object rows for validation, but first parsed record (approx. file line ${firstDataRowActualLine}) is not an object.`);
          }
          const sampleKeys = Object.keys(parsedData[0]);
          parsedData.forEach((row, i) => {
            if (!(row && typeof row === 'object')) { throw new CSVError(`Row at approx. file line ${firstDataRowActualLine + i} (parsed index ${i}) is not an object as expected.`); }
            const relaxCount = finalMainParserOptions.relax_column_count ?? finalMainParserOptions.relaxColumnCount;
            if (Object.keys(row).length !== sampleKeys.length && !relaxCount) { throw new CSVError(`Row at approx. file line ${firstDataRowActualLine + i} (parsed index ${i}) has inconsistent column count. Expected ${sampleKeys.length}, got ${Object.keys(row).length}.`); }
          });
        }
      }

      // Apply schema validation if configured
      if (options.schema && parsedData.length > 0) {
        // If schema specifies async validation, throw an error as fromFile is synchronous
        if (options.schema.useAsync) {
          throw new CSVError(
            "Asynchronous schema validation is not supported in fromFile. Use fromFileAsync instead, or set useAsync: false in your schema configuration."
          );
        }

        // Ensure synchronous validation is used
        const syncSchema: CSVSchemaConfig<T> = {
          ...options.schema,
          useAsync: false
        };

        const [validatedData, validationResults] = this._validateWithSchemaSync(
          parsedData,
          syncSchema,
          baseLineNumber
        );

        // Return validated data and include validation results
        return new CSV<T>(validatedData, fileAdditionalHeader, validationResults);
      }

      // No schema validation, return parsed data as-is
      return new CSV<T>(parsedData as T[], fileAdditionalHeader);
    }

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
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }


  /**
   * Create a CSV instance from an array of objects, with optional schema validation.
   *
   * @param data - Array of objects representing CSV-like rows.
   * @param options - Optional configuration, primarily for schema validation.
   * @returns A new CSV instance.
   * @throws {CSVError} If schema validation is mode 'error' and fails, or if an async schema is used incorrectly.
   */
  static fromData<T extends Record<string, any>>(
    data: (T |Record<string, any>)[], // Input can be Record<string, any> to allow for validation to type T
    options?: CSVFromDataOptions<T>
  ): CSV<T> {
    // Create a new array with copies of the input objects to ensure immutability of the input `data` array
    let processedData: Record<string, any>[] = Array.isArray(data) ? data.map(row => ({ ...row })) : [];
    let finalAdditionalHeader: string | undefined = undefined; // Not applicable for fromData
    let validationResults: RowValidationResult<T>[] | undefined = undefined;

    // Apply schema validation if configured
    if (options?.schema && processedData.length > 0) {
      // If schema specifies async validation, throw an error as fromData is synchronous
      if (options.schema.useAsync) {
        throw new CSVError(
          "Asynchronous schema validation is not supported in the synchronous fromData method. " +
          "Validate separately using csvInstance.validateAsync() or ensure your schema and useAsync:false are set for synchronous validation."
        );
      }

      // Ensure synchronous validation is used for this synchronous method
      const syncSchema: CSVSchemaConfig<T> = {
        ...options.schema,
        useAsync: false, // Force synchronous validation path
      };

      try {
        const [validatedDataOutput, valRes] = this._validateWithSchemaSync(
          processedData, // Pass the current data
          syncSchema
        );
        processedData = validatedDataOutput; // Update processedData with the validated (and possibly filtered/transformed) data
        validationResults = valRes;
      } catch (error) {
        // _validateWithSchemaSync throws CSVError directly if validationMode is 'error' and a failure occurs.
        // Re-throw if it's already a CSVError, otherwise wrap it.
        if (error instanceof CSVError) {
          throw error;
        }
        throw new CSVError(
          'Schema validation failed during CSV.fromData',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    // The final data should conform to T after validation (or be T[] if no validation)
    return new CSV<T>(processedData as T[], finalAdditionalHeader, validationResults);
  }

  /**
   * Create a CSV instance from a string
   * @param csvString - CSV content as a string
   * @param options - CSV reading options including custom casting
   * @returns A new CSV instance
   * @throws {CSVError} If parsing fails
   */
  /**
   * Common function to process parsed CSV data with header mapping and custom casting
   * @param dataAfterCsvParse - The initially parsed data from csv-parse
   * @param options - Reading options including custom casting
   * @param baseLineNumber - Base line number for error reporting (usually 1 or the value of from_line)
   * @returns Processed data with header mapping and custom casting applied
   */
  private static processCSVData<T>(
    dataAfterCsvParse: any[],
    options: CSVReadOptions<T & Record<string, any>>,
    baseLineNumber: number = 1
  ): any[] {
    // Apply header mapping if specified
    let processedData: any[] = dataAfterCsvParse;
    if (options.headerMap && dataAfterCsvParse.length > 0 && typeof dataAfterCsvParse[0] === 'object') {
      const { fromRowArr } = createHeaderMapFns<T & Record<string, any>>(options.headerMap);
      processedData = dataAfterCsvParse.map(row => fromRowArr(row));
    }

    // Apply custom casting if specified
    if (options.customCasts && processedData.length > 0) {
      const { definitions, columnCasts, onCastError = 'error' } = options.customCasts;

      // Only apply custom casting to object-based rows
      if (typeof processedData[0] === 'object' && processedData[0] !== null) {
        return processedData.map((row: Record<string, any>, rowIndex: number) => {
          const newRow = { ...row };

          for (const columnName in row) {
            if (Object.prototype.hasOwnProperty.call(row, columnName)) {
              const originalValue = row[columnName];

              // Prepare string input for custom casters
              let valueToTestAndParse: string;
              if (typeof originalValue === 'string') {
                valueToTestAndParse = originalValue;
              } else if (originalValue === null) {
                valueToTestAndParse = 'null';
              } else if (originalValue === undefined) {
                valueToTestAndParse = 'undefined';
              } else {
                valueToTestAndParse = String(originalValue);
              }

              // Build casting context
              const context: CastingContext = {
                column: columnName,
                header: false,
                index: Object.keys(row).indexOf(columnName),
                lines: baseLineNumber + rowIndex,
                records: rowIndex,
                empty_lines: 0,
                invalid_field_length: 0,
                quoting: false
              };

              let castSuccessful = false;
              let castedValue: any = originalValue; // Default to original value

              // Function to apply a caster
              const applyCaster = (caster: Caster<any>): boolean => {
                if (caster.test(valueToTestAndParse, context)) {
                  try {
                    castedValue = caster.parse(valueToTestAndParse, context);
                    castSuccessful = true;
                    return true; // Caster applied successfully
                  } catch (e) {
                    if (onCastError === 'error') {
                      throw new CSVError(
                        `Custom cast failed for column "${columnName}" at line ${context.lines}, value: "${valueToTestAndParse}". Error: ${(e as Error).message}`,
                        e
                      );
                    } else if (onCastError === 'null') {
                      castedValue = null;
                    } else { // 'original'
                      castedValue = originalValue;
                    }
                    return true; // Caster was attempted but failed/handled
                  }
                }
                return false; // Caster test failed
              };

              // 1. Try column-specific casters first
              if (columnCasts && columnCasts[columnName as string]) {
                const columnRule = columnCasts[columnName as string];
                const rulesToTry = Array.isArray(columnRule) ? columnRule : [columnRule];

                for (const rule of rulesToTry) {
                  let casterToUse: Caster<any> | undefined;

                  if (typeof rule === 'string' && definitions && definitions[rule as keyof CustomCastDefinition]) {
                    casterToUse = definitions[rule as keyof CustomCastDefinition];
                  } else if (typeof rule === 'object' && rule !== null && 'test' in rule && 'parse' in rule) {
                    casterToUse = rule as Caster<any>;
                  }

                  if (casterToUse && applyCaster(casterToUse)) {
                    break; // First successful caster wins
                  }
                }
              }

              // 2. If no column-specific caster succeeded, try global casters
              if (!castSuccessful && definitions) {
                // Predefined order for more predictable behavior
                const orderedGlobalKeys: (keyof CustomCastDefinition)[] = [
                  'null', 'boolean', 'number', 'date', 'object', 'array', 'string'
                ];

                for (const defKey of orderedGlobalKeys) {
                  const globalCaster = definitions[defKey];
                  if (globalCaster && applyCaster(globalCaster)) {
                    break; // First successful global caster wins
                  }
                }
              }

              // Set the potentially modified value in the new row
              newRow[columnName] = castedValue;
            }
          }

          return newRow as T;
        });
      }
    }

    // No header mapping or custom casting needed, or non-object rows
    return processedData as (T & Record<string, any>)[];
  }

  static fromString<T extends Record<string, any>>(
    csvString: string,
    options: CSVReadOptions<T> = { csvOptions: { columns: true } }
  ): CSV<T> {
    try {
      // Set columns: true by default to ensure consistent behavior, then allow user overrides
      const csvOptions = {
        columns: true,
        ...options.csvOptions
      };
      let dataAfterCsvParse = parseCSV(csvString, csvOptions) as any[];

      // Process the data with the shared function
      const parsedData = this.processCSVData<T>(dataAfterCsvParse, options);

      // Apply schema validation if configured
      if (options.schema && parsedData.length > 0) {
        // If schema specifies async validation, throw an error as fromString is synchronous
        if (options.schema.useAsync) {
          throw new CSVError(
            "Asynchronous schema validation is not supported in fromString. Use fromFileAsync or validateAsync instead, or set useAsync: false in your schema configuration."
          );
        }

        // Ensure synchronous validation is used
        const syncSchema: CSVSchemaConfig<T> = {
          ...options.schema,
          useAsync: false
        };

        const [validatedData, validationResults] = this._validateWithSchemaSync(
          parsedData,
          syncSchema
        );

        // Return validated data and include validation results
        return new CSV<T>(validatedData, undefined, validationResults);
      }

      return new CSV<T>(parsedData as T[]);
    } catch (error) {
      throw new CSVError('Failed to parse CSV string', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create a CSV instance from a readable stream
   * @param stream - Readable stream containing CSV data
   * @param options - CSV reading options including custom casting
   * @returns Promise resolving to a new CSV instance
   * @throws {CSVError} If parsing fails
   */
  static async fromStream<T extends Record<string, any>>(
    stream: NodeJS.ReadableStream,
    options: CSVReadOptions<T> | { columns?: boolean } = { columns: true }
  ): Promise<CSV<T>> {
    try {
      // Handle the case where options is just simple options
      const readOptions: CSVReadOptions<T> = 'csvOptions' in options
        ? options as CSVReadOptions<T>
        : { csvOptions: options } as CSVReadOptions<T>;

      // Consistent approach: Set columns: true by default for proper object-based parsing
      const csvParseOptions = {
        columns: true,
        ...(readOptions.csvOptions || {})
      };

      return new Promise((resolve, reject) => {
        const data: any[] = [];
        const parser = parseCSVAsync(csvParseOptions);

        parser.on('readable', () => {
          let record;
          while ((record = parser.read()) !== null) {
            data.push(record);
          }
        });

        parser.on('error', (err) => {
          reject(new CSVError('Failed to parse CSV stream', err instanceof Error ? err : new Error(String(err))));
        });

        parser.on('end', () => {
          try {
            // Process the data with the shared function (apply header mapping and custom casting)
            const processedData = this.processCSVData<T>(data, readOptions as CSVReadOptions<T & Record<string, any>>);

            // Apply schema validation if configured
            if (readOptions.schema && processedData.length > 0) {
              try {
                const [validatedData, validationResults] = this._validateWithSchema(
                  processedData,
                  readOptions.schema
                );

                // Return validated data and include validation results
                resolve(new CSV<T>(validatedData, undefined, validationResults));
              } catch (validationError) {
                reject(new CSVError('CSV validation failed', validationError instanceof Error ? validationError : new Error(String(validationError))));
              }
            } else {
              // No schema validation, return processed data as-is
              resolve(new CSV<T>(processedData as T[]));
            }
          } catch (error) {
            reject(new CSVError('Failed to process CSV stream data', error instanceof Error ? error : new Error(String(error))));
          }
        });

        stream.pipe(parser);
      });
    } catch (error) {
      throw new CSVError('Failed to parse CSV stream', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create a CSV instance from a file asynchronously using streams
   * @param filename - Path to the CSV file
   * @param options - Reading options including custom casting
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

      // Check if the schema might need async validation
      if (options.schema && options.schema.useAsync === undefined) {
        // Set useAsync to true for fromFileAsync to ensure proper handling of potentially async schemas
        const schemaWithAsyncOption = {
          ...options.schema,
          useAsync: true
        };

        // Pass the options to fromStream with updated schema
        return CSV.fromStream<T>(stream, {
          ...options,
          csvOptions: options.csvOptions || { columns: true },
          schema: schemaWithAsyncOption
        });
      }

      // Pass the options to fromStream as csvOptions to ensure it has the right type
      return CSV.fromStream<T>(stream, {
        csvOptions: options.csvOptions || { columns: true },
        ...options
      });
    } catch (error) {
      throw new CSVError(
        `Failed to read or parse CSV file asynchronously: ${filename}`,
        error instanceof Error ? error : new Error(String(error))
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

        // Handle streaming with header map
        if (options.streaming && this.data.length > streamingThreshold) {
          // Use streaming for large datasets with header mapping
          const headerToPrepend = options.additionalHeader ?? this.additionalHeader ?? '';
          const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });

          if (headerToPrepend) {
            writable.write(headerToPrepend);
          }

          // Create transform stream for header mapping
          const headerMapTransform = new Transform({
            objectMode: true,
            transform(chunk, encoding, callback) {
              try {
                const mappedRow = toRowArr(chunk, headers);
                callback(null, mappedRow);
              } catch (error) {
                callback(error as Error);
              }
            }
          });

          // Create stringifier with appropriate options
          // If header is true, make sure it's handled correctly in stringifyOptions
          const csvStringifyOptions = {
            ...stringifyOptions,
            header: Array.isArray(stringifyOptions.header) ? headers : stringifyOptions.header
          };

          // Create a transform stream using stringifyCSVAsync 
          // Use a type assertion to help TypeScript understand this is valid
          // The CSV module expects options as the first argument
          // The 'as any' casting is necessary because csvStringifyOptions' structure (with header property that 
          // could be boolean or string[]) may not perfectly align with stringifyCSVAsync's expected type
          const stringifier = stringifyCSVAsync(csvStringifyOptions as any) as Transform;

          // Add a simple error handler to the stringifier
          stringifier.on('error', (err) => {
            console.error('CSV stringification error:', err);
          });

          // Create pipeline
          Readable.from(this.data)
            .pipe(headerMapTransform)
            .pipe(stringifier)
            .pipe(writable);

          return;
        } else {
          // Standard in-memory processing for smaller datasets
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
            (options.additionalHeader ?? this.additionalHeader ?? '') + csvString,
            'utf-8'
          );
          return;
        }
      }

      // Standard CSV writing without header mapping
      if (options.streaming && this.data.length > streamingThreshold) {
        // Use streaming for large datasets
        // Use a type assertion to help TypeScript understand this is valid
        const stringifier = stringifyCSVAsync(
          options.stringifyOptions || { header: true }
        ) as Transform;

        const readable = Readable.from(this.data);
        const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });

        const headerToPrepend = options.additionalHeader ?? this.additionalHeader ?? '';
        if (headerToPrepend) {
          writable.write(headerToPrepend);
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
          (options.additionalHeader ?? this.additionalHeader ?? '') + csvString,
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
  async writeToFileAsync(filename: string, options: CSVWriteOptions<T> = {}): Promise<void> {
    try {
      const outputPath = filename.endsWith('.csv')
        ? filename
        : `${filename}.csv`;

      return new Promise((resolve, reject) => {
        const stringifyOptions = options.stringifyOptions || { header: true };
        const stringifier = stringifyCSVAsync(stringifyOptions);
        const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });

        // Add additional header if present
        if (options.additionalHeader || this.additionalHeader) {
          writable.write(options.additionalHeader ?? this.additionalHeader ?? '');
        }

        writable.on('finish', resolve);
        writable.on('error', reject);

        // Apply header mapping if provided
        if (options.headerMap) {
          // Get headers
          const headers = Array.isArray(stringifyOptions.header)
            ? stringifyOptions.header
            : Object.keys(this.data[0] || {});

          const { toRowArr } = createHeaderMapFns<T>(options.headerMap);

          // Create a transform stream that applies the header mapping
          const transformer = new Transform({
            objectMode: true,
            transform(chunk, encoding, callback) {
              try {
                const mappedRow = toRowArr(chunk, headers);
                callback(null, mappedRow);
              } catch (error) {
                callback(error as Error);
              }
            }
          });

          Readable.from(this.data).pipe(transformer).pipe(stringifier).pipe(writable);
        } else {
          // Standard processing without header mapping
          Readable.from(this.data).pipe(stringifier).pipe(writable);
        }
      });
    } catch (error) {
      throw new CSVError(
        `Failed to write CSV to file asynchronously: ${filename}`,
        error
      );
    }
  }

  // /**
  //  * Convert the current data to a CSV string
  //  * @param options - Stringify options
  //  * @returns CSV content as a string
  //  * @throws {CSVError} If stringification fails
  //  */
  // toString(options: Parameters<typeof stringifyCSV>[1] = { header: true }): string {
  //   try {
  //     return stringifyCSV(this.data, options);
  //   } catch (error) {
  //     throw new CSVError('Failed to convert data to CSV string', error);
  //   }
  // }

  /**
   * Get the data as an array
   * @returns Copy of the underlying data array
   */
  toArray(): T[] {
    return [...this.data];
  }

  /**
   * Validates the CSV data against a schema using synchronous validation
   * @param schema The schema configuration to use for validation
   * @returns A new CSV instance with validated data
   * @throws {CSVError} If the schema is configured for async validation
   */
  validate<U extends Record<string, any> = T>(schema: CSVSchemaConfig<U>): CSV<U> {
    if (this.data.length === 0) {
      return new CSV<U>([], this.additionalHeader);
    }

    // Ensure schema uses sync validation
    const syncSchema: CSVSchemaConfig<U> = {
      ...schema,
      useAsync: false // Force synchronous validation
    };

    try {
      const [validatedData, validationResults] = CSV._validateWithSchemaSync<U>(
        this.data,
        syncSchema
      );

      return new CSV<U>(validatedData, this.additionalHeader, validationResults);
    } catch (error) {
      // Propagate any validation errors
      throw error instanceof CSVError ? error : new CSVError(
        'Schema validation failed',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Validates the CSV data asynchronously against a schema
   * @param schema The schema configuration to use for validation
   * @returns A promise resolving to a new CSV instance with validated data
   */
  async validateAsync<U extends Record<string, any> = T>(schema: CSVSchemaConfig<U>): Promise<CSV<U>> {
    if (this.data.length === 0) {
      return new CSV<U>([], this.additionalHeader);
    }

    // Ensure schema uses async validation
    const asyncSchema: CSVSchemaConfig<U> = {
      ...schema,
      useAsync: true // Force async validation
    };

    try {
      // Use the internal async validation method
      const [validatedData, validationResults] = await CSV._validateWithSchemaAsync<U>(
        this.data,
        asyncSchema
      );

      return new CSV<U>(validatedData, this.additionalHeader, validationResults);
    } catch (error) {
      // Propagate any validation errors
      throw error instanceof CSVError ? error : new CSVError(
        'Async schema validation failed',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Asynchronously validates data using a standard schema configuration.
   * This method properly awaits promises from validateRowAsync before processing results.
   *
   * @param data - The data to validate
   * @param schemaConfig - The schema configuration
   * @returns A promise resolving to a tuple containing: [validatedData, validationResults]
   * @private
   */
  /**
   * Validates data asynchronously using a standard schema configuration.
   * This method properly handles asynchronous validations in row and column schemas.
   *
   * @param data - The data to validate
   * @param schemaConfig - The schema configuration
   * @param baseLineNumber - The base line number for error reporting
   * @returns A promise resolving to a tuple containing: [validatedData, validationResults]
   * @private
   */
  private static async _validateWithSchemaAsync<T extends Record<string, any>>(
    data: Record<string, any>[],
    schemaConfig: CSVSchemaConfig<T>,
    baseLineNumber: number = 1
  ): Promise<[T[], RowValidationResult<T>[]]> {
    const { rowSchema, columnSchemas, validationMode = 'error' } = schemaConfig;
    const validationResults: RowValidationResult<T>[] = [];
    const validatedData: T[] = [];

    // Function to validate a row asynchronously
    const validateRowAsync = async (row: Record<string, any>, index: number): Promise<RowValidationResult<T>> => {
      const result: RowValidationResult<T> = {
        originalRow: row,
        valid: true
      };

      // Validate row using row schema if provided
      if (rowSchema) {
        const rowValidation = await tryValidateStandardSchemaAsync(rowSchema, row);
        if (rowValidation.issues) {
          result.valid = false;
          result.rowIssues = [...rowValidation.issues];
        } else {
          result.validatedRow = rowValidation.value as T;
        }
      } else {
        // If no row schema, original row is the validated row
        result.validatedRow = row as T;
      }

      // Validate individual columns if provided
      if (columnSchemas) {
        result.columnIssues = {};

        // Validate columns in parallel
        const columnEntries = Object.entries(columnSchemas);
        const columnValidationPromises = columnEntries.map(async ([column, schema]) => {
          if (!schema) return null;

          const columnValidation = await tryValidateStandardSchemaAsync(schema, row[column]);
          return { column, columnValidation };
        });

        const columnResults = await Promise.all(columnValidationPromises);

        // Process column validation results
        for (const columnResult of columnResults) {
          if (!columnResult) continue;

          const { column, columnValidation } = columnResult;

          if (columnValidation.issues) {
            result.valid = false;
            result.columnIssues[column] = [...columnValidation.issues];

            // If row validation succeeded but column validation failed, update the column value in validated row
            if (result.validatedRow && !result.rowIssues) {
              if ('value' in columnValidation) {
                (result.validatedRow as any)[column] = columnValidation.value;
              } else {
                // Column validation failed, set to null/undefined or keep original
                (result.validatedRow as any)[column] = null;
              }
            }
          } else if (result.validatedRow) {
            // Update the validated value in the result
            (result.validatedRow as any)[column] = columnValidation.value;
          }
        }

        // If no column issues, remove the empty object
        if (Object.keys(result.columnIssues).length === 0) {
          delete result.columnIssues;
        }
      }

      return result;
    };

    // Process all rows asynchronously in parallel
    const rowValidationPromises = data.map((row, index) => validateRowAsync(row, index));
    const results = await Promise.all(rowValidationPromises);

    // Process validation results
    for (const result of results) {
      validationResults.push(result);

      if (result.valid && result.validatedRow) {
        validatedData.push(result.validatedRow);
      } else if (validationMode === 'error') {
        // Collect all validation issues for better error reporting
        const issues: string[] = [];

        if (result.rowIssues) {
          issues.push(`Row validation issues: ${result.rowIssues.map(i => i.message).join(', ')}`);
        }

        if (result.columnIssues) {
          for (const [column, columnIssues] of Object.entries(result.columnIssues)) {
            issues.push(`Column '${column}' validation issues: ${columnIssues.map(i => i.message).join(', ')}`);
          }
        }

        throw new CSVError(`CSV validation failed: ${issues.join('; ')}`);
      } else if (validationMode === 'filter') {
        // Skip invalid rows - don't add to validatedData
        continue;
      } else if (validationMode === 'keep' && !result.valid) {
        // Keep even invalid rows in the resulting dataset
        validatedData.push(result.originalRow as T);
      }
    }

    return [validatedData, validationResults];
  }

  /**
   * Convert the CSV data to a string, with support for header mapping
   * @param options - Stringify options including headerMap
   * @returns CSV content as a string
   * 
   * IMPLEMENTATION NOTE: This method handles various combinations of options including headerMap
   * in a robust and flexible way. It first processes the data according to the headerMap (if provided),
   * before performing the stringification, ensuring proper column transformation.
   */
  toString(options: CsvStringifyOptions<T> = {}): string {
    // Handle case when options is a union type
    if (options && typeof options === 'object' && 'headerMap' in options) {
      // Handle object with headerMap
      const headerMap = options.headerMap;
      const stringifyOptions = options.stringifyOptions || { header: true };

      if (headerMap) {
        const headers = Array.isArray(stringifyOptions.header)
          ? stringifyOptions.header
          : Object.keys(this.data[0] || {});

        const { toRowArr } = createHeaderMapFns<T>(headerMap);

        // Transform the data through the header map
        const rows = this.data.map(item => toRowArr(item, headers));

        // Add headers as the first row if needed
        if (stringifyOptions.header === true) {
          rows.unshift(headers);
        }

        // Use a custom stringifier without the header option
        return rows.map(row =>
          row.map(cell => {
            if (cell === null || cell === undefined) return '';
            return typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))
              ? `"${cell.replace(/"/g, '""')}"`
              : String(cell);
          }).join(',')
        ).join('\n');
      }

      // If headerMap is not provided, use standard stringify with stringifyOptions
      return stringifyCSV(this.data, stringifyOptions);
    }

    // Handle standard stringify options (direct options object)
    // Handle case when options has stringifyOptions property
    if (options && 'stringifyOptions' in options) {
      return stringifyCSV(this.data, options.stringifyOptions || { header: true });
    }
    // Handle case when options is a direct stringify options object
    return stringifyCSV(this.data, options as Parameters<typeof stringifyCSV>[1] || { header: true });
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
   * Sort rows by a column using standard JavaScript sorting
   * @param column - The column to sort by
   * @param direction - Sort direction (default: 'asc')
   * @returns A new CSV instance with sorted data
   */
  sortBy<K extends keyof T>(
    column: K,
    direction: SortDirection = 'asc'
  ): CSV<T> {
    // Define the sort function - standard in-memory sort
    const sortFunction = (data: T[]): T[] => {
      return [...data].sort((a, b) => {
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
    };

    return new CSV<T>(sortFunction(this.data), this.additionalHeader);
  }

  /**
  * Default threshold for using worker threads for sorting.
  * If data length exceeds this, parallel sorting is attempted.
  */
  static DEFAULT_SORT_WORKER_THRESHOLD = 10000; // Adjust as needed

  /**
   * Asynchronously sorts rows by a column or a custom sort function.
   * For large datasets (above `options.workerThreshold`), it attempts to use worker threads
   * for parallel sorting of chunks, followed by a k-way merge.
   *
   * @param columnOrFn - The column key (keyof T) to sort by, or a custom comparison function
   *                     `(a: T, b: T) => number` compatible with `Array.prototype.sort`.
   *                     If a column key is provided, a default string/number-aware comparison is used.
   *                     If a custom function is provided AND workers are used, the function's
   *                     `toString()` representation will be sent to workers (requires `eval`).
   * @param direction - Sort direction ('asc' or 'desc'). Only applies if `columnOrFn` is a column key.
   *                    Ignored if `columnOrFn` is a custom comparison function.
   * @param options - Optional configuration for asynchronous sorting.
   * @param options.workerThreshold - Number of rows above which to attempt using worker threads.
   *                                  Defaults to `CSV.DEFAULT_SORT_WORKER_THRESHOLD`.
   * @param options.maxWorkers - Maximum number of worker threads to use. Defaults to CPU core count.
   * @returns A Promise resolving to a new CSV instance with sorted data.
   */
  async sortByAsync<K extends keyof T>(
    columnOrFn: K | ((a: T, b: T) => number),
    direction: SortDirection = 'asc',
    options: { workerThreshold?: number; maxWorkers?: number } = {}
  ): Promise<CSV<T>> {
    if (this.data.length === 0) {
      return new CSV<T>([], this.additionalHeader, this.validationResults);
    }

    const workerThreshold = options.workerThreshold ?? CSV.DEFAULT_SORT_WORKER_THRESHOLD;

    // Determine the comparison function
    let compareFn: (a: T, b: T) => number;
    let sortFnStringToWorker: string | undefined = undefined;

    if (typeof columnOrFn === 'function') {
      compareFn = columnOrFn;
      // For workers, we'll try to send the function as a string.
      // This has limitations (closures, non-serializable context won't work).
      // And uses eval in the worker, which has security implications.
      sortFnStringToWorker = columnOrFn.toString();
    } else {
      const column = columnOrFn; // It's a keyof T
      compareFn = (a: T, b: T): number => {
        const aVal = a[column];
        const bVal = b[column];

        // Consistent handling of null/undefined: nulls/undefineds come first in asc, last in desc
        if (aVal === bVal) return 0;
        if (aVal === null || aVal === undefined) return direction === 'asc' ? -1 : 1;
        if (bVal === null || bVal === undefined) return direction === 'asc' ? 1 : -1;

        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return direction === 'asc' ? aVal - bVal : bVal - aVal;
        }
        // Default to string comparison for other types
        const comparison = String(aVal).localeCompare(String(bVal));
        return direction === 'asc' ? comparison : -comparison;
      };
    }

    // If data size is below threshold or only 1 CPU, sort in the main thread
    const numCPUs = os.cpus().length;
    if (this.data.length <= workerThreshold || numCPUs <= 1) {
      // console.log('Sorting in main thread');
      const sortedData = [...this.data].sort(compareFn);
      return new CSV<T>(sortedData, this.additionalHeader, this.validationResults);
    }

    // --- Parallel Sorting with Workers ---
    // console.log('Attempting parallel sort');
    const maxWorkers = Math.min(options.maxWorkers || numCPUs, numCPUs);
    const chunkSize = Math.ceil(this.data.length / maxWorkers);
    const chunks: T[][] = [];

    for (let i = 0; i < this.data.length; i += chunkSize) {
      chunks.push(this.data.slice(i, i + Math.min(chunkSize, this.data.length - i)));
    }

    const workerPromises = chunks.map((chunk, index) => {
      return new Promise<T[]>((resolve, reject) => {
        const worker = new Worker(`
  const { parentPort, workerData } = require('worker_threads');

  const { chunk, column, direction, sortFnString } = workerData;

  // Reconstruct the sort function (be cautious with eval in production)
  // A safer way would be to pass only primitive comparators or have predefined sort strategies.
  let compareFn;
  if (sortFnString) {
    try {
      const dynamicallyCreatedSortFn = eval('(' + sortFnString + ')');
      compareFn = (a, b) => dynamicallyCreatedSortFn(a, b, column, direction);
    } catch (e) {
      parentPort.postMessage({ error: 'Failed to evaluate sortFnString: ' + e.message });
      return;
    }
  } else {
    // Default comparator if no custom function string is provided
    compareFn = (a, b) => {
      const aVal = a[column];
      const bVal = b[column];

      if (aVal === bVal) return 0;
      if (aVal === null || aVal === undefined) return direction === 'asc' ? -1 : 1;
      if (bVal === null || bVal === undefined) return direction === 'asc' ? 1 : -1;
      
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const comparison = String(aVal).localeCompare(String(bVal));
      return direction === 'asc' ? comparison : -comparison;
    };
  }

  try {
    chunk.sort(compareFn);
    parentPort.postMessage({ sortedChunk: chunk });
  } catch (e) {
    parentPort.postMessage({ error: 'Error during sort in worker: ' + e.message });
  }
`, {
          eval: true, // Necessary for the inline string worker
          workerData: {
            chunk,
            column: typeof columnOrFn !== 'function' ? columnOrFn : undefined, // Only pass column if not custom fn
            direction,
            sortFnString: sortFnStringToWorker, // Pass the function string
          },
        });

        worker.on('message', (message) => {
          if (message.error) {
            reject(new CSVError(`Worker sort error (chunk ${index}): ${message.error}`, message.error));
          } else if (message.sortedChunk) {
            resolve(message.sortedChunk);
          } else {
            reject(new CSVError(`Worker ${index} sent unknown message.`));
          }
          worker.terminate();
        });
        worker.on('error', (err) => {
          reject(new CSVError(`Worker ${index} encountered an error: ${err.message}`, err));
          worker.terminate();
        });
        worker.on('exit', (code) => {
          if (code !== 0) {
            // This might be redundant if 'error' or 'message.error' already rejected
            // reject(new CSVError(`Worker ${index} exited with code ${code}`));
          }
        });
      });
    });

    try {
      const sortedChunks = await Promise.all(workerPromises);
      // Now, merge the sorted chunks
      const mergedData = this.kWayMerge(sortedChunks, compareFn);
      return new CSV<T>(mergedData, this.additionalHeader, this.validationResults);
    } catch (error) {
      console.error("Error during parallel sort:", error);
      // Fallback: sort in main thread if workers fail catastrophically
      // (Or rethrow, depending on desired robustness vs. performance guarantee)
      console.warn("Parallel sort failed, falling back to main thread sort.");
      const sortedData = [...this.data].sort(compareFn);
      return new CSV<T>(sortedData, this.additionalHeader, this.validationResults);
    }
  }

  /**
   * Performs a k-way merge on multiple sorted arrays (chunks).
   * This is a helper for `sortByAsync`.
   *
   * @param arrays - An array of arrays, where each inner array is already sorted
   *                 according to the `compareFn`.
   * @param compareFn - The comparison function used to sort the arrays and to merge them.
   * @returns A single sorted array containing all elements from the input arrays.
   * @private
   */
  private kWayMerge(arrays: T[][], compareFn: (a: T, b: T) => number): T[] {
    if (!arrays || arrays.length === 0) return [];
    if (arrays.length === 1) return arrays[0];

    // This is a basic iterative merge. For a large number of arrays (k),
    // a min-heap based k-way merge would be more efficient.
    let result = arrays[0];
    for (let i = 1; i < arrays.length; i++) {
      result = this.mergeTwoSortedArrays(result, arrays[i], compareFn);
    }
    return result;
  }

  /**
   * Merges two already sorted arrays into a single sorted array.
   * @param arr1 - First sorted array.
   * @param arr2 - Second sorted array.
   * @param compareFn - Comparison function.
   * @returns A new sorted array containing elements from arr1 and arr2.
   * @private
   */
  private mergeTwoSortedArrays(arr1: T[], arr2: T[], compareFn: (a: T, b: T) => number): T[] {
    const merged: T[] = [];
    let i = 0, j = 0;
    while (i < arr1.length && j < arr2.length) {
      if (compareFn(arr1[i], arr2[j]) <= 0) {
        merged.push(arr1[i++]);
      } else {
        merged.push(arr2[j++]);
      }
    }
    while (i < arr1.length) {
      merged.push(arr1[i++]);
    }
    while (j < arr2.length) {
      merged.push(arr2[j++]);
    }
    return merged;
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
    const result: T[] = [];

    // Use a more efficient algorithm by creating an index for faster lookups
    // We'll use a Map to group otherData items by their key characteristics
    // This is a heuristic that may not work for all equality functions, but works for many common cases
    const createKey = (item: T | E): string => {
      if (typeof item !== 'object' || item === null) return String(item);
      // Use the first few properties as a rough index
      return Object.entries(item)
        .slice(0, 3)
        .map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('|');
    };

    // Index the other array for faster lookups
    const otherMap = new Map<string, E[]>();
    for (const itemB of otherData) {
      const key = createKey(itemB);
      if (!otherMap.has(key)) {
        otherMap.set(key, []);
      }
      otherMap.get(key)!.push(itemB);
    }

    // Track processed items from both arrays
    const processedB = new Set<E>();

    // First pass: find matches and merge them
    for (const itemA of this.data) {
      const key = createKey(itemA);
      const potentialMatches = otherMap.get(key) || [];
      let matched = false;

      // Only iterate through potential matches that share the same key
      for (const itemB of potentialMatches) {
        if (processedB.has(itemB)) continue;

        if (equalityFn(itemA, itemB)) {
          result.push(mergeFn(itemA, itemB));
          processedB.add(itemB);
          matched = true;
          break;
        }
      }

      // If no match found, add the item from A
      if (!matched) {
        result.push({ ...itemA });
      }
    }

    // Add remaining items from B that weren't matched
    for (const itemB of otherData) {
      if (!processedB.has(itemB)) {
        result.push({ ...(itemB as unknown as T) });
      }
    }

    return new CSV<T>(result, this.additionalHeader);
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
   * @param options - Options for batch processing
   * @param options.batchSize - Number of items to process in parallel (default: 1)
   * @param options.batchConcurrency - Number of batches to process in parallel (default: 1)
   * @returns Promise that resolves when processing is complete
   */
  async forEachAsync(
    callback: (row: T, index: number) => Promise<void>,
    options: { batchSize?: number; batchConcurrency?: number } = {}
  ): Promise<void> {
    const batchSize = options.batchSize || 1;
    const batchConcurrency = options.batchConcurrency || 1;

    if (batchSize <= 1 && batchConcurrency <= 1) {
      // Original sequential processing
      for (let i = 0; i < this.data.length; i++) {
        await callback(this.data[i], i);
      }
      return;
    }

    // Process data in batches with concurrency
    const batches: T[][] = [];
    for (let i = 0; i < this.data.length; i += batchSize) {
      batches.push(this.data.slice(i, i + batchSize));
    }

    // Process batches with controlled concurrency
    for (let i = 0; i < batches.length; i += batchConcurrency) {
      const batchPromises = batches.slice(i, i + batchConcurrency).map(async (batch, batchIndex) => {
        const startIdx = i * batchSize + batchIndex * batchSize;
        const promises = batch.map((row, rowIndex) =>
          callback(row, startIdx + rowIndex)
        );
        await Promise.all(promises);
      });

      await Promise.all(batchPromises);
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
   * Map over rows asynchronously with optional batch processing
   * @param callback - Async function to map each row
   * @param options - Options for batch processing
   * @param options.batchSize - Number of items to process in parallel (default: 1)
   * @param options.batchConcurrency - Number of batches to process in parallel (default: 1) 
   * @returns Promise resolving to array of mapped values
   */
  async mapAsync<R>(
    callback: (row: T, index: number) => Promise<R>,
    options: { batchSize?: number; batchConcurrency?: number } = {}
  ): Promise<R[]> {
    const batchSize = options.batchSize || 1;
    const batchConcurrency = options.batchConcurrency || 1;

    if (batchSize <= 1 && batchConcurrency <= 1) {
      // Original sequential processing
      const results: R[] = [];
      for (let i = 0; i < this.data.length; i++) {
        results.push(await callback(this.data[i], i));
      }
      return results;
    }

    // Process data in batches with concurrency
    const batches: T[][] = [];
    for (let i = 0; i < this.data.length; i += batchSize) {
      batches.push(this.data.slice(i, i + batchSize));
    }

    // Create a sparse array to maintain order after parallel processing
    const results: R[] = new Array(this.data.length);

    // Process batches with controlled concurrency
    for (let i = 0; i < batches.length; i += batchConcurrency) {
      const batchPromises = batches.slice(i, i + batchConcurrency).map(async (batch, batchIndex) => {
        const startIdx = i * batchSize + batchIndex * batchSize;
        const batchResults = await Promise.all(
          batch.map((row, rowIndex) => callback(row, startIdx + rowIndex))
        );

        // Insert batch results at the right position
        batchResults.forEach((result, resultIndex) => {
          results[startIdx + resultIndex] = result;
        });
      });

      await Promise.all(batchPromises);
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
   * Reduce the rows asynchronously with optimized batch processing
   * 
   * @description This method offers two different optimization strategies:
   * 1. Sequential with batched preprocessing (default) - This helps when preprocessing your data 
   *    is expensive but the actual reduction is order-dependent
   * 2. Map-reduce style parallel processing - This requires an associative and commutative reducer
   *    and is more efficient for large datasets with independent operations
   * 
   * @param callback - Async reducer function
   * @param initialValue - Starting value
   * @param options - Options for optimized processing
   * @param options.strategy - Processing strategy: 'sequential' (default) or 'mapreduce'
   * @param options.batchSize - Size of batches for preprocessing or parallel reduction
   * @returns Promise resolving to reduced value
   */
  async reduceAsync<R>(
    callback: (accumulator: R, row: T, index: number) => Promise<R>,
    initialValue: R,
    options: {
      strategy?: 'sequential' | 'mapreduce';
      batchSize?: number;
    } = {}
  ): Promise<R> {
    const batchSize = options.batchSize || 20;
    const strategy = options.strategy || 'sequential';

    // Simple sequential case for small datasets or when not optimizing
    if (this.data.length <= batchSize || batchSize <= 1) {
      let result = initialValue;
      for (let i = 0; i < this.data.length; i++) {
        result = await callback(result, this.data[i], i);
      }
      return result;
    }

    if (strategy === 'sequential') {
      // Sequential with batched preprocessing optimization
      // This helps when preprocessing your data is expensive but the reduction is order-dependent
      let result = initialValue;

      // Process data in batches
      const batches: T[][] = [];
      for (let i = 0; i < this.data.length; i += batchSize) {
        batches.push(this.data.slice(i, i + batchSize));
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const baseIndex = batchIndex * batchSize;

        // Process the batch sequentially but with possible preprocessing optimizations
        for (let i = 0; i < batch.length; i++) {
          result = await callback(result, batch[i], baseIndex + i);
        }
      }

      return result;
    } else if (strategy === 'mapreduce') {
      // Map-reduce style parallel processing
      // This requires an associative and commutative reducer and is more efficient for large datasets

      // Create batches
      const batches: T[][] = [];
      for (let i = 0; i < this.data.length; i += batchSize) {
        batches.push(this.data.slice(i, i + batchSize));
      }

      // First, reduce each batch in parallel (map phase)
      const batchResults = await Promise.all(
        batches.map(async (batch, batchIndex) => {
          const baseIndex = batchIndex * batchSize;
          let batchResult = initialValue;

          for (let i = 0; i < batch.length; i++) {
            batchResult = await callback(batchResult, batch[i], baseIndex + i);
          }

          return batchResult;
        })
      );

      // Then, reduce the batch results (reduce phase)
      let finalResult = initialValue;
      for (const batchResult of batchResults) {
        // We use a dummy index here since we're reducing already-reduced results
        finalResult = await callback(finalResult, batchResult as unknown as T, -1);
      }

      return finalResult;
    }

    // Fallback to standard sequential processing
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
   * Get the first n rows
   * @param count - Number of rows to get
   * @returns A new CSV instance with the first rows
   */
  take(count: number = 10): CSV<T> {
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

  /**
   * Adds a new column to each row.
   * The new column's value can be a fixed default or derived from a function.
   * If the column name already exists, its values will be overwritten.
   *
   * @param columnName - The name of the new column.
   * @param valueOrFn - A fixed value for the new column, or a function that
   *                    takes the current row and returns the value for the new column.
   * @returns A new CSV instance with the added/updated column.
   * @template NewKey - The type of the new column's name (string literal).
   * @template NewValue - The type of the new column's value.
   * @example
   * ```typescript
   * // interface User { id: number; name: string; }
   * // const csv = CSV.fromData<User>([{ id: 1, name: 'Alice' }]);
   *
   * // Add a column with a fixed value
   * const csvWithRole = csv.addColumn('role', 'user');
   * // csvWithRole.toArray() is [{ id: 1, name: 'Alice', role: 'user' }]
   *
   * // Add a column with a derived value
   * const csvWithLen = csv.addColumn('nameLength', row => row.name.length);
   * // csvWithLen.toArray() is [{ id: 1, name: 'Alice', nameLength: 5 }]
   *
   * // Overwrite an existing column
   * const csvUpdatedName = csv.addColumn('name', row => row.name.toUpperCase());
   * // csvUpdatedName.toArray() is [{ id: 1, name: 'ALICE' }]
   * ```
   */
  addColumn<NewKey extends string, NewValue>(
    columnName: NewKey,
    valueOrFn: NewValue | ((row: T) => NewValue)
  ): CSV<T & Record<NewKey, NewValue>> {
    if (this.data.length > 0 && Object.prototype.hasOwnProperty.call(this.data[0], columnName)) {
      console.warn(`CSV.addColumn: Column "${columnName}" already exists. Its values will be overwritten.`);
    }

    const newData = this.data.map(row => {
      const newValue = typeof valueOrFn === 'function'
        ? (valueOrFn as (row: T) => NewValue)(row) // Type assertion for clarity
        : valueOrFn;
      return {
        ...row,
        [columnName]: newValue,
      } as T & Record<NewKey, NewValue>; // Assert the new row type
    });
    return new CSV<T & Record<NewKey, NewValue>>(newData, this.additionalHeader);
  }

  /**
   * Removes one or more columns from each row.
   * If a specified column does not exist, it's silently ignored.
   *
   * @param columnNames - A single column name or an array of column names to remove.
   *                      Can be `keyof T` or a string.
   * @returns A new CSV instance with the specified columns removed.
   * @template K - Union of the keys to be removed.
   * @example
   * ```typescript
   * // interface User { id: number; name: string; email: string; }
   * // const csv = CSV.fromData<User>([
   * //   { id: 1, name: 'Alice', email: 'a@ex.com' }
   * // ]);
   *
   * // Remove a single column
   * const csvWithoutEmail = csv.removeColumn('email');
   * // csvWithoutEmail.toArray() is [{ id: 1, name: 'Alice' }]
   *
   * // Remove multiple columns
   * const csvOnlyId = csv.removeColumn(['name', 'email']);
   * // csvOnlyId.toArray() is [{ id: 1 }]
   * ```
   */
  removeColumn<K extends keyof T | string>( // Allow string for broader compatibility
    columnNames: K | K[]
  ): CSV<Omit<T, Extract<K, keyof T>>> { // Extract ensures K is narrowed to actual keys of T for Omit
    const namesToRemoveArray = Array.isArray(columnNames) ? columnNames : [columnNames];
    // Convert all to string for consistent Set operations, as keyof T could be numbers/symbols
    const nameSetToRemove = new Set(namesToRemoveArray.map(String));

    if (nameSetToRemove.size === 0) {
      // If no columns specified or empty array, return a new instance with the same data and type
      return new CSV<Omit<T, Extract<K, keyof T>>>([...this.data] as any, this.additionalHeader); // `as any` because Omit might be Omit<T, never>
    }

    const newData = this.data.map(row => {
      const newRow = { ...row } as Partial<T>; // Start as Partial for deletion
      nameSetToRemove.forEach(name => {
        delete newRow[name as keyof T]; // Type assertion for deletion
      });
      return newRow as Omit<T, Extract<K, keyof T>>;
    });
    return new CSV<Omit<T, Extract<K, keyof T>>>(newData, this.additionalHeader);
  }

  /**
   * Renames a column in each row.
   * If the old column name does not exist in a row, that row remains unchanged (but its type signature adapts).
   * If the new column name already exists and is different from the old name, it will be overwritten.
   *
   * @param oldName - The current name of the column. Can be `keyof T` or a string.
   * @param newName - The new name for the column.
   * @returns A new CSV instance with the column renamed.
   * @template OldK - The type of the old column name.
   * @template NewK - The type of the new column name (string literal).
   * @example
   * ```typescript
   * // interface User { userId: number; userName: string; }
   * // const csv = CSV.fromData<User>([
   * //   { userId: 1, userName: 'Alice' }
   * // ]);
   *
   * // Rename 'userId' to 'id'
   * const csvRenamedId = csv.renameColumn('userId', 'id');
   * // csvRenamedId.toArray() is [{ id: 1, userName: 'Alice' }]
   *
   * // Rename 'userName' to 'name'
   * const csvRenamedName = csvRenamedId.renameColumn('userName', 'name');
   * // csvRenamedName.toArray() is [{ id: 1, name: 'Alice' }]
   * ```
   */
  renameColumn<OldK extends keyof T | string, NewK extends string>(
    oldName: OldK,
    newName: NewK
  ): CSV<Omit<T, Extract<OldK, keyof T>> & Record<NewK, OldK extends keyof T ? T[OldK] : any>> {
    const oldNameStr = String(oldName);
    const newNameStr = String(newName);

    if (oldNameStr === newNameStr) {
      console.warn(`CSV.renameColumn: Old name and new name are the same ("${oldNameStr}"). Returning a new instance with potentially updated type signature but unchanged data values.`);
      // Return new instance to reflect the potentially more specific type signature (e.g. if NewK was a literal type)
      return new CSV(this.data.map(row => ({ ...row })) as any[], this.additionalHeader);
    }

    if (this.data.length > 0 && Object.prototype.hasOwnProperty.call(this.data[0], newNameStr)) {
      console.warn(`CSV.renameColumn: New column name "${newNameStr}" already exists. It will be overwritten by the value from "${oldNameStr}".`);
    }

    const newData = this.data.map(row => {
      if (!Object.prototype.hasOwnProperty.call(row, oldNameStr)) {
        // If oldName doesn't exist, return row as is but cast to new type signature.
        // This implies the new column might be undefined if the old one wasn't there.
        // The Record<NewK, OldK extends keyof T ? T[OldK] : any> attempts to handle this.
        // A stricter approach might require oldName to always exist.
        const newRow = { ...row } as any;
        if (!(newNameStr in newRow)) { // Only add if newName isn't already there (e.g. from an earlier overwrite warning)
          newRow[newNameStr] = undefined; // Or handle as error / configurable default
        }
        return newRow;
      }

      // Standard rename: destructure, assign to new key, omit old key
      const { [oldNameStr]: value, ...rest } = row as any; // Use 'as any' for dynamic destructuring
      return {
        ...rest,
        [newNameStr]: value,
      };
    });
    // The resulting type is complex to infer perfectly. The Omit & Record combination is a good attempt.
    return new CSV<Omit<T, Extract<OldK, keyof T>> & Record<NewK, OldK extends keyof T ? T[OldK] : any>>(newData, this.additionalHeader);
  }

  /**
   * Reorders columns in each row according to the specified order.
   * Columns not included in `orderedColumnNames` will be placed after the ordered ones,
   * maintaining their original relative order among themselves.
   * If `orderedColumnNames` contains names not present in the data, they are ignored.
   *
   * @param orderedColumnNames - An array of column names (or `keyof T`) in the desired order.
   * @returns A new CSV instance with columns reordered.
   * @example
   * ```typescript
   * // interface User { id: number; name: string; email: string; age: number }
   * // const csv = CSV.fromData<User>([
   * //   { id: 1, name: 'Alice', email: 'a@ex.com', age: 30 }
   * // ]);
   *
   * // Reorder to: name, id, email, age
   * const reorderedCsv = csv.reorderColumns(['name', 'id']);
   * // reorderedCsv.toArray()[0] keys order: 'name', 'id', 'email', 'age'
   *
   * // Reorder with a non-existent column (it will be ignored)
   * const reorderedCsv2 = csv.reorderColumns(['email', 'nonExistent', 'name']);
   * // reorderedCsv2.toArray()[0] keys order: 'email', 'name', 'id', 'age'
   * ```
   */
  reorderColumns(
    orderedColumnNames: (keyof T | string)[]
  ): CSV<T> {
    if (this.data.length === 0) {
      return new CSV<T>([], this.additionalHeader); // Return new empty instance
    }

    const allCurrentKeys = Object.keys(this.data[0]); // Get keys from the first row as a prototype
    const uniqueOrderedStrNames = Array.from(new Set(orderedColumnNames.map(String)));

    const finalOrder: string[] = [];
    const remainingKeys = new Set(allCurrentKeys);

    // Add keys from orderedColumnNames that exist in the data
    uniqueOrderedStrNames.forEach(name => {
      if (remainingKeys.has(name)) {
        finalOrder.push(name);
        remainingKeys.delete(name);
      }
    });

    // Add remaining keys (those not in orderedColumnNames but in the original data)
    // in their original relative order.
    allCurrentKeys.forEach(key => {
      if (remainingKeys.has(key)) { // Check if it wasn't already added
        finalOrder.push(key);
      }
    });

    // If finalOrder is empty (e.g., allCurrentKeys was empty, or orderedColumnNames were all non-existent)
    // default to original keys to avoid creating empty objects.
    const effectiveOrder = finalOrder.length > 0 ? finalOrder : allCurrentKeys;

    const newData = this.data.map(row => {
      const newRow: Partial<T> = {};
      effectiveOrder.forEach(key => {
        // Only copy properties that actually exist on the current row
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          newRow[key as keyof T] = row[key as keyof T];
        }
      });
      return newRow as T; // Cast to T, assuming the reordering preserves the necessary fields
    });

    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
   * Attempts to cast the values in a specified column to a given data type.
   * If casting fails for a value (e.g., 'abc' to number), it becomes `null`.
   *
   * @param columnName - The name of the column to cast. Can be `keyof T` or a string.
   * @param targetType - The target data type: 'string', 'number', 'boolean', or 'date'.
   * @returns A new CSV instance with the column values cast.
   *          The generic type `T` of the CSV instance does not change due to runtime casting limitations.
   *          Users should be aware that the underlying data's types will change.
   * @example
   * ```typescript
   * // interface Product { id: string; price: string; available: string; }
   * // const csv = CSV.fromData<Product>([
   * //   { id: '1', price: '19.99', available: 'true' },
   * //   { id: '2', price: ' N/A ', available: '0' }
   * // ]);
   *
   * let castedCsv = csv.castColumnType('id', 'number');
   * castedCsv = castedCsv.castColumnType('price', 'number');
   * castedCsv = castedCsv.castColumnType('available', 'boolean');
   * // castedCsv.toArray() might be:
   * // [
   * //   { id: 1, price: 19.99, available: true },
   * //   { id: '2', price: null, available: false } // 'N/A' becomes null for price
   * // ]
   * ```
   */
  castColumnType(
    columnName: keyof T | string,
    targetType: 'string' | 'number' | 'boolean' | 'date'
    // dateFormat?: string // Kept commented as it requires an external library
  ): CSV<T> {
    const colNameStr = String(columnName);

    const newData = this.data.map(row => {
      if (!Object.prototype.hasOwnProperty.call(row, colNameStr)) {
        return { ...row }; // Column doesn't exist in this row, return a copy
      }

      const originalValue = (row as any)[colNameStr]; // Use 'as any' for dynamic access
      let newValue: string | number | boolean | Date | null = originalValue; // Typed more specifically

      switch (targetType) {
        case 'string':
          newValue = originalValue === null || originalValue === undefined ? '' : String(originalValue);
          break;
        case 'number':
          // Handle various representations of numbers before casting
          const strValForNum = String(originalValue).trim();
          if (strValForNum === '') {
            newValue = null; // Empty string to null for numbers
          } else {
            const num = Number(strValForNum);
            newValue = isNaN(num) ? null : num;
          }
          break;
        case 'boolean':
          if (typeof originalValue === 'boolean') {
            newValue = originalValue;
          } else if (originalValue === null || originalValue === undefined) {
            newValue = null; // Or false, depending on desired policy for nulls
          } else {
            const strValForBool = String(originalValue).trim().toLowerCase();
            if (['true', '1', 'yes', 'on', 't'].includes(strValForBool)) {
              newValue = true;
            } else if (['false', '0', 'no', 'off', 'f', ''].includes(strValForBool)) { // Empty string often means false
              newValue = false;
            } else {
              newValue = null; // Unrecognized boolean string to null
            }
          }
          break;
        case 'date':
          if (originalValue === null || originalValue === undefined || String(originalValue).trim() === '') {
            newValue = null;
          } else {
            // Consider a more robust date check if originalValue is already a Date object
            if (originalValue instanceof Date && !isNaN(originalValue.getTime())) {
              newValue = originalValue;
            } else {
              const date = new Date(originalValue as any); // `as any` for flexible Date constructor
              newValue = isNaN(date.getTime()) ? null : date;
            }
          }
          break;
        default:
          // This case should be unreachable due to TypeScript's union type for targetType
          // but good for defensive programming or if targetType could be less constrained.
          ((exhaustiveCheck: never) => {
            // This forces a compile-time check if not all cases of targetType are handled.
            // If targetType is expanded, TypeScript will error here unless new cases are added.
            console.warn(`CSV.castColumnType: Unhandled target type "${exhaustiveCheck}" for column "${colNameStr}".`);
          })(targetType);
          break;
      }

      return {
        ...row,
        [colNameStr]: newValue,
      };
    });
    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
   * Removes duplicate rows based on all columns or a specified subset of columns.
   * The first occurrence of a unique row (or unique combination of values in `columnsToCheck`) is kept.
   *
   * @param columnsToCheck - Optional array of column names to check for duplication.
   *                         If omitted or empty, all columns in a row are used to determine uniqueness.
   *                         The order of columns in `columnsToCheck` matters for the generated key.
   * @returns A new CSV instance with duplicate rows removed.
   * @example
   * ```typescript
   * // interface Item { id: number; category: string; value: number }
   * // const csv = CSV.fromData<Item>([
   * //   { id: 1, category: 'A', value: 10 },
   * //   { id: 2, category: 'B', value: 20 },
   * //   { id: 1, category: 'A', value: 10 }, // Duplicate of first row
   * //   { id: 3, category: 'A', value: 30 },
   * //   { id: 4, category: 'B', value: 20 }  // Same category & value as 2nd, but different ID
   * // ]);
   *
   * // Deduplicate based on all columns
   * const dedupAll = csv.deduplicate();
   * // dedupAll.toArray() would be:
   * // [
   * //   { id: 1, category: 'A', value: 10 },
   * //   { id: 2, category: 'B', value: 20 },
   * //   { id: 3, category: 'A', value: 30 },
   * //   { id: 4, category: 'B', value: 20 }
   * // ]
   *
   * // Deduplicate based on 'category' and 'value'
   * const dedupByCatVal = csv.deduplicate(['category', 'value']);
   * // dedupByCatVal.toArray() would be (first occurrence of 'A', 10 and 'B', 20 are kept):
   * // [
   * //   { id: 1, category: 'A', value: 10 },
   * //   { id: 2, category: 'B', value: 20 },
   * //   { id: 3, category: 'A', value: 30 }
   * // ]
   * ```
   */
  deduplicate(columnsToCheck?: (keyof T)[]): CSV<T> {
    if (this.data.length === 0) {
      return new CSV<T>([], this.additionalHeader); // Return new empty instance
    }

    const seen = new Set<string>();
    const newData: T[] = [];
    // Determine the keys to use for uniqueness check once
    const effectiveColumnsToCheck = (columnsToCheck && columnsToCheck.length > 0)
      ? columnsToCheck
      : (this.data.length > 0 ? Object.keys(this.data[0]) as (keyof T)[] : []); // Fallback to all keys from first row

    if (effectiveColumnsToCheck.length === 0 && this.data.length > 0) {
      // This case implies all rows are considered unique if columnsToCheck is effectively empty
      // but data exists. Usually, if columnsToCheck is empty, we use all columns.
      // The logic above means Object.keys(this.data[0]) is used.
      // If this.data[0] was empty object, then all rows would be "" key.
      console.warn("CSV.deduplicate: No columns to check for uniqueness effectively; if all rows are empty objects, only one will be kept.");
    }


    this.data.forEach(row => {
      let key: string;
      if (columnsToCheck && columnsToCheck.length > 0) { // User explicitly provided columns
        key = columnsToCheck
          .map(colName => {
            const val = row[colName];
            // Consistent stringification for Set key (null/undefined become specific strings)
            return val === null ? 'null' : (val === undefined ? 'undefined' : String(val));
          })
          .join('||::||'); // Use a more unique separator
      } else {
        // Use all values in the row (in the order of keys from the first row for consistency)
        key = (Object.keys(row) as (keyof T)[]) // Get keys from current row to handle sparse data
          .sort() // Sort keys for consistent key generation regardless of original object order
          .map(k => {
            const val = row[k];
            return `${String(k)}:${val === null ? 'null' : (val === undefined ? 'undefined' : String(val))}`;
          })
          .join('||::||');
      }

      if (!seen.has(key)) {
        seen.add(key);
        newData.push({ ...row }); // Push a shallow copy
      }
    });

    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
   * Splits the CSV into two new CSV instances based on a condition.
   * Rows for which the condition is true go into the `pass` CSV; others go into the `fail` CSV.
   *
   * @param condition - A function that takes a row and returns `true` if it should
   *                    be included in the `pass` CSV instance.
   * @returns An object containing two new CSV instances: `pass` and `fail`.
   * @example
   * ```typescript
   * // interface User { id: number; name: string; age: number }
   * // const csv = CSV.fromData<User>([
   * //   { id: 1, name: 'Alice', age: 30 },
   * //   { id: 2, name: 'Bob', age: 22 },
   * //   { id: 3, name: 'Carol', age: 35 }
   * // ]);
   *
   * const { pass: adults, fail: minors } = csv.split(row => row.age >= 30);
   * // adults.toArray() is [{ id: 1, name: 'Alice', age: 30 }, { id: 3, name: 'Carol', age: 35 }]
   * // minors.toArray() is [{ id: 2, name: 'Bob', age: 22 }]
   * ```
   */
  split(condition: (row: T) => boolean): { pass: CSV<T>; fail: CSV<T> } {
    const passData: T[] = [];
    const failData: T[] = [];

    this.data.forEach(row => {
      // Ensure a shallow copy is pushed to maintain immutability of original data if row objects are complex
      if (condition(row)) {
        passData.push({ ...row });
      } else {
        failData.push({ ...row });
      }
    });

    return {
      pass: new CSV<T>(passData, this.additionalHeader),
      fail: new CSV<T>(failData, this.additionalHeader),
    };
  }

  /**
   * Joins the current CSV data (left table) with another CSV dataset (right table).
   *
   * @param otherCsv - The other CSV instance to join with.
   * @param on - An object specifying the join keys and type:
   *             `left`: The key (column name) from the current (left) CSV.
   *             `right`: The key (column name) from the `otherCsv` (right) CSV.
   *             `type`: Optional join type: 'inner' (default), 'left', 'right', 'outer'.
   * @param select - Optional function to transform the combined row. It receives `leftRow`
   *                 (or `null` if no match from left) and `rightRow` (or `null` if no match from right).
   *                 If not provided, the result is a shallow merge `{ ...leftRow, ...rightRow }`.
   *                 In case of colliding property names (not part of join keys), properties from
   *                 `rightRow` will overwrite those from `leftRow` in the default merge.
   * @returns A new CSV instance with the joined data.
   * @template OtherRowType - The row type of the `otherCsv`.
   * @template JoinedRowType - The row type of the resulting CSV. Defaults to a broad combination.
   * @example
   * ```typescript
   * // interface User { id: number; name: string; cityId: number; }
   * // interface City { cityId: number; cityName: string; }
   * // const users = CSV.fromData<User>([
   * //   { id: 1, name: 'Alice', cityId: 101 },
   * //   { id: 2, name: 'Bob', cityId: 102 },
   * //   { id: 3, name: 'Charlie', cityId: 103 }, // No matching city
   * // ]);
   * // const cities = CSV.fromData<City>([
   * //   { cityId: 101, cityName: 'New York' },
   * //   { cityId: 102, cityName: 'London' },
   * //   { cityId: 104, cityName: 'Paris' }, // No matching user
   * // ]);
   *
   * // Inner Join
   * const innerJoin = users.join(cities, { left: 'cityId', right: 'cityId' });
   * // innerJoin.toArray() could be:
   * // [
   * //   { id: 1, name: 'Alice', cityId: 101, cityName: 'New York' },
   * //   { id: 2, name: 'Bob', cityId: 102, cityName: 'London' }
   * // ]
   *
   * // Left Join
   * const leftJoin = users.join(cities, { left: 'cityId', right: 'cityId', type: 'left' });
   * // leftJoin.toArray() could be:
   * // [
   * //   { id: 1, name: 'Alice', cityId: 101, cityName: 'New York' },
   * //   { id: 2, name: 'Bob', cityId: 102, cityName: 'London' },
   * //   { id: 3, name: 'Charlie', cityId: 103, cityName: undefined } // or null from select
   * // ]
   *
   * // Custom select function
   * const customJoin = users.join(
   *   cities,
   *   { left: 'cityId', right: 'cityId', type: 'inner' },
   *   (user, city) => ({ userName: user!.name, city: city!.cityName })
   * );
   * // customJoin.toArray() could be:
   * // [
   * //   { userName: 'Alice', city: 'New York' },
   * //   { userName: 'Bob', city: 'London' }
   * // ]
   * ```
   */
  join<
    OtherRowType extends Record<string, any>,
    JoinedRowType extends Record<string, any> = T & Partial<OtherRowType>
  >(
    otherCsv: CSV<OtherRowType>,
    onConfig: { // Renamed 'on' to 'onConfig' to avoid conflict with potential future JS keyword
      left: keyof T;
      right: keyof OtherRowType;
      type?: 'inner' | 'left' | 'right' | 'outer';
    },
    select?: (leftRow: T | null, rightRow: OtherRowType | null) => JoinedRowType
  ): CSV<JoinedRowType> {
    const leftData = this.toArray(); // Use .toArray() to get a mutable copy if needed, or just this.data if immutable
    const rightData = otherCsv.toArray();
    const joinType = onConfig.type || 'inner';

    const defaultSelectFn = (l: T | null, r: OtherRowType | null): JoinedRowType => {
      // Shallow merge. Properties from 'r' will overwrite 'l' in case of name collision.
      // The join keys themselves might appear twice if named differently, or once if named the same.
      return { ...(l as any), ...(r as any) } as JoinedRowType;
    };
    const selectFn = select || defaultSelectFn;

    const joinedData: JoinedRowType[] = [];

    // Build a map of the right table for efficient lookups (key -> array of rows with that key)
    const rightDataMap = new Map<any, OtherRowType[]>();
    rightData.forEach(rRow => {
      const key = rRow[onConfig.right];
      if (!rightDataMap.has(key)) {
        rightDataMap.set(key, []);
      }
      rightDataMap.get(key)!.push(rRow);
    });

    // Keep track of which right rows have been matched (for right/outer joins)
    // Using a Set of the actual row objects (references)
    const matchedRightRows = new Set<OtherRowType>();

    // --- Process Left Table ---
    leftData.forEach(lRow => {
      const leftKey = lRow[onConfig.left];
      const potentialRightMatches = rightDataMap.get(leftKey) || [];
      let lRowHasMatch = false;

      if (potentialRightMatches.length > 0) {
        potentialRightMatches.forEach(rRow => {
          joinedData.push(selectFn(lRow, rRow));
          matchedRightRows.add(rRow); // Mark this right row as matched
          lRowHasMatch = true;
        });
      }

      if (!lRowHasMatch && (joinType === 'left' || joinType === 'outer')) {
        joinedData.push(selectFn(lRow, null));
      }
    });

    // --- Process Unmatched Right Table Rows (for 'right' and 'outer' joins) ---
    if (joinType === 'right' || joinType === 'outer') {
      rightData.forEach(rRow => {
        if (!matchedRightRows.has(rRow)) {
          joinedData.push(selectFn(null, rRow));
        }
      });
    }

    return new CSV<JoinedRowType>(joinedData, this.additionalHeader);
  }

  /**
   * Transforms the CSV from a wide format to a long format (unpivots or melts).
   * Specified `valueCols` are converted into two new columns: one for the original
   * column name (variable) and one for its value. `idCols` are repeated for each new row.
   *
   * @param idCols - An array of column names that identify each observation and will be repeated.
   * @param valueCols - An array of column names whose values will be unpivoted.
   * @param varName - The name for the new column that will hold the original column names from `valueCols`. Defaults to 'variable'.
   * @param valueName - The name for the new column that will hold the values from `valueCols`. Defaults to 'value'.
   * @returns A new CSV instance with the unpivoted data.
   * @template IdKeys - Keys of the identifier columns.
   * @template ValueKeys - Keys of the value columns being unpivoted.
   * @template VarNameCol - Type of the new variable name column.
   * @template ValueNameCol - Type of the new value name column.
   * @example
   * ```typescript
   * // interface Sales { product: string; q1_sales: number; q2_sales: number; q3_sales: number; }
   * // const csv = CSV.fromData<Sales>([
   * //   { product: 'A', q1_sales: 100, q2_sales: 150, q3_sales: 120 },
   * //   { product: 'B', q1_sales: 200, q2_sales: 180, q3_sales: 210 },
   * // ]);
   *
   * const idCols: (keyof Sales)[] = ['product'];
   * const valueCols: (keyof Sales)[] = ['q1_sales', 'q2_sales', 'q3_sales'];
   *
   * const unpivotedCsv = csv.unpivot(idCols, valueCols, 'quarter', 'sales');
   * // unpivotedCsv.toArray() could be:
   * // [
   * //   { product: 'A', quarter: 'q1_sales', sales: 100 },
   * //   { product: 'A', quarter: 'q2_sales', sales: 150 },
   * //   { product: 'A', quarter: 'q3_sales', sales: 120 },
   * //   { product: 'B', quarter: 'q1_sales', sales: 200 },
   * //   { product: 'B', quarter: 'q2_sales', sales: 180 },
   * //   { product: 'B', quarter: 'q3_sales', sales: 210 }
   * // ]
   * ```
   */
  unpivot<
    IdKeys extends keyof T,
    ValueKeys extends keyof T,
    VarNameCol extends string = 'variable', // Default name for the variable column
    ValueNameCol extends string = 'value'  // Default name for the value column
  >(
    idCols: IdKeys[],
    valueCols: ValueKeys[],
    varName: VarNameCol = 'variable' as VarNameCol,
    valueName: ValueNameCol = 'value' as ValueNameCol
  ): CSV<
    Pick<T, IdKeys> &
    Record<VarNameCol, ValueKeys extends string ? ValueKeys : string> & // Type of variable name is the string literal of ValueKeys if possible
    Record<ValueNameCol, T[ValueKeys]> // Type of value is the union of types of values in ValueKeys
  > {
    if (idCols.length === 0 && valueCols.length === 0) {
      console.warn("CSV.unpivot: Both idCols and valueCols are empty. Returning original data structure.");
      return this as any; // Or a new CSV with copied data if strict immutability is preferred
    }
    if (valueCols.length === 0) {
      console.warn("CSV.unpivot: valueCols is empty. No columns to unpivot. Returning data with only idCols.");
      // This effectively becomes a select operation on idCols
      const selectedData = this.data.map(row => {
        const newRow: Partial<Pick<T, IdKeys>> = {};
        idCols.forEach(idCol => {
          if (Object.prototype.hasOwnProperty.call(row, idCol)) {
            newRow[idCol] = row[idCol];
          }
        });
        return newRow as Pick<T, IdKeys>;
      });
      return new CSV(selectedData as any[], this.additionalHeader);
    }

    const newData: Array<
      Pick<T, IdKeys> &
      Record<VarNameCol, ValueKeys extends string ? ValueKeys : string> &
      Record<ValueNameCol, T[ValueKeys]>
    > = [];

    this.data.forEach(row => {
      const idPart: Pick<T, IdKeys> = {} as Pick<T, IdKeys>;
      idCols.forEach(idCol => {
        if (Object.prototype.hasOwnProperty.call(row, idCol)) {
          idPart[idCol] = row[idCol];
        }
      });

      valueCols.forEach(valueColKey => {
        if (Object.prototype.hasOwnProperty.call(row, valueColKey)) {
          const newRow = {
            ...idPart,
            [varName]: valueColKey, // valueColKey is keyof T, will be stringified
            [valueName]: row[valueColKey],
          } as Pick<T, IdKeys> &
            Record<VarNameCol, ValueKeys extends string ? ValueKeys : string> &
            Record<ValueNameCol, T[ValueKeys]>;
          newData.push(newRow);
        } else {
          // Optionally handle missing valueCols differently, e.g., skip or add with null/undefined value
          console.warn(`CSV.unpivot: Column "${String(valueColKey)}" not found in a row. Skipping for this row's unpivot operation on this column.`);
        }
      });
    });

    return new CSV<
      Pick<T, IdKeys> &
      Record<VarNameCol, ValueKeys extends string ? ValueKeys : string> &
      Record<ValueNameCol, T[ValueKeys]>
    >(newData, this.additionalHeader);
  }


  /**
   * Fills missing values (`null` or `undefined`) in a specified column.
   *
   * @param columnName - The name of the column to fill missing values in.
   * @param valueOrFn - The value to fill with, or a function that takes the current row
   *                    and returns the value to fill with.
   * @returns A new CSV instance with missing values filled in the specified column.
   *          The generic type T does not change, but the underlying data will.
   * @example
   * ```typescript
   * // interface Product { name: string; price?: number | null; category: string }
   * // const csv = CSV.fromData<Product>([
   * //   { name: 'Apple', price: 1.0, category: 'Fruit' },
   * //   { name: 'Banana', price: null, category: 'Fruit' },
   * //   { name: 'Carrot', category: 'Vegetable' } // price is undefined
   * // ]);
   *
   * // Fill with a fixed value
   * const filledPrice = csv.fillMissingValues('price', 0);
   * // filledPrice.toArray():
   * // [
   * //   { name: 'Apple', price: 1.0, category: 'Fruit' },
   * //   { name: 'Banana', price: 0, category: 'Fruit' },
   * //   { name: 'Carrot', price: 0, category: 'Vegetable' }
   * // ]
   *
   * // Fill with a derived value (e.g., average of other items - more complex, example simplified)
   * const filledComplex = csv.fillMissingValues('price', row => (row.category === 'Fruit' ? 0.75 : 0.5));
   * ```
   */
  fillMissingValues<K extends keyof T>(
    columnName: K,
    valueOrFn: T[K] | any | ((row: T) => T[K] | any) // Allow 'any' for flexibility if new value type differs
  ): CSV<T> { // Type T remains, but underlying data changes.
    const colNameStr = String(columnName);

    const newData = this.data.map(row => {
      const currentValue = (row as any)[colNameStr]; // Dynamic access

      if (currentValue === null || currentValue === undefined) {
        const newValue = typeof valueOrFn === 'function'
          ? (valueOrFn as (row: T) => T[K] | any)(row)
          : valueOrFn;
        return {
          ...row,
          [colNameStr]: newValue,
        };
      }
      return { ...row }; // Return a copy even if no change for consistency
    });

    return new CSV<T>(newData, this.additionalHeader);
  }


  /**
   * Normalizes the text case of string values in a specified column.
   * Non-string values or missing columns are not affected.
   *
   * @param columnName - The name of the column to normalize.
   * @param normalizationType - The type of normalization: 'lowercase', 'uppercase', or 'capitalize' (first letter of each word).
   * @returns A new CSV instance with text normalized in the specified column.
   * @example
   * ```typescript
   * // interface City { name: string; countryCode: string; }
   * // const csv = CSV.fromData<City>([
   * //   { name: 'new york city', countryCode: 'us' },
   * //   { name: 'LONDON', countryCode: 'GB' }
   * // ]);
   *
   * // Lowercase
   * const lowerNames = csv.normalizeText('name', 'lowercase');
   * // lowerNames.toArray()[0].name is 'new york city'
   *
   * // Uppercase
   * const upperCodes = csv.normalizeText('countryCode', 'uppercase');
   * // upperCodes.toArray()[0].countryCode is 'US'
   *
   * // Capitalize
   * const capNames = csv.normalizeText('name', 'capitalize');
   * // capNames.toArray()[0].name is 'New York City'
   * ```
   */
  normalizeText<K extends keyof T>(
    columnName: K,
    normalizationType: 'lowercase' | 'uppercase' | 'capitalize'
  ): CSV<T> {
    const colNameStr = String(columnName);

    const capitalizeWord = (str: string): string => {
      if (!str) return '';
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    }

    const capitalizeSentence = (str: string): string => {
      if (!str) return '';
      // Simple space-based word splitting. More complex scenarios might need regex for other separators.
      return str.split(' ').map(capitalizeWord).join(' ');
    };


    const newData = this.data.map(row => {
      if (
        !Object.prototype.hasOwnProperty.call(row, colNameStr) ||
        typeof (row as any)[colNameStr] !== 'string'
      ) {
        return { ...row }; // Column doesn't exist or is not a string, return copy
      }

      const originalValue = (row as any)[colNameStr] as string;
      let normalizedValue = originalValue;

      switch (normalizationType) {
        case 'lowercase':
          normalizedValue = originalValue.toLowerCase();
          break;
        case 'uppercase':
          normalizedValue = originalValue.toUpperCase();
          break;
        case 'capitalize':
          // Capitalizes the first letter of each word (simple space-based split)
          normalizedValue = capitalizeSentence(originalValue);
          break;
        default:
          // Should be unreachable with TypeScript
          ((exhaustiveCheck: never) => {
            console.warn(`CSV.normalizeText: Unhandled normalization type "${exhaustiveCheck}".`);
          })(normalizationType);
          break;
      }

      return {
        ...row,
        [colNameStr]: normalizedValue,
      };
    });

    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
   * Trims leading and trailing whitespace from string values in specified columns.
   * If no columns are specified, it attempts to trim all string values in all columns.
   * Non-string values are not affected.
   *
   * @param columns - Optional array of column names to trim. If omitted, all columns are processed.
   * @returns A new CSV instance with whitespace trimmed from specified string columns.
   * @example
   * ```typescript
   * // interface Contact { name: string; city: string; zip: number }
   * // const csv = CSV.fromData<Contact>([
   * //   { name: '  Alice  ', city: ' New York ', zip: 10001 },
   * //   { name: 'Bob ', city: ' London', zip: 20002 }
   * // ]);
   *
   * // Trim specific columns
   * const trimmedSpecific = csv.trimWhitespace(['name', 'city']);
   * // trimmedSpecific.toArray()[0] is { name: 'Alice', city: 'New York', zip: 10001 }
   *
   * // Trim all string columns (if 'zip' was string, it would also be trimmed)
   * const trimmedAll = csv.trimWhitespace();
   * // trimmedAll.toArray()[0] is { name: 'Alice', city: 'New York', zip: 10001 }
   * ```
   */
  trimWhitespace(columns?: (keyof T | string)[]): CSV<T> {
    if (this.data.length === 0) {
      return new CSV<T>([], this.additionalHeader);
    }

    const columnsToProcess = columns && columns.length > 0
      ? columns.map(String) // Convert all to string for consistent key access
      : Object.keys(this.data[0]); // Default to all keys from the first row

    const newData = this.data.map(row => {
      const newRow = { ...row };
      columnsToProcess.forEach(colKeyStr => {
        const colKey = colKeyStr as keyof T; // Assume string keys correspond to T's keys
        if (Object.prototype.hasOwnProperty.call(newRow, colKey) && typeof newRow[colKey] === 'string') {
          (newRow[colKey] as any) = (newRow[colKey] as string).trim();
        }
      });
      return newRow; // Type T is preserved as structure doesn't change
    });

    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
 * Creates a CSV stream processor from a file, allowing for fluent, chainable
 * stream-based operations. This is suitable for processing large CSV files
 * efficiently without loading the entire file into memory at once.
 * Note: Preamble (additionalHeader) features from `CSVReadOptions` are NOT
 * handled by this streaming method; they are for `fromFile` and `fromString`.
 * This stream starts directly with parsed CSV data rows.
 *
 * @param filename The path to the CSV file.
 * @param options Reading options, primarily `csvOptions` for `csv-parse` and `headerMap`.
 * @returns A `CSVStreamProcessor` instance ready to configure and run a stream pipeline.
 */
  // Assuming CsvParseUserOptions and CsvParseInternalOptions are correctly defined
  // type CsvParseUserOptions = Parameters<typeof parseCSVAsync>[0];
  // type CsvParseInternalOptions = Exclude<CsvParseUserOptions, undefined>;

  // Inside CSV class
  static streamFromFile<SourceRowType extends Record<string, any>>(
    filename: string,
    options: CSVReadOptions<SourceRowType> = {} // CSVReadOptions should use CsvParseUserOptions for csvOptions
  ): CSVStreamProcessor<SourceRowType, SourceRowType> {

    const sourceFactory = (): Readable => { // This factory MUST return a Readable stream
      const resolvedPath = path.resolve(filename);
      const fileReadStream: fs.ReadStream = fs.createReadStream(resolvedPath, options.fsOptions);

      // 1. Prepare options for the main CSV parser (parseCSVAsync)
      const mainDataParserOptions: CsvParseInternalOptions = options.csvOptions ? { ...options.csvOptions } : {};

      const getCsvFromLineValue = (csvOpts?: CsvParseOptions): number | undefined => {
        if (!csvOpts) return undefined;
        const fromVal = csvOpts.from ?? csvOpts.from_line ?? csvOpts.fromLine;
        return typeof fromVal === 'number' && fromVal >= 1 ? fromVal : undefined;
      };
      const initialFromForData = getCsvFromLineValue(mainDataParserOptions); // Use options.csvOptions from the CSVReadOptions

      if (initialFromForData !== undefined) {
        mainDataParserOptions.from_line = initialFromForData;
      } else {
        mainDataParserOptions.from_line = 1;
      }
      delete mainDataParserOptions.from;
      delete mainDataParserOptions.fromLine;
      if (mainDataParserOptions.from_line < 1) {
        delete mainDataParserOptions.from_line;
      }

      const toLineForData = mainDataParserOptions.to_line ?? mainDataParserOptions.toLine;
      if (toLineForData !== undefined && mainDataParserOptions.to === undefined) {
        mainDataParserOptions.to = toLineForData;
      }
      delete mainDataParserOptions.to_line; delete mainDataParserOptions.toLine;

      // Set columns behavior for mainDataParserOptions
      // This stream processor outputs objects, so columns: true (or array/fn) is needed for mainCsvParser
      // unless the user *explicitly* wants arrays from the source stream.
      if (options.headerMap) {
        mainDataParserOptions.columns = true; // HeaderMap needs objects from parser
      } else {
        // If user set columns: false, respect it. Otherwise, default to true for objectMode streams.
        if (mainDataParserOptions.columns === undefined) {
          mainDataParserOptions.columns = true;
        }
      }

      // 2. Create the main CSV parser
      // parseCSVAsync returns a Transform stream
      const mainCsvParser: Transform = parseCSVAsync(mainDataParserOptions);

      // 3. Optionally create and pipe through a headerMap transform
      let outputProducingStream: Readable = mainCsvParser; // This is the stream that will output SourceRowType objects

      if (options.headerMap && options.headerMap) { // Ensure options.headerMap is truthy
        const headerMapTransform: Transform = new Transform({
          objectMode: true, // Expects objects from mainCsvParser, outputs mapped objects
          transform(parsedRow: Record<string, any>, encoding, callback) { // Input is from mainCsvParser
            try {
              // Ensure options.headerMap is valid and createHeaderMapFns returns the expected functions
              const mappedRow = createHeaderMapFns<SourceRowType>(options.headerMap!).fromRowArr(parsedRow);
              this.push(mappedRow);
              callback();
            } catch (err) {
              callback(err instanceof Error ? err : new CSVError("Error in stream headerMap transform", err));
            }
          }
        });

        // Pipe data from mainCsvParser through headerMapTransform
        mainCsvParser.pipe(headerMapTransform);
        // Propagate errors from mainCsvParser to headerMapTransform
        mainCsvParser.on('error', (err) => headerMapTransform.destroy(err));

        outputProducingStream = headerMapTransform; // headerMapTransform is now the final data source
      }

      // 4. Connect the fileReadStream to the beginning of the parsing pipeline
      // fileReadStream (Readable) -> mainCsvParser (Transform's Writable side)
      // The 'error' event from fileReadStream should destroy the first processing stream
      fileReadStream.on('error', (err) => {
        mainCsvParser.destroy(err); // Destroy mainCsvParser; if headerMapTransform exists, its error handler will catch mainCsvParser's error
      });

      fileReadStream.pipe(mainCsvParser); // This initiates the flow

      // The factory must return the stream that will be the *source* for the CSVStreamProcessor's pipeline
      return outputProducingStream; // This IS Readable (either mainCsvParser or headerMapTransform)
    };

    return new CSVStreamProcessor<SourceRowType, SourceRowType>(sourceFactory);
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
  mergeRows<T extends Record<string, any>, E extends Record<string, any>>(
    arrayA: T[],
    arrayB: E[],
    equalityFn: (a: T, b: E) => boolean,
    mergeFn: (a: T, b: E) => T & Record<string, any>
  ): T[] {
    const csvInstance = CSV.fromData<T>(arrayA);
    return csvInstance
      .mergeWith<E>(arrayB, 
        (a, b) => equalityFn(a as T, b), 
        (a, b) => mergeFn(a as T, b)
      )
      .toArray();
  },

  /**
   * Deep clone an object. Prefers structuredClone if available,
   * otherwise falls back to JSON.parse(JSON.stringify(obj)).
   * @param obj - The object to clone
   * @returns A deep copy of the object
   */
  clone<T>(obj: T): T {
    const cloneWithJson = (item: T): T => {
      // Handle null and undefined explicitly as JSON.stringify(undefined) is undefined
      // and JSON.parse(undefined) would error.
      if (item === undefined || item === null) {
        return item;
      }
      return JSON.parse(JSON.stringify(item));
    };

    if (typeof globalThis?.structuredClone === 'function') {
      try {
        return globalThis.structuredClone(obj);
      } catch (e) {
        //console.warn("structuredClone failed, falling back to JSON method. Error:", e);
        return cloneWithJson(obj);
      }
    } else {
      return cloneWithJson(obj);
    }
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
          // @ts-expect-error
          callback(error);
        }
      }
    });
  },

  /**
   * Execute a CPU-intensive operation in a worker thread to avoid blocking the main thread
   * @param operation - Function that defines the operation to execute (must be serializable)
   * @param data - Data to pass to the worker thread (must be serializable)
   * @returns Promise resolving to the operation result
   */
  processInWorker<T, R>(
    operation: (data: T) => R,
    data: T
  ): Promise<R> {
    return new Promise((resolve, reject) => {
      // Create the worker with the operation and data
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('worker_threads');
        
        try {
          // Deserialize and execute the operation
          const operationFn = eval(workerData.operationFn);
          const result = operationFn(workerData.data);
          parentPort.postMessage({ success: true, result });
        } catch (error) {
          parentPort.postMessage({ 
            success: false, 
            error: { 
              message: error.message,
              stack: error.stack,
              name: error.name
            } 
          });
        }
        `,
        {
          eval: true,
          workerData: {
            operationFn: operation.toString(),
            data
          }
        }
      );

      // Handle message from worker
      worker.on('message', (message) => {
        if (message.success) {
          resolve(message.result);
        } else {
          const error = new Error(message.error.message);
          error.stack = message.error.stack;
          error.name = message.error.name;
          reject(error);
        }
      });

      // Handle worker errors
      worker.on('error', reject);

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    });
  },

  /**
   * Process data in parallel across multiple worker threads
   * @param items - Array of items to process
   * @param operation - Function to apply to each item (must be serializable)
   * @param options - Processing options
   * @param options.maxWorkers - Maximum number of worker threads to use (default: CPU count)
   * @param options.chunkSize - Number of items per worker (default: evenly distributed)
   * @returns Promise resolving to array of processed items
   * 
   * @remarks
   * IMPORTANT LIMITATION: This method is suitable for operations where the order of chunk processing 
   * and recombination doesn't affect the overall result integrity (like map operations).
   * It is NOT suitable for operations that require proper merging of sorted results (like sorting).
   * For sorting operations, the results will be processed in chunks and flattened without a proper merge step,
   * resulting in a partially sorted but not fully sorted result. Use direct sorting methods instead.
   */
  async processInParallel<T, R>(
    items: T[],
    operation: (items: T[]) => R[],
    options: { maxWorkers?: number; chunkSize?: number } = {}
  ): Promise<R[]> {
    if (items.length === 0) return [];

    // Determine the number of workers
    const cpuCount = require('os').cpus().length;
    const maxWorkers = options.maxWorkers || cpuCount;
    const workerCount = Math.min(maxWorkers, items.length, cpuCount);

    // If only a few items or just one worker, process directly
    if (workerCount <= 1 || items.length <= 10) {
      return operation(items);
    }

    // Split items into chunks
    const chunks: T[][] = [];
    const chunkSize = options.chunkSize || Math.ceil(items.length / workerCount);

    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    // Process each chunk in a separate worker
    const promises = chunks.map(chunk =>
      this.processInWorker(operation, chunk)
    );

    // Combine results
    const results = await Promise.all(promises);
    return results.flat();
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
      // Use a type assertion to help TypeScript understand this is valid
      const stringifier = stringifyCSVAsync(stringifyOptions) as Transform;

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

            const headerMap = options.headerMap as HeaderMap<T>
            const { toRowArr } = createHeaderMapFns<T>(headerMap);

            // Create a transform stream that applies the header mapping
            const transformer = new Transform({
              objectMode: true,
              transform(chunk, encoding, callback) {
                try {
                  const mappedRow = toRowArr(chunk, headers);
                  callback(null, mappedRow);
                } catch (error) {
                  // @ts-ignore
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

    const inverseMap: { [x: string]: string;[x: number]: string } = {};
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

const pipelineAsync = promisify(streamPipeline);

/**
 * Enum for terminal action types configured on the CSVStreamProcessor.
 * @internal
 */
enum TerminalActionType {
  Collect = 'collect',
  ToFile = 'toFile',
  ForEach = 'forEach',
  PipeTo = 'pipeTo',
  None = 'none',
}

/**
 * Configuration for a terminal action.
 * @internal
 */
interface TerminalActionConfig {
  type: TerminalActionType;
  filename?: string;
  writeOptions?: CSVWriteOptions<any>; // 'any' because OutType is generic on CSVStreamProcessor
  forEachCallback?: (row: any) => void | Promise<void>;
  destinationStream?: Writable;
  pipeOptions?: { end?: boolean };
}

/**
 * A processor for fluent, chainable operations on a stream of CSV row objects.
 * This class builds a pipeline of stream transformations that are executed by
 * calling the `.run()` method or by using it in an async iteration (`for await...of`).
 * Each fluent transformation method returns a new `CSVStreamProcessor` instance,
 * ensuring immutability of the pipeline stages.
 *
 * @template InType The type of rows coming from the initial source stream (after initial parsing).
 * @template OutType The type of rows produced by the current last stage of the pipeline.
 */
export class CSVStreamProcessor<InType extends Record<string, any>, OutType extends Record<string, any> = InType> {
  private readonly sourceStreamFactory: () => Readable;
  private readonly transformFactories: ReadonlyArray<(currentStream: Readable) => Readable>;
  private readonly terminalActionConfig: TerminalActionConfig;

  /**
   * @internal - Should be instantiated via static methods like `CSV.streamFromFile()`.
   * @param sourceStreamFactory A function that returns a new Readable stream of parsed CSV row objects.
   * @param initialTransformFactories An array of initial transform factories for the pipeline.
   * @param initialTerminalAction The initial terminal action configuration.
   */
  constructor(
    sourceStreamFactory: () => Readable,
    initialTransformFactories: ReadonlyArray<(currentStream: Readable) => Readable> = [],
    initialTerminalAction: TerminalActionConfig = { type: TerminalActionType.None }
  ) {
    this.sourceStreamFactory = sourceStreamFactory;
    this.transformFactories = initialTransformFactories; // Already a copy if spread in _clone...
    this.terminalActionConfig = initialTerminalAction;
  }

  /**
   * Builds the full pipeline of streams.
   * @internal
   */
  private _buildPipeline(): Readable { // DEFINED HERE
    let currentWorkingStream = this.sourceStreamFactory();
    this.transformFactories.forEach(factory => {
      currentWorkingStream = factory(currentWorkingStream);
    });
    return currentWorkingStream;
  }

  /**
   * @internal Helper to create a new processor instance with an added transform.
   */
  private _cloneWithNewTransform<NewOutType extends Record<string, any>>(
    transformFactory: (currentStream: Readable) => Readable
  ): CSVStreamProcessor<InType, NewOutType> {
    return new CSVStreamProcessor<InType, NewOutType>(
      this.sourceStreamFactory,
      [...this.transformFactories, transformFactory],
      this.terminalActionConfig // Intermediate ops don't change terminal config
    );
  }

  /**
   * @internal Helper to create a new processor instance with a new terminal action.
   */
  private _cloneWithTerminalAction(
    actionConfig: TerminalActionConfig
  ): CSVStreamProcessor<InType, OutType> {
    return new CSVStreamProcessor<InType, OutType>(
      this.sourceStreamFactory,
      this.transformFactories, // Keep existing transforms
      actionConfig // Set/replace the terminal action
    );
  }

  // --- Intermediate Stream Operations ---
  /**
   * Executes the stream pipeline and provides its final Readable stream output,
   * piping it to the provided destination Writable stream.
   * This is a terminal operation.
   *
   * @param destination The Writable stream to pipe the results to.
   * @param options Options for the pipe operation (e.g., `{ end?: boolean }`).
   * @returns The destination stream, for further chaining if it's also a Duplex/Transform,
   *          or for listening to its 'finish' or 'error' events.
   * @example
   * ```typescript
   * // processor.pipe(fs.createWriteStream('output.txt'));
   * // processor.pipe(new MyCustomWritableProcessingStream());
   * ```
   */
  pipe(destination: Writable, options?: { end?: boolean }): Writable {
    const finalStream = this._buildPipeline(); // This returns a Readable
    // finalStream is Readable, destination is Writable.
    // stream.pipe(destination) returns the destination stream.
    return finalStream.pipe(destination, options);
  }


  /**
   * Filters rows in the stream based on a condition.
   * @param condition A function that takes a row of the current output type (`OutType`)
   *                  and returns `true` to keep the row, `false` to discard it.
   * @returns A new `CSVStreamProcessor` instance with the filter applied.
   *          The output type of the rows remains `OutType`.
   * @example
   * ```typescript
   * // processor.filter(user => user.age > 30)
   * ```
   */
  filter(condition: (row: OutType) => boolean | Promise<boolean>): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithNewTransform<OutType>((currentStream: Readable) => {
      const filterTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, encoding, callback) {
          try {
            if (await condition(row)) { // Await condition if it's async
              this.push(row);
            }
            callback();
          } catch (err) {
            callback(err instanceof Error ? err : new CSVError("Error in filter condition", err));
          }
        }
      });
      currentStream.on('error', (err) => filterTransform.destroy(err)); // Propagate errors
      return currentStream.pipe(filterTransform);
    });
  }

  /**
   * Transforms each row in the stream using a mapping function.
   * @param transformFn A function that takes a row of the current output type (`OutType`)
   *                    and returns a new transformed row. Can be an async function.
   * @returns A new `CSVStreamProcessor` instance that will output rows of type `NewOutType`.
   * @template NewOutType The type of the rows after transformation.
   * @example
   * ```typescript
   * // processor.map(user => ({ id: user.id, fullName: `${user.firstName} ${user.lastName}` }))
   * ```
   */
  map<NewOutType extends Record<string, any>>(
    transformFn: (row: OutType) => NewOutType | Promise<NewOutType>
  ): CSVStreamProcessor<InType, NewOutType> {
    return this._cloneWithNewTransform<NewOutType>((currentStream: Readable) => {
      const mapTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, encoding, callback) {
          try {
            this.push(await transformFn(row)); // Await transformFn if it's async
            callback();
          } catch (err) {
            callback(err instanceof Error ? err : new CSVError("Error in map transform function", err));
          }
        }
      });
      currentStream.on('error', (err) => mapTransform.destroy(err)); // Propagate errors
      return currentStream.pipe(mapTransform);
    });
  }

  /**
   * Adds a new column to each row in the stream.
   * @param columnName The name of the new column.
   * @param valueOrFn A fixed value for the new column, or a function that takes the current
   *                  row (`OutType`) and returns the value for the new column. Can be async.
   * @returns A new `CSVStreamProcessor` instance with the added column.
   *          The output type will be `OutType` extended with the new column.
   * @template NewKey The literal string type of the new column name.
   * @template NewValue The type of the value in the new column.
   * @example
   * ```typescript
   * // processor.addColumn('processedAt', () => new Date())
   * // processor.addColumn('fullName', async (row) => `${row.firstName} ${await fetchLastName(row.id)}`)
   * ```
   */
  addColumn<NewKey extends string, NewValue>(
    columnName: NewKey,
    valueOrFn: NewValue | ((row: OutType) => NewValue | Promise<NewValue>)
  ): CSVStreamProcessor<InType, OutType & Record<NewKey, NewValue>> {
    return this._cloneWithNewTransform<OutType & Record<NewKey, NewValue>>((currentStream: Readable) => {
      const addColumnTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, encoding, callback) {
          try {
            const newValue = typeof valueOrFn === 'function'
              ? await (valueOrFn as (row: OutType) => NewValue | Promise<NewValue>)(row)
              : valueOrFn;
            this.push({ ...row, [columnName]: newValue });
            callback();
          } catch (err) {
            callback(err instanceof Error ? err : new CSVError(`Error in addColumn for column '${columnName}'`, err));
          }
        }
      });
      currentStream.on('error', (err) => addColumnTransform.destroy(err)); // Propagate errors
      return currentStream.pipe(addColumnTransform);
    });
  }

  // --- "Prefixed" Terminal-like Configuration Methods ---

  /**
   * Configures the pipeline to collect all results into an in-memory `CSV` instance upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * Use with caution for very large datasets as it loads all data into memory.
   * @returns A new `CSVStreamProcessor` instance configured for collection.
   */
  prepareCollect(): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction({ type: TerminalActionType.Collect });
  }

  /**
   * Configures the pipeline to write its output to a CSV file upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param filename The path to the output CSV file.
   * @param writeOptions Optional `CSVWriteOptions` for customizing CSV stringification and file writing.
   * @returns A new `CSVStreamProcessor` instance configured for file writing.
   */
  prepareToFile(filename: string, writeOptions?: CSVWriteOptions<OutType>): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction({ type: TerminalActionType.ToFile, filename, writeOptions });
  }

  /**
   * Configures the pipeline to execute an asynchronous callback for each row upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param callback The async function to call for each processed row of type `OutType`.
   * @returns A new `CSVStreamProcessor` instance configured for row-by-row processing.
   */
  prepareForEach(callback: (row: OutType) => void | Promise<void>): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction({ type: TerminalActionType.ForEach, forEachCallback: callback });
  }

  /**
   * Configures the pipeline to pipe its output to a specified Writable stream upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param destination The Writable stream to pipe the results to.
   * @param options Options for the pipe operation (e.g., `{ end?: boolean }`).
   * @returns A new `CSVStreamProcessor` instance configured for piping.
   */
  preparePipeTo(destination: Writable, options?: { end?: boolean }): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction({
      type: TerminalActionType.PipeTo, destinationStream: destination,
      // pipeOptions: options 
    });
  }

  // --- True Terminal Execution Method ---

  /**
   * Executes the configured stream pipeline and the specified terminal action.
   * This method consumes the stream.
   *
   * @returns A Promise that resolves based on the configured terminal action:
   *          - For `prepareCollect`: `Promise<CSV<OutType>>` (an in-memory CSV instance).
   *          - For `prepareToFile`: `Promise<void>` (resolves when file writing is complete).
   *          - For `prepareForEach`: `Promise<void>` (resolves after all rows are processed by the callback).
   *          - For `preparePipeTo`: `Promise<void>` (resolves when piping to the destination is complete).
   *          - If no terminal action is configured (e.g., only using `for await...of`):
   *            `Promise<void>` (resolves when the stream is fully consumed, data is discarded if not iterated).
   * @throws {CSVError} if an error occurs during stream processing or if a required parameter for a terminal action is missing.
   */
  async run(): Promise<CSV<OutType> | void> {
    const pipelineToRun = this._buildPipeline();

    try {
      switch (this.terminalActionConfig.type) {
        case TerminalActionType.Collect:
          // ... (implementation as before)
          return new Promise((resolve, reject) => {
            const records: OutType[] = [];
            pipelineToRun.on('data', (row: OutType) => records.push(row));
            pipelineToRun.on('error', (err) => reject(new CSVError("Error during stream collection via run()", err)));
            pipelineToRun.on('end', () => resolve(CSV.fromData<OutType>(records)));
          });

        case TerminalActionType.ToFile:
          // ... (implementation as before using pipelineAsync)
          const { filename, writeOptions } = this.terminalActionConfig;
          if (!filename) return Promise.reject(new CSVError("Filename not provided for toFile action."));
          const stringifyOpts = writeOptions?.stringifyOptions || { header: true, bom: true };
          // Use a type assertion to help TypeScript understand this is valid
          const csvStringifier = stringifyCSVAsync(stringifyOpts) as Transform;
          const fileWriteStream = fs.createWriteStream(filename, { encoding: 'utf-8' });
          if (writeOptions?.additionalHeader) {
            fileWriteStream.write(writeOptions.additionalHeader);
          }
          await pipelineAsync(pipelineToRun, csvStringifier, fileWriteStream);
          return; // Resolve void

        case TerminalActionType.ForEach:
          // ... (implementation as before using _yieldFromStream)
          const { forEachCallback } = this.terminalActionConfig;
          if (!forEachCallback) return Promise.reject(new CSVError("Callback not provided for forEach action."));
          for await (const row of this._yieldFromStream(pipelineToRun)) {
            await forEachCallback(row);
          }
          return; // Resolve void

        case TerminalActionType.PipeTo: // CORRECTED
          const { destinationStream } = this.terminalActionConfig; // Removed pipeOptions from here
          if (!destinationStream) {
            return Promise.reject(new CSVError("Destination stream not provided for pipeTo action."));
          }
          // Using pipelineAsync for robust error handling and promise-based flow.
          // stream.pipeline does not accept the { end: boolean } option directly.
          // Its default behavior is equivalent to { end: true }.
          await pipelineAsync(pipelineToRun, destinationStream);
          return; // Resolve void

        case TerminalActionType.None:
          // ... (implementation as before)
          return new Promise<void>((resolve, reject) => {
            pipelineToRun.on('data', () => { /* Consume */ });
            pipelineToRun.on('end', resolve);
            pipelineToRun.on('error', (err) => reject(new CSVError("Error running stream with no terminal action", err)));
          });

        default:
          return Promise.reject(new CSVError("Unknown or no terminal action configured for CSVStreamProcessor.run()"));
      }
    } catch (err) {
      // This catch block handles errors from await pipelineAsync and other synchronous parts
      throw err instanceof CSVError ? err : new CSVError("Unhandled error in CSVStreamProcessor.run()", err);
    }
  }

  /**
   * @internal Helper to adapt a Readable stream to an AsyncGenerator with memory efficiency.
   * Uses a fixed-size ring buffer to limit memory usage during streaming.
   * @param stream The readable stream to convert to an async generator
   * @param bufferSize The maximum number of items to keep in memory (default: 1000)
   */
  private async *_yieldFromStream(
    stream: Readable,
    bufferSize: number = 1000
  ): AsyncGenerator<OutType, void, undefined> {
    // Create a fixed-size circular buffer to limit memory usage
    class CircularBuffer<T> {
      private buffer: Array<T | undefined>;
      private head: number = 0;
      private tail: number = 0;
      private _size: number = 0;
      private readonly capacity: number;

      constructor(capacity: number) {
        this.capacity = Math.max(capacity, 2); // Min size of 2
        this.buffer = new Array<T | undefined>(this.capacity);
      }

      get size(): number {
        return this._size;
      }

      get isFull(): boolean {
        return this._size === this.capacity;
      }

      get isEmpty(): boolean {
        return this._size === 0;
      }

      push(item: T): void {
        // If full, oldest item will be overwritten
        if (this.isFull) {
          this.head = (this.head + 1) % this.capacity;
          this._size--;
        }

        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        this._size++;
      }

      shift(): T | undefined {
        if (this.isEmpty) return undefined;

        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined; // Help GC
        this.head = (this.head + 1) % this.capacity;
        this._size--;

        return item;
      }

      clear(): void {
        this.buffer.fill(undefined);
        this.head = 0;
        this.tail = 0;
        this._size = 0;
      }
    }

    // Create a buffer with the specified capacity
    const dataBuffer = new CircularBuffer<OutType>(bufferSize);
    let streamEnded = false;
    let streamError: Error | null = null;
    let waitingForDataResolver: ((value?: any) => void) | null = null;
    let backpressureApplied = false;

    // Set up stream handlers
    const onData = (chunk: OutType) => {
      dataBuffer.push(chunk);

      // Apply backpressure if buffer is getting full
      if (!backpressureApplied && dataBuffer.size >= bufferSize * 0.8) {
        backpressureApplied = true;
        stream.pause();
      }

      if (waitingForDataResolver) {
        waitingForDataResolver();
        waitingForDataResolver = null;
      }
    };

    const onEnd = () => {
      streamEnded = true;
      if (waitingForDataResolver) {
        waitingForDataResolver();
        waitingForDataResolver = null;
      }
    };

    const onError = (err: Error) => {
      streamError = err;
      if (waitingForDataResolver) {
        waitingForDataResolver();
        waitingForDataResolver = null;
      }
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);

    try {
      while (true) {
        if (streamError) throw streamError;

        if (!dataBuffer.isEmpty) {
          // If buffer was full and now has room, resume the stream
          if (backpressureApplied && dataBuffer.size < bufferSize * 0.5) {
            backpressureApplied = false;
            stream.resume();
          }

          yield dataBuffer.shift()!;
        } else if (streamEnded) {
          return;
        } else {
          await new Promise<void>((resolve, reject) => {
            if (streamError) return reject(streamError);
            if (streamEnded || !dataBuffer.isEmpty) return resolve();
            waitingForDataResolver = resolve;
          });
        }
      }
    } finally {
      // Cleanup listeners and destroy stream if not already ended/destroyed
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);

      if (!stream.destroyed && !stream.readableEnded) {
        stream.destroy();
      }

      // Clear buffer to help GC
      dataBuffer.clear();
    }
  }

  /**
   * Allows the `CSVStreamProcessor` to be used directly in a `for await...of` loop.
   * This effectively executes the pipeline and yields each processed row.
   * @example
   * ```typescript
   * // const processor = CSV.streamFromFile(...);
   * // for await (const row of processor.filter(r => r.isActive).map(r => r.name)) {
   * //   console.log(row); // row here is a string (name)
   * // }
   * ```
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<OutType, void, undefined> {
    let currentWorkingStream = this.sourceStreamFactory();
    this.transformFactories.forEach(factory => {
      currentWorkingStream = factory(currentWorkingStream);
    });
    yield* this._yieldFromStream(currentWorkingStream);
  }
}


// Default export for easier imports
export default CSV;





