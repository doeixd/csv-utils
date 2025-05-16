# CSV Utils

[![npm version](https://img.shields.io/npm/v/@doeixd/csv-utils.svg)](https://www.npmjs.com/package/@doeixd/csv-utils)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A production-ready TypeScript library for CSV manipulation, featuring robust error handling, strong typing, and a fluent interface. This library provides comprehensive utilities for parsing, transforming, analyzing, and writing CSV data / arrays of objects, with support for operations like header mapping, streaming for large files, schema validation, and async processing.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Default Options](#default-options)
- [Examples](#examples)
  - [Basic Operations](#basic-operations)
  - [Custom Type Casting](#custom-type-casting)
  - [Header Mapping](#header-mapping)
    - [Basic Mapping](#basic-mapping)
    - [Reading and Writing with Header Mapping](#reading-and-writing-with-header-mapping)
    - [Array Mapping](#array-mapping)
      - [Mapping Multiple Columns to an Array](#mapping-multiple-columns-to-an-array)
      - [Explicit Column List for Array Mapping](#explicit-column-list-for-array-mapping)
      - [Mapping an Array to Multiple Columns](#mapping-an-array-to-multiple-columns)
  - [Preamble Handling](#preamble-handling)
  - [Schema Validation](#schema-validation)
    - [Using Standard Schema](#using-standard-schema)
    - [Using Zod for Schema Validation](#using-zod-for-schema-validation)
    - [Working with Validation Results](#working-with-validation-results)
  - [Array Transformations](#array-transformations)
  - [Async Processing](#async-processing)
    - [Async File Operations](#async-file-operations)
    - [Async Iteration and Batching](#async-iteration-and-batching)
    - [Async Generators for Large Files](#async-generators-for-large-files)
  - [Error Handling and Retries](#error-handling-and-retries)
  - [Data Analysis and Transformation](#data-analysis-and-transformation)
    - [Merging Datasets](#merging-datasets)
    - [Simple Data Analysis](#simple-data-analysis)
    - [Advanced Transformations (Join, Unpivot, etc.)](#advanced-transformations-join-unpivot-etc)
- [Standalone Functions](#standalone-functions-module)
  - [Quick Start with Standalone Functions](#quick-start-with-standalone-functions)
  - [Functional Composition](#functional-composition)
- [API Documentation](#api-documentation)
  - [Core Class: CSV](#core-class-csv)
    - [Static Methods](#static-methods)
    - [Instance Methods](#instance-methods)
  - [Utility Objects](#utility-objects)
    - [CSVUtils](#csvutils)
    - [CSVArrayUtils](#csvarrayutils)
  - [Generator Functions](#generator-functions)
  - [Key Types and Interfaces](#key-types-and-interfaces)
    - [CSVError](#csverror)
    - [Options Interfaces](#options-interfaces)
    - [Casting Related Types](#casting-related-types)
    - [Schema Related Types](#schema-related-types)
    - [Other Types](#other-types)
- [Memory-Efficient Stream Processing with `CSVStreamProcessor`](#memory-efficient-stream-processing-with-csvstreamprocessor)
  - [Creating a Stream Processor](#creating-a-stream-processor)
  - [Fluent Stream Transformations](#fluent-stream-transformations)
  - [Executing the Stream Pipeline](#executing-the-stream-pipeline)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Features

- **🔒 Type Safety** - Comprehensive TypeScript support with generic types for robust data handling.
- **🧩 Flexible Header Mapping** - Sophisticated transformation between flat CSV columns and nested object structures, including mapping to/from array properties.
- **📊 Rich Data Operations** - Extensive methods for querying, filtering, updating, sorting, grouping, and aggregating data.
- **📈 Advanced Transformations** - Powerful tools for data conversion, including `join`, `pivot`, `unpivot`, `addColumn`, `castColumnType`, and more.
- **⚡ Async & Parallel Processing** - Efficiently handle large files with asynchronous operations, stream processing, and worker thread support for CPU-intensive tasks.
- **🛡️ Robust Error Handling** - Custom `CSVError` class and configurable retry mechanisms for I/O operations.
- **📝 Extensive Preamble Support** - Read, store, and write CSV preambles (additional header lines/comments).
- **🚀 Fluent Interface (Builder Pattern)** - Chain methods for elegant and readable data manipulation pipelines.
- **🧠 Smart Custom Type Casting** - Define custom logic to test and parse string values into specific types (numbers, dates, booleans, custom objects) on a global or per-column basis.
- **🔄 High-Performance Streaming API** - `CSVStreamProcessor` for processing massive CSV files with minimal memory footprint, featuring a fluent API.
- **🔍 Schema Validation** - Integrated support for data validation against `StandardSchemaV1` (compatible with Zod and other validation libraries), with modes for erroring, filtering, or keeping invalid data.
- **⚖️ Memory Efficiency** - Stream processing utilizes a fixed-size circular buffer with automatic backpressure to manage memory usage effectively for very large datasets.
- **📦 Batch Processing** - Optimized methods for processing data in configurable batches for improved throughput in async operations.
- **📦 Standalone Functions** - Alternative functional programming style for all core operations.

## Installation

```bash
npm install @doeixd/csv-utils
# or
yarn add @doeixd/csv-utils
# or
pnpm add @doeixd/csv-utils
```

## Quick Start

```typescript
import CSV, { CSVUtils } from '@doeixd/csv-utils';

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  inventory?: number;
  currency?: string;
}

// Read from a CSV file (assuming price is numeric in CSV or cast later)
const products = CSV.fromFile<Product>('products.csv');

// Chain operations
const result = products
  .findRowsWhere(p => p.price > 100)     // Find expensive products
  .update({ currency: 'USD' })           // Add currency field
  .updateColumn('price', p => p * 0.9)   // Apply 10% discount
  .sortBy('price', 'desc')               // Sort by price (high to low)
  .removeWhere(p => (p.inventory ?? 0) < 5) // Remove low inventory items
  .toArray();                            // Get the results as an array

// Write back to file
CSVUtils.writeCSV('discounted_products.csv', result);

// Alternatively, write using the CSV instance
// CSV.fromData(result).writeToFile('discounted_products.csv');
```

## Default Options

By default, all CSV reading methods (`fromString`, `fromFile`, and `fromStream`) set the following options for the underlying `csv-parse` library if not otherwise specified:

- `columns: true` - CSV data is parsed into objects with column headers as keys. This is essential for most object-based operations in the library.

You can override these defaults by providing your own options in the `csvOptions` property:

```typescript
// Override the default columns setting
const rawData = CSV.fromString(csvContent, {
  csvOptions: { columns: false, delimiter: ';' } // Results in arrays of strings
});

// Use all the defaults (columns: true is applied automatically)
const data = CSV.fromFile('data.csv');
```

## Examples

### Basic Operations

```typescript
import CSV from '@doeixd/csv-utils';

interface User { id: string; name: string; role: string; department?: string; accessLevel?: string; }

// Create from data
const users = CSV.fromData<User>([
  { id: '1', name: 'Alice', role: 'admin' },
  { id: '2', name: 'Bob', role: 'user' },
  { id: '3', name: 'Charlie', role: 'user' }
]);

// Query operations
const admin = users.findRow('1', 'id');
const allUsers = users.findRowsWhere(user => user.role === 'user');

// Transformation
const withDepartment = users.update({ department: 'IT' });
const updatedUsers = users.updateWhere(
  user => user.role === 'admin',
  { accessLevel: 'full' }
);

// Output as CSV string (by default, includes headers)
const csvString = users.toString();
// console.log(csvString);
// id,name,role
// 1,Alice,admin
// 2,Bob,user
// 3,Charlie,user

// Write to file
users.writeToFile('users.csv');
```

### Custom Type Casting

Apply sophisticated type conversions beyond basic CSV parsing.

```typescript
import CSV, { Caster, CSVReadOptions } from '@doeixd/csv-utils';

interface Order {
  order_id: string;
  discount_code: string | null; // Can be 'N/A' or empty
  tax_rate: number;          // e.g., '7.5%' -> 0.075
  created_at: Date;          // e.g., '12/25/2023' -> Date object
  price: number;             // e.g., '$19.99' or '19.99'
}

// Custom caster for percentages (e.g., '7.5%' -> 0.075)
const percentageCaster: Caster<number> = {
  test: (value) => typeof value === 'string' && value.endsWith('%'),
  parse: (value) => parseFloat(value.replace('%', '')) / 100,
};

// Custom caster for dates (e.g., 'MM/DD/YYYY')
const dateCaster: Caster<Date> = {
  test: (value) => typeof value === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value),
  parse: (value) => {
    const [month, day, year] = value.split('/').map(Number);
    return new Date(year, month - 1, day); // Month is 0-indexed
  },
};

// Custom caster for potentially null string values
const nullableStringCaster: Caster<string | null> = {
    test: (value) => typeof value === 'string' && (value.toUpperCase() === 'N/A' || value.trim() === ''),
    parse: () => null,
};

const readOptions: CSVReadOptions<Order> = {
  customCasts: {
    definitions: { // Globally available casters by key
      number: {
        test: (value) => typeof value === 'string' && !isNaN(parseFloat(value.replace(/[^0-9.-]+/g, ""))),
        parse: (value) => parseFloat(value.replace(/[^0-9.-]+/g, "")),
      },
      date: dateCaster, // Use our custom dateCaster
      nullableString: nullableStringCaster,
    },
    columnCasts: { // Column-specific rules
      order_id: 'string', // Use built-in string caster (or keep as is if already string)
      discount_code: ['nullableString'], // Try nullableString caster first
      tax_rate: [percentageCaster, 'number'], // Try percentage, then general number
      created_at: 'date',
      price: [ // Try multiple specific casters for price
        { // Caster for '$XX.YY' format
          test: (v) => typeof v === 'string' && v.startsWith('$'),
          parse: (v) => parseFloat(v.substring(1)),
        },
        'number', // Fallback to general number caster
      ],
    },
    onCastError: 'error', // 'error' (default), 'null', or 'original'
  },
};

// Assuming 'orders.csv' contains:
// order_id,discount_code,tax_rate,created_at,price
// ORD001,NA,7.5%,12/25/2023,$19.99
// ORD002,,5%,01/15/2024,25
const orders = CSV.fromFile<Order>('orders.csv', readOptions);

const firstOrder = orders.toArray()[0];
console.log(firstOrder.tax_rate); // 0.075
console.log(firstOrder.created_at instanceof Date); // true
console.log(firstOrder.price); // 19.99
console.log(firstOrder.discount_code); // null
```

### Header Mapping

Transform CSV column names to/from nested object properties.

#### Basic Mapping

```typescript
import { createHeaderMapFns, HeaderMap } from '@doeixd/csv-utils';

interface User {
  id: string;
  profile: { firstName: string; lastName: string; };
  contact: { email: string; };
}

// Define a mapping: CSV header -> object path
const headerMap: HeaderMap<User> = {
  'user_id': 'id',
  'first_name': 'profile.firstName',
  'last_name': 'profile.lastName',
  'email_address': 'contact.email',
};

// Create mapping functions
const { fromRowArr, toRowArr } = createHeaderMapFns<User>(headerMap);

// Convert CSV row (object) to structured object
const csvRow = {
  user_id: '123',
  first_name: 'John',
  last_name: 'Doe',
  email_address: 'john@example.com',
};
const userObject = fromRowArr(csvRow);
console.log(userObject.profile.firstName); // John

// Convert structured object back to a flat array for CSV writing
const csvHeaders = ['user_id', 'first_name', 'last_name', 'email_address'];
const flatArray = toRowArr(userObject, csvHeaders);
console.log(flatArray); // ['123', 'John', 'Doe', 'john@example.com']
```

#### Reading and Writing with Header Mapping

```typescript
import CSV, { HeaderMap } from '@doeixd/csv-utils';

interface User {
  id: string;
  profile: { firstName: string; lastName: string; };
}

// --- READING (flat CSV columns -> nested object properties) ---
const inputHeaderMap: HeaderMap<User> = {
  'USER_IDENTIFIER': 'id',
  'GIVEN_NAME': 'profile.firstName',
  'FAMILY_NAME': 'profile.lastName',
};
// Assumes users_input.csv has columns: USER_IDENTIFIER,GIVEN_NAME,FAMILY_NAME
const users = CSV.fromFile<User>('users_input.csv', { headerMap: inputHeaderMap });
console.log(users.toArray()[0].profile.firstName);

// --- WRITING (nested object properties -> flat CSV columns) ---
const outputHeaderMap: HeaderMap<User> = {
  'id': 'UserID', // map 'id' property to 'UserID' CSV column
  'profile.firstName': 'FirstName',
  'profile.lastName': 'LastName',
};
users.writeToFile('users_output.csv', {
  headerMap: outputHeaderMap,
  stringifyOptions: { header: true } // Ensure specified headers are written
});
// users_output.csv will have columns: UserID,FirstName,LastName
```

#### Array Mapping

Map multiple CSV columns to/from an array property in your objects.

##### Mapping Multiple Columns to an Array

```typescript
import CSV, { HeaderMap, CsvToArrayConfig } from '@doeixd/csv-utils';

interface Product {
  id: string;
  name: string;
  imageUrls: string[];
}

// CSV columns 'image_1', 'image_2', ... map to 'imageUrls' array
const productHeaderMap: HeaderMap<Product> = {
  'product_sku': 'id',
  'product_name': 'name',
  // This special key (e.g., '_imageMapping') is a config, not a CSV column.
  '_imageMappingConfig': {
    _type: 'csvToTargetArray',
    targetPath: 'imageUrls', // Property in Product interface
    sourceCsvColumnPattern: /^image_url_(\d+)$/, // Matches 'image_url_1', 'image_url_2', etc.
    // Optional: sort columns before adding to array (e.g., by the number in pattern)
    sortSourceColumnsBy: (match) => parseInt(match[1], 10),
    // Optional: transform each value before adding to array
    transformValue: (value) => (value ? `https://cdn.example.com/${value}` : null),
    // Optional: filter out null/empty values after transformation
    filterEmptyValues: true,
  } as CsvToArrayConfig,
};

// Assuming products_images.csv:
// product_sku,product_name,image_url_2,image_url_1
// SKU001,Awesome Gadget,gadget_thumb.jpg,gadget_main.jpg
const products = CSV.fromFile<Product>('products_images.csv', { headerMap: productHeaderMap });
// products.toArray()[0].imageUrls will be ['https://cdn.example.com/gadget_main.jpg', 'https://cdn.example.com/gadget_thumb.jpg']
```

##### Explicit Column List for Array Mapping

```typescript
// If CSV columns don't follow a pattern, list them explicitly:
const explicitImageMap: HeaderMap<Product> = {
  'product_sku': 'id',
  'product_name': 'name',
  '_imageMappingConfig': {
    _type: 'csvToTargetArray',
    targetPath: 'imageUrls',
    sourceCsvColumns: ['mainProductImage', 'thumbnailImage', 'galleryImage3'],
  } as CsvToArrayConfig,
};
```

##### Mapping an Array to Multiple Columns

```typescript
import CSV, { HeaderMap, ObjectArrayToCsvConfig } from '@doeixd/csv-utils';
// (Product interface is same as above)

const productsData: Product[] = [
  { id: 'SKU002', name: 'Another Item', imageUrls: ['item_front.png', 'item_back.png'] }
];

// Map 'imageUrls' array back to CSV columns 'image_col_0', 'image_col_1', ...
const writeProductHeaderMap: HeaderMap<Product> = {
  'id': 'product_sku',
  'name': 'product_name',
  'imageUrls': { // Key must match the array property name in Product
    _type: 'targetArrayToCsv',
    targetCsvColumnPrefix: 'image_col_', // Output columns: image_col_0, image_col_1, ...
    maxColumns: 3, // Create up to 3 image columns
    emptyCellOutput: '', // Value for empty cells if array is shorter than maxColumns
    // Optional: transform value before writing
    transformValue: (value) => value.replace('https://cdn.example.com/', ''),
  } as ObjectArrayToCsvConfig,
};

CSV.fromData(productsData).writeToFile('products_output_arrays.csv', {
  headerMap: writeProductHeaderMap,
  stringifyOptions: { header: true }
});
// products_output_arrays.csv might have:
// product_sku,product_name,image_col_0,image_col_1,image_col_2
// SKU002,Another Item,item_front.png,item_back.png,""
```

### Preamble Handling

Manage metadata or comments at the beginning of CSV files.

```typescript
import CSV from '@doeixd/csv-utils';

// Example CSV file (data_with_preamble.csv):
// # File Generated: 2024-01-01
// # Source: SystemX
// id,name,value
// 1,Alpha,100
// 2,Beta,200

// --- Reading with Preamble ---
const csvInstance = CSV.fromFile('data_with_preamble.csv', {
  saveAdditionalHeader: true, // Enable preamble capture
  csvOptions: {
    from_line: 3, // Actual data starts on line 3
    comment: '#',   // Treat lines starting with # as comments (part of preamble if before from_line)
  },
  // Optional: dedicated parsing options for the preamble itself
  additionalHeaderParseOptions: {
    delimiter: ',', // If preamble has a different structure
    // Note: options like 'columns', 'from_line', 'to_line' are overridden for preamble.
  }
});

console.log('Preamble:\n', csvInstance.additionalHeader);
// Preamble:
// # File Generated: 2024-01-01
// # Source: SystemX

console.log('Data:', csvInstance.toArray());
// Data: [ { id: '1', name: 'Alpha', value: '100' }, { id: '2', name: 'Beta', value: '200' } ]

// --- Writing with Preamble ---
const preambleContent = `# Exported: ${new Date().toISOString()}\n# User: admin\n`;
csvInstance.writeToFile('output_with_preamble.csv', {
  additionalHeader: preambleContent,
});

// To preserve an existing preamble when modifying and saving:
const modifiedCsv = csvInstance.updateColumn('value', v => parseInt(v) * 2);
modifiedCsv.writeToFile('modified_output.csv', {
  additionalHeader: csvInstance.additionalHeader // Use the original preamble
});
```
**Note on `saveAdditionalHeader`:**
- If `number > 0`: Specifies the exact number of lines to extract as the preamble. Data parsing will start after these lines, unless `csvOptions.from_line` points to an even later line.
- If `true`: Enables preamble extraction *if* `csvOptions.from_line` is set to a value greater than 1. The preamble will consist of `csvOptions.from_line - 1` lines.
- If `false`, `0`, or `undefined`: No preamble is extracted.

### Schema Validation

Validate CSV data against predefined schemas.

#### Using Standard Schema

This library supports `StandardSchemaV1` for defining custom validation logic.

```typescript
import CSV, { StandardSchemaV1, CSVSchemaConfig } from '@doeixd/csv-utils';

interface User { id: number; email: string; age?: number; }

// Custom schema for validating email strings
const emailFormatSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'csv-utils-example',
    validate: (value: unknown): StandardSchemaV1.Result<string> => {
      if (typeof value !== 'string') return { issues: [{ message: 'Must be a string' }] };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { issues: [{ message: 'Invalid email format' }] };
      return { value };
    },
    types: { input: '' as string, output: '' as string }
  }
};

const userSchemaConfig: CSVSchemaConfig<User> = {
  columnSchemas: {
    id: { // Ensure ID is a positive number (example with simple validation)
      '~standard': {
        version: 1, vendor: 'csv-utils-example',
        validate: (v: unknown) => {
          const n = Number(v);
          if (isNaN(n) || n <= 0) return { issues: [{message: "ID must be a positive number"}]};
          return { value: n };
        },
        types: { input: undefined as any, output: 0 as number }
      }
    },
    email: emailFormatSchema,
  },
  validationMode: 'filter', // 'error', 'filter', or 'keep'
  // useAsync: false // Default, set to true for async validation logic within schemas
};

// Assuming users_for_validation.csv:
// id,email,age
// 1,alice@example.com,30
// two,bob-invalid-email,25
// 3,carol@example.com,
const users = CSV.fromFile<User>('users_for_validation.csv', { schema: userSchemaConfig });
// 'users' will only contain valid rows due to 'filter' mode.
// { id: 1, email: 'alice@example.com', age: '30' } // age is still string from parser
// { id: 3, email: 'carol@example.com', age: ''   }
```

#### Using Zod for Schema Validation

Requires `zod` to be installed (`npm install zod`).

```typescript
import CSV, { CSVSchemaConfig } from '@doeixd/csv-utils';
import { z } from 'zod';

const zodUserSchema = z.object({
  id: z.string().min(1, "ID is required"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  age: z.number().positive("Age must be a positive number").optional(),
});
type ZodUser = z.infer<typeof zodUserSchema>;

const csvWithZodSchema: CSVSchemaConfig<ZodUser> = {
  rowSchema: zodUserSchema, // Apply to the whole row after initial parsing & custom casting
  // columnSchemas: { // Can also define Zod schemas for individual columns for pre-rowSchema validation
  //   age: z.coerce.number().positive().optional() // Coerce age to number before row validation
  // },
  validationMode: 'filter',
  // useAsync: true // If any Zod schema uses async refinements
};

// Example: use customCasts to convert 'age' before Zod validation
const usersZod = CSV.fromFile<ZodUser>('users_data.csv', {
  customCasts: { // Convert age string to number before Zod validation
    columnCasts: { age: 'number' },
    definitions: { number: { test: v => !isNaN(parseFloat(v)), parse: v => parseFloat(v) } }
  },
  schema: csvWithZodSchema
});
```

#### Working with Validation Results

If `validationMode: 'keep'` is used, results are available on the `CSV` instance.

```typescript
const configKeep: CSVSchemaConfig<User> = { /* ... */ validationMode: 'keep' };
const usersResult = CSV.fromFile<User>('users.csv', { schema: configKeep });

if (usersResult.validationResults) {
  usersResult.validationResults.forEach(res => {
    if (!res.valid) {
      console.log(`Invalid row: ${JSON.stringify(res.originalRow)}`);
      if (res.rowIssues) console.log('  Row issues:', res.rowIssues.map(i => i.message));
      if (res.columnIssues) {
        Object.entries(res.columnIssues).forEach(([col, issues]) => {
          console.log(`  Column '${col}' issues:`, issues.map(i => i.message));
        });
      }
    }
  });
}
```

### Array Transformations

Utilities for converting between arrays of arrays and arrays of objects.

```typescript
import { CSVArrayUtils, HeaderMap } from '@doeixd/csv-utils';

interface ProductRecord { id: string; productName: string; unitPrice: number; category: string; }

// --- Array of Arrays -> Array of Objects ---
const csvDataAsArrays = [
  ['SKU', 'Item Name', 'Price', 'Type'], // Header
  ['A123', 'Super Widget', '19.99', 'Gadgets'],
  ['B456', 'Mega Thinger', '29.50', 'Gizmos'],
];
const productMap: HeaderMap<ProductRecord> = {
  0: 'id', // Index 0 maps to 'id'
  1: 'productName',
  2: 'unitPrice', // This will be a string initially from CSV
  3: 'category',
};
const productsArray = CSVArrayUtils.arrayToObjArray<ProductRecord>(
  csvDataAsArrays.slice(1), // Data rows
  productMap
);
// productsArray[0] = { id: 'A123', productName: 'Super Widget', unitPrice: '19.99', category: 'Gadgets' }
// Note: For type conversion (e.g., string '19.99' to number), use CSV class with customCasts or schema validation.

// --- Array of Objects -> Array of Arrays ---
const productObjects: ProductRecord[] = [
  { id: 'C789', productName: 'Hyper Spanner', unitPrice: 9.95, category: 'Tools' },
];
// Map object properties back to array indices/CSV headers
const outputMapConfig: HeaderMap = { // Here, keys are object paths, values are CSV headers or indices
  'id': 'Product ID',
  'productName': 'Name',
  'unitPrice': 'Cost',
  'category': 'Department',
};
const outputHeaders = ['Product ID', 'Name', 'Cost', 'Department'];
const arraysForCsv = CSVArrayUtils.objArrayToArray<ProductRecord>(
  productObjects,
  outputMapConfig,
  outputHeaders,
  true // Include headers as the first row
);
// arraysForCsv = [
//   ['Product ID', 'Name', 'Cost', 'Department'],
//   ['C789', 'Hyper Spanner', 9.95, 'Tools']
// ]

// --- Grouping ---
const groupedByCategory = CSVArrayUtils.groupByField(productsArray, 'category');
// groupedByCategory['Gadgets'] would be an array of products in that category.
```

### Async Processing

Handle large datasets and I/O-bound operations efficiently.

#### Async File Operations
```typescript
import CSV from '@doeixd/csv-utils';
interface MyData { /* ... */ }

// Asynchronously read from a file (loads all data into memory after parsing)
async function loadDataAsync() {
  const csvData = await CSV.fromFileAsync<MyData>('large_dataset.csv', {
    // CSVReadOptions apply here, e.g., headerMap, customCasts, schema
  });
  console.log(`Loaded ${csvData.count()} records.`);
  return csvData;
}

// Asynchronously write to a file
async function saveDataAsync(csvInstance: CSV<MyData>) {
  await csvInstance.writeToFileAsync('output_dataset.csv');
  console.log('Data written asynchronously.');
}
```

#### Async Iteration and Batching
```typescript
async function processDataInBatches(csvInstance: CSV<MyData>) {
  // Process each row with an async callback
  await csvInstance.forEachAsync(async (row, index) => {
    // await someAsyncDbUpdate(row);
    console.log(`Processed row ${index + 1} asynchronously.`);
  }, { batchSize: 100, batchConcurrency: 5 }); // 100 items per batch, 5 batches concurrently

  // Transform data with an async mapping function
  const enrichedData = await csvInstance.mapAsync(async (row) => {
    // const details = await fetchExtraDetails(row.id);
    // return { ...row, ...details };
    return row; // Placeholder
  }, { batchSize: 50, batchConcurrency: 10 });
  
  console.log(`Enriched ${enrichedData.length} records.`);
}
```

#### Async Generators for Large Files
Ideal for memory-efficient processing of very large files.

```typescript
import { csvGenerator, csvBatchGenerator, writeCSVFromGenerator, CSVStreamOptions } from '@doeixd/csv-utils';
interface LogEntry { timestamp: string; level: string; message: string; }

const streamOptions: CSVStreamOptions<LogEntry> = {
  csvOptions: { columns: true, trim: true },
  // headerMap: { /* ... */ }, // Optional header mapping
  // transform: (row) => ({ ...row, parsedAt: new Date() }) // Optional row transformation
};

async function analyzeLogs() {
  // Process row by row
  let errorCount = 0;
  for await (const log of csvGenerator<LogEntry>('application.log', streamOptions)) {
    if (log.level === 'ERROR') errorCount++;
  }
  console.log(`Total error logs: ${errorCount}`);

  // Process in batches
  for await (const batch of csvBatchGenerator<LogEntry>('application.log', { ...streamOptions, batchSize: 1000 })) {
    // await bulkInsertToDb(batch);
    console.log(`Processed batch of ${batch.length} logs.`);
  }
}

// Example: Transform and write using generators
async function transformAndWriteLogs() {
  async function* transformedLogGenerator() {
    for await (const log of csvGenerator<LogEntry>('input.log')) {
      if (log.level === 'INFO') { // Filter and transform
        yield { ...log, message: log.message.toUpperCase() } as LogEntry;
      }
    }
  }
  await writeCSVFromGenerator('output_info_logs.csv', transformedLogGenerator());
}
```

### Error Handling and Retries

```typescript
import CSV, { CSVError } from '@doeixd/csv-utils';

try {
  const data = CSV.fromFile('potentially_flaky_network_file.csv', {
    retry: {
      maxRetries: 3,        // Attempt up to 3 times after initial failure
      baseDelay: 500,       // Initial delay 500ms, then 1000ms, 2000ms (exponential backoff)
      logRetries: true,     // Log retry attempts to console.warn
    }
  });
  // ... process data
} catch (error) {
  if (error instanceof CSVError) {
    console.error(`CSV operation failed: ${error.message}`);
    if (error.cause) {
      console.error('Underlying cause:', error.cause);
    }
  } else {
    console.error('An unexpected error occurred:', error);
  }
}
```

### Data Analysis and Transformation

#### Merging Datasets
```typescript
import CSV from '@doeixd/csv-utils';
interface InventoryItem { sku: string; name: string; price: number; stock: number; }
interface SalesDataItem { sku: string; unitsSold: number; }

const inventory = CSV.fromData<InventoryItem>([
  { sku: 'A1', name: 'Apple', price: 1.0, stock: 100 },
  { sku: 'B2', name: 'Banana', price: 0.5, stock: 150 },
]);
const sales = CSV.fromData<SalesDataItem>([
  { sku: 'A1', unitsSold: 10 },
  { sku: 'C3', unitsSold: 5 }, // This SKU not in inventory
]);

// Merge sales data into inventory, updating stock
const updatedInventory = inventory.mergeWith(
  sales,
  (invItem, saleItem) => invItem.sku === saleItem.sku, // Equality condition
  (invItem, saleItem) => ({ // Merge function for matched items
    ...invItem,
    stock: invItem.stock - saleItem.unitsSold,
  })
);
// updatedInventory will have Banana unchanged, Apple with reduced stock.
// Items only in 'sales' are not included by default with this merge logic.
```

#### Simple Data Analysis
```typescript
import CSV from '@doeixd/csv-utils';
interface Sale { product: string; region: string; amount: number; month: string; }

const salesData = CSV.fromData<Sale>([
  { product: 'Laptop', region: 'North', amount: 1200, month: 'Jan' },
  { product: 'Mouse', region: 'North', amount: 25, month: 'Jan' },
  { product: 'Laptop', region: 'South', amount: 1500, month: 'Feb' },
  { product: 'Keyboard', region: 'North', amount: 75, month: 'Jan' },
]);

const totalRevenue = salesData.aggregate('amount', 'sum'); // Sum of 'amount'
const averageSale = salesData.aggregate('amount', 'avg');
const uniqueRegions = salesData.distinct('region'); // ['North', 'South']

// Pivot table: product sales by region
const salesPivot = salesData.pivot('product', 'region', 'amount');
// salesPivot = {
//   Laptop: { North: 1200, South: 1500 },
//   Mouse: { North: 25 },
//   Keyboard: { North: 75 }
// }
```

#### Advanced Transformations (Join, Unpivot, etc.)
```typescript
import CSV from '@doeixd/csv-utils';

// --- Join Example ---
interface User { id: number; name: string; cityId: number; }
interface City { cityId: number; cityName: string; }
const users = CSV.fromData<User>([ { id: 1, name: 'Alice', cityId: 101 }, { id: 2, name: 'Bob', cityId: 102 } ]);
const cities = CSV.fromData<City>([ { cityId: 101, cityName: 'New York' }, { cityId: 103, cityName: 'Paris' } ]);

const usersWithCities = users.join(
  cities,
  { left: 'cityId', right: 'cityId', type: 'left' }, // Left join on cityId
  (user, city) => ({ // Custom select function for the result
    userId: user!.id,
    userName: user!.name,
    cityName: city ? city.cityName : 'Unknown',
  })
);
// usersWithCities.toArray() would include Alice with New York, Bob with Unknown city.

// --- Unpivot Example ---
interface QuarterlySales { product: string; q1: number; q2: number; }
const wideSales = CSV.fromData<QuarterlySales>([ { product: 'Gadget', q1: 100, q2: 150 } ]);
const longSales = wideSales.unpivot(
  ['product'], // ID columns to repeat
  ['q1', 'q2'],  // Value columns to unpivot
  'quarter',     // Name for the new 'variable' column
  'sales'        // Name for the new 'value' column
);
// longSales.toArray() = [
//   { product: 'Gadget', quarter: 'q1', sales: 100 },
//   { product: 'Gadget', quarter: 'q2', sales: 150 }
// ]

// Other useful transformations:
const sampleData = CSV.fromData([{ a:1, b:" x "}, {a:2, b:" y "}]);
const cleanedData = sampleData
  .addColumn('c', row => row.a * 2)         // Add new column 'c'
  .renameColumn('a', 'alpha')             // Rename 'a' to 'alpha'
  .castColumnType('alpha', 'string')      // Cast 'alpha' to string
  .normalizeText('b', 'uppercase')        // Uppercase column 'b'
  .trimWhitespace(['b'])                  // Trim whitespace from 'b'
  .fillMissingValues('alpha', 'N/A');     // Fill missing in 'alpha' (if any)
```

## Standalone Functions Module

For a more functional programming style, standalone functions are available. They operate on arrays of objects and return new arrays or values, mirroring the `CSV` class methods.

### Quick Start with Standalone Functions
```typescript
import { findRowsWhere, updateColumn, sortBy, aggregate } from '@doeixd/csv-utils/standalone';
// Or import all as a namespace: import csvFn from '@doeixd/csv-utils/standalone';

interface Product { id: string; name: string; price: number; category: string; }
const products: Product[] = [
  { id: 'P001', name: 'Laptop', price: 899.99, category: 'Electronics' },
  { id: 'P002', name: 'Headphones', price: 149.99, category: 'Electronics' },
  { id: 'P003', name: 'T-shirt', price: 19.99, category: 'Clothing' },
];

// Find expensive electronics
const expensiveElectronics = findRowsWhere(
  products,
  p => p.category === 'Electronics' && p.price > 500
);

// Apply discount to all products
const discounted = updateColumn(products, 'price', (price: number) => price * 0.9);

// Sort products by price (descending)
const sortedByPrice = sortBy(products, 'price', 'desc');

// Get max price
const maxPrice = aggregate(products, 'price', 'max'); // csvFn.aggregate(...)
```

### Functional Composition

Standalone functions are well-suited for composition libraries like `fp-ts`.
```typescript
import { pipe } from 'fp-ts/function'; // Example with fp-ts
import { findRowsWhere, updateColumn, sortBy } from '@doeixd/csv-utils/standalone';
// (products array defined as above)

const processProducts = (data: Product[]) => pipe(
  data,
  d => findRowsWhere(d, p => p.category === 'Electronics'),
  d => updateColumn(d, 'price', (price: number) => price * 0.9),
  d => sortBy(d, 'price', 'asc')
);

const processed = processProducts(products);
```

## API Documentation

### Core Class: CSV

The central class for CSV manipulation with a fluent interface.

#### Static Methods

| Method                                       | Description                                                                    | Return Type                 |
| :------------------------------------------- | :----------------------------------------------------------------------------- | :-------------------------- |
| `fromFile<T>(filename, options?)`            | Creates a CSV instance from a file path.                                       | `CSV<T>`                    |
| `fromData<T>(data)`                          | Creates a CSV instance from an array of objects.                               | `CSV<T>`                    |
| `fromString<T>(csvString, options?)`         | Creates a CSV instance from a CSV content string.                              | `CSV<T>`                    |
| `fromStream<T>(stream, options?)`            | Creates a CSV instance from a NodeJS Readable stream.                          | `Promise<CSV<T>>`           |
| `fromFileAsync<T>(filename, options?)`       | Asynchronously creates a CSV instance from a file path using streams.          | `Promise<CSV<T>>`           |
| `streamFromFile<SourceRowType>(filename, options?)` | Creates a `CSVStreamProcessor` for fluent, memory-efficient stream operations. | `CSVStreamProcessor<SourceRowType, SourceRowType>` |

_`options` for read methods are typically `CSVReadOptions<T>`._

#### Instance Methods

##### Data Retrieval & Output
| Method                                       | Description                                                                 | Return Type                 |
| :------------------------------------------- | :-------------------------------------------------------------------------- | :-------------------------- |
| `toArray()`                                  | Returns the internal data as a new array of objects.                        | `T[]`                       |
| `toString(options?: CsvStringifyOptions<T>)` | Converts the data to a CSV string. Supports `headerMap` via options.        | `string`                    |
| `count()`                                    | Returns the number of rows.                                                 | `number`                    |
| `getBaseRow(defaults?)`                      | Creates a template object based on the CSV's column structure.              | `Partial<T>`                |
| `createRow(data?)`                           | Creates a new row object conforming to the CSV's structure.                 | `T`                         |
| `writeToFile(filename, options?)`            | Writes the CSV data to a file.                                              | `void`                      |
| `writeToFileAsync(filename, options?)`       | Asynchronously writes the CSV data to a file.                               | `Promise<void>`             |

##### Validation
| Method                                       | Description                                                                 | Return Type                 |
| :------------------------------------------- | :-------------------------------------------------------------------------- | :-------------------------- |
| `validate<U = T>(schema)`                    | Validates data synchronously against a schema. Throws on async schema.      | `CSV<U>`                    |
| `validateAsync<U = T>(schema)`               | Validates data asynchronously against a schema.                             | `Promise<CSV<U>>`           |
| `validationResults` (readonly property)      | Array of `RowValidationResult<T>` if schema validation used 'keep' mode.    | `RowValidationResult<T>[] \| undefined` |


##### Query Methods
| Method                               | Description                                                         | Return Type                     |
| :----------------------------------- | :------------------------------------------------------------------ | :------------------------------ |
| `findRow(value, column?)`            | Finds the first row where `column` strictly matches `value`.        | `T \| undefined`                |
| `findRowByRegex(regex, column?)`     | Finds the first row where `column` matches `regex`.                 | `T \| undefined`                |
| `findRows(value, column?)`           | Finds all rows where `column` (as string) includes `value` (as string). | `T[]`                           |
| `findRowWhere(predicate)`            | Finds the first row matching the `predicate` function.              | `T \| undefined`                |
| `findRowsWhere(predicate)`           | Finds all rows matching the `predicate` function.                   | `T[]`                           |
| `findSimilarRows(str, column)`       | Finds rows with string similarity to `str` in `column`, sorted by distance. | `SimilarityMatch<T>[]`          |
| `findMostSimilarRow(str, column)`    | Finds the most similar row to `str` in `column`.                    | `SimilarityMatch<T> \| undefined` |

##### Transformation Methods
| Method                                                  | Description                                                              | Return Type                                     |
| :------------------------------------------------------ | :----------------------------------------------------------------------- | :---------------------------------------------- |
| `update(modifications)`                                 | Updates all rows. `modifications` can be an object or a function.        | `CSV<T>`                                        |
| `updateWhere(condition, modifications)`                 | Updates rows matching `condition`.                                       | `CSV<T>`                                        |
| `updateColumn(column, valueOrFn)`                       | Updates a specific `column` in all rows.                                 | `CSV<T>`                                        |
| `transform<R>(transformer)`                             | Transforms each row into a new structure `R`.                            | `CSV<R>`                                        |
| `removeWhere(condition)`                                | Removes rows matching `condition`.                                       | `CSV<T>`                                        |
| `append(...rows)`                                       | Adds new `rows` to the dataset.                                          | `CSV<T>`                                        |
| `mergeWith<E>(other, equalityFn, mergeFn)`              | Merges with another dataset `other` (array or `CSV<E>`).                 | `CSV<T>`                                        |
| `addColumn<NK, NV>(colName, valOrFn)`                   | Adds a new column `colName` of type `NK` with values of type `NV`.       | `CSV<T & Record<NK, NV>>`                     |
| `removeColumn<K>(colNames)`                             | Removes one or more `colNames`.                                          | `CSV<Omit<T, K>>`                             |
| `renameColumn<OK, NK>(oldName, newName)`                | Renames `oldName` (type `OK`) to `newName` (type `NK`).                  | `CSV<Omit<T, OK> & Record<NK, T[OK]>>`          |
| `reorderColumns(orderedNames)`                          | Reorders columns based on `orderedNames`.                                | `CSV<T>`                                        |
| `castColumnType(colName, targetType)`                   | Casts `colName` to `targetType` ('string', 'number', 'boolean', 'date'). | `CSV<T>` (underlying data type changes)         |
| `deduplicate(colsToCheck?)`                             | Removes duplicate rows, optionally checking specific `colsToCheck`.      | `CSV<T>`                                        |
| `split(condition)`                                      | Splits data into two `CSV` instances (`pass`, `fail`) based on `condition`. | `{ pass: CSV<T>; fail: CSV<T> }`                |
| `join<O, J>(otherCsv, onConfig, selectFn?)`             | Joins with `otherCsv` (`CSV<O>`) based on `onConfig`, produces `CSV<J>`.   | `CSV<J>`                                        |
| `unpivot<I, V, VN, VLN>(idCols, valCols, varN?, valN?)`  | Transforms data from wide to long format.                                | `CSV< новой_структуры >`                       |
| `fillMissingValues<K>(colName, valOrFn)`                | Fills `null`/`undefined` in `colName`.                                   | `CSV<T>`                                        |
| `normalizeText<K>(colName, normType)`                   | Normalizes text case in `colName` (`lowercase`, `uppercase`, `capitalize`).| `CSV<T>`                                        |
| `trimWhitespace(columns?)`                              | Trims whitespace from string values in specified (or all) `columns`.     | `CSV<T>`                                        |

##### Analysis & Sampling Methods
| Method                                       | Description                                                              | Return Type        |
| :------------------------------------------- | :----------------------------------------------------------------------- | :----------------- |
| `groupBy(column)`                            | Groups rows by values in `column`.                                       | `Record<string, T[]>` |
| `sortBy<K>(column, direction?)`              | Sorts rows by `column`.                                                  | `CSV<T>`           |
| `sortByAsync<K>(column, direction?)`         | Asynchronously sorts rows, potentially using worker threads.             | `Promise<CSV<T>>`  |
| `aggregate<K>(column, operation?)`           | Calculates 'sum', 'avg', 'min', 'max', 'count' for `column`.             | `number`           |
| `distinct<K>(column)`                        | Gets unique values from `column`.                                        | `Array<T[K]>`      |
| `pivot(rowCol, colCol, valCol)`              | Creates a pivot table.                                                   | `Record<string, Record<string, unknown>>` |
| `sample(count?)`                             | Gets `count` random rows.                                                | `CSV<T>`           |
| `head(count?)` / `take(count?)`              | Gets the first `count` rows.                                             | `CSV<T>`           |
| `tail(count?)`                               | Gets the last `count` rows.                                              | `CSV<T>`           |

##### Iteration Methods
| Method                                       | Description                                                              | Return Type        |
| :------------------------------------------- | :----------------------------------------------------------------------- | :----------------- |
| `forEach(callback)`                          | Executes `callback` for each row.                                        | `void`             |
| `forEachAsync(callback, options?)`           | Asynchronously executes `callback` for each row, with batching.          | `Promise<void>`    |
| `map<R>(callback)`                           | Creates a new array by applying `callback` to each row.                  | `R[]`              |
| `mapAsync<R>(callback, options?)`            | Asynchronously creates a new array, with batching.                       | `Promise<R[]>`     |
| `reduce<R>(callback, initialValue)`          | Reduces rows to a single value.                                          | `R`                |
| `reduceAsync<R>(callback, initialValue, options?)` | Asynchronously reduces rows, with optimized batching/parallel strategies. | `Promise<R>`       |

### Utility Objects

#### CSVUtils
Standalone utility functions.

| Function                                       | Description                                                              |
| :--------------------------------------------- | :----------------------------------------------------------------------- |
| `mergeRows(arrA, arrB, eqFn, mergeFn)`         | Merges two arrays of objects based on custom logic.                      |
| `clone(obj)`                                   | Deep clones an object (using `JSON.parse(JSON.stringify(obj))`).         |
| `isValidCSV(str)`                              | Performs a quick check if a string seems to be valid CSV.                |
| `writeCSV(filename, data, options?)`           | Writes an array of objects `data` to a CSV `filename`.                   |
| `writeCSVAsync(filename, data, options?)`      | Asynchronously writes `data` to `filename`.                              |
| `createTransformer<T, R>(transformFn)`         | Creates a NodeJS `Transform` stream for row-by-row transformation.       |
| `processInWorker<T, R>(operation, data)`       | Executes a serializable `operation` with `data` in a worker thread.      |
| `processInParallel<T, R>(items, op, opts?)`    | Processes `items` in parallel using worker threads. Not for order-dependent ops like sort. |

#### CSVArrayUtils
Utilities for converting between arrays and objects, often used with header maps.

| Function                                       | Description                                                              |
| :--------------------------------------------- | :----------------------------------------------------------------------- |
| `arrayToObjArray<T>(data, headerMap, headerRow?)` | Transforms an array of arrays/objects `data` to an array of `T` objects using `headerMap`. |
| `objArrayToArray<T>(data, headerMap, headers?, includeHeaders?)` | Transforms an array of `T` objects `data` to an array of arrays using `headerMap`. |
| `groupByField<T>(data, field)`                 | Groups an array of `T` objects `data` by the value of `field` (can be a dot-path). |

### Generator Functions
For memory-efficient processing of large CSV files.

| Function                                       | Description                                                              |
| :--------------------------------------------- | :----------------------------------------------------------------------- |
| `csvGenerator<T>(filename, options?)`          | Asynchronously yields rows of type `T` one by one from `filename`.       |
| `csvBatchGenerator<T>(filename, options?)`     | Asynchronously yields batches (arrays of `T`) from `filename`.           |
| `writeCSVFromGenerator<T>(filename, generator, options?)` | Writes data from an async `generator` of `T` rows to `filename`.       |

_`options` for generator functions are `CSVStreamOptions<T>`._

### Key Types and Interfaces

#### CSVError
Custom error class for all library-specific errors.
- `message: string` - Error description.
- `cause?: unknown` - The original error, if any, that led to this `CSVError`.

#### Options Interfaces

-   **`CSVReadOptions<T>`**: Configures CSV reading operations.
    -   `fsOptions?`: NodeJS file system options.
    -   `csvOptions?`: Options for `csv-parse` (e.g., `delimiter`, `quote`, `skip_empty_lines`). Default: `{ columns: true }`.
    -   `transform?: (content: string) => string`: Pre-parsing transform for raw file content.
    -   `headerMap?: HeaderMap<T>`: Configuration for mapping CSV columns to object properties (see [Header Mapping](#header-mapping)).
    -   `retry?: RetryOptions`: Configuration for retrying failed read operations.
    -   `validateData?: boolean`: Basic structural validation of parsed data.
    -   `schema?: CSVSchemaConfig<T>`: Configuration for data validation against schemas (see [Schema Validation](#schema-validation)).
    -   `saveAdditionalHeader?: boolean | number`: Extracts initial lines as a preamble (see [Preamble Handling](#preamble-handling)).
    -   `additionalHeaderParseOptions?`: `csv-parse` options specifically for parsing the preamble.
    -   `customCasts?`: Configuration for advanced type casting (see [Custom Type Casting](#custom-type-casting)).
        -   `definitions?: CustomCastDefinition`: Global named casters.
        -   `columnCasts?: ColumnCastConfig<T>`: Per-column casting rules.
        -   `onCastError?: 'error' | 'null' | 'original'`: Behavior on casting failure.

-   **`CSVWriteOptions<T>`**: Configures CSV writing operations.
    -   `additionalHeader?: string`: String to prepend to the CSV output (e.g., comments, metadata).
    -   `stringifyOptions?`: Options for `csv-stringify` (e.g., `header`, `delimiter`, `quoted`). Default: `{ header: true }`.
    -   `streaming?: boolean`: Whether to use streaming for writing large datasets.
    -   `headerMap?: HeaderMap<T>`: Configuration for mapping object properties to CSV columns.
    -   `streamingThreshold?: number`: Row count threshold to enable streaming (default: 1000).
    -   `retry?: RetryOptions`: Configuration for retrying failed write operations.

-   **`CSVStreamOptions<T>`**: Configures generator-based stream processing.
    -   `csvOptions?`: Options for `csv-parse`. Default: `{ columns: true }`.
    -   `transform?: (row: any) => T`: Function to transform each parsed row.
    -   `batchSize?: number`: Number of rows per batch for `csvBatchGenerator` (default: 100).
    -   `headerMap?: HeaderMap<T>`: Header mapping configuration.
    -   `retry?: RetryOptions`: Retry configuration (applies if underlying operations support it).

-   **`RetryOptions`**: Configures retry behavior.
    -   `maxRetries?: number`: Max retry attempts (default: 3).
    -   `baseDelay?: number`: Initial delay in ms (default: 100), uses exponential backoff.
    -   `logRetries?: boolean`: Log retries to `console.warn` (default: false).

#### Casting Related Types
-   **`Caster<TargetType>`**: Defines a custom type caster.
    -   `test: (value: string, context: CastingContext) => boolean`: Returns `true` if this caster should handle the `value`.
    -   `parse: (value: string, context: CastingContext) => TargetType`: Parses the `value` to `TargetType`. Throws on error.
-   **`CustomCastDefinition`**: A map of type names (e.g., 'string', 'number', 'date') to `Caster` objects for global definitions.
-   **`ColumnCastConfig<T>`**: Per-column casting rules, mapping column names to caster keys (from `definitions`) or direct `Caster` objects, or an array of these to try in order.
-   **`CastingContext`**: Provides context (column name, line number, etc.) to caster functions.

#### Schema Related Types
-   **`CSVSchemaConfig<T>`**: Configures schema-based validation.
    -   `rowSchema?: StandardSchemaV1`: Schema applied to each entire row object (e.g., a Zod schema).
    -   `columnSchemas?: { [K in keyof T]?: StandardSchemaV1 } | { [col: string]: StandardSchemaV1 }`: Schemas applied to individual column values before row validation.
    -   `validationMode?: 'error' | 'filter' | 'keep'`: Action on validation failure (default: 'error').
    -   `useAsync?: boolean`: Set to `true` if schemas involve asynchronous validation logic (default: `false` for sync methods, `true` for async methods if schema present).
-   **`RowValidationResult<T>`**: Contains results of validating a single row.
    -   `originalRow: Record<string, any>`: The row before validation.
    -   `validatedRow?: T`: The row after successful validation and type coercion by schema.
    -   `valid: boolean`: Overall validity of the row.
    -   `rowIssues?: StandardSchemaV1.Issue[]`: Issues from `rowSchema` validation.
    -   `columnIssues?: Record<string, StandardSchemaV1.Issue[]>`: Issues from `columnSchemas` validation.
-   **`StandardSchemaV1`**: Interface for schema objects compatible with the Standard Schema specification (useful for integrating with Zod, Yup, etc., or custom validation).

#### Other Types
-   **`HeaderMap<T>`**: An object defining mapping rules between CSV headers (or array indices) and object property paths. Can include `CsvToArrayConfig` or `ObjectArrayToCsvConfig` for array mappings.
-   **`CsvToArrayConfig`**: Special `HeaderMap` entry to map multiple CSV columns to a single array property.
-   **`ObjectArrayToCsvConfig`**: Special `HeaderMap` entry to map an array property to multiple CSV columns.
-   **`SimilarityMatch<T>`**: Result of `findSimilarRows`, containing the `row: T` and Levenshtein `dist: number`.
-   **`ValueTransformFn` (MergeFn in README context)**: `(currentObject: Partial<T>, targetPath: string, sourceValue: any, sourceKeyOrIndex: string | number, allSourceData: any) => any`. A function type used within `createHeaderMapFns` to allow custom transformation of values during the mapping process from CSV source to target object structure. The README describes it as: `(obj: Partial<T>, key: string, value: any) => any` which is a simplified signature for its common use case.

## Memory-Efficient Stream Processing with `CSVStreamProcessor`

For very large CSV files that don't fit into memory, `CSVStreamProcessor` provides a fluent, chainable API for stream-based transformations.

### Creating a Stream Processor
```typescript
import CSV from '@doeixd/csv-utils';
interface OrderData { /* ... define your expected row structure ... */ }

// Create a stream processor from a file
const processor = CSV.streamFromFile<OrderData>('very_large_orders.csv', {
  // CSVReadOptions can be provided, e.g., csvOptions for parsing, headerMap
  csvOptions: { delimiter: ';', trim: true },
  headerMap: { 'Order ID': 'id', 'Customer Name': 'customer' /* ... */ }
});
```
**Note on Preamble:** `CSV.streamFromFile` does **not** handle `saveAdditionalHeader` or `additionalHeaderParseOptions` from `CSVReadOptions`. It starts processing directly from the data rows as configured by `csvOptions.from_line` (or line 1 if not set).

### Fluent Stream Transformations
Chain operations like `filter`, `map`, `addColumn` just like the main `CSV` class. Each returns a new `CSVStreamProcessor` instance.

```typescript
const processedStream = processor
  .filter(order => order.status === 'COMPLETED' && parseFloat(order.totalValue) > 1000)
  .map(order => ({
    orderId: order.id,
    customerName: order.customer,
    value: parseFloat(order.totalValue),
    processedDate: new Date()
  }))
  .addColumn('isHighValue', order => order.value > 5000);
```

The `CSVStreamProcessor` uses an internal fixed-size circular buffer and automatic backpressure management to control memory usage, making it suitable for processing files of virtually any size.

### Executing the Stream Pipeline

The pipeline is executed when a terminal operation is called:

1.  **Async Iteration (`for await...of`)**: Most common and memory-efficient way.
    ```typescript
    for await (const processedOrder of processedStream) {
      // console.log(processedOrder.orderId, processedOrder.customerName);
      // await saveToDatabase(processedOrder);
    }
    ```

2.  **`run()` with a Preparatory Method**: Configure a terminal action, then execute.
    -   **Collect into `CSV` instance**:
        ```typescript
        // Loads all results into memory - use with caution on huge files!
        const collectedCsv: CSV<ProcessedOrderType> = await processedStream.prepareCollect().run() as CSV<ProcessedOrderType>;
        ```
    -   **Write to File**:
        ```typescript
        await processedStream.prepareToFile('processed_large_orders.csv', {
          // CSVWriteOptions, e.g., stringifyOptions
          stringifyOptions: { header: true, bom: true }
        }).run();
        ```
    -   **Execute Callback for Each Row**:
        ```typescript
        await processedStream.prepareForEach(async (row) => {
          // await sendNotification(row);
        }).run();
        ```
    -   **Pipe to another Writable Stream**:
        ```typescript
        import fs from 'node:fs';
        const myWritable = fs.createWriteStream('output.log');
        await processedStream.preparePipeTo(myWritable).run();
        ```

3.  **`pipe()` method**: Directly pipe to a Writable stream (terminal operation).
    ```typescript
    import fs from 'node:fs';
    const anotherWritable = fs.createWriteStream('output_direct_pipe.txt');
    processedStream.pipe(anotherWritable); // Returns 'anotherWritable'
    // Listen for 'finish' or 'error' on anotherWritable
    anotherWritable.on('finish', () => console.log('Direct pipe finished.'));
    ```

## Troubleshooting

### Important Note: Mutability and Query Results

Many of the query methods in this library, such as `findRowWhere` and `findRowsWhere`, **return direct references to the objects within the CSV data**, rather than creating new copies. This design choice enhances performance and enables efficient in-place modifications, but it also introduces a potential pitfall.

**Benefits of Mutability:**

*   **Performance:** Avoids the overhead of creating new objects for each query result, which can be significant for large datasets.
*   **In-Place Modification:** Allows you to directly modify the data within the CSV instance without the need for additional assignment or update operations. This can simplify certain data manipulation workflows.

**The "Foot Gun": Potential Pitfalls:**

*   **Unintended Side Effects:** If you modify an object returned by a query method, you are directly changing the underlying data within the CSV instance. This can lead to unexpected side effects if other parts of your code are relying on the original state of the data.
*   **Unexpected Results:** Subsequent queries or operations might be affected by these in-place modifications.

**Example Illustrating the Issue:**

```typescript
import CSV from '@doeixd/csv-utils';

interface User { id: number; name: string; active: boolean; }

const csv = CSV.fromData<User>([
  { id: 1, name: 'Alice', active: true },
  { id: 2, name: 'Bob', active: false },
  { id: 3, name: 'Carol', active: true }
]);

// Find the first inactive user
const inactiveUser = csv.findRowWhere(user => !user.active);

// Directly modify the object returned by findRowWhere
if (inactiveUser) {
  inactiveUser.active = true; // **DANGER: Modifies the underlying CSV data!**
}

// Now the CSV instance has been modified!
const activeUsers = csv.findRowsWhere(user => user.active);
console.log(activeUsers.length); // 3 (Bob is now considered active)
```

**How to Avoid Pitfalls (Best Practices):**

*   **Clone Before Modifying:** To prevent unintended side effects, always clone the object returned by query methods before making any modifications. Use `CSVUtils.clone` for a deep copy:

    ```typescript
    import CSV, { CSVUtils } from '@doeixd/csv-utils';

    const inactiveUser = csv.findRowWhere(user => !user.active);

    if (inactiveUser) {
      const clonedUser = CSVUtils.clone(inactiveUser); // Create a deep copy
      clonedUser.active = true; // Modify the clone, not the original
      // ... do something with clonedUser, but don't re-insert it into the CSV
    }

    // Original CSV instance remains unchanged
    const activeUsers = csv.findRowsWhere(user => user.active);
    console.log(activeUsers.length); // 2 (Bob is still considered inactive)
    ```

*   **Use `updateWhere` for Bulk Updates:** If you need to update multiple rows based on a condition, use the `updateWhere` method. This ensures that new objects are created, avoiding direct mutation of the original data:

    ```typescript
    import CSV from '@doeixd/csv-utils';

    const updatedCsv = csv.updateWhere(
      user => !user.active,
      { active: true }  // This creates new objects, not mutating existing ones
    );

    // The original CSV instance remains unchanged
    const stillInactive = csv.findRowWhere(user => !user.active); // May still exist
    // But updatedCsv contains *new* objects
    const updatedActive = updatedCsv.findRowsWhere(user => user.active); // Will contain Alice, Carol, and a new Bob
    ```

By being aware of this mutability characteristic and following these best practices, you can effectively leverage the power of this library while avoiding potential issues.

### Common Issues

-   **Inconsistent Row Lengths / Malformed CSV**:
    -   Error like: `Error: Row length mismatch at line 42...` or `Invalid Record Length`.
    -   **Solution**: Check your CSV for unescaped quotes, incorrect delimiters, or missing fields. Ensure `csvOptions.delimiter` matches your file. For debugging, you can use `CSVReadOptions.transform` to log raw content. If structural errors are expected and should be ignored (at risk of data issues), underlying `csv-parse` options like `relax_column_count: true` might be used in `csvOptions`, though this library emphasizes strictness by default.

-   **Type Casting Failures**:
    -   Error like: `Custom cast failed for column "price"...` or values not being the expected type.
    -   **Solution**: Review `customCasts` definitions. Ensure `test` functions are specific enough and `parse` functions handle edge cases. Use `onCastError: 'null'` or `'original'` to prevent errors and inspect problematic values.

-   **Performance with Large Files**:
    -   Slow processing or high memory usage.
    -   **Solution**:
        -   For reading/transforming: Use `CSV.streamFromFile()` to get a `CSVStreamProcessor` and process data via `for await...of` or `prepareForEach().run()`.
        -   For reading only (less transformation): Use `csvGenerator()` or `csvBatchGenerator()`.
        -   For writing: `CSV.writeToFile()` uses streaming for large datasets by default (`streamingThreshold`). `CSV.writeToFileAsync()` and `writeCSVFromGenerator()` are also good options.
        -   For CPU-bound tasks on arrays of data: `CSVUtils.processInParallel()`.

-   **Header Mapping Not Working as Expected**:
    -   Properties are `undefined` or not mapped correctly.
    -   **Solution**:
        -   Ensure `HeaderMap` keys exactly match CSV headers (case-sensitive by default, unless `csvOptions.columns` is a function that normalizes them).
        -   Verify object paths in `HeaderMap` values are correct.
        -   For `targetArrayToCsv`, the key in `HeaderMap` must be the name of the array property in your source objects.
        -   For `csvToTargetArray`, the `sourceCsvColumnPattern` or `sourceCsvColumns` must correctly identify the columns in the CSV file.

-   **Schema Validation Errors**:
    -   `CSVError: CSV validation failed...`
    -   **Solution**: Check schema definitions (e.g., Zod schemas, `StandardSchemaV1` implementations). If using `validationMode: 'keep'`, inspect `csvInstance.validationResults` for detailed error messages per row/column. Ensure data types are what the schema expects (e.g., use `customCasts` to convert strings to numbers/dates before schema validation if needed).

-   **Preamble Not Captured**:
    -   `csvInstance.additionalHeader` is empty.
    -   **Solution**: Ensure `saveAdditionalHeader: true` (or a number) is set in `CSVReadOptions`. If `saveAdditionalHeader: true`, `csvOptions.from_line` must be greater than 1. The preamble consists of lines *before* `from_line`.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. Ensure that your contributions include relevant tests and documentation updates.

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
(Assuming you have a LICENSE file, if not, you can generate one, e.g. from choosealicense.com)
