# Preamble Handling in CSV Files

## Overview

CSV files sometimes contain metadata, comments, or additional information before the actual CSV data begins. This section before the headers and data is often called a "preamble" or "additional header." The @doeixd/csv-utils library provides robust support for handling these preambles, allowing you to:

- Extract and preserve preamble lines when reading CSV files
- Add preamble content when writing CSV files
- Configure custom parsing options for preamble lines
- Automatically detect and handle prelude content

## Reading CSVs with Preambles

### Basic Usage

To read a CSV file that contains preamble information before the actual data:

```typescript
// Example CSV file with preamble:
// # Generated on: 2023-12-25
// # Version: 1.0.0
// # Notes: This is sample data
// id,name,value
// 1,Item A,10.5
// 2,Item B,20.75

// Read the CSV and capture the preamble lines
const csv = CSV.fromFile('data-with-preamble.csv', {
  saveAdditionalHeader: true,
  csvOptions: {
    from_line: 4 // Start parsing from line 4 (first data line after preamble)
  }
});

// Access the captured preamble content
console.log(csv.additionalHeader);
// "# Generated on: 2023-12-25
// # Version: 1.0.0
// # Notes: This is sample data"

// Process the CSV data normally
const data = csv.toArray();
```

### Configuration Options

The `saveAdditionalHeader` option controls preamble extraction:

```typescript
// Specify exact number of lines to treat as preamble
const csv = CSV.fromFile('data.csv', {
  saveAdditionalHeader: 3, // Extract exactly 3 lines as preamble
  csvOptions: {
    from_line: 4  // Start parsing from line 4
  }
});

// Auto-detect preamble based on from_line setting
const csv = CSV.fromFile('data.csv', {
  saveAdditionalHeader: true, // Extract from_line - 1 lines as preamble
  csvOptions: {
    from_line: 4  // Start parsing from line 4, so 3 lines for preamble
  }
});
```

### Custom Parsing Options for Preamble

You can specify different parsing options for the preamble content:

```typescript
const csv = CSV.fromFile('data.csv', {
  saveAdditionalHeader: true,
  csvOptions: {
    from_line: 4,
    delimiter: ','
  },
  additionalHeaderParseOptions: {
    delimiter: '|',      // Use different delimiter for preamble
    quote: '"',          // Specify quote character
    escape: '\\',        // Specify escape character
    record_delimiter: '\r\n'  // Specify record delimiter
  }
});
```

### Handling Preamble Lines

How `saveAdditionalHeader` controls preamble extraction:

- `saveAdditionalHeader: number > 0`: Extracts exactly that number of lines as preamble.
- `saveAdditionalHeader: true`: If `csvOptions.from_line` > 1, extracts `from_line - 1` lines as preamble.
- `saveAdditionalHeader: false | undefined | 0`: No preamble extraction.

## Writing CSVs with Preambles

To write a CSV file with preamble content:

```typescript
// Create a CSV instance
const csv = CSV.fromData([
  { id: 1, name: 'Item A', value: 10.5 },
  { id: 2, name: 'Item B', value: 20.75 }
]);

// Write to file with preamble content
csv.writeToFile('output.csv', {
  additionalHeader: '# Generated on: 2023-12-25\n# Version: 1.0.0\n# Notes: This is export data'
});

// Result in output.csv:
// # Generated on: 2023-12-25
// # Version: 1.0.0
// # Notes: This is export data
// id,name,value
// 1,Item A,10.5
// 2,Item B,20.75
```

### Preserving Original Preamble

You can preserve the original preamble when reading and writing:

```typescript
// Read CSV with preamble
const csv = CSV.fromFile('input.csv', {
  saveAdditionalHeader: true,
  csvOptions: {
    from_line: 4
  }
});

// Modify data
const modifiedCsv = csv.update(/* some modifications */);

// Write back with the same preamble
modifiedCsv.writeToFile('output.csv', {
  additionalHeader: csv.additionalHeader
});
```

## Advanced Usage

### Combining with Schema Validation

You can use preamble handling together with schema validation:

```typescript
// Define a schema for the CSV data
const schema: CSVSchemaConfig<Item> = {
  rowSchema: /* your schema definition */,
  columnSchemas: {
    id: /* schema for id column */,
    value: /* schema for value column */
  }
};

// Read CSV with both preamble extraction and schema validation
const csv = CSV.fromFile<Item>('data.csv', {
  saveAdditionalHeader: true,
  csvOptions: { from_line: 3 },
  schema
});

// Access validated data and preamble
const validData = csv.toArray();
const metadata = csv.additionalHeader;
```

### Programmatically Adding Preamble Information

You can generate preamble content dynamically:

```typescript
const generateMetadata = () => {
  const now = new Date();
  return [
    `# Generated on: ${now.toISOString()}`,
    `# Generator: My Application v1.0`,
    `# Records: ${data.length}`
  ].join('\n');
};

// Write CSV with dynamically generated preamble
csv.writeToFile('output.csv', {
  additionalHeader: generateMetadata()
});
```

### Parsing Preamble Content

You can extract structured information from the preamble:

```typescript
const csv = CSV.fromFile('data.csv', {
  saveAdditionalHeader: true,
  csvOptions: { from_line: 5 }
});

// Parse metadata from preamble
const parseMetadata = (preamble: string) => {
  const result: Record<string, string> = {};
  
  preamble.split('\n').forEach(line => {
    if (line.startsWith('# ')) {
      const content = line.substring(2);
      const colonIndex = content.indexOf(':');
      
      if (colonIndex > 0) {
        const key = content.substring(0, colonIndex).trim();
        const value = content.substring(colonIndex + 1).trim();
        result[key] = value;
      }
    }
  });
  
  return result;
};

const metadata = parseMetadata(csv.additionalHeader);
console.log(metadata);
// { "Generated on": "2023-12-25", "Version": "1.0.0", "Notes": "This is sample data" }
```

## Best Practices

1. **Consistent Format**: Maintain a consistent format for your preamble information.
2. **Documentation**: Document the expected preamble format for your CSV files.
3. **Validation**: Consider validating preamble content if it contains important configuration information.
4. **Separation**: Use a clear separator (like comment markers #) to distinguish preamble from CSV data.
5. **Automation**: When possible, automate the extraction and generation of preamble information.

## Implementation Details

Internally, the library handles preamble extraction by:

1. First reading the specified number of lines from the file
2. Capturing these lines as the preamble/additional header
3. Starting the standard CSV parsing from the specified `from_line`
4. Storing the preamble in the `additionalHeader` property of the CSV instance

When writing files with preambles, the library simply prepends the preamble content to the CSV output before writing to the file.