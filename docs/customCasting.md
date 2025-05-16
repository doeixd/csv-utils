# Custom Casting

## Overview

Custom casting provides a powerful way to transform CSV string values into appropriate JavaScript/TypeScript types. While the underlying csv-parse library offers basic type conversion, the custom casting feature in csv-utils allows for:

- More sophisticated type detection and conversion
- Column-specific casting rules
- Chainable fallback casting attempts
- Robust error handling policies
- Complete control over the parsing process

This happens after the CSV is initially parsed but before the data is used by the application, ensuring that your data has the correct types when you start working with it.

## Basic Concepts

Custom casting revolves around three core components:

1. **Caster**: An object with `test` and `parse` functions that determines if it can handle a value and converts it.
2. **CustomCastDefinition**: A collection of named casters for common types like numbers, dates, booleans, etc.
3. **ColumnCastConfig**: Configuration specifying which casters to apply to which columns.

### The Caster Interface

```typescript
interface Caster<TargetType> {
  /**
   * Tests if a string value is a candidate for this caster
   * @returns True if this caster should attempt to parse the value
   */
  test: (value: string, context: CastingContext) => boolean;
  
  /**
   * Parses the string value into the target type
   * Called only if `test` returns true
   * @returns The parsed value of TargetType
   * @throws If parsing fails and strict error handling is desired
   */
  parse: (value: string, context: CastingContext) => TargetType;
}
```

### The Casting Context

The `CastingContext` provides information about the current field being cast:

```typescript
interface CastingContext {
  column: string | number;   // Column name or index
  header: boolean;           // Is it the header row?
  index: number;             // Index of the field in the record
  lines: number;             // Line number in the source
  records: number;           // Number of records parsed so far
  empty_lines: number;       // Count of empty lines
  invalid_field_length: number; // Count of rows with inconsistent lengths
  quoting: boolean;          // Is the field quoted?
}
```

## Creating Custom Casters

### Basic Casters

```typescript
// A number caster that handles commas and currency symbols
const numberCaster: Caster<number> = {
  test: (value) => /^[$€£]?[\d,]+(\.\d+)?%?$/.test(value.trim()),
  parse: (value) => {
    const cleanValue = value.trim().replace(/[$€£,]/g, '');
    if (cleanValue.endsWith('%')) {
      return parseFloat(cleanValue.replace('%', '')) / 100;
    }
    return parseFloat(cleanValue);
  }
};

// A date caster that handles common date formats
const dateCaster: Caster<Date> = {
  test: (value) => {
    // Check for common date formats
    return /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-\d{1,2}-\d{4})$/.test(value.trim());
  },
  parse: (value) => {
    // For simple cases, letting the Date constructor handle it
    return new Date(value);
  }
};

// A boolean caster with various true/false representations
const booleanCaster: Caster<boolean> = {
  test: (value) => {
    const lower = value.toLowerCase().trim();
    return ['true', 'false', 'yes', 'no', '1', '0', 'y', 'n'].includes(lower);
  },
  parse: (value) => {
    const lower = value.toLowerCase().trim();
    return ['true', 'yes', '1', 'y'].includes(lower);
  }
};
```

### Advanced Casters Using the Context

```typescript
// A date caster that uses context information
const smartDateCaster: Caster<Date> = {
  test: (value, context) => {
    // Only test date strings for specific columns
    if (context.column === 'birthdate' || context.column === 'joinDate') {
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    }
    return false;
  },
  parse: (value, context) => {
    // Could apply different parsing logic for different columns
    return new Date(value);
  }
};

// A caster that uses line number to handle header rows differently
const headerAwareCaster: Caster<any> = {
  test: (value, context) => !context.header,
  parse: (value, context) => {
    // Only parse if not in header row
    return value; // Apply transformations as needed
  }
};
```

## Using Custom Casting

### Basic Usage

```typescript
import CSV, { Caster } from '@doeixd/csv-utils';

// Define custom casters
const numberCaster: Caster<number> = {
  test: (value) => !isNaN(parseFloat(value)) && isFinite(Number(value)),
  parse: (value) => parseFloat(value)
};

const dateCaster: Caster<Date> = {
  test: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  parse: (value) => new Date(value)
};

// Read CSV file with custom casting
const users = CSV.fromFile<User>('users.csv', {
  customCasts: {
    definitions: {
      number: numberCaster,
      date: dateCaster,
      boolean: {
        test: (value) => ['true', 'false', 'yes', 'no'].includes(value.toLowerCase()),
        parse: (value) => ['true', 'yes'].includes(value.toLowerCase())
      }
    },
    columnCasts: {
      'age': 'number',
      'registered': 'date',
      'active': 'boolean'
    }
  }
});

// The data now has the correct types
console.log(typeof users.toArray()[0].age); // 'number'
console.log(users.toArray()[0].registered instanceof Date); // true
console.log(typeof users.toArray()[0].active); // 'boolean'
```

### Column-Specific Casting with Multiple Attempts

```typescript
// Read CSV with column-specific fallback casting
const orders = CSV.fromFile<Order>('orders.csv', {
  customCasts: {
    definitions: {
      number: numberCaster,
      date: dateCaster
    },
    columnCasts: {
      // Try multiple options for the price column
      'price': [
        // First try a custom caster
        {
          test: (value) => value.startsWith('$'),
          parse: (value) => parseFloat(value.substring(1))
        },
        // Fall back to the standard number caster
        'number'
      ],
      // Try multiple date formats for the orderDate column
      'orderDate': [
        // Try ISO format first
        {
          test: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
          parse: (value) => new Date(value)
        },
        // Then try MM/DD/YYYY format
        {
          test: (value) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value),
          parse: (value) => {
            const [month, day, year] = value.split('/').map(Number);
            return new Date(year, month - 1, day);
          }
        }
      ]
    },
    // Define error handling policy
    onCastError: 'null' // options: 'error', 'null', 'original'
  }
});
```

### Error Handling Policies

The `onCastError` option determines what happens when a caster's `parse` function throws an error:

- `'error'` (default): Propagates the error, failing the CSV loading
- `'null'`: Sets the value to null
- `'original'`: Keeps the original string value

```typescript
// CSV with strict error handling
const strictData = CSV.fromFile<StrictData>('data.csv', {
  customCasts: {
    // ...casters and column configuration...
    onCastError: 'error' // Will throw an error if any parsing fails
  }
});

// CSV with null-fallback handling
const nullFallbackData = CSV.fromFile<NullableData>('data.csv', {
  customCasts: {
    // ...casters and column configuration...
    onCastError: 'null' // Will set value to null if parsing fails
  }
});
```

## TypeScript Integration

The custom casting works especially well with TypeScript, allowing your parsed CSV data to match your type definitions:

```typescript
// Define the expected structure
interface Product {
  id: string;
  name: string;
  price: number; // Note these type expectations
  inStock: boolean;
  createdAt: Date;
}

// CSV might contain strings, but after parsing:
const products = CSV.fromFile<Product>('products.csv', {
  customCasts: {
    // ...casters configuration...
  }
});

// Now products match the Product interface with correct types
products.toArray().forEach(product => {
  // These operations are all type-safe:
  const priceWithTax = product.price * 1.07;
  const daysAvailable = (Date.now() - product.createdAt.getTime()) / (1000*60*60*24);
  if (product.inStock === true) {
    // Do something...
  }
});
```

## Advanced Use Cases

### Custom Enum Parsing

```typescript
enum Status {
  Pending = "PENDING",
  Approved = "APPROVED",
  Rejected = "REJECTED"
}

// Create a caster for the Status enum
const statusCaster: Caster<Status> = {
  test: (value) => {
    const upper = value.toUpperCase();
    return upper === 'PENDING' || upper === 'APPROVED' || upper === 'REJECTED';
  },
  parse: (value) => {
    const upper = value.toUpperCase();
    return upper as Status;
  }
};

// Use the enum caster for a specific column
const applications = CSV.fromFile<Application>('applications.csv', {
  customCasts: {
    columnCasts: {
      'status': statusCaster
    }
  }
});
```

### Creating a Null Caster

```typescript
// A caster for null values
const nullCaster: Caster<null> = {
  test: (value) => {
    const lower = value.toLowerCase().trim();
    return lower === '' || lower === 'null' || lower === 'na' || lower === 'n/a';
  },
  parse: () => null
};

// Apply globally for any column
const data = CSV.fromFile<Data>('data.csv', {
  customCasts: {
    definitions: {
      null: nullCaster,
      // Other casters...
    }
  }
});
```

### JSON Object/Array Casting

```typescript
// A caster for JSON objects
const objectCaster: Caster<object> = {
  test: (value) => {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  },
  parse: (value) => JSON.parse(value)
};

// A caster for JSON arrays
const arrayCaster: Caster<any[]> = {
  test: (value) => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed);
    } catch {
      return false;
    }
  },
  parse: (value) => JSON.parse(value)
};

// Use for columns that contain serialized JSON
const data = CSV.fromFile<ComplexData>('data.csv', {
  customCasts: {
    definitions: {
      object: objectCaster,
      array: arrayCaster
    },
    columnCasts: {
      'metadata': 'object',
      'tags': 'array'
    }
  }
});
```

## Order of Operations

The processing sequence when reading a CSV file is:

1. CSV parsing with csv-parse (with any native casting from `csvOptions`)
2. Header mapping (if `headerMap` is provided)
3. Custom casting (if `customCasts` is provided)
4. Data validation (if `validateData` is true)

This order ensures that custom casting occurs after structural transformations but before validation, giving you the most flexibility and control over your data.

## Performance Considerations

When implementing custom casters, keep these performance tips in mind:

- Keep `test` functions simple and fast, as they run on every value
- Consider using column-specific casters rather than relying on global casters for everything
- For very large files, use streaming and batch processing with custom casting
- When using multiple fallback casters for a column, order them from most to least likely to match

## Conclusion

Custom casting provides a powerful way to ensure your CSV data has the correct types when working with it in your application. By defining specific casting rules and handling policies, you can transform raw strings into rich, typed data structures that match your application's needs.