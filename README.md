# CSV Utils

[![npm version](https://img.shields.io/npm/v/@doeixd/csv-utils.svg)](https://www.npmjs.com/package/@doeixd/csv-utils)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A TypeScript library for CSV manipulation with strong typing. This library provides comprehensive utilities for parsing, transforming, analyzing, and writing CSV data with support for complex operations like header mapping, streaming for large files, and async processing.

## Features

- **🚀 Fluent API** - Chain methods for elegant data manipulation
- **🔒 Type Safety** - Comprehensive TypeScript support with generic types
- **🧩 Header Mapping** - Transform between CSV columns and nested object structures
- **📊 Data Analysis** - Rich query, filtering, and aggregation capabilities
- **📈 Transformation** - Powerful data conversion and manipulation tools
- **⚡ Async Support** - Process large files with generators and streams
- **🛡️ Error Handling** - Robust error recovery with retry mechanisms
- **📝 Documentation** - Extensive examples and API documentation

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

## Examples

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

### Header Mapping

The library provides powerful utilities for mapping between CSV columns and structured objects with nested properties:

```typescript
import { createHeaderMapFns } from '@doeixd/csv-utils';

// Define a mapping between CSV headers and object properties
const headerMap = {
  'user_id': 'id',
  'first_name': 'profile.firstName',
  'last_name': 'profile.lastName',
  'email': 'contact.email',
  'phone': 'contact.phone'
};

// Create mapping functions
const { fromRowArr, toRowArr } = createHeaderMapFns<User>(headerMap);

// Convert CSV row to structured object
const csvRow = {
  user_id: '123',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
  phone: '555-1234'
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
//     email: 'john@example.com',
//     phone: '555-1234'
//   }
// }

// Convert back to array format
const headers = ['user_id', 'first_name', 'last_name', 'email', 'phone'];
const rowArray = toRowArr(user, headers);
// Result: ['123', 'John', 'Doe', 'john@example.com', '555-1234']
```

### Reading with Header Mapping

```typescript
import CSV from '@doeixd/csv-utils';

// Define interface for your data
interface User {
  id: string;
  profile: {
    firstName: string;
    lastName: string;
  };
  settings: {
    theme: string;
    notifications: boolean;
  };
}

// Define header mapping
const headerMap = {
  'user_id': 'id',
  'first_name': 'profile.firstName',
  'last_name': 'profile.lastName',
  'theme': 'settings.theme',
  'notifications': 'settings.notifications'
};

// Read CSV file with automatic transformation
const users = CSV.fromFile<User>('users.csv', { 
  headerMap,
  validateData: true // Optional validation of structure
});

console.log(users.toArray());
```

### Writing with Header Mapping

```typescript
import CSV, { CSVUtils } from '@doeixd/csv-utils';

// Define output header mapping (nested properties to flat CSV)
const outputMap = {
  'id': 'ID',
  'profile.firstName': 'First Name',
  'profile.lastName': 'Last Name',
  'settings.theme': 'Theme',
  'settings.notifications': 'Notifications'
};

// Write structured data to CSV with transformation
users.writeToFile('users_export.csv', { 
  headerMap: outputMap,
  streamingThreshold: 500 // Use streaming for datasets > 500 rows
});

// Or use the static utility
CSVUtils.writeCSV('users_export.csv', users.toArray(), { 
  headerMap: outputMap 
});
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

### Asynchronous Operations

```typescript
import CSV from '@doeixd/csv-utils';

// Async file reading with streams
const data = await CSV.fromFileAsync('large_file.csv');

// Process rows asynchronously
await data.forEachAsync(async (row, index) => {
  // Perform async operations on each row
  const result = await someAsyncOperation(row);
  console.log(`Processed row ${index}: ${result}`);
});

// Transform data asynchronously
const transformed = await data.mapAsync(async (row) => {
  const details = await fetchAdditionalData(row.id);
  return { ...row, ...details };
});

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

#### Instance Methods

##### Data Retrieval
| Method | Description |
|--------|-------------|
| `toArray()` | Get data as an array |
| `toString(options?)` | Convert data to a CSV string |
| `count()` | Get the number of rows |
| `getBaseRow(defaults?)` | Create a base row template |
| `createRow(data?)` | Create a new row with the CSV structure |

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

##### Analysis Methods
| Method | Description |
|--------|-------------|
| `groupBy(column)` | Group rows by values in a column |
| `sortBy(column, direction?)` | Sort rows by a column |
| `aggregate(column, operation?)` | Calculate aggregate values for a column |
| `distinct(column)` | Get unique values from a column |
| `pivot(rowColumn, colColumn, valueColumn)` | Create a pivot table |
| `sample(count?)` | Get a random sample of rows |
| `head(count?)` | Get the first n rows |
| `tail(count?)` | Get the last n rows |

##### Iteration Methods
| Method | Description |
|--------|-------------|
| `forEach(callback)` | Process rows with a callback |
| `forEachAsync(callback)` | Process rows with an async callback |
| `map<R>(callback)` | Map over rows to create a new array |
| `mapAsync<R>(callback)` | Map over rows asynchronously |
| `reduce<R>(callback, initialValue)` | Reduce the rows to a single value |
| `reduceAsync<R>(callback, initialValue)` | Reduce the rows asynchronously |

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

#### CSVArrayUtils

| Function | Description |
|----------|-------------|
| `arrayToObjArray(data, headerMap, headerRow?)` | Transform arrays to objects |
| `objArrayToArray(data, headerMap, headers?, includeHeaders?)` | Transform objects to arrays |
| `groupByField(data, field)` | Group objects by a field value |

#### Generator Functions

| Function | Description |
|----------|-------------|
| `csvGenerator(filename, options?)` | Process CSV data with an async generator |
| `csvBatchGenerator(filename, options?)` | Process CSV data in batches |
| `writeCSVFromGenerator(filename, generator, options?)` | Write CSV data from a generator |

#### Header Mapping

| Function | Description |
|----------|-------------|
| `createHeaderMapFns(headerMap)` | Create functions for mapping between row arrays and objects |

## Options Interfaces

### CSVReadOptions

| Option | Type | Description |
|--------|------|-------------|
| `fsOptions` | Object | File system options for reading |
| `csvOptions` | Object | CSV parsing options |
| `transform` | Function | Function to transform raw content |
| `headerMap` | HeaderMap | Header mapping configuration |
| `retry` | RetryOptions | Options for retry logic |
| `validateData` | boolean | Enable data validation |
| `allowEmptyValues` | boolean | Allow empty values in the CSV |

### CSVWriteOptions

| Option | Type | Description |
|--------|------|-------------|
| `additionalHeader` | string | Content to prepend to the CSV |
| `stringifyOptions` | Object | Options for stringifying |
| `streaming` | boolean | Use streaming for large files |
| `headerMap` | HeaderMap | Header mapping configuration |
| `streamingThreshold` | number | Threshold for using streaming |
| `retry` | RetryOptions | Options for retry logic |

### CSVStreamOptions

| Option | Type | Description |
|--------|------|-------------|
| `csvOptions` | Object | CSV parsing options |
| `transform` | Function | Function to transform rows |
| `batchSize` | number | Size of batches (for csvBatchGenerator) |
| `headerMap` | HeaderMap | Header mapping for transformation |
| `retry` | RetryOptions | Options for retry logic |
| `useBuffering` | boolean | Use buffering for large files |
| `bufferSize` | number | Size of buffer when useBuffering is true |

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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.