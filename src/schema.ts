/**
 * Standard Schema integration for CSV validation.
 */

/**
 * The Standard Schema interface.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  export interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Validates unknown input values. */
    readonly validate: (
      value: unknown
    ) => Result<Output> | Promise<Result<Output>>;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The result interface of the validate function. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  export interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** The non-existent issues. */
    readonly issues?: undefined;
  }

  /** The result interface if validation fails. */
  export interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** The issue interface of the failure output. */
  export interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  export interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard Schema types interface. */
  export interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Schema. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Schema. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/**
 * Synchronously validates input against a Standard Schema.
 *
 * @template S - A type that extends `StandardSchemaV1`
 * @param {S} schema - The Standard Schema compliant validator
 * @param {unknown} input - The value to validate
 * @returns {StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>} The validation result
 */
export function tryValidateStandardSchemaSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>> {
  const validationOutcome = schema['~standard'].validate(input);

  if (validationOutcome instanceof Promise) {
    return {
      issues: [{ message: "Validation is asynchronous but synchronous validation was expected." }]
    } as StandardSchemaV1.FailureResult;
  } else {
    return validationOutcome as StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>;
  }
}

/**
 * Asynchronously validates input against a Standard Schema.
 *
 * @template S - A type that extends `StandardSchemaV1`
 * @param {S} schema - The Standard Schema compliant validator
 * @param {unknown} input - The value to validate
 * @returns {Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>>} Promise resolving to the validation result
 */
export async function tryValidateStandardSchemaAsync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>> {
  const validationOutcome = schema['~standard'].validate(input);
  return await validationOutcome as StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>;
}

/**
 * CSV schema configuration for validating rows and columns.
 */
export interface CSVSchemaConfig<T extends Record<string, any>> {
  /** Schema for validating entire rows */
  rowSchema?: StandardSchemaV1<any, T>;
  
  /** Schemas for validating individual columns */
  columnSchemas?: {
    [K in keyof T]?: StandardSchemaV1<unknown, T[K]>;
  };
  
  /** 
   * How to handle validation failures 
   * - 'error': Stop processing and throw an error (default)
   * - 'filter': Skip invalid rows
   * - 'keep': Keep all rows but track validation results
   */
  validationMode?: 'error' | 'filter' | 'keep';
  
  /** Whether to use async validation (required for async schemas) */
  useAsync?: boolean;
}

/**
 * Represents the validation result for a row.
 */
export interface RowValidationResult<T> {
  /** The original row data */
  originalRow: Record<string, any>;
  
  /** The validated row data (if successful) */
  validatedRow?: T;
  
  /** Whether the row passed validation */
  valid: boolean;
  
  /** Issues with row validation */
  rowIssues?: StandardSchemaV1.Issue[];
  
  /** Issues with column validation */
  columnIssues?: {
    [column: string]: StandardSchemaV1.Issue[];
  };
}