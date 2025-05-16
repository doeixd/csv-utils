# Header Mapping

## Overview

Header mapping provides a powerful way to transform between flat CSV structures and nested JavaScript/TypeScript objects. It allows you to:

- Transform CSV columns with human-readable names to structured objects with nested properties
- Convert structured objects back to flat CSV rows for export
- Work seamlessly with external data sources that don't match your internal data model
- Maintain clean separation between storage format and application model

## Basic Concepts

A header map is an object that defines the relationship between:

- CSV column headers or array indices (the keys)
- Object property paths (the values)

```typescript
// Example header map
const headerMap: HeaderMap<User> = {
  'First Name': 'profile.firstName',  // Maps CSV column to nested property
  'Last Name': 'profile.lastName',    // Maps CSV column to nested property
  'User ID': 'id',                   // Maps CSV column to root property
  'Join Date': 'metadata.joinedAt'    // Maps CSV column to nested property
};
```

## Creating Header Maps

### For Object-to-Object Mapping

When your CSV has headers and you want to map to a structured object:

```typescript
interface User {
  id: string;
  profile: {
    firstName: string;
    lastName: string;
  };
  metadata: {
    joinedAt: string;
  };
}

const headerMap: HeaderMap<User> = {
  'User ID': 'id',
  'First Name': 'profile.firstName',
  'Last Name': 'profile.lastName',
  'Join Date': 'metadata.joinedAt'
};
```

### For Array-to-Object Mapping

When your CSV data is represented as arrays and you want to map to a structured object:

```typescript
interface Product {
  sku: string;
  name: string;
  price: number;
}

const headerMap: HeaderMap<Product> = {
  0: 'sku',    // First column maps to sku
  1: 'name',   // Second column maps to name
  2: 'price'   // Third column maps to price
};
```

## Using Header Maps

### Reading CSV Files

```typescript
// Read a CSV file and apply header mapping
const users = CSV.fromFile<User>('users.csv', {
  headerMap: {
    'User ID': 'id',
    'First Name': 'profile.firstName',
    'Last Name': 'profile.lastName',
    'Join Date': 'metadata.joinedAt'
  }
});

// The resulting User objects will have nested properties
// {
//   id: "1001",
//   profile: {
//     firstName: "John",
//     lastName: "Doe"
//   },
//   metadata: {
//     joinedAt: "2023-01-15"
//   }
// }
```

### Writing CSV Files

```typescript
// Write structured objects to a CSV file with header mapping
users.writeToFile('exported-users.csv', {
  headerMap: {
    'id': 'User ID',
    'profile.firstName': 'First Name',
    'profile.lastName': 'Last Name',
    'metadata.joinedAt': 'Join Date'
  }
});

// The CSV will have columns: "User ID", "First Name", "Last Name", "Join Date"
```

### Processing Arrays

The library provides utility functions for working with arrays:

```typescript
// Convert array data to structured objects
const rawData = [
  ['A123', 'Laptop', 999.99],
  ['B456', 'Mouse', 49.99]
];

const products = arrayToObjArray<Product>(
  rawData,
  { 0: 'sku', 1: 'name', 2: 'price' }
);

// Convert structured objects back to arrays
const csvRows = objArrayToArray<Product>(
  products,
  { 'sku': 0, 'name': 1, 'price': 2 },
  ['SKU', 'NAME', 'PRICE'],
  true // include headers
);
```

## Advanced Usage

### Custom Type Casting with Header Mapping

When header mapping is used together with custom casting, the casting is applied after the header mapping is performed. This allows you to transform both the structure and types of your data:

```typescript
interface User {
  id: string;
  profile: {
    firstName: string;
    lastName: string;
  };
  metadata: {
    joinedAt: Date;  // Note this is a Date type, not a string
    activeDays: number;
  };
}

// Define header mapping
const headerMap: HeaderMap<User> = {
  'User ID': 'id',
  'First Name': 'profile.firstName',
  'Last Name': 'profile.lastName',
  'Join Date': 'metadata.joinedAt',
  'Active Days': 'metadata.activeDays'
};

// Define custom casting
const dateCaster: Caster<Date> = {
  test: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  parse: (value) => new Date(value)
};

// Read CSV with both header mapping and custom casting
const users = CSV.fromFile<User>('users.csv', {
  headerMap,
  customCasts: {
    definitions: {
      date: dateCaster,
      number: {
        test: (value) => !isNaN(Number(value)),
        parse: (value) => Number(value)
      }
    },
    columnCasts: {
      'metadata.joinedAt': 'date',
      'metadata.activeDays': 'number'
    }
  }
});

// Now users have properly structured and typed data:
// - Nested object structure from header mapping
// - Properly typed values from custom casting
console.log(users.toArray()[0].metadata.joinedAt instanceof Date); // true
console.log(typeof users.toArray()[0].metadata.activeDays); // 'number'
```

### Bidirectional Mapping

You can use the same header map in both directions by swapping keys and values:

```typescript
// Define mapping once
const userFieldMap = {
  'id': 'User ID',
  'profile.firstName': 'First Name',
  'profile.lastName': 'Last Name'
};

// Create inverse mapping for reading
const csvToObjectMap = Object.entries(userFieldMap).reduce((map, [key, value]) => {
  map[value] = key;
  return map;
}, {} as HeaderMap<User>);

// Use for reading
const users = CSV.fromFile<User>('users.csv', { headerMap: csvToObjectMap });

// Use original map for writing
users.writeToFile('export.csv', { headerMap: userFieldMap });
```

### Partial Mapping

You don't need to map every field - only the ones you want to transform:

```typescript
// Only map specific fields
const partialMap: HeaderMap<User> = {
  'First Name': 'profile.firstName',
  'Last Name': 'profile.lastName'
};

// Other fields in the CSV will be ignored
```

### Type Safety

The `HeaderMap<T>` type parameter provides TypeScript validation:

```typescript
// TypeScript will flag errors for invalid paths
const invalidMap: HeaderMap<User> = {
  'Email': 'email', // Error if User has no email property
  'First Name': 'profile.firstName' // Valid if User has profile.firstName
};
```

## Implementation Details

Internally, header mapping uses the `createHeaderMapFns` function which provides two key functions:

1. `fromRowArr`: Transforms a row (array or object) into a structured object
2. `toRowArr`: Transforms a structured object back into a row array

The implementation uses Lodash's `get` and `set` functions to handle nested property paths safely.

## Handling Special Cases

### Null and Undefined Values

- When reading CSVs, empty fields are typically mapped to empty strings
- When writing CSVs, `null` and `undefined` values are typically written as empty strings

### Complex Objects

- When writing nested objects that don't have a 1:1 field mapping, they are automatically converted to JSON strings
- Arrays are preserved as-is when possible

## Performance Considerations

Header mapping adds minimal overhead during processing. For very large files:

- Consider using streaming operations with header mapping
- The `csvGenerator` and `csvBatchGenerator` functions both support header mapping
- For optimal performance with large datasets, use batch processing

```typescript
// Process large files in batches with header mapping
for await (const batch of csvBatchGenerator<User>('large-file.csv', {
  headerMap: userHeaderMap,
  batchSize: 1000
})) {
  // Process 1000 records at a time
}
```