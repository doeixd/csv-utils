# Data Validation in CSV Utils

CSV Utils provides robust mechanisms for validating your CSV data to ensure its integrity and conformity to expected structures and types. Validation can be performed against individual columns or entire rows, using either the library's `StandardSchemaV1` interface or popular validation libraries like Zod.

## Table of Contents

-   [Why Validate CSV Data?](#why-validate-csv-data)
-   [Core Validation Concepts](#core-validation-concepts)
    -   [`CSVSchemaConfig<T>`](#csvschemaconfigt-options)
    -   [Validation Modes](#validation-modes)
    -   [Synchronous vs. Asynchronous Validation](#synchronous-vs-asynchronous-validation)
-   [Using `StandardSchemaV1`](#using-standardschemav1)
    -   [Defining a `StandardSchemaV1` Object](#defining-a-standardschemav1-object)
    -   [Example: Custom Column Validation](#example-custom-column-validation)
-   [Using Zod for Validation](#using-zod-for-validation)
    -   [Installation](#installation)
    -   [Example: Row Validation with Zod](#example-row-validation-with-zod)
    -   [Example: Column Validation with Zod](#example-column-validation-with-zod)
    -   [Coercion with Zod](#coercion-with-zod)
-   [Applying Schemas](#applying-schemas)
    -   [During CSV Reading (`CSV.fromFile`, `CSV.fromString`, etc.)](#during-csv-reading)
    *   [Using `csvInstance.validate()` or `csvInstance.validateAsync()`](#using-csvinstancevalidate-or-csvinstancevalidateasync)
-   [Working with Validation Results (`validationMode: 'keep'`)](#working-with-validation-results-validationmode-keep)
    -   [`RowValidationResult<T>`](#rowvalidationresultt-interface)
    -   [Example: Inspecting Issues](#example-inspecting-issues)
-   [Common Scenarios and Best Practices](#common-scenarios-and-best-practices)
    -   [Order of Operations: Casting vs. Validation](#order-of-operations-casting-vs-validation)
    -   [Validating Numeric Ranges or String Patterns](#validating-numeric-ranges-or-string-patterns)
    -   [Handling Optional Fields](#handling-optional-fields)
    -   [Combining Column and Row Validations](#combining-column-and-row-validations)
    -   [Performance Considerations](#performance-considerations)
-   [Troubleshooting Validation](#troubleshooting-validation)

## Why Validate CSV Data?

Real-world CSV files can be messy. Validation helps you:

*   **Ensure Data Quality:** Catch errors, inconsistencies, and unexpected formats early.
*   **Maintain Type Safety:** Confirm that data can be correctly processed by your application logic.
*   **Prevent Downstream Errors:** Avoid issues in later stages of data processing or storage.
*   **Enforce Business Rules:** Ensure data adheres to specific constraints (e.g., valid product SKUs, positive quantities).

## Core Validation Concepts

### `CSVSchemaConfig<T>` (Options)

This is the primary configuration object you provide to enable validation.

```typescript
interface CSVSchemaConfig<T> {
  // Schema applied to each entire row object (e.g., a Zod schema or StandardSchemaV1).
  // This runs AFTER columnSchemas.
  rowSchema?: StandardSchemaV1<any, T> | ZodSchema<T>;

  // Schemas applied to individual column values *before* rowSchema validation.
  // Keys are property names of T (after header mapping and custom casting).
  columnSchemas?: {
    [K in keyof Partial<T>]?: StandardSchemaV1<any, T[K]> | ZodSchema<T[K]>
  } | {
    // Or, if column names are not known at compile time or are dynamic
    [columnName: string]: StandardSchemaV1<any, any> | ZodSchema<any>;
  };

  // How to handle rows that fail validation.
  validationMode?: 'error' | 'filter' | 'keep'; // Default: 'error'

  // Set to true if any of your schema validation logic is asynchronous.
  // This is automatically handled by async CSV methods (e.g., fromFileAsync).
  // For sync methods (e.g. fromFile), if a schema is async and useAsync is not true,
  // an error will be thrown or async validation might be skipped.
  useAsync?: boolean;
}
```

### Validation Modes

Determines what happens when a row (or column within a row) fails validation:

*   **`'error'` (Default):** The CSV processing operation (e.g., `CSV.fromFile`) immediately throws a `CSVError` upon encountering the first invalid row.
*   **`'filter'`:** Invalid rows are silently removed from the dataset. Only valid rows are included in the resulting `CSV` instance.
*   **`'keep'`:** All rows are kept, regardless of their validity. The validation status and any issues for each row are stored in `csvInstance.validationResults`. This mode is useful for inspecting errors or implementing custom error handling.

### Synchronous vs. Asynchronous Validation

*   **Synchronous:** Most basic validation logic (e.g., checking string length, number range) is synchronous.
*   **Asynchronous:** Some validation might require async operations (e.g., checking if a user ID exists in a database via an API call).
    *   If your schemas involve `async` logic (like Zod's `.refine(async ...)`), you **must** set `useAsync: true` in your `CSVSchemaConfig` when using synchronous CSV methods like `CSV.fromFile()`.
    *   Alternatively, use asynchronous CSV methods like `CSV.fromFileAsync()` or `csvInstance.validateAsync()`, which handle `useAsync: true` by default if a schema is provided.

## Using `StandardSchemaV1`

The library directly supports a basic schema interface called `StandardSchemaV1`. This is useful for defining simple, self-contained validation rules without external dependencies.

### Defining a `StandardSchemaV1` Object

A `StandardSchemaV1` object has a specific structure:

```typescript
import { StandardSchemaV1 } from '@doeixd/csv-utils';

// Example: Schema to ensure a string is a valid, non-empty email.
const nonEmptyEmailSchema: StandardSchemaV1<string, string> = {
  '~standard': { // This key is mandatory
    version: 1,
    vendor: 'my-app-validations', // Your identifier
    types: {
      input: '' as string,  // Type hint for input (value from CSV after casting)
      output: '' as string, // Type hint for output (value after validation, possibly coerced)
    },
    validate: (value: unknown): StandardSchemaV1.Result<string> => {
      if (typeof value !== 'string') {
        return { issues: [{ message: 'Must be a string.' }] };
      }
      if (value.trim() === '') {
        return { issues: [{ message: 'Email cannot be empty.' }] };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return { issues: [{ message: 'Invalid email format.' }] };
      }
      // If valid, return the value (can be transformed/coerced here)
      return { value: value.toLowerCase() }; // Example: coerce to lowercase
    },
  },
};
```
*   `validate` function:
    *   Receives the value to validate.
    *   Returns an object:
        *   If valid: `{ value: validatedAndPossiblyCoercedValue }`
        *   If invalid: `{ issues: [{ message: string, path?: (string|number)[], code?: string }, ...] }`

### Example: Custom Column Validation

Let's validate that a `productId` column starts with "SKU-" and an `age` column is a positive number.

```typescript
import CSV, { CSVReadOptions, CSVSchemaConfig, StandardSchemaV1 } from '@doeixd/csv-utils';

interface Product {
  productId: string;
  productName: string;
  quantity: number; // Assume this is already number after customCasts
}

const skuSchema: StandardSchemaV1<string, string> = {
  '~standard': { /* ... version, vendor, types ... */
    types: { input: '', output: '' },
    validate: (value: unknown) => {
      if (typeof value !== 'string' || !value.startsWith('SKU-')) {
        return { issues: [{ message: 'Product ID must start with "SKU-".' }] };
      }
      return { value };
    },
  }
};

// Schema for quantity (assuming it's already a number from customCasts)
const positiveNumberSchema: StandardSchemaV1<number, number> = {
  '~standard': { /* ... version, vendor, types ... */
    types: { input: 0, output: 0 },
    validate: (value: unknown) => {
      if (typeof value !== 'number' || value <= 0) {
        return { issues: [{ message: 'Must be a positive number.' }] };
      }
      return { value };
    },
  }
};

const productSchemaConfig: CSVSchemaConfig<Product> = {
  columnSchemas: {
    productId: skuSchema,
    quantity: positiveNumberSchema,
  },
  validationMode: 'filter', // Filter out rows with invalid productId or quantity
};

// CSV data:
// productId,productName,quantity
// SKU-123,Apple,10
// INV-456,Banana,5      <-- Invalid productId
// SKU-789,Orange,-2     <-- Invalid quantity

const csvReadOptions: CSVReadOptions<Product> = {
  // Assume customCasts handle 'quantity' string to number conversion
  customCasts: { columnCasts: { quantity: 'number' } },
  schema: productSchemaConfig,
};

// const products = CSV.fromFile<Product>('products_with_errors.csv', csvReadOptions);
// `products` will only contain the 'Apple' row.
```

## Using Zod for Validation

[Zod](https://zod.dev/) is a popular TypeScript-first schema declaration and validation library. CSV Utils seamlessly integrates with Zod schemas.

### Installation

If you haven't already, install Zod:
`npm install zod` or `yarn add zod`

### Example: Row Validation with Zod

Validate the entire row object after initial parsing, header mapping, and custom casting.

```typescript
import CSV, { CSVSchemaConfig, CSVReadOptions } from '@doeixd/csv-utils';
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string().min(1, "ID cannot be empty"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
  age: z.coerce.number().positive("Age must be a positive number").optional(),
  // .coerce.number() attempts to convert string to number before validation
});
type User = z.infer<typeof UserSchema>;

const schemaConfig: CSVSchemaConfig<User> = {
  rowSchema: UserSchema,
  validationMode: 'keep', // Keep invalid rows to inspect them
};

// CSV: id,name,email,age
//      1,Alice,alice@example.com,30
//      ,Bo,bob@invalid,twenty   <-- empty id, short name, invalid email, non-numeric age
//      3,Carol,carol@example,   <-- invalid email, age is fine (optional)

const readOpts: CSVReadOptions<User> = {
  // No customCasts for 'age' needed here because z.coerce.number() handles it.
  // If 'age' was 'N/A' or similar, customCasts might still be useful before Zod.
  schema: schemaConfig,
};

// const usersCsv = CSV.fromFile<User>('users_for_zod.csv', readOpts);
// Check usersCsv.validationResults for details on the second row's failures.
```

### Example: Column Validation with Zod

Validate individual columns *before* the `rowSchema` is applied. This can be useful for early exits or specific column transformations/coercions.

```typescript
import CSV, { CSVSchemaConfig } from '@doeixd/csv-utils';
import { z } from 'zod';

interface Item {
  sku: string;       // Must be uppercase, 5 chars
  quantity: number;  // Must be integer > 0
  description: string;
}

const itemSchemaConfig: CSVSchemaConfig<Item> = {
  columnSchemas: {
    sku: z.string().length(5).toUpperCase().regex(/^[A-Z0-9]+$/, "SKU must be alphanumeric"),
    quantity: z.coerce.number().int().positive(), // Coerce then validate
  },
  // Optional: A rowSchema could be added here for cross-field validation
  // rowSchema: z.object({ /* ... */ }).superRefine(...),
  validationMode: 'filter',
};

// CSV: sku,quantity,description
//      abcde,10,Valid Item          <-- sku will be uppercased by Zod
//      SKU01,5.5,Item with float qty <-- quantity fails .int()
//      TOOLONG,5,Bad SKU            <-- sku fails .length(5)

// const itemsCsv = CSV.fromFile<Item>('items_column_zod.csv', { schema: itemSchemaConfig });
// `itemsCsv` will only contain the (transformed) first item.
```

### Coercion with Zod

Zod's `z.coerce` (e.g., `z.coerce.number()`, `z.coerce.date()`) is very powerful. It attempts to convert the input value to the target type before applying further validations. This can often reduce the need for extensive `customCasts` if Zod's coercion meets your needs.

*   **Order:** `customCasts` run *before* schema validation. If a custom cast prepares a value (e.g., string to number), Zod then validates that number. If Zod coerces, it does so on the value it receives (which might have already been through `customCasts`).

## Applying Schemas

You can apply schema validation in two main ways:

### During CSV Reading

Pass the `CSVSchemaConfig` object in the `schema` property of `CSVReadOptions` when calling methods like `CSV.fromFile`, `CSV.fromString`, `CSV.fromFileAsync`, or `CSV.fromStream`.

```typescript
const readOptions: CSVReadOptions<MyType> = {
  // ... other options like headerMap, customCasts ...
  schema: mySchemaConfig,
};
const csvData = CSV.fromFile<MyType>('data.csv', readOptions);
```

### Using `csvInstance.validate()` or `csvInstance.validateAsync()`

Apply validation to an existing `CSV` instance. This returns a *new* `CSV` instance.

```typescript
const initialCsv = CSV.fromData<MyType>(someData);

// Synchronous validation (throws if schema is async and useAsync:false not set)
try {
  const validatedCsv = initialCsv.validate(mySchemaConfig);
  // Work with validatedCsv
} catch (e) {
  console.error("Validation failed:", e);
}

// Asynchronous validation
async function processData() {
  try {
    const asyncValidatedCsv = await initialCsv.validateAsync({
      ...mySchemaConfig,
      useAsync: true, // Ensure async is enabled if schema needs it
    });
    // Work with asyncValidatedCsv
  } catch (e) {
    console.error("Async validation failed:", e);
  }
}
```

## Working with Validation Results (`validationMode: 'keep'`)

When `validationMode: 'keep'` is used, the `CSV` instance will have a `validationResults` property. This is an array of `RowValidationResult<T>` objects, one for each original row.

### `RowValidationResult<T>` Interface

```typescript
interface RowValidationResult<T> {
  originalRow: Record<string, any>; // The row data BEFORE validation/coercion by schema
  validatedRow?: T;                 // The row data AFTER successful validation and schema coercion.
                                    // Undefined if the row was invalid.
  valid: boolean;                   // Overall validity of the row.
  rowIssues?: StandardSchemaV1.Issue[];       // Issues from `rowSchema` validation.
  columnIssues?: Record<string, StandardSchemaV1.Issue[]>; // Issues from `columnSchemas`, keyed by column name.
}

interface StandardSchemaV1.Issue {
  message: string;
  path?: (string | number)[]; // Path to the invalid property (e.g., ['address', 'zipCode'])
  code?: string;              // Specific error code (Zod provides these)
}
```

### Example: Inspecting Issues

```typescript
import CSV, { CSVSchemaConfig } from '@doeixd/csv-utils';
import { z } from 'zod';
// ... (User and UserSchema defined as in Zod example above) ...

const schemaConfigKeep: CSVSchemaConfig<User> = {
  rowSchema: UserSchema,
  validationMode: 'keep', // Important!
};

// Assuming 'users_for_zod.csv' with invalid data
const usersResult = CSV.fromFile<User>('users_for_zod.csv', { schema: schemaConfigKeep });

if (usersResult.validationResults) {
  console.log(`Processed ${usersResult.count()} rows. Validation results available.`);
  usersResult.validationResults.forEach((res, index) => {
    if (!res.valid) {
      console.log(`\nRow ${index + 1} (Original: ${JSON.stringify(res.originalRow)}) is INVALID:`);
      if (res.rowIssues) {
        console.log('  Row-level issues:');
        res.rowIssues.forEach(issue => console.log(`    - ${issue.path?.join('.') || 'row'}: ${issue.message} (Code: ${issue.code || 'N/A'})`));
      }
      if (res.columnIssues) {
        console.log('  Column-level issues:');
        Object.entries(res.columnIssues).forEach(([col, issues]) => {
          issues.forEach(issue => console.log(`    - Column '${col}': ${issue.message} (Code: ${issue.code || 'N/A'})`));
        });
      }
    } else {
      // console.log(`\nRow ${index + 1} is VALID. Validated: ${JSON.stringify(res.validatedRow)}`);
    }
  });
}
```

## Common Scenarios and Best Practices

### Order of Operations: Casting vs. Validation

1.  **Core CSV Parsing (`csv-parse`):** Initial parsing, potential built-in casting by `csv-parse`.
2.  **Header Mapping:** Column names/structure transformed.
3.  **Custom Type Casting (`customCasts`):** Your specific string-to-type logic is applied.
4.  **Schema Validation (`schema`):** Zod or `StandardSchemaV1` rules are checked against the data that has already been through custom casting.
    *   **Implication:** If your schema expects a `number` (e.g., `z.number().positive()`), ensure that the value is already a number (or can be coerced by Zod using `z.coerce.number()`) by the time schema validation runs. Use `customCasts` if `csv-parse` or Zod's coercion isn't sufficient for your input string formats.

### Validating Numeric Ranges or String Patterns

*   **Zod:** Use `.min()`, `.max()`, `.gte()`, `.lte()` for numbers; `.regex()`, `.startsWith()`, `.endsWith()` for strings.
*   **`StandardSchemaV1`:** Implement the logic within your `validate` function.

```typescript
// Zod example for a rating between 1 and 5
const ratingSchema = z.coerce.number().int().min(1, "Rating too low").max(5, "Rating too high");

// StandardSchemaV1 example
const ratingStandardSchema: StandardSchemaV1<number, number> = {
  '~standard': { /* ... */
    types: { input: 0, output: 0 },
    validate: (v: unknown) => {
      const n = Number(v); // Assuming v might still be string/unknown here
      if (isNaN(n) || !Number.isInteger(n) || n < 1 || n > 5) {
        return { issues: [{ message: "Rating must be an integer between 1 and 5." }] };
      }
      return { value: n };
    }
  }
};
```

### Handling Optional Fields

*   **Zod:** Use `.optional()` or `.nullable()` on a schema definition.
    *   `z.string().optional()`: The field can be `undefined` or a string.
    *   `z.string().nullable()`: The field can be `null` or a string.
    *   `z.string().optional().nullable()`: Can be string, `null`, or `undefined`.
*   **`StandardSchemaV1`:** Your `validate` function should explicitly allow `null` or `undefined` if the field is optional and not return an issue for those cases.

### Combining Column and Row Validations

*   **`columnSchemas`** are good for:
    *   Type checking and coercion for individual fields early.
    *   Format validation specific to a single column (e.g., SKU format).
*   **`rowSchema`** is good for:
    *   Validating the overall structure of the row object.
    *   Cross-field validation (e.g., `endDate` must be after `startDate`).
    *   Applying complex business rules to the entire record.

Data flows through `columnSchemas` first, then the (potentially transformed by column schemas) row is passed to `rowSchema`.

### Performance Considerations

*   Validation, especially complex regex or asynchronous checks, adds overhead.
*   For very large files and performance-critical applications:
    *   Validate only necessary fields.
    *   Prefer simpler, synchronous validation rules if possible.
    *   If using `validationMode: 'keep'`, processing `validationResults` for millions of rows can be memory-intensive. Consider streaming approaches (`CSVStreamProcessor`) if error reporting on huge datasets is needed without loading all results.
    *   `CSVStreamProcessor` also supports a `.validate()` step for stream-based validation.

## Troubleshooting Validation

*   **"Expected number, received string":** This common Zod error means a field Zod expected to be a number was still a string.
    *   **Solution:** Ensure `customCasts` converts the string to a number *before* Zod validation, OR use `z.coerce.number()` in your Zod schema. Check the order of operations.
*   **Unexpected `validationMode: 'filter'` behavior:** If rows are disappearing when you don't expect, use `validationMode: 'keep'` temporarily and inspect `validationResults` to see *why* they are being filtered.
*   **Async validation not working with sync methods:** If you have async logic in your schemas (e.g., Zod's `async .refine()`), you *must* use `validateAsync()` or an async CSV creation method (like `fromFileAsync()`) and ensure `CSVSchemaConfig.useAsync: true` is set (or automatically inferred by async methods).
*   **Issues from `columnSchemas` vs. `rowSchema`:** If `validationMode: 'keep'`, check both `res.columnIssues` and `res.rowIssues` to pinpoint the source of the validation failure.

By using these validation features thoughtfully, you can significantly improve the reliability and robustness of your CSV data processing workflows.
