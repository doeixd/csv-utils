# CSV Utils

[![npm version](https://img.shields.io/npm/v/@doeixd/csv-utils.svg)](https://www.npmjs.com/package/@doeixd/csv-utils)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A TypeScript library for CSV manipulation with strong typing. This library provides comprehensive utilities for parsing, transforming, analyzing, and writing CSV data / arrays of objects, with support for operations like header mapping, streaming for large files, and async processing.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Default Options](#default-options)
- [Examples](#examples)
  - [Basic Operations](#basic-operations)
  - [Custom Type Casting](#custom-type-casting)
  - [Header Mapping](#header-mapping)
  - [Schema Validation](#schema-validation)
  - [Array Transformations](#array-transformations)
  - [Async Processing](#async-processing-with-generators)
  - [Error Handling](#error-handling-and-retries)
  - [Data Analysis](#simple-data-analysis)
- [Standalone Functions](#csv-functions-module)
- [API Documentation](#api-documentation)
  - [Core Class: CSV](#core-class-csv)
  - [Utility Functions](#utility-functions)
  - [Types and Interfaces](#types-and-interfaces)
- [Memory-Efficient Streaming](#memory-efficient-stream-processing)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Features

- **🔒 Type Safety** - Comprehensive TypeScript support with generic types
- **🧩 Header Mapping** - Transform between CSV columns and nested object structures
- **📊 Data Analysis** - Rich query, filtering, and aggregation capabilities
- **📈 Transformation** - Powerful data conversion and manipulation tools
- **⚡ Async Support** - Process large files with generators and streams
- **🛡️ Error Handling** - Robust error recovery with retry mechanisms
- **📝 Documentation** - Extensive examples and API documentation
- **🚀 Builder Pattern** - Chain methods for elegant data manipulation
- **🧠 Smart Type Casting** - Configurable custom type casting for CSV data
- **🔄 Streaming API** - Efficient processing of large files with minimal memory usage
- **🔍 Schema Validation** - Support for Standard Schema validation (compatible with Zod and other libraries)
- **⚖️ Memory Efficiency** - Fixed-size circular buffer for streaming to limit memory usage
- **🧮 Parallel Processing** - Worker thread support for CPU-intensive operations
- **🔍 Optimized Algorithms** - Improved data structure usage for better performance
- **📦 Batch Processing** - Process data in configurable batches for better throughput
  
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

// Read from a CSV file
const products = CSV.fromFile<Product>('products.csv');

// Chain operations
const result = products
  .findRowsWhere(p => p.price > 100)     // Find expensive products
  .update({ currency: 'USD' })           // Add currency field
  .updateColumn('price', p => p * 0.9)   // Apply 10% discount
  .sortBy('price', 'desc')               // Sort by price (high to low)
  .removeWhere(p => p.inventory < 5)     // Remove low inventory items
  .toArray();                            // Get the results as an array

// Write back to file
CSVUtils.writeCSV('discounted_products.csv', result);
```

## Default Options

By default, all CSV reading methods (`fromString`, `fromFile`, and `fromStream`) set the following options:

- `columns: true` - CSV data is parsed into objects with column headers as keys

You can override these defaults by providing your own options in the `csvOptions` property:

```typescript
// Override the default columns setting
const rawData = CSV.fromString(csvContent, {
  csvOptions: { columns: false }
});

// Use all the defaults
const data = CSV.fromFile('data.csv'); // columns: true is applied automatically
```

## Examples

### Standalone Functions Quick Start

```typescript
// Import standalone functions for a simpler workflow
import { findRowsWhere, updateColumn, sortBy } from '@doeixd/csv-utils/standalone';

// Sample data
const products = [
  { id: 'P001', name: 'Laptop', price: 899.99, category: 'Electronics' },
  { id: 'P002', name: 'Headphones', price: 149.99, category: 'Electronics' },
  { id: 'P003', name: 'T-shirt', price: 19.99, category: 'Clothing' }
];

// Find expensive electronics
const expensiveElectronics = findRowsWhere(
  products,
  p => p.category === 'Electronics' && p.price > 500
);

// Apply discount to all products
const discounted = updateColumn(products, 'price', price => price * 0.9);

// Sort products by price (descending)
const sortedByPrice = sortBy(products, 'price', 'desc');
```

### Basic Operations

```typescript
import CSV from '@doeixd/csv-utils';

// Create from data
const users = CSV.fromData([
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

// Output as CSV string
const csvString = users.toString();

// Write to file
users.writeToFile('users.csv');
```

### Custom Type Casting

The library provides powerful custom type casting that can be applied after the initial CSV parsing but before other transformations:

```typescript
import CSV, { Caster } from '@doeixd/csv-utils';

// Define a custom caster for percentages
const percentageCaster: Caster<number> = {
  test: (value, context) => value.endsWith('%'),
  parse: (value, context) => parseFloat(value.replace('%', '')) / 100
};

// Define a custom caster for dates in MM/DD/YYYY format
const dateCaster: Caster<Date> = {
  test: (value) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value),
  parse: (value) => {
    const [month, day, year] = value.split('/').map(Number);
    return new Date(year, month - 1, day);
  }
};

// Define custom casts for specific columns
const orders = CSV.fromFile<Order>('orders.csv', { 
  customCasts: {
    // Global casters that apply to any column when specific casters aren't defined or fail
    definitions: {
      number: {
        test: (value) => !isNaN(parseFloat(value)),
        parse: (value) => parseFloat(value)
      },
      date: dateCaster
    },
    // Column-specific casters
    columnCasts: {
      'discount': 'number', // Use the number caster from definitions
      'tax_rate': percentageCaster, // Use a custom caster directly
      'created_at': 'date', // Use the date caster from definitions
      // For columns with multiple possible formats, provide an array of casters to try in order
      'price': ['number', { 
        test: (value) => value.startsWith('$'),
        parse: (value) => parseFloat(value.replace('$', ''))
      }]
    },
    // How to handle casting errors
    onCastError: 'error' // Options: 'error' (default), 'null', 'original'
  }
});

// Now all columns are properly typed
// prices are numbers, dates are Date objects, and percentages are decimal values
console.log(typeof orders.toArray()[0].price); // 'number'
console.log(orders.toArray()[0].created_at instanceof Date); // true
console.log(orders.toArray()[0].tax_rate); // 0.075 (from '7.5%')
```

### Header Mapping

The library provides powerful utilities for mapping between flat CSV columns and structured objects with nested properties.

### Basic Mapping

```typescript
import { createHeaderMapFns } from '@doeixd/csv-utils';

// Define a mapping between CSV headers and object properties
const headerMap = {
  'user_id': 'id',
  'first_name': 'profile.firstName',
  'last_name': 'profile.lastName',
  'email': 'contact.email'
};

// Create mapping functions
const { fromRowArr, toRowArr } = createHeaderMapFns<User>(headerMap);

// Convert CSV row to structured object (flat → nested)
const csvRow = {
  user_id: '123',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com'
};

const user = fromRowArr(csvRow);
// Result:
// {
//   id: '123',
//   profile: {
//     firstName: 'John',
//     lastName: 'Doe'
//   },
//   contact: {
//     email: 'john@example.com'
//   }
// }

// Convert back to array format (nested → flat)
const headers = ['user_id', 'first_name', 'last_name', 'email'];
const rowArray = toRowArr(user, headers);
// Result: ['123', 'John', 'Doe', 'john@example.com']
```

### Reading and Writing with Header Mapping

```typescript
import CSV from '@doeixd/csv-utils';

// Define interface for your data
interface User {
  id: string;
  profile: {
    firstName: string;
    lastName: string;
  };
}

// --- READING (flat CSV → nested objects) ---
const inputMap = {
  'user_id': 'id',
  'first_name': 'profile.firstName',
  'last_name': 'profile.lastName'
};

// Read CSV file with automatic transformation
const users = CSV.fromFile<User>('users.csv', { headerMap: inputMap });

// --- WRITING (nested objects → flat CSV) ---
const outputMap = {
  'id': 'ID',
  'profile.firstName': 'First Name',
  'profile.lastName': 'Last Name'
};

// Write structured data to CSV with transformation
users.writeToFile('users_export.csv', { headerMap: outputMap });

// Or use the static utility for one-off operations
CSVUtils.writeCSV('users_export.csv', users.toArray(), { headerMap: outputMap });
```

### Array Transformations

```typescript
import { CSVArrayUtils } from '@doeixd/csv-utils';

// Input: Array of arrays (typical CSV format)
const csvData = [
  ['SKU', 'NAME', 'PRICE', 'CATEGORY'],
  ['A123', 'Laptop', '999.99', 'Electronics'],
  ['B456', 'Mouse', '49.99', 'Electronics'],
  ['C789', 'T-shirt', '19.99', 'Clothing']
];

// Define mapping from array indices to object structure
const headerMap = {
  0: 'id',
  1: 'productName',
  2: 'price',
  3: 'category'
};

// Transform arrays to structured objects
const products = CSVArrayUtils.arrayToObjArray(
  csvData.slice(1), // Skip header row
  headerMap
);

// Result:
// [
//   { id: 'A123', productName: 'Laptop', price: '999.99', category: 'Electronics' },
//   { id: 'B456', productName: 'Mouse', price: '49.99', category: 'Electronics' },
//   { id: 'C789', productName: 'T-shirt', price: '19.99', category: 'Clothing' }
// ]

// Group by category
const byCategory = CSVArrayUtils.groupByField(products, 'category');
// Result:
// {
//   'Electronics': [
//     { id: 'A123', productName: 'Laptop', price: '999.99', category: 'Electronics' },
//     { id: 'B456', productName: 'Mouse', price: '49.99', category: 'Electronics' }
//   ],
//   'Clothing': [
//     { id: 'C789', productName: 'T-shirt', price: '19.99', category: 'Clothing' }
//   ]
// }
```

### Async Processing with Generators

```typescript
import { csvGenerator, csvBatchGenerator } from '@doeixd/csv-utils';

// Process large CSV files row by row
async function processLargeFile() {
  // Process one row at a time
  for await (const row of csvGenerator('large_file.csv')) {
    // Process each row individually
    console.log(`Processing ${row.id}`);
  }
  
  // Or process in batches of 100 rows
  for await (const batch of csvBatchGenerator('large_file.csv', { batchSize: 100 })) {
    console.log(`Processing batch of ${batch.length} rows`);
    // Process the batch...
  }
}

// With header mapping
async function processWithTransformation() {
  const headerMap = {
    'order_id': 'id',
    'customer_name': 'customer.name',
    'product_id': 'product.id',
    'quantity': 'quantity',
    'price': 'price'
  };
  
  for await (const order of csvGenerator('orders.csv', { headerMap })) {
    // Rows are automatically transformed with the headerMap
    console.log(`Order ${order.id} from ${order.customer.name}`);
  }
}
```

### Error Handling and Retries

```typescript
import CSV from '@doeixd/csv-utils';

// Built-in retry logic for unreliable file operations
try {
  const data = CSV.fromFile('network_file.csv', {
    retry: {
      maxRetries: 5,        // Try up to 5 times
      baseDelay: 200,       // Start with 200ms delay
      logRetries: true      // Log retry attempts
    }
  });
  // Process data...
} catch (error) {
  console.error('All retries failed:', error.message);
  if (error.cause) {
    console.error('Original error:', error.cause);
  }
}
```

### Merging Datasets

```typescript
import CSV from '@doeixd/csv-utils';

// Two datasets to merge
const localInventory = CSV.fromFile('local_inventory.csv');
const warehouseInventory = CSV.fromFile('warehouse_inventory.csv');

// Merge with custom logic
const mergedInventory = localInventory.mergeWith(
  warehouseInventory,
  // Match rows by SKU
  (local, warehouse) => local.sku === warehouse.sku,
  // Merge logic: take name from local, use lowest price, combine stock
  (local, warehouse) => ({
    ...local,
    price: Math.min(local.price, warehouse.price),
    stock: local.stock + warehouse.stock
  })
);

// Save merged result
mergedInventory.writeToFile('combined_inventory.csv');
```

### Simple Data Analysis

```typescript
import CSV from '@doeixd/csv-utils';

const salesData = CSV.fromFile('sales.csv');

// Aggregation functions
const totalRevenue = salesData.aggregate('amount', 'sum');
const averageOrder = salesData.aggregate('amount', 'avg');
const largestOrder = salesData.aggregate('amount', 'max');
const transactionCount = salesData.aggregate('amount', 'count');

// Unique values
const productCategories = salesData.distinct('category');

// Create a pivot table
const salesByProductAndMonth = salesData.pivot(
  'product',     // Rows
  'month',       // Columns
  'amount'       // Values
);
console.log(salesByProductAndMonth);
// Example output:
// {
//   'Laptop': { 'Jan': 10000, 'Feb': 12000, 'Mar': 15000 },
//   'Phone': { 'Jan': 5000, 'Feb': 6000, 'Mar': 7000 }
// }
```

### Asynchronous and Parallel Operations

#### Async File Reading with Streams

```typescript
import CSV from '@doeixd/csv-utils';

// Async file reading with streams
const data = await CSV.fromFileAsync('large_file.csv');
```

#### Batch Processing

```typescript
// Process rows asynchronously with batch processing
await data.forEachAsync(
  async (row, index) => {
    const result = await someAsyncOperation(row);
    console.log(`Processed row ${index}: ${result}`);
  },
  { batchSize: 10, batchConcurrency: 4 } // 10 items per batch, 4 batches in parallel
);

// Transform data in batches
const transformed = await data.mapAsync(
  async (row) => {
    const details = await fetchAdditionalData(row.id);
    return { ...row, ...details };
  },
  { batchSize: 20 }
);
```

#### Parallel Sorting and Processing

```typescript
// Parallel sorting with worker threads (for large datasets)
const sorted = await data.sortByAsync('price', 'desc');

// Efficiently reduce large datasets in parallel
const total = await data.reduceAsync(
  async (sum, row) => sum + await getNumericValue(row),
  0,
  { strategy: 'mapreduce', batchSize: 1000 }
);

// Process data in parallel using worker threads
const processedData = await CSVUtils.processInParallel(
  data.toArray(),
  (items) => items.map(item => processItem(item))
);
```

#### Writing Asynchronously

```typescript
// Write asynchronously
await data.writeToFileAsync('output.csv');
```
## CSV Functions Module

This module provides standalone functions for CSV data manipulation. Unlike the core CSV class with its method-chaining approach, these functions all follow a consistent pattern:

1. They take an array of objects as the first parameter
2. They return an array of objects as the result (or a single value for aggregation functions)

This allows for a more functional programming style while utilizing the same powerful features from the core CSV library.

You can import the standalone functions from `@doeixd/csv-utils/standalone`:

```typescript
// Import individual functions
import { findRowsWhere, sortBy, updateColumn } from '@doeixd/csv-utils/standalone';

// Or import everything
import csvFn from '@doeixd/csv-utils/standalone';

// Sample data
const products = [
  { id: 'P001', name: 'Laptop', price: 899.99, category: 'Electronics', stock: 15 },
  { id: 'P002', name: 'Headphones', price: 149.99, category: 'Electronics', stock: 42 },
  { id: 'P003', name: 'T-shirt', price: 19.99, category: 'Clothing', stock: 100 }
];

// Find expensive electronics
const expensiveElectronics = findRowsWhere(
  products,
  p => p.category === 'Electronics' && p.price > 500
);

// Sort products by price (descending)
const sortedByPrice = sortBy(products, 'price', 'desc');

// Apply discount to all products
const discounted = updateColumn(products, 'price', price => price * 0.9);

// Using the default import 
const inStock = csvFn.findRowsWhere(products, p => p.stock > 0);
const highValue = csvFn.aggregate(products, 'price', 'max');
```

## Functional Composition

The standalone functions are perfect for functional composition patterns:

```typescript
import { pipe } from 'fp-ts/function';
import { findRowsWhere, updateColumn, sortBy } from '@doeixd/csv-utils/standalone';

// Process products with a pipeline of operations
const processProducts = pipe(
  findRowsWhere(products, p => p.category === 'Electronics'), // Filter electronics
  products => updateColumn(products, 'price', p => p * 0.9),  // Apply 10% discount
  products => sortBy(products, 'price')                       // Sort by price
);
```
## API Documentation

### Core Class: CSV

#### Static Methods

| Method | Description |
|--------|-------------|
| `fromFile<T>(filename, options?)` | Create a CSV instance from a file |
| `fromData<T>(data)` | Create a CSV instance from an array of objects |
| `fromString<T>(csvString, options?)` | Create a CSV instance from a CSV string |
| `fromStream<T>(stream, options?)` | Create a CSV instance from a readable stream |
| `fromFileAsync<T>(filename, options?)` | Asynchronously create a CSV instance from a file |
| `streamFromFile<T>(filename, options?)` | Create a CSVStreamProcessor for efficient streaming operations |

#### Instance Methods

##### Data Retrieval
| Method | Description |
|--------|-------------|
| `toArray()` | Get data as an array |
| `toString(options?)` | Convert data to a CSV string |
| `count()` | Get the number of rows |
| `getBaseRow(defaults?)` | Create a base row template |
| `createRow(data?)` | Create a new row with the CSV structure |
| `validate<U>(schema)` | Validate data against a schema |
| `validateAsync<U>(schema)` | Validate data asynchronously against a schema |

##### File Operations
| Method | Description |
|--------|-------------|
| `writeToFile(filename, options?)` | Write data to a CSV file |
| `writeToFileAsync(filename, options?)` | Asynchronously write data to a CSV file |

##### Query Methods
| Method | Description |
|--------|-------------|
| `findRow(value, column?)` | Find the first row with an exact match |
| `findRowByRegex(regex, column?)` | Find the first row matching a regex pattern |
| `findRows(value, column?)` | Find all rows containing a value |
| `findRowWhere(predicate)` | Find the first row matching a condition |
| `findRowsWhere(predicate)` | Find all rows matching a condition |
| `findSimilarRows(str, column)` | Find rows by string similarity |
| `findMostSimilarRow(str, column)` | Find the most similar row |

##### Transformation Methods
| Method | Description |
|--------|-------------|
| `update(modifications)` | Update all rows with new values |
| `updateWhere(condition, modifications)` | Update rows that match a condition |
| `updateColumn(column, value)` | Update a specific column for all rows |
| `transform<R>(transformer)` | Transform rows into a different structure |
| `removeWhere(condition)` | Remove rows matching a condition |
| `append(...rows)` | Add new rows to the data |
| `mergeWith(other, equalityFn, mergeFn)` | Merge with another dataset |
| `addColumn(columnName, valueOrFn)` | Add a new column to each row |
| `removeColumn(columnNames)` | Remove one or more columns from each row |
| `renameColumn(oldName, newName)` | Rename a column in each row | 
| `reorderColumns(orderedColumnNames)` | Reorder columns according to specified order |
| `castColumnType(columnName, targetType)` | Cast values in a column to a specific type |
| `deduplicate(columnsToCheck?)` | Remove duplicate rows based on columns |
| `split(condition)` | Split CSV into two based on a condition |
| `join(otherCsv, onConfig, select?)` | Join with another CSV dataset |
| `unpivot(idCols, valueCols, varName?, valueName?)` | Transform from wide to long format |
| `fillMissingValues(columnName, valueOrFn)` | Fill null or undefined values in a column |
| `normalizeText(columnName, normalizationType)` | Normalize text case in a column |
| `trimWhitespace(columns?)` | Trim whitespace from string values |

##### Analysis Methods
| Method | Description |
|--------|-------------|
| `groupBy(column)` | Group rows by values in a column |
| `sortBy(column, direction?, options?)` | Sort rows by a column with optional worker thread acceleration |
| `sortByAsync(column, direction?)` | Sort rows asynchronously using worker threads for large datasets |
| `aggregate(column, operation?)` | Calculate aggregate values for a column |
| `distinct(column)` | Get unique values from a column |
| `pivot(rowColumn, colColumn, valueColumn)` | Create a pivot table |
| `sample(count?)` | Get a random sample of rows |
| `head(count?)` | Get the first n rows |
| `take(count?)` | Get the first n rows (alias for head) |
| `tail(count?)` | Get the last n rows |

##### Iteration Methods
| Method | Description |
|--------|-------------|
| `forEach(callback)` | Process rows with a callback |
| `forEachAsync(callback, options?)` | Process rows with an async callback with optional batch processing |
| `map<R>(callback)` | Map over rows to create a new array |
| `mapAsync<R>(callback, options?)` | Map over rows asynchronously with optional batch processing |
| `reduce<R>(callback, initialValue)` | Reduce the rows to a single value |
| `reduceAsync<R>(callback, initialValue, options?)` | Reduce rows asynchronously with optimized batch processing |

### Utility Functions

#### CSVUtils

| Function | Description |
|----------|-------------|
| `mergeRows(arrayA, arrayB, equalityFn, mergeFn)` | Merge two arrays of objects |
| `clone(obj)` | Deep clone an object |
| `isValidCSV(str)` | Check if a string is valid CSV |
| `writeCSV(filename, data, options?)` | Write data to a CSV file |
| `writeCSVAsync(filename, data, options?)` | Write data to a CSV file asynchronously |
| `createTransformer(transform)` | Create a CSV transformer stream |
| `processInWorker(operation, data)` | Execute a CPU-intensive operation in a worker thread |
| `processInParallel(items, operation, options?)` | Process data in parallel across multiple worker threads |

#### CSVArrayUtils

| Function | Description |
|----------|-------------|
| `arrayToObjArray(data, headerMap, headerRow?, mergeFn?)` | Transform arrays to objects with optional value transformation |
| `objArrayToArray(data, headerMap, headers?, includeHeaders?, transformFn?)` | Transform objects to arrays with optional value transformation |
| `groupByField(data, field)` | Group objects by a field value |

#### Generator Functions

| Function | Description |
|----------|-------------|
| `csvGenerator(filename, options?)` | Process CSV data with an async generator |
| `csvBatchGenerator(filename, options?)` | Process CSV data in batches |
| `writeCSVFromGenerator(filename, generator, options?)` | Write CSV data from a generator |

## Memory-Efficient Stream Processing

CSV Utils provides optimized streaming capabilities for working with large files efficiently.

### Creating a Stream Processor

```typescript
import CSV from '@doeixd/csv-utils';

// Create a stream processor for large files
const processor = CSV.streamFromFile<OrderData>('orders.csv')
  .filter(order => order.status === 'shipped')
  .map(order => ({
    id: order.id,
    total: order.price * order.quantity,
    customer: order.customerName
  }))
  .addColumn('processedAt', () => new Date());
```

### Processing Options

```typescript
// Option 1: Process row-by-row with a for-await loop (memory efficient)
for await (const row of processor) {
  console.log(`Order ${row.id} processed`);
}

// Option 2: Collect all results into a CSV instance
const results = await processor.prepareCollect().run();

// Option 3: Write directly to a file
await processor.prepareToFile('processed_orders.csv').run();

// Option 4: Process each row with a callback
await processor.prepareForEach(async row => {
  await database.updateOrder(row);
}).run();

// Option 5: Pipe to another stream
import fs from 'node:fs';
const writeStream = fs.createWriteStream('output.json');
processor.pipe(writeStream);
```

The stream processor uses a circular buffer to limit memory consumption and includes automatic backpressure handling to prevent memory issues when processing very large files.

#### Header Mapping

| Function | Description |
|----------|-------------|
| `createHeaderMapFns(headerMap, mergeFn?)` | Create functions for mapping between row arrays and objects with optional value transformation |

## Types and Interfaces

### CSVError
Custom error class for CSV operations with additional context.

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Error message |
| `cause` | `unknown` | Original error that caused this error |

### CSVStreamProcessor
Stream-based processor for large CSV files with fluent API.

#### Methods
| Method | Description |
|--------|-------------|
| `filter(condition)` | Filter rows based on a condition |
| `map<NewOutType>(transformFn)` | Transform rows using a mapping function |
| `addColumn<NewKey, NewValue>(columnName, valueOrFn)` | Add a new column to each row |
| `prepareCollect()` | Configure to collect results into a CSV instance |
| `prepareToFile(filename, writeOptions?)` | Configure to write output to a CSV file |
| `prepareForEach(callback)` | Configure to execute a callback for each row |
| `preparePipeTo(destination, options?)` | Configure to pipe output to a stream |
| `run()` | Execute the configured stream pipeline |
| `pipe(destination, options?)` | Pipe output to a writable stream |
| `[Symbol.asyncIterator]()` | Allow use in a `for await...of` loop |

### Caster
Definition for converting string values to typed values.

| Property | Type | Description |
|----------|------|-------------|
| `test` | `CastTestFunction` | Tests if a value should be cast |
| `parse` | `CastParseFunction<T>` | Converts the string to target type |

### CustomCastDefinition
Type-specific casters to apply to CSV values.

| Property | Type | Description |
|----------|------|-------------|
| `string?` | `Caster<string>` | String value caster |
| `number?` | `Caster<number>` | Number value caster |
| `boolean?` | `Caster<boolean>` | Boolean value caster |
| `date?` | `Caster<Date>` | Date value caster |
| `object?` | `Caster<object>` | Object value caster |
| `array?` | `Caster<any[]>` | Array value caster |
| `null?` | `Caster<null>` | Null value caster |

### CastingContext 
Context for casting functions.

| Property | Type | Description |
|----------|------|-------------|
| `column` | `string \| number` | Column name or index |
| `header` | `boolean` | Is it the header row? |
| `index` | `number` | Index of the field in the record |
| `lines` | `number` | Line number in the source |
| `records` | `number` | Number of records parsed so far |
| `empty_lines` | `number` | Count of empty lines |
| `invalid_field_length` | `number` | Count of rows with inconsistent field lengths |
| `quoting` | `boolean` | Is the field quoted? |

### SimilarityMatch
Result type for similarity matches.

| Property | Type | Description |
|----------|------|-------------|
| `row` | `T` | The matching row |
| `dist` | `number` | Levenshtein distance score |

### MergeFn

| Parameter | Type | Description |
|-----------|------|-------------|
| `obj` | `Partial<T>` | The partially constructed target object |
| `key` | `string` | The target path where the value will be stored (e.g., 'profile.firstName') |
| `value` | `any` | The original value from the source data |
| **returns** | `any` | The transformed value to be stored in the target object |

## Options Interfaces

### CSVReadOptions

| Option | Type | Description |
|--------|------|-------------|
| `fsOptions` | Object | File system options for reading |
| `csvOptions` | Object | CSV parsing options |
| `transform` | Function | Function to transform raw content |
| `headerMap` | HeaderMap | Header mapping configuration |
| `rawData` | boolean | Flag to indicate if input is raw data rather than a filename |
| `retry` | RetryOptions | Options for retry logic |
| `validateData` | boolean | Enable basic structural validation |
| `schema` | CSVSchemaConfig | Schema validation configuration (compatible with Zod) |
| `allowEmptyValues` | boolean | Allow empty values in the CSV |
| `saveAdditionalHeader` | boolean \| number | Controls extraction of initial lines as preamble |
| `additionalHeaderParseOptions` | Object | CSV parsing options for preamble lines |
| `customCasts` | Object | Custom type casting configuration |
| `customCasts.definitions` | CustomCastDefinition | Global casters for different types |
| `customCasts.columnCasts` | ColumnCastConfig | Column-specific casting rules |
| `customCasts.onCastError` | string | How to handle casting errors ('error', 'null', or 'original') |

### CSVWriteOptions

| Option | Type | Description |
|--------|------|-------------|
| `additionalHeader` | string | Content to prepend to the CSV |
| `stringifyOptions` | Object | Options for stringifying |
| `streaming` | boolean | Use streaming for large files |
| `headerMap` | HeaderMap | Header mapping configuration |
| `transformFn` | Function | Function to transform values during object-to-array conversion |
| `streamingThreshold` | number | Threshold for using streaming |
| `retry` | RetryOptions | Options for retry logic |

### CSVStreamOptions

| Option | Type | Description |
|--------|------|-------------|
| `csvOptions` | Object | CSV parsing options |
| `transform` | Function | Function to transform rows |
| `batchSize` | number | Size of batches (for csvBatchGenerator) |
| `headerMap` | HeaderMap | Header mapping for transformation |
| `mergeFn` | MergeFn | Function to customize value transformations during mapping |
| `retry` | RetryOptions | Options for retry logic |
| `useBuffering` | boolean | Use buffering for large files |
| `bufferSize` | number | Size of buffer when useBuffering is true |

### CSVSchemaConfig

| Option | Type | Description |
|--------|------|-------------|
| `rowSchema` | StandardSchemaV1 | Schema for validating entire rows (compatible with Zod) |
| `columnSchemas` | Object | Schemas for validating individual columns |
| `validationMode` | string | How to handle validation failures ('error', 'filter', or 'keep') |
| `useAsync` | boolean | Whether to use async validation (required for async schemas) |

### RowValidationResult

| Property | Type | Description |
|----------|------|-------------|
| `originalRow` | `Record<string, any>` | The original row data before validation |
| `validatedRow` | `T \| undefined` | The validated row data (if validation succeeded) | 
| `valid` | `boolean` | Whether the row passed validation |
| `rowIssues` | `StandardSchemaV1.Issue[]` | Issues found during row validation |
| `columnIssues` | `Record<string, StandardSchemaV1.Issue[]>` | Issues found during column validation |

### RetryOptions

| Option | Type | Description |
|--------|------|-------------|
| `maxRetries` | number | Maximum number of retry attempts |
| `baseDelay` | number | Base delay between retries (ms) |
| `logRetries` | boolean | Log retry attempts |

## Error Handling

The library uses a custom `CSVError` class that includes the original error as a `cause` property, making debugging easier:

```typescript
try {
  // Some CSV operation
} catch (error) {
  if (error instanceof CSVError) {
    console.error(`CSV Error: ${error.message}`);
    if (error.cause) {
      console.error('Original error:', error.cause);
    }
  }
}
```

## Typescript Support

This library is written in TypeScript and provides comprehensive type definitions. You can specify the expected structure of your data with interfaces or types:

```typescript
interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  inStock: boolean;
}

const products = CSV.fromFile<Product>('products.csv');
// All operations will now be properly typed
```

## License

MIT

## Schema Validation

The library supports validation of CSV data using the Standard Schema specification, allowing you to define validation rules for rows and individual columns.

### Using Standard Schema

```typescript
import CSV, { StandardSchemaV1 } from '@doeixd/csv-utils';

// Define a schema for validating email columns
const emailSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'csv-utils',
    validate: (value: unknown): StandardSchemaV1.Result<string> => {
      if (typeof value !== 'string') {
        return { issues: [{ message: 'Email must be a string' }] };
      }
      
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return { issues: [{ message: 'Invalid email format' }] };
      }
      
      return { value };
    },
    types: {
      input: '' as string,
      output: '' as string
    }
  }
};

// Load CSV with schema validation
const users = CSV.fromFile<User>('users.csv', {
  schema: {
    // Validate specific columns with dedicated schemas
    columnSchemas: {
      email: emailSchema
    },
    // How to handle validation failures: 'error', 'filter', or 'keep'
    validationMode: 'filter'
  }
});
```

### Using Zod

⚠️ **Note:** You must install Zod separately with `npm install zod`

```typescript
import CSV from '@doeixd/csv-utils';
import { z } from 'zod';

// Define Zod schemas for validating CSV data
const emailSchema = z.string().email("Invalid email format");

// Define a schema for validating entire user rows
const userSchema = z.object({
  id: z.string().min(1, "User ID is required"),
  name: z.string().min(1, "User name is required"),
  email: z.string().email("Invalid email format").optional()
});

// TypeScript type derived from the schema
type User = z.infer<typeof userSchema>;

// Load CSV with schema validation
const users = CSV.fromFile<User>('users.csv', {
  schema: {
    // Validate entire rows with Zod schema
    rowSchema: userSchema,
    validationMode: 'filter'
  }
});
```

### Working with Validation Results

```typescript
// When using validationMode: 'keep'
if (users.validationResults) {
  const invalidRows = users.validationResults.filter(result => !result.valid);
  console.log(`Found ${invalidRows.length} invalid rows`);
  
  // Check specific validation issues
  for (const result of invalidRows) {
    if (result.rowIssues) {
      console.log('Row issues:', result.rowIssues.map(i => i.message).join(', '));
    }
    
    if (result.columnIssues) {
      for (const [column, issues] of Object.entries(result.columnIssues)) {
        console.log(`Column '${column}' issues:`, issues.map(i => i.message).join(', '));
      }
    }
  }
}

// Validate existing CSV data
const validatedUsers = existingCSVData.validate({
  columnSchemas: {
    email: emailSchema
  },
  validationMode: 'filter'
});

// Async validation is also supported
const asyncValidatedUsers = await existingCSVData.validateAsync({
  rowSchema: userSchema,
  validationMode: 'keep'
});
```

## Common Options

This table summarizes the most commonly used options:

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `csvOptions` | `Object` | Settings for the CSV parser | `{ columns: true }` |
| `headerMap` | `Object` | Mapping between CSV columns and object properties | `undefined` |
| `customCasts` | `Object` | Custom type casting rules | `undefined` |
| `schema` | `Object` | Schema validation configuration | `undefined` |
| `validateData` | `boolean` | Validate structure of CSV data | `false` |
| `retry` | `Object` | Options for retrying failed operations | `undefined` |
| `streaming` | `boolean` | Use streaming for large files | `false` |

For complete details, see the [API Documentation](#api-documentation) section.

## Troubleshooting

### Common Issues

**Inconsistent Row Lengths**

```
Error: Row length mismatch at line 42: expected 5 columns but got 4
```

- Check for missing commas or quotes in your CSV
- Use `validateData: false` to skip validation if needed
- Inspect the raw file with `options.transform = content => { console.log(content); return content; }`

**Casting Errors**

```
Error: Failed to cast value "abc" to number for column "price"
```

- Check your custom casting definitions
- Use `customCasts.onCastError: 'original'` to preserve original values
- Use more specific test conditions in your casters

**Performance Issues with Large Files**

- Use streaming: `CSV.fromFileAsync()` or `CSV.streamFromFile()`
- Increase batch size: `{ batchSize: 5000 }`
- For read-only operations, use generators: `csvGenerator()` or `csvBatchGenerator()`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
