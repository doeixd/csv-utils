# Preamble Handling in CSV Files

## Overview

CSV files often include introductory lines before the main data and headers. This "preamble" or "additional header" can contain metadata, comments, version information, or other contextual details. The `@doeixd/csv-utils` library provides robust features to manage these preambles:

*   **Extract and Store:** Capture preamble lines when reading CSV files and store them as a string.
*   **Custom Preamble Parsing:** Optionally parse the preamble lines themselves using different CSV parsing rules if they have a structured format (e.g., key-value pairs). The parsed result is then re-stringified into the stored `additionalHeader`.
*   **Prepend to Output:** Add custom or preserved preamble content when writing CSV files.
*   **Flexible Configuration:** Control preamble extraction based on line counts or in conjunction with the main data's starting line.

**Note:** Preamble handling features described here are primarily available for synchronous and full-file asynchronous read methods like `CSV.fromFile()`, `CSV.fromString()`, and `CSV.fromFileAsync()`. They are **not** part of the low-level streaming APIs like `CSV.streamFromFile()` or the `csvGenerator` functions, which begin processing directly from the configured data start line.

## Reading CSVs with Preambles

### Configuring Preamble Extraction

The `saveAdditionalHeader` option in `CSVReadOptions` controls how the preamble is extracted:

1.  **`saveAdditionalHeader: number` (e.g., `3`)**:
    *   Extracts exactly the specified number of lines from the beginning of the file as the preamble.
    *   The main CSV data parsing will then start from the line *after* these preamble lines, **unless** `csvOptions.from_line` (or `from` / `fromLine`) is set to an even later line number, in which case `from_line` takes precedence for the data start.

    ```typescript
    // Example: Extract first 2 lines as preamble, data starts on line 3
    const csv1 = CSV.fromFile('data.csv', {
      saveAdditionalHeader: 2 // Extracts lines 1-2 for preamble
      // Data parsing will implicitly start from line 3
    });

    // Example: Extract first 2 lines, but data parsing explicitly starts later
    const csv2 = CSV.fromFile('data.csv', {
      saveAdditionalHeader: 2,
      csvOptions: {
        from_line: 5 // Preamble is lines 1-2; Data parsing starts at line 5
      }
    });
    ```

2.  **`saveAdditionalHeader: true`**:
    *   This mode works in conjunction with `csvOptions.from_line` (or `from` / `fromLine`).
    *   If `from_line` is set to a value greater than 1, then `from_line - 1` lines will be extracted as the preamble.
    *   If `from_line` is not set, or is 1, no preamble is extracted with `saveAdditionalHeader: true`.

    ```typescript
    // Example CSV ('data_with_header.csv'):
    // # Comment line 1
    // # Comment line 2
    // --- End of Preamble ---
    // ID,Name,Value  <-- This is line 4
    // 1,Apple,10

    const csv3 = CSV.fromFile('data_with_header.csv', {
      saveAdditionalHeader: true,
      csvOptions: {
        from_line: 4 // Data starts at line 4
      }
    });
    // csv3.additionalHeader will contain lines 1-3
    // "# Comment line 1\n# Comment line 2\n--- End of Preamble ---\n" (actual line endings preserved)
    ```

3.  **`saveAdditionalHeader: false | undefined | 0`**:
    *   No preamble is extracted. This is the default behavior.

The extracted preamble is stored as a single string in the `csvInstance.additionalHeader` property, with original line endings typically preserved.

### Custom Parsing for Preamble Content (`additionalHeaderParseOptions`)

If the preamble lines themselves have a CSV-like structure (e.g., key:value pairs, different delimiters), you can provide `additionalHeaderParseOptions`. These are `csv-parse` options used *only* to parse the extracted preamble lines. The result of this parsing is then re-stringified (using default `csv-stringify` options) to form the `additionalHeader` string property.

```typescript
// Example: Preamble uses '|' delimiter, main data uses ','
// File 'structured_preamble.csv':
// MetaKey|MetaValue
// Version|1.0.5
// Date|2024-01-15
// ---
// ID,DataPoint
// A,100

const csvWithStructuredPreamble = CSV.fromFile('structured_preamble.csv', {
  saveAdditionalHeader: 3, // Lines 1-3 are preamble
  csvOptions: {
    from_line: 5, // Main data starts at line 5
    delimiter: ','
  },
  additionalHeaderParseOptions: {
    delimiter: '|',
    columns: false, // Preamble parsed as array of arrays
    // Other relevant options: quote, escape, record_delimiter, trim, etc.
  }
});

// csvWithStructuredPreamble.additionalHeader might be:
// "MetaKey|MetaValue\nVersion|1.0.5\nDate|2024-01-15\n"
// (The result of parsing with '|' then re-stringifying the array of arrays)
```
**Note:** Options like `columns`, `from_line`, `to_line` within `additionalHeaderParseOptions` will be overridden internally for preamble extraction. Use it primarily for format-defining options like `delimiter`, `quote`, `escape`, `trim`, `bom`. If `additionalHeaderParseOptions` is not provided, but `saveAdditionalHeader` is active, the library might inherit some low-level parsing options (like `delimiter`, `quote`) from the main `csvOptions` for consistency if the preamble is simple text per line.

### Accessing the Preamble

```typescript
const csv = CSV.fromFile('data_with_header.csv', {
  saveAdditionalHeader: true,
  csvOptions: { from_line: 4 }
});

if (csv.additionalHeader) {
  console.log("Preamble Content:");
  console.log(csv.additionalHeader);
}

const data = csv.toArray(); // Main CSV data
```

## Writing CSVs with Preambles

You can prepend a string to your CSV output using the `additionalHeader` property in `CSVWriteOptions`.

```typescript
const dataToWrite = [
  { id: 1, name: 'Item A', value: 10.5 },
  { id: 2, name: 'Item B', value: 20.75 }
];
const csvInstance = CSV.fromData(dataToWrite);

const preambleText =
  `# File Generated: ${new Date().toISOString()}\n` +
  `# Source System: MyApp v2.1\n` +
  `# Record Count: ${dataToWrite.length}\n`;

csvInstance.writeToFile('output_with_preamble.csv', {
  additionalHeader: preambleText
});

// 'output_with_preamble.csv' will contain:
// # File Generated: 2024-01-18T...
// # Source System: MyApp v2.1
// # Record Count: 2
// id,name,value
// 1,Item A,10.5
// 2,Item B,20.75
```

### Preserving an Original Preamble

If you read a CSV with a preamble and want to write it back out (perhaps after modifying the data), you can use the stored `additionalHeader`.

```typescript
const originalCsv = CSV.fromFile('input.csv', {
  saveAdditionalHeader: true,
  csvOptions: { from_line: 3 }
});

const modifiedData = originalCsv.updateColumn('value', val => parseFloat(val) * 1.1);

modifiedData.writeToFile('output_modified.csv', {
  additionalHeader: originalCsv.additionalHeader // Use the preamble read from input.csv
});
```

## Advanced Usage Scenarios

### Programmatic Preamble Generation

Dynamically create preamble content based on your data or application state.

```typescript
const dataForCsv = [ /* ... your data ... */ ];
const csv = CSV.fromData(dataForCsv);

function generatePreamble(recordCount: number): string {
  return `# Report Generated: ${new Date().toLocaleDateString()}\n` +
         `# Total Records: ${recordCount}\n` +
         `# Data Version: 1.3\n`;
}

csv.writeToFile('report.csv', {
  additionalHeader: generatePreamble(csv.count())
});
```

### Parsing Information from Preamble Strings

If you need to extract structured data from the `additionalHeader` string after reading:

```typescript
const csvFile = CSV.fromFile('data_with_metadata_preamble.csv', {
  saveAdditionalHeader: true,
  csvOptions: { from_line: 4 }
});

interface PreambleMetadata {
  version?: string;
  generatedDate?: Date;
  source?: string;
}

function parseMetadataFromPreamble(preambleString?: string): PreambleMetadata {
  const metadata: PreambleMetadata = {};
  if (!preambleString) return metadata;

  preambleString.split('\n').forEach(line => {
    const matchVersion = line.match(/^#\s*Version:\s*(.+)/i);
    if (matchVersion) metadata.version = matchVersion[1].trim();

    const matchDate = line.match(/^#\s*Generated on:\s*(.+)/i);
    if (matchDate) metadata.generatedDate = new Date(matchDate[1].trim());
    // Add more regex or parsing logic for other fields
  });
  return metadata;
}

const extractedMetadata = parseMetadataFromPreamble(csvFile.additionalHeader);
if (extractedMetadata.version) {
  console.log(`File Version: ${extractedMetadata.version}`);
}
```

## Implementation Details Summary

*   **Reading:**
    1.  The library first determines the number of preamble lines to extract based on `saveAdditionalHeader` and `csvOptions.from_line`.
    2.  These lines are read from the input.
    3.  If `additionalHeaderParseOptions` are provided, these preamble lines are parsed as CSV content, then re-stringified to form the `additionalHeader` string. Otherwise, the raw lines (joined by newlines) form the `additionalHeader`.
    4.  The main CSV parser (`csv-parse`) is then configured to start parsing from the line immediately following the preamble (or the `csvOptions.from_line` if it's later).
    5.  The `additionalHeader` string is stored on the `CSV` instance.
*   **Writing:**
    1.  If `CSVWriteOptions.additionalHeader` is provided, its string content is written to the output file first.
    2.  The main CSV data is then stringified and appended to the file.

This approach ensures that preamble content is handled distinctly from the primary CSV data, allowing for flexible management of metadata and comments.