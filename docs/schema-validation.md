# Data Validation in CSV Utils

CSV Utils provides robust mechanisms for validating your CSV data, ensuring its integrity and conformity to your expected structures and types. Validation can be performed against individual columns or entire rows using any schema library that implements the **Standard Schema** specification (e.g., Zod 3.24+, Valibot, ArkType).

## Table of Contents

-   [Why Validate CSV Data?](#why-validate-csv-data)
-   [Core Validation Concepts](#core-validation-concepts)
    -   [The Standard Schema Interface (`StandardSchemaV1`)](#the-standard-schema-interface-standardschemav1)
    -   [`CSVSchemaConfig<T>`](#csvschemaconfigt-options)
    -   [Validation Modes](#validation-modes)
    -   [Synchronous vs. Asynchronous Validation](#synchronous-vs-asynchronous-validation)
-   [Using Standard Schema Compliant Libraries (e.g., Zod)](#using-standard-schema-compliant-libraries-eg-zod)
    -   [Example: Row Validation with Zod](#example-row-validation-with-zod)
    -   [Example: Column Validation with Zod](#example-column-validation-with-zod)
    -   [Leveraging Coercion in Schema Libraries](#leveraging-coercion-in-schema-libraries)
-   [Creating Custom `StandardSchemaV1` Objects (Advanced)](#creating-custom-standardschemav1-objects-advanced)
-   [Applying Schemas](#applying-schemas)
    -   [During CSV Reading (`CSV.fromFile`, `CSV.fromString`, etc.)](#during-csv-reading)
    -   [Using `csvInstance.validate()` or `csvInstance.validateAsync()`](#using-csvinstancevalidate-or-csvinstancevalidateasync)
-   [Working with Validation Results (`validationMode: 'keep'`)](#working-with-validation-results-validationmode-keep)
    -   [`RowValidationResult<T>`](#rowvalidationresultt-interface)
    -   [Example: Inspecting Issues](#example-inspecting-issues)
-   [Order of Operations: `customCasts` vs. Schema Validation](#order-of-operations-customcasts-vs-schema-validation)
-   [Common Validation Scenarios & Best Practices](#common-validation-scenarios--best-practices)
-   [Troubleshooting Validation](#troubleshooting-validation)

## Why Validate CSV Data?

Real-world CSV files can be inconsistent. Validation helps you:

*   **Ensure Data Quality:** Catch errors, inconsistencies, and unexpected formats early.
*   **Maintain Type Safety:** Confirm that data can be correctly processed by your application.
*   **Prevent Downstream Errors:** Avoid issues in later stages of data processing or storage.
*   **Enforce Business Rules:** Ensure data adheres to specific constraints.

## Core Validation Concepts

### The Standard Schema Interface (`StandardSchemaV1`)

CSV Utils leverages the [Standard Schema](https://standardschema.dev) specification. This allows you to use schemas from any compatible library (like Zod 3.24+, Valibot, ArkType) directly. A Standard Schema object exposes its validation logic and type information through a `~standard` property.

```typescript
// Abstract representation of the StandardSchemaV1 interface
// (as defined by @standard-schema/spec)
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string; // e.g., 'zod', 'valibot'
    readonly validate: (value: unknown) =>
      | StandardSchemaV1.SuccessResult<Output>
      | StandardSchemaV1.FailureResult
      | Promise<StandardSchemaV1.SuccessResult<Output> | StandardSchemaV1.FailureResult>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

// namespace StandardSchemaV1 {
//   interface SuccessResult<Output> { readonly value: Output; readonly issues?: undefined; }
//   interface FailureResult { readonly issues: ReadonlyArray<Issue>; }
//   interface Issue { message: string; path?: ReadonlyArray<PropertyKey | PathSegment>; }
// }
```

### `CSVSchemaConfig<T>` (Options)

This configuration object enables validation and expects schemas conforming to `StandardSchemaV1`.

```typescript
interface CSVSchemaConfig<T extends Record<string, any>> {
  /**
   * Schema applied to each entire row object.
   * Its `Output` type (from `~standard.types.output`) MUST be `T`.
   * Runs AFTER `columnSchemas`.
   */
  rowSchema?: StandardSchemaV1<any, T>;

  /**
   * Schemas applied to individual column values *before* `rowSchema` validation.
   * Keys are property names of `T` (after header mapping and custom casting).
   * The `Output` type of `columnSchemas[K]` MUST be `T[K]`.
   */
  columnSchemas?: {
    [K in keyof Partial<T>]?: StandardSchemaV1<unknown, T[K]>;
  } | {
    [columnName: string]: StandardSchemaV1<unknown, any>; // For dynamic column names
  };

  /** How to handle rows that fail validation. Default: 'error' */
  validationMode?: 'error' | 'filter' | 'keep';

  /**
   * Must be `true` if any schema's `~standard.validate` function is asynchronous (returns a Promise).
   * Synchronous CSV methods (e.g., `CSV.fromFile()`) will report an issue via `tryValidateStandardSchemaSync`
   * if `useAsync` is not `true` for an async schema.
   * Async CSV methods (e.g., `CSV.fromFileAsync()`) typically infer or default this to `true`.
   */
  useAsync?: boolean;
}
```

### Validation Modes

*   **`'error'` (Default):** Throws a `CSVError` on the first invalid row.
*   **`'filter'`:** Silently removes invalid rows.
*   **`'keep'`:** Keeps all rows; `csvInstance.validationResults` stores validation details for each.

### Synchronous vs. Asynchronous Validation

A `StandardSchemaV1`'s `~standard.validate` function can be synchronous (returning a result directly) or asynchronous (returning a `Promise` of a result).

*   **Async Schemas with Synchronous CSV Methods:** If you use a schema with an async `validate` function with methods like `CSV.fromFile()`:
    *   You **must** set `useAsync: true` in `CSVSchemaConfig`.
    *   If `useAsync` is `false` (or omitted), an issue will be reported by the library's internal synchronous validation helper, indicating that synchronous validation was expected for an asynchronous schema. This treats that specific validation attempt as a failure for the synchronous path.
*   **Async Schemas with Asynchronous CSV Methods:** Methods like `CSV.fromFileAsync()` or `csvInstance.validateAsync()` are designed for asynchronous operations and will correctly handle (i.e., `await`) async `validate` functions. In these contexts, `useAsync: true` is often the default or inferred behavior when a schema is provided.

## Using Standard Schema Compliant Libraries (e.g., Zod)

Libraries like Zod (v3.24.0+), Valibot, and ArkType directly implement the `StandardSchemaV1` interface. This means their schema objects can be passed directly to CSV Utils' `CSVSchemaConfig`.

### Example: Row Validation with Zod

```typescript
import CSV, { CSVSchemaConfig } from '@doeixd/csv-utils';
import { z } from 'zod'; // Ensure Zod v3.24.0+

const UserZodSchema = z.object({
  id: z.coerce.number().int().positive(), // z.coerce attempts type conversion
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
});
type User = z.infer<typeof UserZodSchema>;

// UserZodSchema from Zod v3.24.0+ is already a StandardSchemaV1<unknown, User>
const schemaConfig: CSVSchemaConfig<User> = {
  rowSchema: UserZodSchema, // Pass the Zod schema directly
  validationMode: 'filter',
};

// Example CSV content:
// id,name,email
// 1,Alice,alice@example.com  (Valid)
// " 02 ",B,bob@invalid      (id will be coerced by Zod, but name 'B' fails min(2), and email is invalid)

// const usersCsv = CSV.fromString(
//   'id,name,email\n1,Alice,alice@example.com\n" 02 ",B,bob@invalid',
//   { schema: schemaConfig }
// );
// usersCsv.count() would be 1 (only Alice's record)
```

### Example: Column Validation with Zod

```typescript
import CSV, { CSVSchemaConfig, CSVReadOptions } from '@doeixd/csv-utils';
import { z } from 'zod';

interface Item { sku: string; quantity: number; }

const itemSchemaConfig: CSVSchemaConfig<Item> = {
  columnSchemas: {
    // Zod schemas are directly StandardSchemaV1 compliant
    sku: z.string().length(5).toUpperCase(), // Zod can transform (toUpperCase) during validation
    quantity: z.coerce.number().int().positive(),
  },
  validationMode: 'filter',
};

// Example CSV content:
// sku,quantity
// abcde,10          (sku becomes "ABCDE" via Zod's transform, quantity 10 is valid)
// SKU01,"5.5"       (quantity coerced by Zod to 5.5, then fails .int() validation)
// TOOLONG,5         (sku fails .length(5) validation)

// const readOpts: CSVReadOptions<Item> = { schema: itemSchemaConfig };
// const itemsCsv = CSV.fromString(csvString, readOpts);
// itemsCsv would contain: { sku: "ABCDE", quantity: 10 }
```

### Leveraging Coercion in Schema Libraries
Schema libraries like Zod, with features such as `z.coerce.*` (e.g., `z.coerce.number()`), can attempt to convert input values to the target type *during their validation process*. This is a powerful feature that can reduce the need for extensive pre-processing with CSV Utils' `customCasts`, especially if the schema's built-in coercion capabilities are sufficient for your data formats. The "Order of Operations" section below further clarifies how `customCasts` and schema coercion interact.

## Creating Custom `StandardSchemaV1` Objects (Advanced)

For highly specific validation logic not covered by existing Standard Schema compliant libraries, or if you prefer not to use them, you can manually implement the `StandardSchemaV1` interface.

```typescript
import { StandardSchemaV1 } from '@standard-schema/spec'; // Or from your library if re-exported

const customPositiveNumberSchema: StandardSchemaV1<unknown, number> = {
  '~standard': {
    version: 1,
    vendor: 'my-custom-validator/positiveNumber',
    types: { input: undefined as unknown, output: 0 as number },
    validate: (value: unknown): StandardSchemaV1.Result<number> => {
      const n = Number(value); // Input is unknown, attempt conversion
      // Ensure boolean 'true' (which is Number(true) === 1) is not treated as a valid positive number here if not desired
      if (typeof value === 'boolean' || isNaN(n) || n <= 0) {
        return { issues: [{ message: 'Must be a positive number' }] };
      }
      return { value: n }; // Return the coerced number
    },
  },
};
```

## Applying Schemas

### During CSV Reading
Provide the `CSVSchemaConfig` object in the `schema` property of `CSVReadOptions` when calling methods like `CSV.fromFile()`, `CSV.fromString()`, `CSV.fromFileAsync()`, or `CSV.fromStream()`.

```typescript
const readOptions: CSVReadOptions<MyType> = {
  customCasts: { columnCasts: { /* e.g., someField: 'number' */ } }, // customCasts run before schema
  schema: mySchemaConfig, // mySchemaConfig contains StandardSchemaV1 compliant schemas
  // ... other options ...
};
// const csvData = CSV.fromFile<MyType>('data.csv', readOptions);
```

### Using `csvInstance.validate()` or `csvInstance.validateAsync()`
Apply validation to an existing `CSV` instance. These methods return a *new* `CSV` instance with the validation results.

```typescript
const initialCsv = CSV.fromData<MyType>(someDataArray); // Data is already in object form

// Synchronous validation:
// Ensure schemas in mySyncSchemaConfig are synchronous,
// or if they are async, ensure useAsync:false is set to get the "async expected" issue.
const validatedCsv = initialCsv.validate(mySyncSchemaConfig);

// Asynchronous validation:
// const asyncValidatedCsv = await initialCsv.validateAsync({ ...mySchemaConfig, useAsync: true });
```
**Note:** When using `csvInstance.validate()` or `validateAsync()` directly on a `CSV` instance, the library's `customCasts` (defined in `CSVReadOptions`) are **not** re-applied as part of these validation methods. The data within the `CSV` instance is validated as-is. If type preparation is needed for the data already in the `CSV` instance before schema validation, that preparation must have occurred before, or your schemas themselves must handle coercion from the existing types.

## Working with Validation Results (`validationMode: 'keep'`)
When `validationMode: 'keep'`, `csvInstance.validationResults` (an array of `RowValidationResult<T>`) provides detailed outcomes for each original row.

### `RowValidationResult<T>` Interface
```typescript
interface RowValidationResult<T> {
  /** Row data AFTER customCasts but BEFORE schema validation/coercion by schemas. */
  originalRow: Record<string, any>;
  /**
   * Row data AFTER successful validation & schema coercion by schemas.
   * If validation failed, this may be partially transformed, contain original values for failed parts, or be undefined.
   */
  validatedRow?: T;
  /** Overall validity of the row. */
  valid: boolean;
  /** Issues from the schema in `rowSchema`. */
  rowIssues?: StandardSchemaV1.Issue[];
  /** Issues from schemas in `columnSchemas`, keyed by column name. */
  columnIssues?: Record<string, StandardSchemaV1.Issue[]>;
}

// StandardSchemaV1.Issue (from @standard-schema/spec or your library's re-export) typically includes:
// interface Issue {
//   message: string;
//   path?: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>;
//   // Specific libraries (like Zod when adapted) might add other properties like 'code'.
// }
```

### Example: Inspecting Issues
When `validationMode: 'keep'`, iterate through `usersResult.validationResults`:
```typescript
// ... (assuming usersResult from a CSV.fromFile call with validationMode: 'keep')
// usersResult.validationResults?.forEach((res, index) => {
//   if (!res.valid) {
//     console.log(`Row ${index + 1} (Original: ${JSON.stringify(res.originalRow)}) is INVALID:`);
//     if (res.columnIssues) {
//       Object.entries(res.columnIssues).forEach(([col, issues]) => {
//         issues.forEach(issue => console.log(`  - Column '${col}' on path '${issue.path?.join('.')}': ${issue.message}`));
//       });
//     }
//     if (res.rowIssues) {
//       res.rowIssues.forEach(issue => console.log(`  - Row Issue on path '${issue.path?.join('.')}': ${issue.message}`));
//     }
//   }
// });
```

## Order of Operations: `customCasts` vs. Schema Validation

Understanding this sequence is crucial for preparing your data correctly for validation:

1.  **Core CSV Parsing (`csv-parse`):**
    *   The raw CSV string is parsed into records and fields.
    *   `csv-parse` itself might perform basic, built-in type casting if its `cast` options (e.g., `csvOptions.cast: true`) are enabled. For example, it might convert a string `"123"` to the number `123`.

2.  **Header Mapping (`options.headerMap`):**
    *   Column names are transformed, and the structure of parsed objects is adjusted according to your mapping rules.

3.  **Custom Type Casting (`options.customCasts`):**
    *   This CSV Utils feature applies *after* `csv-parse` and `headerMap`.
    *   **Input to Casters:** Custom casters receive values that may have already been cast by `csv-parse`. If `csv-parse` didn't cast a value (e.g., `csvOptions.cast: false` or the value wasn't a simple number/boolean), the caster will likely receive a string.
    *   **Purpose:** `customCasts` are designed to handle specific string formats common in CSV files (e.g., "TRUE" to boolean `true`, "N/A" to `null`, "€5.50" to number `5.50`) and convert them into the fundamental JavaScript types your application logic and subsequent schemas expect.
    *   The data output from this step has had specific fields type-converted by your custom logic.

4.  **Schema Validation (`options.schema`):**
    *   This is the final data transformation and validation stage, operating on data processed by the preceding steps.
    *   **`columnSchemas` run first:** Each configured column schema receives the value for its respective column. This value is the result from step 3 (Custom Type Casting). The column schema validates this value and can perform its own further coercions or transformations.
    *   **`rowSchema` runs next:** It receives the entire row object. The properties of this object are the values that have potentially been transformed by `columnSchemas`. The `rowSchema` validates the overall object structure and any inter-field relationships.
    *   **Schema Coercion:** Standard Schema compliant libraries like Zod may perform their *own* type coercions as part of their `~standard.validate` step (e.g., Zod's `z.coerce.number()` can convert a string `"123"` to the number `123`).

**Interaction Example:**

Consider a CSV with an `amount` column containing `"€1,234.50"`.

1.  **`csv-parse` (assume `cast:false`):** Output is the string `"€1,234.50"`.
2.  **`headerMap`:** (Assume 'AmountFromCSV' maps to 'transactionAmount'). The value is still `"€1,234.50"`.
3.  **`customCasts` for `transactionAmount`:**
    *   A custom caster tests for "€" and ",".
    *   It parses by removing "€", replacing "," with "", and converts to the `number` `1234.50`.
4.  **Schema Validation (`columnSchemas.transactionAmount` using Zod: `z.number().positive().max(10000)`):**
    *   The Zod schema receives the `number` `1234.50` from `customCasts`.
    *   It validates that this is a positive number and within the defined maximum.

If `customCasts` were not used for `transactionAmount`, and the Zod schema was `z.coerce.number().positive()...`, Zod would attempt to coerce `"€1,234.50"` directly. This might fail (resulting in `NaN`) if Zod's default coercion doesn't handle currency symbols or thousand separators, leading to a validation failure unless the schema is specifically designed to parse such complex strings.

**Key Principle:** Use `customCasts` to transform raw CSV string representations into clean, fundamental JavaScript types (string, number, boolean, Date, null). Then, use schema validation for structural validation, business rule enforcement, and more fine-grained type checking or coercion on these already-prepared types. Schema libraries (like Zod) can also perform significant coercion, potentially reducing the need for some `customCasts` if their coercion capabilities match your input formats.

## Common Validation Scenarios & Best Practices

*   **Data Preparation is Key:** Ensure data is in the expected basic JavaScript type *before* it reaches a strict schema validator. Use `customCasts` for CSV-specific string cleaning and initial type conversion. Leverage schema library coercion (like Zod's `z.coerce.*`) for more standard conversions if the input to the schema is suitable for it.
*   **Specificity:** Use `columnSchemas` for early, atomic validation and coercion of individual fields. Use `rowSchema` for validating the overall record structure and cross-field dependencies.
*   **Optional Fields:** Define optionality within your schema definitions using features from your chosen schema library (e.g., Zod's `.optional()`, `.nullable()`).
*   **Performance:** Complex validation rules (especially regex on large strings or asynchronous checks) add processing time. For performance-critical applications with very large datasets, validate selectively and prefer synchronous rules where possible. Stream-based validation with `CSVStreamProcessor.validate()` is available for memory efficiency.

## Troubleshooting Validation

*   **"Expected `typeA`, received `typeB`" (Common error from schema libraries like Zod):**
    *   **Cause:** The data reaching the schema validator was not the JavaScript type it expected.
    *   **Solution:**
        1.  Carefully review the "Order of Operations" section.
        2.  Check if your `customCasts` are correctly converting CSV string values into the basic JavaScript types that your schema anticipates. For example, if your schema expects a `number`, a custom cast should convert strings like `"123.45"` or `"-$50"` into actual numbers.
        3.  Consider if your schema library's own coercion features (e.g., Zod's `z.coerce.number()`) can appropriately handle the type of data it's receiving *after* `customCasts` have run. If `customCasts` produced a clean string like `"100"`, `z.coerce.number()` can turn it into `100`. But if `customCasts` resulted in `NaN` from an unparseable string, `z.coerce.number()` will also likely yield `NaN`, which might then fail further schema rules (like `.positive()`).
*   **Rows Filtered Unexpectedly (`validationMode: 'filter'`):**
    *   **Solution:** Temporarily switch to `validationMode: 'keep'` and inspect the `csvInstance.validationResults` property. This will show you which schema (column or row) and which specific rule caused each row to fail validation.
*   **Asynchronous Schema Issues with Synchronous CSV Methods:**
    *   **Cause:** A schema with an `async validate` function is used with a synchronous method (e.g., `CSV.fromFile()`) and `useAsync: true` was not set in the `CSVSchemaConfig`.
    *   **Solution:** Ensure `useAsync: true` is set in your `CSVSchemaConfig` when using async schemas with synchronous CSV methods. Alternatively, and often preferably, use asynchronous CSV methods like `CSV.fromFileAsync()` or `csvInstance.validateAsync()`, which are designed to handle async schemas correctly.
*   **Pinpointing Validation Failures:** When using `validationMode: 'keep'`, always check `res.valid`. If `false`, examine both `res.columnIssues` (for failures in individual `columnSchemas`) and `res.rowIssues` (for failures in the `rowSchema`). The `path` property within `StandardSchemaV1.Issue` objects helps locate the specific data field that caused the error.
