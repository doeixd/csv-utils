/**
 * @fileoverview A production-ready TypeScript library for CSV manipulation,
 * featuring robust error handling, strong typing, and a fluent interface.
 */


import fs from 'node:fs';
import path from 'node:path';
import { parse as parseCSV, stringify as stringifyCSV } from 'csv/sync';
import { parse as parseCSVAsync, stringify as stringifyCSVAsync } from 'csv';
import { distance as levenshteinDistance } from 'fastest-levenshtein';
import { getPathValue, setPathValueCopy } from './path-utils';
import type { Options as CsvParseOptionsType } from 'csv-parse';
import { createHeaderMapFns, objArrayToArray as mapObjectsToRows, HeaderMap, RetryOptions, ObjectArrayToCsvConfig } from './headers'
import { tryValidateStandardSchemaSync, tryValidateStandardSchemaAsync, CSVSchemaConfig, RowValidationResult } from './schema'
import { Readable, Transform, Writable, pipeline as streamPipeline } from 'node:stream';
import { type Transform as NodeTransform } from 'node:stream'
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import os from 'node:os';

export * from './headers'
export * from './schema'
export * from './standalone'

/** Fields in a default join can be absent for unmatched rows; right values win on matches. */
export type JoinedRow<L, R> = Partial<Omit<L, keyof R>> & {
  [K in keyof R]?: K extends keyof L ? L[K] | R[K] : R[K]
};

export type ColumnUpdate<T, K extends string, V> = K extends unknown ? string extends K
  ? { [P in keyof T]: T[P] | V } & Record<string, unknown>
  : Omit<T, K> & Record<K, V> : never;
export type ColumnCastTarget = 'string' | 'number' | 'boolean' | 'date';
export type ColumnCastValue<C extends ColumnCastTarget> = C extends 'string' ? string
  : C extends 'number' ? number | null : C extends 'boolean' ? boolean | null : Date | null;
export type CastColumn<T, K extends string, C extends ColumnCastTarget> = K extends unknown ? {
  [P in keyof T]: string extends K ? T[P] | ColumnCastValue<C> : P extends K ? ColumnCastValue<C> : T[P]
} : never;
export type RenamedColumn<T, Old extends string, New extends string> = Old extends unknown ? New extends unknown ? string extends Old
  ? Partial<T> & Partial<Record<New, unknown>>
  : Old extends New ? T
  : Old extends keyof T ? Omit<T, Old | New> & ({} extends Pick<T, Old>
      ? Partial<Record<New, T[Old] | (New extends keyof T ? T[New] : never)>>
      : Record<New, T[Old]>)
  : Omit<T, New> & Partial<Record<New, unknown>> : never : never;
export type FilledColumn<T, K extends keyof T, V> = K extends unknown
  ? Omit<T, K> & { [P in K]-?: Exclude<T[P], null | undefined> | V }
  : never;
type WidenString<V> = V extends string ? string : V;
export type TextColumns<T> = { [P in keyof T]: WidenString<T[P]> };
export type TextColumn<T, K extends keyof T> = K extends unknown
  ? { [P in keyof T]: P extends K ? WidenString<T[P]> : T[P] }
  : never;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new CSVError(`${name} must be a positive integer`);
  return value;
}

// Writing maps object paths to CSV headers. Keep directional rules separate
// so a CSV header cannot overwrite an array or function rule with the same key.
function createWriteHeaderMapFns<T>(headerMap: HeaderMap<T>) {
  const rules: HeaderMap<T> = {};
  const paths = new Map<string, string>();
  for (const [path, rule] of Object.entries(headerMap)) {
    if (typeof rule === 'string') {
      paths.set(rule, path);
    } else {
      rules[path] = rule;
    }
  }
  const mapper = Object.keys(rules).length ? createHeaderMapFns<T>(rules) : undefined;
  if (!mapper && !paths.size) createHeaderMapFns<T>(headerMap);
  return {
    toRowArr(item: T, headers: string[]) {
      const row = mapper ? mapper.toRowArr(item, headers) : headers.map(() => '');
      return headers.map((header, index) => {
        const path = paths.get(header);
        if (path === undefined) return row[index] ?? '';
        const value = getPathValue(item, path);
        if (value === undefined || value === null) return '';
        return typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      });
    }
  };
}

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

export type CsvParseOptions<T = string[]> = CsvParseOptionsType<T>;
type CsvParseInternalOptions<T = string[]> = CsvParseOptionsType<T>;
const normalizeLineNumber = (value: string | number | null | undefined): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  return numeric >= 1 ? numeric : undefined;
};

export type CSVWriteStringifyOptions = Omit<NonNullable<Parameters<typeof stringifyCSV>[1]>, 'header'> & {
  /** An array selects and orders columns without emitting a header row. */
  header?: boolean | string[];
};

function normalizeWriteStringifyOptions(options: CSVWriteStringifyOptions): NonNullable<Parameters<typeof stringifyCSV>[1]> {
  return Array.isArray(options.header)
    ? { ...options, columns: options.header, header: false }
    : { ...options, header: options.header };
}

function prependCSVHeader(header: string, content: string): string {
  if (!header || !content.startsWith('\uFEFF')) return header + content;
  return (header.startsWith('\uFEFF') ? header : `\uFEFF${header}`) + content.slice(1);
}

function prepareStreamingHeader(header: string, options: CSVWriteStringifyOptions) {
  if (!header || !options.bom) return { header, options };
  return {
    header: header.startsWith('\uFEFF') ? header : `\uFEFF${header}`,
    options: { ...options, bom: false },
  };
}

export type CsvStringifyOptions<T = any> = Parameters<typeof stringifyCSV>[1] | {
  stringifyOptions?: CSVWriteStringifyOptions;
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
  csvOptions?: CsvParseOptions<T>;
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
   *   Data parsing will start after these lines, unless `csvOptions.from_line` (or `fromLine`)
   *   is set and points to an even later line.
   *
   * - If `true`: Enables preamble extraction *if* `csvOptions.from_line` (or `fromLine`)
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
  additionalHeaderParseOptions?: CsvParseOptions<any>;
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
  stringifyOptions?: CSVWriteStringifyOptions;
  /** @deprecated Synchronous writes always complete before returning; use writeToFileAsync for streaming. */
  streaming?: boolean;
  /** Optional header mapping configuration */
  headerMap?: HeaderMap<T>;
  /** @deprecated Synchronous writes do not use a streaming threshold. */
  streamingThreshold?: number;
  /** Options for retrying failed operations */
  retry?: RetryOptions;
}

/**
 * Options for working with CSV streams and generators
 */
export interface CSVStreamOptions<T> {
  /** CSV parsing options */
  csvOptions?: CsvParseOptions<T>;
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
    _baseLineNumber: number = 1
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
    const validateRowSync = (row: Record<string, any>, _index: number): RowValidationResult<T> => {
      const result: RowValidationResult<T> = {
        originalRow: { ...row },
        valid: true
      };

      const workingRow = { ...row };
      if (columnSchemas) {
        const issues: Record<string, import('./schema').StandardSchemaV1.Issue[]> = {};
        for (const [column, schema] of Object.entries(columnSchemas)) {
          if (!schema) continue;
          const validation = tryValidateStandardSchemaSync(schema, row[column]);
          if (validation.issues) {
            result.valid = false;
            Object.defineProperty(issues, column, { value: [...validation.issues], enumerable: true, configurable: true, writable: true });
          } else {
            Object.defineProperty(workingRow, column, { value: validation.value, enumerable: true, configurable: true, writable: true });
          }
        }
        if (Object.keys(issues).length) result.columnIssues = issues;
      }
      if (rowSchema) {
        const validation = tryValidateStandardSchemaSync(rowSchema, workingRow);
        if (validation.issues) {
          result.valid = false;
          result.rowIssues = [...validation.issues];
        } else {
          result.validatedRow = { ...validation.value } as T;
        }
      } else {
        result.validatedRow = workingRow as T;
      }

      return result;
    };

    // Validate lazily so error mode stops at the first invalid row.
    for (const row of data) {
      const result = validateRowSync(row, 0);
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

      const getCsvFromLineValue = (csvOpts?: CsvParseOptions<any>): number | undefined => {
        if (!csvOpts) return undefined;
        return normalizeLineNumber(csvOpts.from_line ?? csvOpts.fromLine);
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
          ? { bom: true, ...options.additionalHeaderParseOptions } : {};
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
          bom: true, ...basePreambleOpts, columns: false, to: numPreambleLinesToExtract,
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

      const contentForMainParsing = options.transform ? options.transform(rawFullContent) : rawFullContent;
      // Explicitly set columns: true as the default, then spread user options for clarity and consistency
      // This ensures the desired default behavior while still allowing user overrides if needed
      const finalMainParserOptions: CsvParseInternalOptions<any> = {
        columns: true,
        bom: true,
        ...((options.csvOptions as CsvParseOptions<any> | undefined) || {})
      };

      // Set relax_column_count if validateData is enabled to allow validation to catch inconsistencies
      if (options.validateData) {
        finalMainParserOptions.relax_column_count = true;
      }

      const fromLineForData = getCsvFromLineValue(options.csvOptions);
      if (fromLineForData !== undefined) { finalMainParserOptions.from_line = fromLineForData; }
      delete finalMainParserOptions.fromLine;

      if (numPreambleLinesToExtract && numPreambleLinesToExtract > 0) {
        const startDataAfterPreamble = numPreambleLinesToExtract + 1;
        const currentFromLine = normalizeLineNumber(finalMainParserOptions.from_line);
        if (!currentFromLine || currentFromLine < startDataAfterPreamble) {
          finalMainParserOptions.from_line = startDataAfterPreamble;
        }
      }

      const normalizedFromLine = normalizeLineNumber(finalMainParserOptions.from_line);
      if (normalizedFromLine !== undefined) {
        finalMainParserOptions.from_line = normalizedFromLine;
      } else {
        delete finalMainParserOptions.from_line;
      }

      const toLineForData = normalizeLineNumber(finalMainParserOptions.to_line ?? finalMainParserOptions.toLine);
      if (toLineForData !== undefined) finalMainParserOptions.to_line = toLineForData;
      else delete finalMainParserOptions.to_line;
      delete finalMainParserOptions.toLine;

      // Initial parsing of the data
      const dataAfterCsvParse = parseCSV(contentForMainParsing, finalMainParserOptions) as any[];

      // Process the data with the shared function (apply header mapping and custom casting)
      const baseLineNumber = normalizeLineNumber(finalMainParserOptions.from_line) ?? 1;
      const parsedData = this.processCSVData<T>(dataAfterCsvParse, options as CSVReadOptions<T & Record<string, any>>, baseLineNumber);

      // Basic structural validation
      if (options.validateData && parsedData.length > 0) {
        const firstDataRowActualLine = normalizeLineNumber(finalMainParserOptions.from_line) ?? 1;
        if (finalMainParserOptions.columns !== false) {
          if (!(parsedData[0] && typeof parsedData[0] === 'object')) {
            throw new CSVError(`Expected object rows for validation, but first parsed record (approx. file line ${firstDataRowActualLine}) is not an object.`);
          }
          const sampleKeys = Object.keys(parsedData[0]);
           parsedData.forEach((row, i) => {
             if (!(row && typeof row === 'object')) { throw new CSVError(`Row at approx. file line ${firstDataRowActualLine + i} (parsed index ${i}) is not an object as expected.`); }
             if (Object.keys(row).length !== sampleKeys.length) { throw new CSVError(`Row at approx. file line ${firstDataRowActualLine + i} (parsed index ${i}) has inconsistent column count. Expected ${sampleKeys.length}, got ${Object.keys(row).length}.`); }
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
        if (error instanceof CSVError) {
          throw error;
        }
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
  static fromData<T extends Record<string, any>>(data: T[], options?: CSVFromDataOptions<T>): CSV<T>;
  static fromData<T extends Record<string, any>>(data: Record<string, any>[], options: CSVFromDataOptions<T> & { schema: CSVSchemaConfig<T> }): CSV<T>;
  static fromData<T extends Record<string, any>>(
    data: (T |Record<string, any>)[], // Input can be Record<string, any> to allow for validation to type T
    options?: CSVFromDataOptions<T>
  ): CSV<T> {
    // Create a new array with copies of the input objects to ensure immutability of the input `data` array
    if (!Array.isArray(data)) throw new CSVError('Data must be an array');
    let processedData: Record<string, any>[] = data.map(row => ({ ...row }));
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
      const { definitions: userDefinitions, columnCasts, onCastError = 'error' } = options.customCasts;

      // Default built-in casters
      const defaultDefinitions: CustomCastDefinition = {
        string: { test: () => true, parse: (v) => String(v) },
        number: { test: () => true, parse: (v) => Number(v) },
        boolean: { test: (v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(v.toLowerCase()), parse: (v) => ['true', '1', 'yes'].includes(v.toLowerCase()) },
        date: { test: (v) => !isNaN(Date.parse(v)), parse: (v) => new Date(v) },
        object: { test: (v) => { try { JSON.parse(v); return true; } catch { return false; } }, parse: (v) => JSON.parse(v) },
        array: { test: (v) => { try { const parsed = JSON.parse(v); return Array.isArray(parsed); } catch { return false; } }, parse: (v) => JSON.parse(v) },
        null: { test: (v) => v === 'null' || v === '', parse: () => null }
      };

      const definitions = { ...defaultDefinitions, ...userDefinitions };

      // Only apply custom casting to object-based rows
      if (typeof processedData[0] === 'object' && processedData[0] !== null) {
        processedData = processedData.map((row: Record<string, any>, rowIndex: number) => {
          let newRow = { ...row };

          const rowKeys = Object.keys(row);
          const castPaths = Object.keys(columnCasts ?? {});
          const positions = castPaths.length > 8 ? new Map(rowKeys.map((name, index) => [name, index])) : undefined;
          const directColumns: Array<{ name: string; index: number; direct: boolean }> = [];
          const nestedColumns: typeof directColumns = [];
          for (const path of castPaths) {
            if (Object.prototype.hasOwnProperty.call(row, path)) {
              const index = positions ? positions.get(path) ?? -1 : rowKeys.indexOf(path);
              if (index >= 0 && columnCasts![path]) directColumns.push({ name: path, index, direct: true });
            } else if (getPathValue(row, path) !== undefined) {
              nestedColumns.push({ name: path, index: -1, direct: false });
            }
          }
          directColumns.sort((a, b) => a.index - b.index);
          const columns = directColumns.concat(nestedColumns);

          for (const { name: columnName, index: columnIndex, direct: directColumn } of columns) {
            const originalValue = directColumn ? row[columnName] : getPathValue(row, columnName);

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
              index: columnIndex,
              lines: baseLineNumber + rowIndex,
              records: rowIndex,
              empty_lines: 0,
              invalid_field_length: 0,
              quoting: false
            };

            let castedValue: any = originalValue; // Default to original value

            // Function to apply a caster
            const applyCaster = (caster: Caster<any>): boolean => {
              if (caster.test(valueToTestAndParse, context)) {
                try {
                  castedValue = caster.parse(valueToTestAndParse, context);
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
            if (columnCasts && Object.prototype.hasOwnProperty.call(columnCasts, columnName) && columnCasts[columnName as string]) {
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

            // 2. Global casters are not automatically applied - only column-specific casters are used
            // This prevents unexpected type conversions on columns that weren't explicitly configured

            // Set the potentially modified value in the new row
            if (directColumn) newRow[columnName] = castedValue;
            else newRow = setPathValueCopy(newRow, columnName, castedValue);
          }

          return newRow as T;
        });
      }
    }

    // Validate for empty values if requested
    if (options.allowEmptyValues === false && processedData.length > 0) {
      processedData.forEach((row, i) => {
        if (typeof row === 'object' && row !== null) {
          for (const [key, value] of Object.entries(row)) {
            if (value === '' || value === null || value === undefined) {
              throw new CSVError(`empty value found at line ${baseLineNumber + i}, column ${key}`);
            }
          }
        }
      });
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
      const csvOptions: CsvParseOptions<any> = {
        columns: true,
        bom: true,
        ...((options.csvOptions as CsvParseOptions<any> | undefined) || {})
      };
      let dataAfterCsvParse = parseCSV(csvString, csvOptions as CsvParseOptionsType<any>) as any[];

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
      if (error instanceof CSVError) {
        throw error;
      }
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
      const readOptions: CSVReadOptions<T> = Object.keys(options).every(key => key === 'columns')
        ? { csvOptions: options } as CSVReadOptions<T>
        : options as CSVReadOptions<T>;

      // Consistent approach: Set columns: true by default for proper object-based parsing
      const csvParseOptions: CsvParseOptions<any> = {
        columns: true,
        bom: true,
        ...((readOptions.csvOptions as CsvParseOptions<any> | undefined) || {})
      };

      return new Promise((resolve, reject) => {
        const data: any[] = [];
        const parser = parseCSVAsync(csvParseOptions as CsvParseOptionsType<any>);

        parser.on('readable', () => {
          let record;
          while ((record = parser.read()) !== null) {
            data.push(record);
          }
        });

        parser.on('error', (err: unknown) => {
          reject(new CSVError('Failed to parse CSV stream', err instanceof Error ? err : new Error(String(err))));
        });

        stream.on('error', (err: Error) => parser.destroy(err));

        parser.on('end', async () => {
          try {
            // Process the data with the shared function (apply header mapping and custom casting)
            const processedData = this.processCSVData<T>(data, readOptions as CSVReadOptions<T & Record<string, any>>);

            // Apply schema validation if configured
            if (readOptions.schema && processedData.length > 0) {
              try {
                const [validatedData, validationResults] = readOptions.schema.useAsync !== false
                  ? await this._validateWithSchemaAsync(processedData, readOptions.schema)
                  : this._validateWithSchemaSync(processedData, readOptions.schema);

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
   * // Use the asynchronous writer for streaming output.
   * await users.writeToFileAsync('users_export.csv');
   * ```
   */
  writeToFile(filename: string, options: CSVWriteOptions<T> = {}): void {
    const operation = () => {
      const outputPath = filename.endsWith('.csv')
        ? filename
        : `${filename}.csv`;

      // Apply header mapping if provided
      if (options.headerMap) {
        // Generate headers from headerMap and data
        const generatedHeaders: string[] = [];
        for (const [key, mapping] of Object.entries(options.headerMap)) {
          if (typeof mapping === 'string') {
            generatedHeaders.push(mapping);
          } else if (typeof mapping === 'object' && mapping !== null && (mapping as any)._type === 'targetArrayToCsv') {
            const arrayRule = mapping as ObjectArrayToCsvConfig;
            if (arrayRule.targetCsvColumns) {
              generatedHeaders.push(...arrayRule.targetCsvColumns);
            } else if (arrayRule.targetCsvColumnPrefix) {
              // Find max length of the array in data
              const maxLength = this.data.reduce((max, item) => {
                const arr = getPathValue(item, key);
                return Array.isArray(arr) ? Math.max(max, arr.length) : max;
              }, 0);
              const limit = arrayRule.maxColumns !== undefined ? Math.min(arrayRule.maxColumns, maxLength) : maxLength;
              for (let i = 1; i <= limit; i++) {
                generatedHeaders.push(`${arrayRule.targetCsvColumnPrefix}${i}`);
              }
            }
          }
        }

        const stringifyOptions = options.stringifyOptions || { header: true };
        const headers = Array.isArray(stringifyOptions.header)
          ? stringifyOptions.header
          : generatedHeaders;

        const { toRowArr } = createWriteHeaderMapFns<T>(options.headerMap);

        const rows = this.data.map(item => toRowArr(item, headers));
        if (stringifyOptions.header === true) rows.unshift(headers);
        const csvString = stringifyCSV(rows, {
          ...stringifyOptions, header: false, columns: undefined, eof: stringifyOptions.eof ?? false,
        });
        fs.writeFileSync(outputPath, prependCSVHeader(options.additionalHeader ?? this.additionalHeader ?? '', csvString), 'utf-8');
        return;
      }

      // This API is synchronous even when the legacy streaming option is set.
      const csvString = stringifyCSV(this.data, normalizeWriteStringifyOptions(options.stringifyOptions || { header: true }));
      fs.writeFileSync(outputPath, prependCSVHeader(options.additionalHeader ?? this.additionalHeader ?? '', csvString), 'utf-8');

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

      return await new Promise((resolve, reject) => {
        const stringifyOptions = options.stringifyOptions || { header: true };
        const prepared = prepareStreamingHeader(options.additionalHeader ?? this.additionalHeader ?? '', stringifyOptions);
        let stringifier: ReturnType<typeof stringifyCSVAsync>;

        // Apply header mapping if provided
        if (options.headerMap) {
          // Generate headers from headerMap and data
          const generatedHeaders: string[] = [];
          for (const [key, mapping] of Object.entries(options.headerMap)) {
            if (typeof mapping === 'string') {
              generatedHeaders.push(mapping);
            } else if (typeof mapping === 'object' && mapping !== null && (mapping as any)._type === 'targetArrayToCsv') {
              const arrayRule = mapping as ObjectArrayToCsvConfig;
              if (arrayRule.targetCsvColumns) {
                generatedHeaders.push(...arrayRule.targetCsvColumns);
              } else if (arrayRule.targetCsvColumnPrefix) {
                // Find max length of the array in data
                const maxLength = this.data.reduce((max, item) => {
                  const arr = getPathValue(item, key);
                  return Array.isArray(arr) ? Math.max(max, arr.length) : max;
                }, 0);
                const limit = arrayRule.maxColumns !== undefined ? Math.min(arrayRule.maxColumns, maxLength) : maxLength;
                for (let i = 1; i <= limit; i++) {
                  generatedHeaders.push(`${arrayRule.targetCsvColumnPrefix}${i}`);
                }
              }
            }
          }

          // Get headers
          const headers = Array.isArray(stringifyOptions.header)
            ? stringifyOptions.header
            : generatedHeaders;

          const { toRowArr } = createWriteHeaderMapFns<T>(options.headerMap);
          stringifier = stringifyCSVAsync({ ...prepared.options, header: Array.isArray(stringifyOptions.header) ? false : stringifyOptions.header, columns: headers } as any);

          // Create a transform stream that applies the header mapping
          const transformer = new Transform({
            objectMode: true,
            transform(chunk, _encoding, callback) {
              try {
                const mappedRow = toRowArr(chunk, headers);
                callback(null, mappedRow);
              } catch (error) {
                callback(error as Error);
              }
            }
          });

          const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
          if (prepared.header) writable.write(prepared.header);
          streamPipeline(Readable.from(this.data), transformer, stringifier, writable, error => error ? reject(error) : resolve());
        } else {
          // Standard processing without header mapping
          stringifier = stringifyCSVAsync(normalizeWriteStringifyOptions(prepared.options));
          const writable = fs.createWriteStream(outputPath, { encoding: 'utf-8' });
          if (prepared.header) writable.write(prepared.header);
          streamPipeline(Readable.from(this.data), stringifier, writable, error => error ? reject(error) : resolve());
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
    if (schema.useAsync) {
      throw new CSVError('Asynchronous schema validation is not supported in validate; use validateAsync instead.');
    }
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
    _baseLineNumber: number = 1
  ): Promise<[T[], RowValidationResult<T>[]]> {
    const { rowSchema, columnSchemas, validationMode = 'error' } = schemaConfig;
    const validationResults: RowValidationResult<T>[] = [];
    const validatedData: T[] = [];

    // Function to validate a row asynchronously
    const validateRowAsync = async (row: Record<string, any>, _index: number): Promise<RowValidationResult<T>> => {
      const result: RowValidationResult<T> = {
        originalRow: { ...row },
        valid: true
      };

      const workingRow = { ...row };
      if (columnSchemas) {
        const issues: Record<string, import('./schema').StandardSchemaV1.Issue[]> = {};
        await Promise.all(Object.entries(columnSchemas).map(async ([column, schema]) => {
          if (!schema) return;
          const validation = await tryValidateStandardSchemaAsync(schema, row[column]);
          if (validation.issues) {
            result.valid = false;
            Object.defineProperty(issues, column, { value: [...validation.issues], enumerable: true, configurable: true, writable: true });
          } else {
            Object.defineProperty(workingRow, column, { value: validation.value, enumerable: true, configurable: true, writable: true });
          }
        }));
        if (Object.keys(issues).length) result.columnIssues = issues;
      }
      if (rowSchema) {
        const validation = await tryValidateStandardSchemaAsync(rowSchema, workingRow);
        if (validation.issues) {
          result.valid = false;
          result.rowIssues = [...validation.issues];
        } else {
          result.validatedRow = { ...validation.value } as T;
        }
      } else {
        result.validatedRow = workingRow as T;
      }

      return result;
    };

    const concurrency = positiveInteger(schemaConfig.concurrency, 32, 'schema concurrency');
    for (let start = 0; start < data.length; start += concurrency) {
      const results = await Promise.all(data.slice(start, start + concurrency).map(validateRowAsync));
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
    // Generate headers from headerMap and data
    const generatedHeaders: string[] = [];
    for (const [key, mapping] of Object.entries(headerMap)) {
      if (typeof mapping === 'string') {
        generatedHeaders.push(mapping);
      } else if (typeof mapping === 'object' && mapping !== null && (mapping as any)._type === 'targetArrayToCsv') {
        const arrayRule = mapping as ObjectArrayToCsvConfig;
        if (arrayRule.targetCsvColumns) {
          generatedHeaders.push(...arrayRule.targetCsvColumns);
        } else if (arrayRule.targetCsvColumnPrefix) {
          // Find max length of the array in data
          const maxLength = this.data.reduce((max, item) => {
            const arr = getPathValue(item, key);
            return Array.isArray(arr) ? Math.max(max, arr.length) : max;
          }, 0);
          const limit = arrayRule.maxColumns !== undefined ? Math.min(arrayRule.maxColumns, maxLength) : maxLength;
          for (let i = 1; i <= limit; i++) {
            generatedHeaders.push(`${arrayRule.targetCsvColumnPrefix}${i}`);
          }
        }
      }
    }

    const headers = Array.isArray(stringifyOptions.header)
      ? stringifyOptions.header
      : generatedHeaders;

    const { toRowArr } = createWriteHeaderMapFns<T>(headerMap);

        // Transform the data through the header map
        const rows = this.data.map(item => toRowArr(item, headers));

        // Add headers as the first row if needed
        if (stringifyOptions.header === true) {
          rows.unshift(headers);
        }

        return stringifyCSV(rows, {
          ...stringifyOptions, header: false, columns: undefined, eof: stringifyOptions.eof ?? false,
        });
      }

      // If headerMap is not provided, use standard stringify with stringifyOptions
      return stringifyCSV(this.data, normalizeWriteStringifyOptions(stringifyOptions));
    }

    // Handle standard stringify options (direct options object)
    // Handle case when options has stringifyOptions property
    if (options && 'stringifyOptions' in options) {
      return stringifyCSV(this.data, normalizeWriteStringifyOptions(options.stringifyOptions || { header: true }));
    }
  // Handle case when options is a direct stringify options object
  return stringifyCSV(this.data, { header: true, ...(options as Parameters<typeof stringifyCSV>[1] || {}) });
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
  getBaseRow(
    defaults?: Partial<T>
  ): Partial<T> {
    if (this.data.length === 0) {
      throw new CSVError('Cannot create base row from empty data');
    }

    const baseRow = Object.fromEntries(
      Object.entries(this.data[0]).map(([key]) => [key, undefined])
    ) as { [K in keyof T]: undefined };

    return defaults ? { ...baseRow, ...defaults } as Partial<T> : baseRow as Partial<T>;
  }

  /**
   * Create a new row with the CSV structure
   * @param data - The data to populate the row with
   * @returns A new object with all CSV fields
   */
  createRow(data: Partial<T> = {}): Partial<T> {
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
    return this.data.map(row => ({
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
    let best: SimilarityMatch<T> | undefined;
    for (const row of this.data) {
      const dist = levenshteinDistance(str, String(row[column]));
      if (!best || dist < best.dist) best = { row, dist };
    }
    return best;
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
      if (!Object.prototype.hasOwnProperty.call(acc, key)) Object.defineProperty(acc, key, { value: [], enumerable: true, writable: true, configurable: true });
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
   *                     Custom comparison functions run in the main thread so closures work.
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
    if (!Number.isSafeInteger(workerThreshold) || workerThreshold < 0) throw new CSVError('workerThreshold must be a non-negative integer');
    const configuredWorkers = options.maxWorkers === undefined
      ? undefined : positiveInteger(options.maxWorkers, 1, 'maxWorkers');

    // Determine the comparison function
    let compareFn: (a: T, b: T) => number;

    if (typeof columnOrFn === 'function') {
      compareFn = columnOrFn;
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

    const sortLocally = () => new CSV<T>([...this.data].sort(compareFn), this.additionalHeader, this.validationResults);
    if (this.data.length <= workerThreshold || configuredWorkers === 1 || typeof columnOrFn === 'function') {
      return sortLocally();
    }

    // Only inspect CPUs and keys when a worker sort may actually be used.
    const numCPUs = os.cpus().length;
    if (numCPUs <= 1) return sortLocally();
    const requestedWorkers = configuredWorkers ?? Math.min(numCPUs, 8);
    const hasNonPrimitiveKeys = typeof columnOrFn !== 'function' && this.data.some(row => {
      const value = row[columnOrFn];
      return value !== null && (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol');
    });
    if (hasNonPrimitiveKeys) return sortLocally();

    // --- Parallel Sorting with Workers ---
    // console.log('Attempting parallel sort');
    const maxWorkers = Math.min(requestedWorkers, numCPUs, this.data.length);
    const chunkSize = Math.ceil(this.data.length / maxWorkers);
    const chunks: T[][] = [];

    for (let i = 0; i < this.data.length; i += chunkSize) {
      chunks.push(this.data.slice(i, i + Math.min(chunkSize, this.data.length - i)));
    }

    const workerPromises = chunks.map((chunk, index) => {
      return new Promise<T[]>((resolve, reject) => {
        const worker = new Worker(`
  const { parentPort, workerData } = require('worker_threads');
  const { chunk, column, direction } = workerData;
  const compare = (a, b) => {
    const aVal = a[column], bVal = b[column];
    if (aVal === bVal) return 0;
    if (aVal == null) return direction === 'asc' ? -1 : 1;
    if (bVal == null) return direction === 'asc' ? 1 : -1;
    const result = typeof aVal === 'number' && typeof bVal === 'number'
      ? aVal - bVal : String(aVal).localeCompare(String(bVal));
    return direction === 'asc' ? result : -result;
  };
  try {
    const sortedIndexes = chunk.map((value, index) => ({ value, index }))
      .sort((a, b) => compare(a.value, b.value))
      .map(entry => entry.index);
    parentPort.postMessage({ sortedIndexes });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
`, {
          eval: true, // Necessary for the inline string worker
          workerData: {
            chunk,
            column: typeof columnOrFn !== 'function' ? columnOrFn : undefined, // Only pass column if not custom fn
            direction,
          },
        });

        worker.on('message', (message) => {
          if (message.error) {
            reject(new CSVError(`Worker sort error (chunk ${index}): ${message.error}`, message.error));
          } else if (message.sortedIndexes) {
            resolve(message.sortedIndexes.map((index: number) => chunk[index]));
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
          reject(new CSVError(`Worker ${index} exited before returning a result (code ${code}).`));
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
      return sortLocally();
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
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of this.data) {
      const value = Number(row[column]);
      if (Number.isNaN(value)) continue;
      count++;
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    if (count === 0) {
      if (operation === 'count') return 0;
      throw new CSVError(`No numeric values found in column "${String(column)}"`);
    }

    switch (operation) {
      case 'sum':
        return sum;
      case 'avg':
        return sum / count;
      case 'min':
        return min;
      case 'max':
        return max;
      case 'count':
        return count;
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

      if (!Object.prototype.hasOwnProperty.call(result, rowKey)) Object.defineProperty(result, rowKey, { value: {}, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(result[rowKey], colKey, { value, enumerable: true, writable: true, configurable: true });
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
  ): CSV<T | E> {
    const otherData = other instanceof CSV ? other.toArray() : other;
    const result: (T | E)[] = [];

    // Track processed items from B
    const processedB = new Set<number>();

    // First pass: find matches and merge them
    for (const itemA of this.data) {
      let matched = false;

      for (const [index, itemB] of otherData.entries()) {
        if (processedB.has(index)) continue;

        if (equalityFn(itemA, itemB)) {
          result.push(mergeFn(itemA, itemB));
          processedB.add(index);
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
    for (const [index, itemB] of otherData.entries()) {
      if (!processedB.has(index)) {
        result.push({ ...itemB });
      }
    }

    return CSV.fromData(result);
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
    const batchSize = positiveInteger(options.batchSize, 1, 'batchSize');
    const batchConcurrency = positiveInteger(options.batchConcurrency, 1, 'batchConcurrency');

    if (batchSize <= 1 && batchConcurrency <= 1) {
      // Original sequential processing
      for (let i = 0; i < this.data.length; i++) {
        await callback(this.data[i], i);
      }
      return;
    }

    const windowSize = batchSize * batchConcurrency;
    for (let start = 0; start < this.data.length; start += windowSize) {
      const end = Math.min(start + windowSize, this.data.length);
      await Promise.all(this.data.slice(start, end).map((row, index) => callback(row, start + index)));
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
    const batchSize = positiveInteger(options.batchSize, 1, 'batchSize');
    const batchConcurrency = positiveInteger(options.batchConcurrency, 1, 'batchConcurrency');

    if (batchSize <= 1 && batchConcurrency <= 1) {
      // Original sequential processing
      const results: R[] = [];
      for (let i = 0; i < this.data.length; i++) {
        results.push(await callback(this.data[i], i));
      }
      return results;
    }

    const results: R[] = [];
    const windowSize = batchSize * batchConcurrency;
    for (let start = 0; start < this.data.length; start += windowSize) {
      const end = Math.min(start + windowSize, this.data.length);
      const windowResults = await Promise.all(this.data.slice(start, end).map((row, index) => callback(row, start + index)));
      for (const result of windowResults) results.push(result);
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
   * Reduce rows asynchronously in order.
   * The legacy mapreduce strategy also runs sequentially because a row reducer
   * cannot safely combine partial accumulators without a separate combiner.
   * @param callback - Async reducer function
   * @param initialValue - Starting value
   * @param options - Legacy strategy and batch size options
   * @returns Promise resolving to the reduced value
   */
  async reduceAsync<R>(
    callback: (accumulator: R, row: T, index: number) => Promise<R>,
    initialValue: R,
    options: {
      strategy?: 'sequential' | 'mapreduce';
      batchSize?: number;
    } = {}
  ): Promise<R> {
    // A row reducer cannot combine partial accumulators in general. Preserve
    // its semantics for both strategies until a separate combiner is supplied.
    void options;
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
    if (count <= 0) return new CSV<T>([], this.additionalHeader);
    if (count >= this.data.length) return new CSV<T>([...this.data], this.additionalHeader);

    const shuffled = [...this.data];
    const limit = Math.floor(count);
    for (let i = 0; i < limit; i++) {
      const selected = i + Math.floor(Math.random() * (shuffled.length - i));
      [shuffled[i], shuffled[selected]] = [shuffled[selected], shuffled[i]];
    }
    return new CSV<T>(shuffled.slice(0, limit), this.additionalHeader);
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
    return new CSV<T>(count <= 0 ? [] : [...this.data.slice(-count)], this.additionalHeader);
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
  ): CSV<ColumnUpdate<T, NewKey, NewValue>> {
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
      } as ColumnUpdate<T, NewKey, NewValue>;
    });
    return new CSV<ColumnUpdate<T, NewKey, NewValue>>(newData, this.additionalHeader);
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
  renameColumn<OldK extends string, NewK extends string>(
    oldName: OldK,
    newName: NewK
  ): CSV<RenamedColumn<T, OldK, NewK>> {
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
    return new CSV<RenamedColumn<T, OldK, NewK>>(newData, this.additionalHeader);
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

    const preferred: PropertyKey[] = Array.from(new Set(orderedColumnNames.map(key => typeof key === 'symbol' ? key : String(key))));
    const newData = this.data.map(row => {
      const result: Record<PropertyKey, unknown> = {};
      const ordered = preferred.filter(key => Object.prototype.propertyIsEnumerable.call(row, key));
      const seen = new Set(ordered);
      for (const key of Reflect.ownKeys(row)) {
        if (!seen.has(key) && Object.prototype.propertyIsEnumerable.call(row, key)) ordered.push(key);
      }
      for (const key of ordered) {
        Object.defineProperty(result, key, { value: Reflect.get(row, key), enumerable: true, writable: true, configurable: true });
      }
      return result as T;
    });

    return new CSV<T>(newData, this.additionalHeader);
  }

  /**
   * Attempts to cast the values in a specified column to a given data type.
   * If casting fails for a value (e.g., 'abc' to number), it becomes `null`.
   *
   * @param columnName - The name of the column to cast. Can be `keyof T` or a string.
   * @param targetType - The target data type: 'string', 'number', 'boolean', or 'date'.
   * @returns A new CSV instance with the cast value type reflected in its rows.
   * @example
   * ```typescript
   * // interface Product { id: string; price: string; available: string; }
   * // const csv = CSV.fromData<Product>([
   * //   { id: '1', price: '19.99', available: 'true' },
   * //   { id: '2', price: ' N/A ', available: '0' }
   * // ]);
   *
   * const castedCsv = csv.castColumnType('id', 'number')
   *   .castColumnType('price', 'number')
   *   .castColumnType('available', 'boolean');
   * // castedCsv.toArray() might be:
   * // [
   * //   { id: 1, price: 19.99, available: true },
   * //   { id: '2', price: null, available: false } // 'N/A' becomes null for price
   * // ]
   * ```
   */
  castColumnType<K extends string, C extends ColumnCastTarget>(
    columnName: K,
    targetType: C
    // dateFormat?: string // Kept commented as it requires an external library
  ): CSV<CastColumn<T, K, C>> {
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
    return new CSV<CastColumn<T, K, C>>(newData as CastColumn<T, K, C>[], this.additionalHeader);
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
   * Values use SameValueZero equality; objects and arrays are compared by identity.
   */
  deduplicate(columnsToCheck?: (keyof T)[]): CSV<T> {
    if (this.data.length === 0) {
      return new CSV<T>([], this.additionalHeader); // Return new empty instance
    }

    // A trie preserves value types and tuple boundaries without serializing
    // objects or conflating values such as 1 and "1".
    type DeduplicationNode = Map<unknown, DeduplicationNode>;
    const seen: DeduplicationNode = new Map();
    const terminal = Symbol('row');
    const newData: T[] = [];
    const selectedColumns = columnsToCheck?.length ? columnsToCheck : undefined;
    for (const row of this.data) {
      const parts: unknown[] = [];
      if (selectedColumns) {
        for (const column of selectedColumns) parts.push(row[column]);
      } else {
        for (const key of Object.keys(row).sort()) parts.push(key, row[key]);
      }
      let node = seen;
      for (const part of parts) {
        let child = node.get(part);
        if (!child) {
          child = new Map();
          node.set(part, child);
        }
        node = child;
      }
      if (!node.has(terminal)) {
        node.set(terminal, new Map());
        newData.push({ ...row });
      }
    }

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
    JoinedRowType extends Record<string, any> = JoinedRow<T, OtherRowType>
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
    Record<VarNameCol, ValueKeys> & // The variable value is the original column key
    Record<ValueNameCol, T[ValueKeys]> // Type of value is the union of types of values in ValueKeys
  > {
    const newData: Array<
      Pick<T, IdKeys> &
      Record<VarNameCol, ValueKeys> &
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
            Record<VarNameCol, ValueKeys> &
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
      Record<VarNameCol, ValueKeys> &
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
  fillMissingValues<K extends keyof T, V>(
    columnName: K,
    valueOrFn: V | ((row: T) => V)
  ): CSV<FilledColumn<T, K, V>> {
    const newData = this.data.map(row => {
      const currentValue = row[columnName];

      if (currentValue === null || currentValue === undefined) {
        const newValue = typeof valueOrFn === 'function'
          ? (valueOrFn as (row: T) => V)(row)
          : valueOrFn;
        return {
          ...row,
          [columnName]: newValue,
        };
      }
      return { ...row }; // Return a copy even if no change for consistency
    });

    return new CSV<FilledColumn<T, K, V>>(newData as FilledColumn<T, K, V>[], this.additionalHeader);
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
  ): CSV<TextColumn<T, K>> {
    const colNameStr = columnName;

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

    return new CSV<TextColumn<T, K>>(newData as TextColumn<T, K>[], this.additionalHeader);
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
  trimWhitespace(columns?: (keyof T | string)[]): CSV<TextColumns<T>> {
    if (this.data.length === 0) {
      return new CSV<TextColumns<T>>([], this.additionalHeader);
    }

    const columnsToProcess = columns && columns.length > 0 ? columns.map(String) : undefined;

    const newData = this.data.map(row => {
      const newRow = { ...row };
      (columnsToProcess ?? Object.keys(row)).forEach(colKeyStr => {
        const colKey = colKeyStr as keyof T; // Assume string keys correspond to T's keys
        if (Object.prototype.hasOwnProperty.call(newRow, colKey) && typeof newRow[colKey] === 'string') {
          (newRow[colKey] as any) = (newRow[colKey] as string).trim();
        }
      });
      return newRow; // Type T is preserved as structure doesn't change
    });

    return new CSV<TextColumns<T>>(newData as TextColumns<T>[], this.additionalHeader);
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
 * @param options Reading options, including `csvOptions`, `headerMap`, `customCasts` and `schema`.
 * Schema validation runs per row; `keep` retains invalid rows without collecting validation results.
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
      // 1. Prepare options for the main CSV parser (parseCSVAsync)
      const mainDataParserOptions: CsvParseInternalOptions<any> = {
        bom: true,
        ...(options.csvOptions as CsvParseOptions<any> | undefined),
      };

      const getCsvFromLineValue = (csvOpts?: CsvParseOptions<any>): number | undefined => {
        if (!csvOpts) return undefined;
        return normalizeLineNumber(csvOpts.from_line ?? csvOpts.fromLine);
      };
      const initialFromForData = getCsvFromLineValue(mainDataParserOptions); // Use options.csvOptions from the CSVReadOptions

      if (initialFromForData !== undefined) {
        mainDataParserOptions.from_line = initialFromForData;
      } else {
        mainDataParserOptions.from_line = 1;
      }
      delete mainDataParserOptions.fromLine;
      const normalizedFromLine = normalizeLineNumber(mainDataParserOptions.from_line);
      if (normalizedFromLine !== undefined) {
        mainDataParserOptions.from_line = normalizedFromLine;
      } else {
        delete mainDataParserOptions.from_line;
      }

      const toLineForData = normalizeLineNumber(mainDataParserOptions.to_line ?? mainDataParserOptions.toLine);
      if (toLineForData !== undefined) mainDataParserOptions.to_line = toLineForData;
      else delete mainDataParserOptions.to_line;
      delete mainDataParserOptions.toLine;

      // Set columns behavior for mainDataParserOptions
      // This stream processor outputs objects, so columns: true (or array/fn) is needed for mainCsvParser
      // unless the user *explicitly* wants arrays from the source stream.
      if (mainDataParserOptions.columns === undefined) mainDataParserOptions.columns = true;

      // 2. Create the main CSV parser
      // parseCSVAsync returns a Transform stream
      const mapper = options.headerMap ? createHeaderMapFns<SourceRowType>(options.headerMap) : undefined;
      const mainCsvParser: Transform = parseCSVAsync(mainDataParserOptions);
      const fileReadStream: fs.ReadStream = fs.createReadStream(resolvedPath, options.fsOptions);
      mainCsvParser.on('close', () => fileReadStream.destroy());

      // 3. Optionally create and pipe through a headerMap transform
      let outputProducingStream: Readable = mainCsvParser; // This is the stream that will output SourceRowType objects

      if (mapper || options.customCasts || options.schema || options.allowEmptyValues === false) {
        const rowOptions = { ...options, headerMap: undefined };
        let rowIndex = 0;
        const headerMapTransform: Transform = new Transform({
          objectMode: true, // Expects objects from mainCsvParser, outputs mapped objects
          async transform(parsedRow: Record<string, any>, _encoding, callback) {
            try {
              const mapped = mapper ? mapper.fromRowArr(parsedRow) : parsedRow;
              const processed = CSV.processCSVData<SourceRowType>([mapped], rowOptions, ++rowIndex)[0];
              if (options.schema) {
                const [validated] = options.schema.useAsync === false
                  ? CSV._validateWithSchemaSync([processed], options.schema)
                  : await CSV._validateWithSchemaAsync([processed], options.schema);
                if (validated.length) callback(null, validated[0]);
                else callback();
              } else {
                callback(null, processed);
              }
            } catch (err) {
              callback(err instanceof Error ? err : new CSVError('Error processing streamed row', err));
            }
          }
        });

        // Pipe data from mainCsvParser through headerMapTransform
        mainCsvParser.pipe(headerMapTransform);
        // Propagate errors from mainCsvParser to headerMapTransform
        mainCsvParser.on('error', (err) => headerMapTransform.destroy(err));
        headerMapTransform.on('close', () => mainCsvParser.destroy());

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
  ): (T | E)[] {
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
    // Basic check: must contain at least one comma or newline to be considered CSV
    if (!str.includes(',') && !str.includes('\n')) {
      return false;
    }
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
    return new class extends Transform {
      constructor() {
        super({ objectMode: true });
      }

      _transform(chunk: T, _encoding: string, callback: (error?: Error | null, data?: R) => void) {
        try {
          const transformed = transform(chunk);
          callback(null, transformed);
        } catch (error) {
          callback(error as Error);
        }
      }
    }();
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
    const cpuCount = os.cpus().length;
    const maxWorkers = positiveInteger(options.maxWorkers, cpuCount, 'maxWorkers');
    const requestedChunkSize = options.chunkSize === undefined ? undefined : positiveInteger(options.chunkSize, 1, 'chunkSize');
    const workerCount = Math.min(maxWorkers, items.length, cpuCount);

    // If only a few items or just one worker, process directly
    if (workerCount <= 1 || items.length <= 10) {
      return operation(items);
    }

    // Split items into chunks
    const chunks: T[][] = [];
    const chunkSize = requestedChunkSize ?? Math.ceil(items.length / workerCount);

    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }

    // Limit concurrently running workers even when a small chunk size is requested.
    const results: R[] = [];
    for (let start = 0; start < chunks.length; start += workerCount) {
      const batch = chunks.slice(start, start + workerCount);
      const completed = await Promise.all(batch.map(chunk => this.processInWorker(operation, chunk)));
      for (const output of completed) for (const item of output) results.push(item);
    }
    return results;
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
  const parser = parseCSVAsync({
    bom: true,
    ...(options.csvOptions as CsvParseOptionsType<any> | undefined),
    columns: true,
  });
  const input = fs.createReadStream(path.resolve(filename), { encoding: 'utf-8' });
  input.on('error', error => parser.destroy(error));
  input.pipe(parser);

  try {
    const { fromRowArr } = options.headerMap
      ? createHeaderMapFns<T>(options.headerMap)
      : { fromRowArr: null };
    for await (const record of parser) {
      const processedRecord = fromRowArr ? fromRowArr(record) : record;
      yield options.transform ? options.transform(processedRecord) : processedRecord;
    }
  } finally {
    input.destroy();
    parser.destroy();
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
  const batchSize = positiveInteger(options.batchSize, 100, 'batchSize');
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

  try {
    const data: T[] = [];
    for await (const row of generator) {
      data.push(row);
    }

    const csv = CSV.fromData(data);
    csv.writeToFile(outputPath, options);
  } catch (error) {
    throw new CSVError('Failed to write CSV from generator', error);
  }
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
        const objRow: Record<string, any> = Object.create(null);
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
    return mapObjectsToRows(data, headerMap, headers, includeHeaders);
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
      const key = String(getPathValue(item, field) ?? 'undefined');
      if (!Object.prototype.hasOwnProperty.call(groups, key)) {
        Object.defineProperty(groups, key, { value: [], enumerable: true, writable: true, configurable: true });
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
export class CSVStreamProcessor<InType extends Record<string, any>, OutType extends Record<string, any> = InType, Action extends 'collect' | 'void' = 'void'> {
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
  ): CSVStreamProcessor<InType, NewOutType, Action> {
    return new CSVStreamProcessor<InType, NewOutType, Action>(
      this.sourceStreamFactory,
      [...this.transformFactories, transformFactory],
      this.terminalActionConfig // Intermediate ops don't change terminal config
    );
  }

  /**
   * @internal Helper to create a new processor instance with a new terminal action.
   */
  private _cloneWithTerminalAction<NewAction extends 'collect' | 'void'>(
    actionConfig: TerminalActionConfig
  ): CSVStreamProcessor<InType, OutType, NewAction> {
    return new CSVStreamProcessor<InType, OutType, NewAction>(
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
  filter(condition: (row: OutType) => boolean | Promise<boolean>): CSVStreamProcessor<InType, OutType, Action> {
    return this._cloneWithNewTransform<OutType>((currentStream: Readable) => {
      const filterTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, _encoding, callback) {
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
      filterTransform.on('close', () => currentStream.destroy());
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
  ): CSVStreamProcessor<InType, NewOutType, Action> {
    return this._cloneWithNewTransform<NewOutType>((currentStream: Readable) => {
      const mapTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, _encoding, callback) {
          try {
            this.push(await transformFn(row)); // Await transformFn if it's async
            callback();
          } catch (err) {
            callback(err instanceof Error ? err : new CSVError("Error in map transform function", err));
          }
        }
      });
      currentStream.on('error', (err) => mapTransform.destroy(err)); // Propagate errors
      mapTransform.on('close', () => currentStream.destroy());
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
  ): CSVStreamProcessor<InType, ColumnUpdate<OutType, NewKey, NewValue>, Action> {
    return this._cloneWithNewTransform<ColumnUpdate<OutType, NewKey, NewValue>>((currentStream: Readable) => {
      const addColumnTransform = new Transform({
        objectMode: true,
        async transform(row: OutType, _encoding, callback) {
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
      addColumnTransform.on('close', () => currentStream.destroy());
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
  prepareCollect(): CSVStreamProcessor<InType, OutType, 'collect'> {
    return this._cloneWithTerminalAction<'collect'>({ type: TerminalActionType.Collect });
  }

  /**
   * Configures the pipeline to write its output to a CSV file upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param filename The path to the output CSV file.
   * @param writeOptions Optional `CSVWriteOptions` for customizing CSV stringification and file writing.
   * @returns A new `CSVStreamProcessor` instance configured for file writing.
   */
  prepareToFile(filename: string, writeOptions?: CSVWriteOptions<OutType>): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction<'void'>({ type: TerminalActionType.ToFile, filename, writeOptions });
  }

  /**
   * Configures the pipeline to execute an asynchronous callback for each row upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param callback The async function to call for each processed row of type `OutType`.
   * @returns A new `CSVStreamProcessor` instance configured for row-by-row processing.
   */
  prepareForEach(callback: (row: OutType) => void | Promise<void>): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction<'void'>({ type: TerminalActionType.ForEach, forEachCallback: callback });
  }

  /**
   * Configures the pipeline to pipe its output to a specified Writable stream upon execution.
   * This is a configuring step; use `.run()` to execute the pipeline.
   * @param destination The Writable stream to pipe the results to.
   * @param options Options for the pipe operation (e.g., `{ end?: boolean }`).
   * @returns A new `CSVStreamProcessor` instance configured for piping.
   */
  preparePipeTo(destination: Writable, options?: { end?: boolean }): CSVStreamProcessor<InType, OutType> {
    return this._cloneWithTerminalAction<'void'>({
      type: TerminalActionType.PipeTo, destinationStream: destination,
      pipeOptions: options
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
  run(): Promise<Action extends 'collect' ? CSV<OutType> : void>;
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
          const prepared = prepareStreamingHeader(writeOptions?.additionalHeader ?? '', stringifyOpts);
          const headerMap = writeOptions?.headerMap;
          let mappedStream: Readable = pipelineToRun;
          let outputOptions = normalizeWriteStringifyOptions(prepared.options);
          if (headerMap) {
            const headers: string[] = Array.isArray(stringifyOpts.header) ? [...stringifyOpts.header] : [];
            if (!Array.isArray(stringifyOpts.header)) {
              for (const rule of Object.values(headerMap)) {
                if (typeof rule === 'string') headers.push(rule);
                else if (rule && typeof rule === 'object' && rule._type === 'targetArrayToCsv') {
                  if (rule.targetCsvColumns) headers.push(...rule.targetCsvColumns);
                  else if (rule.targetCsvColumnPrefix) {
                    if (rule.maxColumns === undefined) throw new CSVError('Streaming array header mapping requires maxColumns or explicit headers');
                    for (let i = 1; i <= rule.maxColumns; i++) headers.push(`${rule.targetCsvColumnPrefix}${i}`);
                  }
                }
              }
            }
            const { toRowArr } = createWriteHeaderMapFns<OutType>(headerMap);
            const mapper = new Transform({
              objectMode: true,
              transform(row, _encoding, callback) {
                try { callback(null, toRowArr(row, headers)); }
                catch (error) { callback(error as Error); }
              }
            });
            pipelineToRun.on('error', error => mapper.destroy(error));
            mapper.on('error', () => pipelineToRun.destroy());
            mappedStream = pipelineToRun.pipe(mapper);
            outputOptions = { ...prepared.options, columns: headers, header: Array.isArray(stringifyOpts.header) ? false : stringifyOpts.header };
          }
          // Use a type assertion to help TypeScript understand this is valid
          const csvStringifier = stringifyCSVAsync(outputOptions) as Transform;
          const fileWriteStream = fs.createWriteStream(filename, { encoding: 'utf-8' });
          if (prepared.header) fileWriteStream.write(prepared.header);
          await pipelineAsync(mappedStream, csvStringifier, fileWriteStream);
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
          const { destinationStream, pipeOptions } = this.terminalActionConfig;
          if (!destinationStream) {
            return Promise.reject(new CSVError("Destination stream not provided for pipeTo action."));
          }
          if (pipeOptions?.end === false) {
            const proxy = new Writable({
              objectMode: destinationStream.writableObjectMode,
              write(chunk, encoding, callback) { destinationStream.write(chunk, encoding, callback); }
            });
            const onDestinationError = (error: Error) => proxy.destroy(error);
            destinationStream.on('error', onDestinationError);
            try { await pipelineAsync(pipelineToRun, proxy); }
            finally { destinationStream.off('error', onDestinationError); }
          } else {
            await pipelineAsync(pipelineToRun, destinationStream);
          }
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
      pipelineToRun.destroy();
      throw err instanceof CSVError ? err : new CSVError("Unhandled error in CSVStreamProcessor.run()", err);
    }
  }

  /** Yield rows with the stream's built-in backpressure and cancellation behavior. */
  private async *_yieldFromStream(stream: Readable): AsyncGenerator<OutType, void, undefined> {
    for await (const row of stream) yield row as OutType;
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





