# Custom Type Casting

## Overview

Custom casting in `csv-utils` offers a sophisticated mechanism to transform raw string values from your CSV into precise JavaScript/TypeScript types. While the underlying `csv-parse` library provides some basic type conversion, this feature elevates that capability, allowing for:

*   **Advanced Type Detection & Conversion:** Implement custom logic to identify and parse complex string formats.
*   **Column-Specific Rules:** Apply different casting logic to different columns.
*   **Fallback Casting Chains:** Define multiple casters for a column, tried in order until one succeeds.
*   **Granular Error Handling:** Choose how casting failures are managed (error, null, or original value).
*   **Full Parsing Control:** Tailor the conversion process to your exact data requirements.

Custom casting is applied *after* initial CSV parsing (and optional header mapping) but *before* schema validation or general data use. This ensures your data is correctly typed and structured when your application logic begins to interact with it.

## Core Concepts

Custom casting is built upon three main components:

1.  **`Caster`**: An object containing `test` and `parse` methods. The `test` method determines if the caster can handle a given string value, and the `parse` method performs the actual conversion.
2.  **`CustomCastDefinition`**: A collection of named, reusable `Caster` objects (e.g., for 'number', 'date', 'boolean'). These serve as a library of global casters.
3.  **`ColumnCastConfig`**: Configuration that specifies which casters (either by name from `CustomCastDefinition` or directly as `Caster` objects) should be applied to specific columns.

### The `Caster<TargetType>` Interface

A `Caster` defines the logic for identifying and converting a string to a `TargetType`.

```typescript
interface Caster<TargetType> {
  /**
   * Tests if a string value is a candidate for this caster.
   * @param value The string value from the CSV cell.
   * @param context Contextual information about the current cell.
   * @returns True if this caster should attempt to parse the value.
   */
  test: (value: string, context: CastingContext) => boolean;

  /**
   * Parses the string value into the target type.
   * This method is called only if `test` returns true.
   * @param value The string value to parse.
   * @param context Contextual information about the current cell.
   * @returns The parsed value of TargetType.
   * @throws If parsing fails and the error handling policy is 'error'.
   */
  parse: (value: string, context: CastingContext) => TargetType;
}
```

### The `CastingContext`

The `CastingContext` object is passed to both `test` and `parse` methods, providing useful metadata about the cell being processed:

```typescript
interface CastingContext {
  column: string | number;   // Column name (if headers used) or numeric index.
  header: boolean;           // True if the current row is the header row.
  index: number;             // Zero-based index of the field within the current record.
  lines: number;             // Line number in the source CSV file (1-based).
  records: number;           // Number of data records parsed so far (0-based, excludes header).
  empty_lines: number;       // Count of empty lines encountered.
  invalid_field_length: number; // Count of records with inconsistent field lengths.
  quoting: boolean;          // True if the original field was quoted.
}
```

## Creating Custom Casters

### Example: Versatile Number Caster

This caster handles numbers that might include currency symbols, commas, or percentage signs.

```typescript
import { Caster } from '@doeixd/csv-utils'; // Assuming Caster is exported

const versatileNumberCaster: Caster<number> = {
  test: (value) => {
    if (typeof value !== 'string') return false;
    // Regex to check for optional currency, digits, commas, optional decimal, optional percent
    return /^[$€£]?[\d,]+(\.\d+)?%?$/.test(value.trim());
  },
  parse: (value) => {
    const cleanedString = value.trim().replace(/[$€£,]/g, ''); // Remove currency and commas
    if (cleanedString.endsWith('%')) {
      return parseFloat(cleanedString.slice(0, -1)) / 100; // Handle percentage
    }
    return parseFloat(cleanedString);
  }
};
```

### Example: Flexible Date Caster

This caster attempts to parse common date string formats.

```typescript
const flexibleDateCaster: Caster<Date> = {
  test: (value) => {
    if (typeof value !== 'string') return false;
    // Simple check for common date-like patterns. More robust regex might be needed.
    return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$|^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(value.trim());
  },
  parse: (value) => {
    const date = new Date(value.trim());
    if (isNaN(date.getTime())) { // Check if the date is valid
      throw new Error(`Invalid date format: "${value}"`);
    }
    return date;
  }
};
```

### Example: Comprehensive Boolean Caster

Handles various string representations of true/false.

```typescript
const comprehensiveBooleanCaster: Caster<boolean> = {
  test: (value) => {
    if (typeof value !== 'string') return false;
    const lowerVal = value.toLowerCase().trim();
    return ['true', 'false', 'yes', 'no', '1', '0', 'y', 'n', 'on', 'off'].includes(lowerVal);
  },
  parse: (value) => {
    const lowerVal = value.toLowerCase().trim();
    return ['true', 'yes', '1', 'y', 'on'].includes(lowerVal);
  }
};
```

### Using `CastingContext`

The context can be used to make casters more intelligent.

```typescript
// Example: Caster that applies only to specific columns
const columnSpecificCurrencyCaster: Caster<number> = {
  test: (value, context) => {
    // Only apply to 'price' or 'amount' columns
    return (context.column === 'price' || context.column === 'amount') &&
           typeof value === 'string' && value.startsWith('$');
  },
  parse: (value) => parseFloat(value.substring(1))
};
```

## Applying Custom Casters

Custom casters are configured within the `customCasts` option when reading CSV data.

```typescript
import CSV, { CSVReadOptions, Caster } from '@doeixd/csv-utils';

interface Transaction {
  transaction_id: string;
  amount: number;
  transaction_date: Date;
  is_approved: boolean;
}

// (Define versatileNumberCaster, flexibleDateCaster, comprehensiveBooleanCaster as above)

const readOptions: CSVReadOptions<Transaction> = {
  customCasts: {
    // 1. Global Definitions: Reusable casters accessible by key.
    definitions: {
      robustNumber: versatileNumberCaster,
      smartDate: flexibleDateCaster,
      flexibleBool: comprehensiveBooleanCaster,
      // A simple string caster (often, no specific string caster is needed if default parsing is fine)
      text: {
        test: (value) => typeof value === 'string',
        parse: (value) => value.trim()
      }
    },
    // 2. Column-Specific Rules: Which casters to apply to which columns.
    columnCasts: {
      // For 'amount', use the globally defined 'robustNumber' caster.
      'amount': 'robustNumber',
      // For 'transaction_date', use the 'smartDate' caster.
      'transaction_date': 'smartDate',
      // For 'is_approved', use the 'flexibleBool' caster.
      'is_approved': 'flexibleBool',
      // For 'transaction_id', ensure it's a trimmed string.
      'transaction_id': 'text'
    },
    // 3. Error Handling Policy: What to do if a caster's `parse` method throws an error.
    onCastError: 'null' // Options: 'error' (default), 'null', 'original'
  }
};

// Assuming 'transactions.csv' columns match: transaction_id,amount,transaction_date,is_approved
const transactions = CSV.fromFile<Transaction>('transactions.csv', readOptions);

// Data in `transactions` will now have types according to the casters:
const firstTransaction = transactions.toArray()[0];
if (firstTransaction) {
  console.log(typeof firstTransaction.amount); // 'number'
  console.log(firstTransaction.transaction_date instanceof Date); // true
  console.log(typeof firstTransaction.is_approved); // 'boolean'
}
```

### Fallback Casting (Multiple Attempts)

For columns with varied data formats, you can provide an array of casters (by name or as direct objects). They are tried in order until one successfully tests and parses the value.

```typescript
const readOptionsWithFallback: CSVReadOptions<any> = {
  customCasts: {
    definitions: {
      isoDate: { /* Caster for YYYY-MM-DD */ test: v => /^\d{4}-\d{2}-\d{2}$/.test(v), parse: v => new Date(v) },
      slashDate: { /* Caster for MM/DD/YYYY */ test: v => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v), parse: v => new Date(v) },
      currencyUSD: { test: v => v.startsWith('$'), parse: v => parseFloat(v.substring(1))},
      numberSimple: { test: v => !isNaN(parseFloat(v)), parse: v => parseFloat(v) }
    },
    columnCasts: {
      'payment_date': ['isoDate', 'slashDate'], // Try ISO date, then slash date
      'value': [
        'currencyUSD', // First, try to parse as USD currency
        { // Then, an inline caster for EUR currency
          test: (value) => typeof value === 'string' && value.startsWith('€'),
          parse: (value) => parseFloat(value.substring(1)) * 1.1 // Example: convert to USD
        },
        'numberSimple' // Finally, as a plain number
      ]
    },
    onCastError: 'null'
  }
};
```

### Error Handling Policies (`onCastError`)

The `onCastError` property in `customCasts` controls behavior when a selected caster's `parse` function throws an error:

*   `'error'` (Default): The error is propagated, and the entire CSV loading process fails. This is strict and ensures data integrity.
*   `'null'`: The value for the cell where casting failed is set to `null`. Processing continues.
*   `'original'`: The original string value (as received by the custom caster) is kept for that cell. Processing continues.

```typescript
// Example: Prefer to keep original string on failure
const optionsKeepOriginal: CSVReadOptions<any> = {
  customCasts: {
    // ... definitions and columnCasts ...
    onCastError: 'original'
  }
};
```

## TypeScript Integration and Type Safety

Custom casting is particularly powerful with TypeScript. By defining an interface for your expected row structure and configuring casters to match those types, you gain strong type safety throughout your application.

```typescript
interface ProductData {
  id: string;
  productName: string;
  unitPrice: number;     // Expect number
  availableStock: number;// Expect number
  isPerishable: boolean; // Expect boolean
  manufactureDate: Date; // Expect Date object
}

const productReadOptions: CSVReadOptions<ProductData> = {
  headerMap: { /* Map CSV headers to ProductData properties */
    'SKU': 'id', 'Name': 'productName', 'Price': 'unitPrice',
    'StockCount': 'availableStock', 'Perishable': 'isPerishable', 'MfgDate': 'manufactureDate'
  },
  customCasts: {
    definitions: { /* ... your defined robustNumber, smartDate, flexibleBool casters ... */ },
    columnCasts: {
      'unitPrice': 'robustNumber',
      'availableStock': 'robustNumber',
      'isPerishable': 'flexibleBool',
      'manufactureDate': 'smartDate'
    },
    onCastError: 'error' // Fail fast if types are not as expected
  }
};

const products = CSV.fromFile<ProductData>('inventory.csv', productReadOptions);

// `products.toArray()` will yield an array of `ProductData` objects
// with correctly typed properties.
products.toArray().forEach(p => {
  const totalPrice = p.unitPrice * p.availableStock; // Type-safe numeric operations
  if (p.isPerishable && p.manufactureDate < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
    console.warn(`${p.productName} might be expiring soon!`);
  }
});
```

## Advanced Use Cases

### Parsing Custom Enums

```typescript
enum OrderStatus {
  Pending = "PENDING",
  Processing = "IN_PROGRESS",
  Shipped = "SHIPPED",
  Cancelled = "CANCELLED"
}

const orderStatusCaster: Caster<OrderStatus | null> = {
  test: (value) => typeof value === 'string' && Object.values(OrderStatus).includes(value.toUpperCase() as OrderStatus),
  parse: (value) => value.toUpperCase() as OrderStatus
};

// In CSVReadOptions:
// customCasts: { columnCasts: { 'current_status': orderStatusCaster } }
```

### Handling Explicit Null Values

Define a caster to convert various string representations (empty string, "NULL", "N/A") to `null`.

```typescript
const explicitNullCaster: Caster<null> = {
  test: (value) => {
    if (typeof value !== 'string') return false;
    const lowerVal = value.toLowerCase().trim();
    return lowerVal === '' || lowerVal === 'null' || lowerVal === 'na' || lowerVal === 'n/a' || lowerVal === 'undefined';
  },
  parse: () => null
};

// In CSVReadOptions:
// customCasts: {
//   definitions: { 'toNull': explicitNullCaster, /* other casters */ },
//   columnCasts: {
//     'optional_field': ['toNull', /* other casters if not null */]
//   }
// }
```
This `toNull` caster could be placed first in a fallback chain for columns that might contain these null representations but otherwise have a specific type.

### Casting Embedded JSON

If a CSV cell contains a JSON string, you can parse it into an object or array.

```typescript
const jsonObjectCaster: Caster<object> = {
  test: (value) => {
    if (typeof value !== 'string' || !value.trim().startsWith('{') || !value.trim().endsWith('}')) return false;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch { return false; }
  },
  parse: (value) => JSON.parse(value)
};

const jsonArrayCaster: Caster<any[]> = {
  test: (value) => {
    if (typeof value !== 'string' || !value.trim().startsWith('[') || !value.trim().endsWith(']')) return false;
    try { return Array.isArray(JSON.parse(value)); } catch { return false; }
  },
  parse: (value) => JSON.parse(value)
};

// In CSVReadOptions:
// customCasts: {
//   definitions: { 'jsonObject': jsonObjectCaster, 'jsonArray': jsonArrayCaster },
//   columnCasts: { 'metadata_json': 'jsonObject', 'tags_json_array': 'jsonArray' }
// }
```

## Order of Data Processing Steps

When reading a CSV file with `csv-utils`, operations are applied in this sequence:

1.  **Initial Parsing (`csv-parse`):** The raw CSV string is parsed into records. Basic type conversions from `csv-parse` (if enabled via its `cast` option) occur here.
2.  **Header Mapping (Optional):** If `headerMap` is provided in `CSVReadOptions`, CSV column names are mapped to object property paths, and the data structure might change (e.g., from flat to nested).
3.  **Custom Casting (Optional):** If `customCasts` is provided, the defined casters are applied to the (potentially header-mapped) string values.
4.  **Schema Validation (Optional):** If a `schema` is provided, the (now custom-cast and typed) data is validated against it.
5.  **Basic Data Validation (Optional):** If `validateData` is `true` in `CSVReadOptions`, a basic structural check is performed (e.g., ensuring all rows are objects if headers were used).

This order ensures that custom casting operates on data that has already undergone initial parsing and structural mapping, and prepares the data with correct types before any schema validation.

## Performance Considerations

While custom casting is highly flexible, keep performance in mind for very large datasets:

*   **Efficient `test` Functions:** The `test` function of a caster is called for many values. Keep its logic as simple and fast as possible. Regular expressions, if complex, can impact performance; profile if necessary.
*   **Targeted Casting:** Prefer `columnCasts` to apply specific casters only where needed, rather than relying solely on broad global `definitions` that test every value against every caster.
*   **Order in Fallbacks:** When using an array of casters for a column, place the most common or fastest-testing casters first in the array.
*   **Streaming:** For truly massive files, custom casting works seamlessly with the streaming API (`CSV.streamFromFile()`), ensuring memory usage remains low.

## Conclusion

Custom casting is a cornerstone feature of `csv-utils`, transforming it from a simple CSV parser into a powerful data ingestion and typing tool. By defining precise rules for how string data should be interpreted and converted, you can ensure data quality and type safety from the moment it enters your application, streamlining subsequent processing and reducing runtime errors.