# Header Mapping

## Overview

Header mapping is a powerful feature in `csv-utils` that bridges the gap between flat CSV column structures and potentially nested JavaScript/TypeScript object models. It enables you to:

*   **Transform CSV data:** Convert rows with specific column names (e.g., "First Name", "User ID") into structured objects with properties like `profile.firstName` or `id`.
*   **Prepare objects for CSV export:** Convert your application's structured objects back into a flat format suitable for CSV files, with desired column headers.
*   **Integrate with diverse data sources:** Seamlessly work with CSVs whose column naming or structure doesn't match your internal data models.
*   **Decouple data format from application logic:** Maintain a clean separation between how data is stored/exchanged and how it's used internally.

## Core Concept: Defining the Map

A `HeaderMap<T>` is an object where:
*   **Keys** represent the source:
    *   For **CSV-to-Object** mapping (reading): CSV column headers (strings) or column indices (numbers).
    *   For **Object-to-CSV** mapping (writing): Object property paths (e.g., `'id'`, `'profile.firstName'`).
*   **Values** represent the destination:
    *   For **CSV-to-Object** mapping: Object property paths.
    *   For **Object-to-CSV** mapping: Desired CSV column headers.
*   Special configuration objects can be used as values (for reading) or keys (for writing) to handle advanced scenarios like mapping to/from array properties.

```typescript
import { HeaderMap } from '@doeixd/csv-utils'; // Assuming HeaderMap is exported

interface User {
  id: string;
  profile: { firstName: string; lastName: string; };
  contactEmail: string;
}

// Example: Mapping CSV columns TO User object properties (for reading)
const csvToUserMap: HeaderMap<User> = {
  'User_ID': 'id',
  'GivenName': 'profile.firstName',
  'Surname': 'profile.lastName',
  'Email Address': 'contactEmail'
};

// Example: Mapping User object properties TO CSV columns (for writing)
const userToCsvMap: HeaderMap<User> = {
  'id': 'User ID', // 'id' property becomes 'User ID' column
  'profile.firstName': 'First Name',
  'profile.lastName': 'Last Name',
  'contactEmail': 'Email'
};
```

## Using Header Maps

### Reading CSV Files (CSV-to-Object)

When reading, `headerMap` keys are CSV column names, and values are target object property paths.

```typescript
import CSV from '@doeixd/csv-utils';
// ... (User interface and csvToUserMap defined above) ...

// CSV file 'users_import.csv' might have columns: User_ID, GivenName, Surname, Email Address
const users = CSV.fromFile<User>('users_import.csv', {
  headerMap: csvToUserMap
});

// The resulting `users` CSV instance will contain objects like:
// {
//   id: "101",
//   profile: { firstName: "John", lastName: "Doe" },
//   contactEmail: "john.doe@example.com"
// }
```

### Writing CSV Files (Object-to-CSV)

When writing, `headerMap` keys are object property paths, and values are the desired CSV column headers.

```typescript
// ... (users CSV instance populated as above, userToCsvMap defined) ...

users.writeToFile('users_export.csv', {
  headerMap: userToCsvMap,
  stringifyOptions: { header: true } // Ensures the mapped headers are written
});

// 'users_export.csv' will have columns: User ID, First Name, Last Name, Email
```

### Direct Array Processing (using `CSVArrayUtils`)

For direct array transformations without the full `CSV` class wrapper:

```typescript
import { CSVArrayUtils, HeaderMap } from '@doeixd/csv-utils';

interface Product { sku: string; name: string; price: number; }

// --- Array of arrays TO Array of objects ---
const rawCsvData = [ // Typically, data rows without the header
  ['A123', 'Laptop', 999.99],
  ['B456', 'Mouse', 49.99]
];
const arrayToObjectMap: HeaderMap<Product> = {
  0: 'sku',    // CSV column index 0 -> 'sku' property
  1: 'name',
  2: 'price'
};
const productObjects = CSVArrayUtils.arrayToObjArray<Product>(rawCsvData, arrayToObjectMap);

// --- Array of objects TO Array of arrays ---
const objectToArrayMap: HeaderMap<Product> = { // Source object path -> Destination array index/header
  'sku': 0, // or 'SKU_ID' if using named headers
  'name': 1, // or 'Product_Name'
  'price': 2 // or 'Unit_Cost'
};
const csvHeaders = ['SKU_ID', 'Product_Name', 'Unit_Cost'];
const csvRows = CSVArrayUtils.objArrayToArray<Product>(
  productObjects,
  objectToArrayMap,
  csvHeaders, // Provide headers if map values are strings, or for output
  true        // true to include the header_row in the output
);
// csvRows[0] will be ['SKU_ID', 'Product_Name', 'Unit_Cost']
```

## Advanced Usage: Array Mapping

A key feature is mapping multiple CSV columns to/from a single array property in your objects. This is useful for data with a variable number of related values (e.g., image URLs, tags, measurements).

Special configuration objects (`CsvToArrayConfig` for reading, `ObjectArrayToCsvConfig` for writing) are used within the `HeaderMap` for this.

#### Mapping Multiple CSV Columns to an Array Property (`CsvToArrayConfig`)

When reading a CSV, you can gather values from several columns into one array on your target object.

```typescript
import { HeaderMap, CsvToArrayConfig } from '@doeixd/csv-utils';

interface Product {
  id: string;
  name: string;
  imageUrls: string[];
}

// Config key (e.g., '_imageConfig') is a placeholder, not a CSV column name.
const mapCsvToProductWithImages: HeaderMap<Product> = {
  'ProductID': 'id',
  'ProductName': 'name',
  '_imageConfig': { // This key starting with '_' signals a configuration object
    _type: 'csvToTargetArray',         // Identifies the mapping type
    targetPath: 'imageUrls',           // The array property in the `Product` interface
    // Option 1: Use a regex pattern for source columns
    sourceCsvColumnPattern: /^IMG_URL_(\d+)$/, // Matches CSV columns like IMG_URL_1, IMG_URL_2
    sortSourceColumnsBy: (match) => parseInt(match[1], 10), // Optional: sort matched columns (e.g., by number)
    // Option 2: Explicitly list source CSV columns (if no clear pattern)
    // sourceCsvColumns: ['ProductPhotoMain', 'ProductPhotoThumb', 'ProductPhotoAngle1'],
    transformValue: (value) => value ? value.trim() : null, // Optional: transform each value
    filterEmptyValues: true, // Optional: if true, null/empty strings after transform are not added
  } as CsvToArrayConfig
};

// Example CSV ('products_with_images.csv'):
// ProductID,ProductName,IMG_URL_2,ExtraInfo,IMG_URL_1
// P123,Awesome Gadget,gadget_thumb.jpg,SomeData,gadget_main.jpg

// const products = CSV.fromFile<Product>('products_with_images.csv', { headerMap: mapCsvToProductWithImages });
// products.toArray()[0].imageUrls would be ['gadget_main.jpg', 'gadget_thumb.jpg'] (due to sortSourceColumnsBy)
```

#### Mapping an Array Property to Multiple CSV Columns (`ObjectArrayToCsvConfig`)

When writing objects to CSV, you can spread an array property out into multiple columns.

```typescript
import { HeaderMap, ObjectArrayToCsvConfig } from '@doeixd/csv-utils';
// ... (Product interface as above)

// The key 'imageUrls' MUST match the array property name in your `Product` object.
const mapProductWithImagesToCsv: HeaderMap<Product> = {
  'id': 'ProductID',
  'name': 'ProductName',
  'imageUrls': { // Key matches the source array property
    _type: 'targetArrayToCsv',        // Identifies the mapping type
    // Option 1: Define a prefix for generated CSV column names
    targetCsvColumnPrefix: 'ImageColumn_', // Creates CSV columns: ImageColumn_0, ImageColumn_1, ...
    // Option 2: Explicitly define target CSV column names
    // targetCsvColumns: ['MainImage', 'ThumbnailImage', 'AlternateImage1'],
    maxColumns: 3,                    // Generate up to this many columns for the array
    emptyCellOutput: '',              // Value for CSV cells if array is shorter than maxColumns
    transformValue: (value) => value.toLowerCase(), // Optional: transform each array item before writing
  } as ObjectArrayToCsvConfig
};

// const productsData = CSV.fromData<Product>([
//   { id: 'P123', name: 'Test Product', imageUrls: ['IMG1.JPG', 'IMG2.JPG'] }
// ]);
// productsData.writeToFile('output_products_array.csv', { headerMap: mapProductWithImagesToCsv });
// 'output_products_array.csv' would have columns: ProductID, ProductName, ImageColumn_0, ImageColumn_1, ImageColumn_2
// And row: P123,Test Product,img1.jpg,img2.jpg,""
```

## Interaction with Custom Type Casting

Custom type casting is applied *after* header mapping. This allows you to first structure your data (e.g., placing a value into `metadata.joinedAt`) and then apply a custom caster to that specific, now correctly pathed, property.

```typescript
import CSV, { Caster, HeaderMap, CSVReadOptions } from '@doeixd/csv-utils';

interface User {
  id: string;
  profile: { firstName: string; lastName: string; };
  metadata: { joinedAt: Date; loginCount: number; };
}

const userCsvToObjectMapper: HeaderMap<User> = {
  'UID': 'id',
  'FIRST': 'profile.firstName',
  'LAST': 'profile.lastName',
  'JOIN_STAMP': 'metadata.joinedAt', // CSV has 'JOIN_STAMP'
  'LOGINS': 'metadata.loginCount'    // CSV has 'LOGINS'
};

const dateCaster: Caster<Date> = { /* ... Caster to parse date strings ... */
  test: v => typeof v === 'string' && !isNaN(new Date(v).getTime()), parse: v => new Date(v)
};
const numberCaster: Caster<number> = { /* ... Caster for numbers ... */
  test: v => typeof v === 'string' && !isNaN(Number(v)), parse: v => Number(v)
};

const readOptions: CSVReadOptions<User> = {
  headerMap: userCsvToObjectMapper,
  customCasts: {
    definitions: { date: dateCaster, number: numberCaster },
    // IMPORTANT: columnCasts keys refer to the OBJECT PROPERTY PATHS *after* header mapping.
    columnCasts: {
      'metadata.joinedAt': 'date',    // Apply date caster to the 'metadata.joinedAt' property
      'metadata.loginCount': 'number' // Apply number caster to 'metadata.loginCount'
    }
  }
};

// const users = CSV.fromFile<User>('user_data.csv', readOptions);
// users.toArray()[0].metadata.joinedAt will be a Date object.
// typeof users.toArray()[0].metadata.loginCount will be 'number'.
```

## Bidirectional Mapping Considerations

While you can manually create an "inverse" map for reading vs. writing, `csv-utils` does not automatically invert `HeaderMap` objects. This is because:
*   Mappings can be many-to-one (multiple CSV columns to one object property).
*   Array mapping configurations (`CsvToArrayConfig`, `ObjectArrayToCsvConfig`) are directional and not trivially invertible.
*   Transformations might be different for read vs. write.

It's generally clearest to define separate `HeaderMap` configurations for reading (CSV-to-Object) and writing (Object-to-CSV) if the transformations are not simple 1:1 symmetrical mappings.

## Partial Mapping

Your `HeaderMap` does not need to include every CSV column or every object property.
*   **Reading:** CSV columns not present as keys in the `headerMap` will typically be included in the resulting objects using their original header names (if `csvOptions.columns` is true and they don't conflict with mapped properties).
*   **Writing:** Object properties not present as keys in the `headerMap` will typically be written to CSV columns using the property name as the header (if `stringifyOptions.header` is true and `stringifyOptions.columns` is not set to restrict columns).

## Type Safety

Using the generic `HeaderMap<T>` provides some compile-time checking with TypeScript, helping to ensure that object property paths in the map are valid for the type `T`.

```typescript
// If User interface does not have an 'email' property:
// const invalidMap: HeaderMap<User> = {
//   'EmailColumn': 'email', // TypeScript may flag 'email' as an invalid path for User.
// };
```

## Implementation Notes

The header mapping functionality relies on `createHeaderMapFns`, which internally uses robust methods (like Lodash `get` and `set` or similar logic) to handle nested property access and assignment.

## Performance Considerations

*   Header mapping itself adds minimal overhead.
*   For very large files, all header mapping operations are compatible with streaming APIs (`CSV.streamFromFile()`, `csvGenerator`, etc.), ensuring efficient processing.

