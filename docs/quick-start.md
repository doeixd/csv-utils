# CSV Utils - Quick Start Guide! 🚀

Tired of wrestling with CSV files? `csv-utils` is your go-to TypeScript library for reading, writing, and powerfully manipulating CSV data with type safety and a smile!

## The Core Idea: Fluent Data Handling

1.  **Load:** Read your CSV into an easy-to-use `CSV` object.
2.  **Transform & Query:** Chain intuitive methods (`filter`, `map`, `sort`, `update`, etc.) to shape your data. *These methods return new `CSV` objects, keeping your original data untouched!*
3.  **Use/Save:** Get your results as an array, a CSV string, or write directly to a new file.

## Installation

```bash
npm install @doeixd/csv-utils
# or
yarn add @doeixd/csv-utils
```

## Key Superpowers ✨

*   **Simple Read/Write:** From files, strings, or arrays.
*   **Fluent Chaining:** Write clean, readable data pipelines.
*   **Type Safe:** Catch errors early with great TypeScript support.
*   **Smart Header Mapping:** Effortlessly connect CSV columns to your object structures (even nested ones!).
*   **Big File Friendly (Streaming):** Process huge CSVs smoothly without memory headaches.
*   **Data Validation:** Ensure data quality with schema validation (works great with Zod!).
*   **Standalone Functions:** Prefer a functional style? We've got you covered!

## Let's Get Started! (Common Tasks)

Imagine this `products.csv`:

```csv
ID,Product Name,Category,Unit Price,Stock
P001,Laptop Pro,Electronics,1200.00,50
P002,Coffee Maker,Appliances,79.99,120
P003,Gaming Mouse,Electronics,45.50,0
P004,Desk Chair,Furniture,150.00,30
```

And your TypeScript interface:

```typescript
interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  status?: string; // We'll add this later
}
```

### 1. Reading Your CSV

```typescript
import CSV from '@doeixd/csv-utils';

// CSV values are initially strings. We'll convert them next.
const productsCsv = CSV.fromFile<Product>('products.csv');
console.log(`Loaded ${productsCsv.count()} products.`); // Output: Loaded 4 products.
```

### 2. Converting Data Types (Casting)

Strings from CSVs often need to be numbers, dates, etc.

```typescript
// Simple casting for a few columns:
let typedProducts = productsCsv
  .castColumnType('price', 'number')
  .castColumnType('stock', 'number');

// For more complex needs or many columns, `customCasts` during load is powerful:
// const typedProducts = CSV.fromFile<Product>('products.csv', {
//   customCasts: {
//     definitions: { number: { test: v => !isNaN(parseFloat(v)), parse: v => parseFloat(v) }},
//     columnCasts: { price: 'number', stock: 'number' }
//   }
// });

const firstProduct = typedProducts.toArray()[0];
console.log(`Product: ${firstProduct.name}, Price Type: ${typeof firstProduct.price}`);
// Output: Product: Laptop Pro, Price Type: number
```

### 3. Finding the Data You Need (Filtering)

```typescript
// Remember, `typedProducts` is our CSV object with correct types.
const electronicsOnly = typedProducts.findRowsWhere(p => p.category === 'Electronics');
console.log(`Found ${electronicsOnly.length} electronics.`); // Output: Found 2 electronics.

const outOfStock = typedProducts.findRowWhere(p => p.stock === 0); // Finds the first match
if (outOfStock) {
  console.log(`${outOfStock.name} is out of stock.`); // Output: Gaming Mouse is out of stock.
}
```
**Heads Up!** Methods like `findRowWhere` return *direct references* to objects in the `CSV` instance. If you modify them directly, the original `CSV` data changes. To modify safely without side effects, either clone the result (`CSVUtils.clone(foundObject)`) or use update methods (see below).

### 4. Transforming Your Data (Updating)

Methods like `addColumn` or `updateWhere` return a **new `CSV` instance** with your changes, leaving the original untouched.

```typescript
// Add a 'status' column based on stock levels
const productsWithStatus = typedProducts.addColumn('status', (row) =>
  row.stock > 0 ? 'In Stock' : 'Out of Stock'
);

// Give all Furniture a 10% discount
const finalProducts = productsWithStatus.updateWhere(
  p => p.category === 'Furniture',
  (row) => ({ price: row.price * 0.9 }) // Update only the price for matching rows
);

const discountedChair = finalProducts.findRow('P004', 'id');
console.log(`Discounted chair price: ${discountedChair?.price}`); // Output: 135
```

### 5. Sorting Your Results

```typescript
// Sort by price, highest first. Again, returns a new CSV instance.
const sortedProducts = finalProducts.sortBy('price', 'desc');
console.log(`Most expensive: ${sortedProducts.head(1).toArray()[0].name}`);
// Output: Most expensive: Laptop Pro
```

### 6. Getting Your Data Out

```typescript
// As an array of Product objects
const productArray: Product[] = sortedProducts.toArray();

// As a CSV formatted string (includes headers by default)
const csvString: string = sortedProducts.toString();
// console.log(csvString);
```

### 7. Saving to a New CSV File

```typescript
sortedProducts.writeToFile('final_products_report.csv');
// This creates 'final_products_report.csv' with your transformed data.
```

### 8. Mapping CSV Headers to Object Properties

What if your CSV headers are `PRODUCT_ID` and `CATEGORY_NAME`, but your interface uses `id` and `category`? `headerMap` to the rescue!

```typescript
interface Item { itemId: string; itemCategory: string; /* ... */ }

const itemMap = {
  'PRODUCT_ID': 'itemId', // CSV header 'PRODUCT_ID' maps to 'itemId' property
  'CATEGORY_NAME': 'itemCategory'
};

const items = CSV.fromFile<Item>('items_with_custom_headers.csv', {
  headerMap: itemMap,
  csvOptions: { // Often needed if map keys don't match CSV headers exactly
    columns: (headerRow: string[]) => headerRow.map(h => h.toUpperCase()) // Normalize CSV headers
  }
});
// Now `items.toArray()[0].itemId` will be correctly populated.
```

### 9. Handling HUGE Files with Streaming

If `products.csv` is gigabytes, don't load it all! Stream it:

```typescript
import CSV from '@doeixd/csv-utils';

async function processSuperLargeFile() {
  const productStream = CSV.streamFromFile<Product>('super_large_products.csv', {
    // You can use customCasts here too for on-the-fly type conversion!
    customCasts: { /* ... as shown in step 2 ... */ }
  });

  const processedStream = productStream
    .filter(p => p.category === 'Electronics' && p.stock > 10) // Only active electronics
    .map(p => ({ // Select and transform fields
      productId: p.id,
      productName: p.name,
      currentStock: p.stock
    }));

  // Option 1: Process each item as it comes through the stream
  for await (const product of processedStream) {
    console.log(`Streaming: ${product.productName} - Stock: ${product.currentStock}`);
    // await sendToAnalytics(product);
  }

  // Option 2: Stream results directly into a new file
  // await processedStream.prepareToFile('streamed_electronics.csv').run();
  console.log('Large file processing complete!');
}

// processSuperLargeFile();
```

## Prefer a Functional Style? Standalone Functions!

All core operations are also available as standalone functions.

```typescript
import { findRowsWhere, updateColumn, sortBy } from '@doeixd/csv-utils/standalone';
// Or import all: import csvFn from '@doeixd/csv-utils/standalone';

const initialData: Product[] = [ /* ... your array of Product objects ... */ ];

const filtered = findRowsWhere(initialData, p => p.category === 'Electronics');
const updated = updateColumn(filtered, 'price', price => price * 1.1); // 10% price increase
const sorted = sortBy(updated, 'name');

// console.log(sorted);
```

## What's Next? Explore More!

You've mastered the basics! `csv-utils` has even more to offer:

*   ✅ **Data Validation:** Use `schema` option with Zod or custom rules to ensure data integrity.
*   🔄 **Advanced Data Shaping:** `join`, `pivot`, `unpivot`, `groupBy`, `aggregate` for complex analysis.
*   📄 **Preamble Power:** Read and write those pesky comment lines or metadata at the top of CSVs.
*   ⚡ **Async & Parallel:** `forEachAsync`, `mapAsync` for batch jobs, and `CSVUtils.processInParallel` for heavy CPU tasks.

Dive into the [**Full API Documentation**](#full-api-documentation) *(link to your more detailed README section or a separate API.md)* when you're ready for these advanced features.

