## Advanced Streaming & Concurrent Processing Guide for CSV-Utils

This guide explores the powerful streaming and concurrent processing capabilities of `csv-utils`, designed for efficiently handling large CSV datasets and complex data pipelines.

### Table of Contents

1.  [Understanding Streaming in `csv-utils`](#1-understanding-streaming-in-csv-utils)
    *   Why Stream?
    *   Core Streaming Components
2.  [The `CSVStreamProcessor`: Fluent Stream Pipelines](#2-the-csvstreamprocessor-fluent-stream-pipelines)
    *   Creating a Stream Processor
    *   Fluent Transformations (`filter`, `map`, `addColumn`)
    *   Memory Management: Buffering and Backpressure
    *   Executing the Pipeline
        *   Async Iteration (`for await...of`)
        *   Collecting Results (`prepareCollect().run()`)
        *   Writing to a File (`prepareToFile().run()`)
        *   Processing with a Callback (`prepareForEach().run()`)
        *   Piping to Other Streams (`preparePipeTo().run()` and `pipe()`)
3.  [Async Generators: Flexible Row-by-Row Processing](#3-async-generators-flexible-row-by-row-processing)
    *   `csvGenerator`: Single Row Processing
    *   `csvBatchGenerator`: Batched Row Processing
    *   Combining Generators with Transformations
4.  [Writing Streamed Data](#4-writing-streamed-data)
    *   From `CSVStreamProcessor` to File
    *   `writeCSVFromGenerator`: Writing from Custom Generators
5.  [Concurrency and Parallelism](#5-concurrency-and-parallelism)
    *   Async Batch Processing (`forEachAsync`, `mapAsync` on `CSV` instances)
    *   `CSVUtils.processInWorker`: Offloading Single CPU-Intensive Tasks
    *   `CSVUtils.processInParallel`: Distributing Array Processing
    *   Considerations for Parallel Operations
6.  [Best Practices and Use Cases](#6-best-practices-and-use-cases)

---

### 1. Understanding Streaming in `csv-utils`

#### Why Stream?

When dealing with CSV files that are too large to fit comfortably in memory (e.g., gigabytes in size), attempting to read the entire file at once can lead to `OutOfMemoryError` exceptions or severe performance degradation. Streaming allows you to process the data in chunks (typically row by row) as it arrives, requiring only a small, constant amount of memory regardless of the file size.

#### Core Streaming Components

`csv-utils` offers several mechanisms for streaming:

*   **`CSVStreamProcessor`**: A class providing a fluent API to build complex data transformation pipelines that operate on streams. This is the most powerful and recommended approach for most streaming tasks.
*   **Async Generators (`csvGenerator`, `csvBatchGenerator`)**: Functions that yield CSV rows (or batches of rows) one at a time, suitable for direct iteration and custom processing loops.
*   **Node.js Streams Integration**: The library leverages Node.js built-in `Readable`, `Writable`, and `Transform` streams, allowing seamless integration with other stream-based Node.js modules.

### 2. The `CSVStreamProcessor`: Fluent Stream Pipelines

The `CSVStreamProcessor` is the cornerstone of advanced streaming in this library. It allows you to define a sequence of operations (filters, maps, column additions) that are applied to each row as it streams from the source CSV file.

#### Creating a Stream Processor

You typically create a `CSVStreamProcessor` using the static `CSV.streamFromFile()` method:

```typescript
import CSV from '@doeixd/csv-utils';

interface ProductData {
  productId: string;
  category: string;
  price: string; // Assuming price is string in CSV, will be parsed later if needed
  stock: string;
}

const processor = CSV.streamFromFile<ProductData>('large_inventory.csv', {
  csvOptions: {
    // Options for the underlying 'csv-parse' library
    delimiter: ',',
    trim: true,
    skip_empty_lines: true,
  },
  headerMap: { // Optional: map CSV headers to object properties
    'SKU': 'productId',
    'Product Category': 'category',
    'Unit Price': 'price',
    'In Stock': 'stock'
  }
});
```

**Note:** `CSV.streamFromFile` initiates processing directly from the data rows. It does not handle preamble (additional header) options like `saveAdditionalHeader` found in `CSV.fromFile`.

#### Fluent Transformations (`filter`, `map`, `addColumn`)

Once you have a `processor` instance, you can chain transformation methods. Each method returns a *new* `CSVStreamProcessor` instance, preserving immutability.

```typescript
const transformedProcessor = processor
  .filter(product => product.category === 'Electronics' && parseInt(product.stock) > 0)
  .map(product => ({
    id: product.productId,
    currentPrice: parseFloat(product.price),
    status: 'In Stock'
  }))
  .addColumn('lastChecked', () => new Date()); // Adds a new column with the current date

// `transformedProcessor` now represents a pipeline that will:
// 1. Read rows from 'large_inventory.csv' (applying headerMap).
// 2. Filter for 'Electronics' with stock > 0.
// 3. Map the row to a new structure, converting price to a number.
// 4. Add a 'lastChecked' timestamp.
```
All transformation functions (`condition` for `filter`, `transformFn` for `map`, `valueOrFn` for `addColumn`) can be **asynchronous** (return a `Promise`). The stream processor will correctly await them.

#### Memory Management: Buffering and Backpressure

Internally, `CSVStreamProcessor` (when iterated using `for await...of` or methods like `prepareForEach().run()`) uses a fixed-size circular buffer to hold data chunks. This prevents unbounded memory growth. It also implements automatic **backpressure**: if the consumer of the stream (e.g., your processing logic) is slower than the producer (file reading/parsing), the stream will pause reading from the source until the consumer catches up. This is crucial for stable processing of large files. The buffer size is configurable but defaults to a sensible value (e.g., 1000 items).

#### Executing the Pipeline

The transformation pipeline defined by `CSVStreamProcessor` is lazy; no data is processed until a terminal operation is invoked.

##### a. Async Iteration (`for await...of`)

This is often the most intuitive and memory-efficient way to consume the processed stream:

```typescript
try {
  for await (const processedProduct of transformedProcessor) {
    // Each `processedProduct` is an object of the type output by the last stage
    // (in this case, { id: string; currentPrice: number; status: string; lastChecked: Date })
    console.log(`Processing: ${processedProduct.id}, Price: ${processedProduct.currentPrice}`);
    // await saveToDatabase(processedProduct);
  }
  console.log('Stream processing complete.');
} catch (error) {
  console.error('Error during stream processing:', error);
}
```

##### b. Collecting Results (`prepareCollect().run()`)

If the final dataset is expected to be small enough to fit in memory, you can collect all results into a `CSV` instance.

```typescript
// WARNING: Loads all processed data into memory. Not suitable for extremely large outputs.
try {
  const collectedCsv = await transformedProcessor.prepareCollect().run() as CSV<{ /* final row type */ }>;
  console.log(`Collected ${collectedCsv.count()} processed products.`);
  // Now you can use synchronous methods on `collectedCsv`
  // const topTen = collectedCsv.sortBy('currentPrice', 'desc').head(10);
} catch (error) {
  console.error('Error collecting stream results:', error);
}
```

##### c. Writing to a File (`prepareToFile().run()`)

Stream the processed data directly to an output CSV file.

```typescript
try {
  await transformedProcessor.prepareToFile('processed_electronics.csv', {
    stringifyOptions: { header: true, bom: true }, // Options for 'csv-stringify'
    // headerMap: { /* Optional: if output CSV needs different headers than object keys */ }
  }).run();
  console.log('Processed data written to file.');
} catch (error) {
  console.error('Error writing stream to file:', error);
}
```

##### d. Processing with a Callback (`prepareForEach().run()`)

Execute an asynchronous callback for each processed row.

```typescript
try {
  await transformedProcessor.prepareForEach(async (product) => {
    // await updateAnalytics(product);
    // await sendRealtimeUpdate(product);
  }).run();
  console.log('All products processed via forEach callback.');
} catch (error) {
  console.error('Error in forEach stream processing:', error);
}
```

##### e. Piping to Other Streams (`preparePipeTo().run()` and `pipe()`)

Integrate with other Node.js Writable streams.

```typescript
import fs from 'node:fs';
import { Transform } from 'node:stream';

// Example: Convert to JSON strings and write to a .jsonl file
const toJsonL = new Transform({
  objectMode: true, // Expects objects
  transform(chunk, encoding, callback) {
    try {
      this.push(JSON.stringify(chunk) + '\n');
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
});

const outputJsonLStream = fs.createWriteStream('output.jsonl');

// Option 1: Using preparePipeTo().run()
// transformedProcessor.preparePipeTo(toJsonL).run() // This would pipe transformedProcessor to toJsonL
// However, preparePipeTo() expects the final destination. So, chain it:
// transformedProcessor.pipe(toJsonL).pipe(outputJsonLStream); // This doesn't use preparePipeTo

// More direct: build the pipeline then pipe
// const finalReadableStream = transformedProcessor._buildPipeline(); // Internal method, for illustration
// await pipelineAsync(finalReadableStream, toJsonL, outputJsonLStream);

// Using the public API:
// The `pipe` method on CSVStreamProcessor returns the destination stream, allowing chaining.
transformedProcessor.pipe(toJsonL).pipe(outputJsonLStream);
outputJsonLStream.on('finish', () => console.log('Piping to JSONL complete.'));
outputJsonLStream.on('error', (err) => console.error('Error piping to JSONL:', err));

// Alternatively, if toJsonL was the *final* destination for `preparePipeTo`:
// await transformedProcessor.preparePipeTo(toJsonL).run();
// // And then separately pipe toJsonL's readable side if it's a Duplex/Transform:
// // toJsonL.pipe(outputJsonLStream); (This setup is slightly different)
```
The `pipe()` method on `CSVStreamProcessor` directly pipes its output (a `Readable` stream) to the provided `Writable` stream. `preparePipeTo().run()` is useful when you want the `run()` method to manage the end-to-end pipeline completion as a Promise.

### 3. Async Generators: Flexible Row-by-Row Processing

For scenarios where you need direct, low-level control over row iteration without the full `CSVStreamProcessor` fluent API, async generators are available.

#### `csvGenerator`: Single Row Processing

Yields one row object at a time.

```typescript
import { csvGenerator, CSVStreamOptions } from '@doeixd/csv-utils';

interface LogEntry { timestamp: string; level: string; message: string; }

const options: CSVStreamOptions<LogEntry> = {
  csvOptions: { columns: true, trim: true },
  // headerMap: { /* ... */ },
  // transform: (row) => ({ ...row, source: 'fileA' }) // Simple transform
};

async function processLogsFromFile(filePath: string) {
  let criticalErrors = 0;
  for await (const log of csvGenerator<LogEntry>(filePath, options)) {
    if (log.level === 'CRITICAL') {
      criticalErrors++;
      // sendAlert(log);
    }
  }
  console.log(`Found ${criticalErrors} critical errors in ${filePath}.`);
}
```

#### `csvBatchGenerator`: Batched Row Processing

Yields arrays (batches) of rows, useful for bulk operations.

```typescript
import { csvBatchGenerator, CSVStreamOptions } from '@doeixd/csv-utils';

async function bulkImportUsers(filePath: string) {
  const batchOptions: CSVStreamOptions<UserData> = { // UserData interface
    csvOptions: { columns: true },
    batchSize: 500 // Process 500 users at a time
  };

  for await (const userBatch of csvBatchGenerator<UserData>(filePath, batchOptions)) {
    // await database.bulkInsertUsers(userBatch);
    console.log(`Imported batch of ${userBatch.length} users.`);
  }
}
```

#### Combining Generators with Transformations

You can create your own transformation pipelines by consuming one generator and yielding transformed data in another.

```typescript
async function* enrichUserData(userGenerator: AsyncGenerator<UserData>) {
  for await (const user of userGenerator) {
    // const departmentInfo = await fetchDepartmentDetails(user.departmentId);
    // yield { ...user, departmentName: departmentInfo.name };
    yield user; // Placeholder
  }
}

async function main() {
  const baseUserGenerator = csvGenerator<UserData>('users.csv', { csvOptions: {columns: true} });
  const enrichedGenerator = enrichUserData(baseUserGenerator);

  for await (const enrichedUser of enrichedGenerator) {
    console.log(enrichedUser);
  }
}
```

### 4. Writing Streamed Data

#### From `CSVStreamProcessor` to File

As shown earlier, `transformedProcessor.prepareToFile('output.csv').run()` is the standard way. This handles creating the CSV stringifier and file write stream internally.

#### `writeCSVFromGenerator`: Writing from Custom Generators

If you have an async generator producing data (perhaps after complex, non-stream-processor transformations), you can write it to a CSV file efficiently.

```typescript
import { writeCSVFromGenerator, CSVWriteOptions } from '@doeixd/csv-utils';

async function* generateReportData(): AsyncGenerator<ReportRow> { // ReportRow interface
  // ... logic to generate report rows, possibly from multiple sources ...
  for (let i = 0; i < 10000; i++) {
    yield { reportId: `R${i}`, value: Math.random() * 100, category: i % 2 === 0 ? 'A' : 'B' };
  }
}

const writeOptions: CSVWriteOptions<ReportRow> = {
  stringifyOptions: { header: true },
  // headerMap: { /* If ReportRow properties need mapping to different CSV headers */ }
};

await writeCSVFromGenerator('large_report.csv', generateReportData(), writeOptions);
console.log('Report generated and written.');
```

### 5. Concurrency and Parallelism

`csv-utils` provides mechanisms to introduce concurrency, speeding up I/O-bound or CPU-bound tasks where applicable.

#### Async Batch Processing (`forEachAsync`, `mapAsync` on `CSV` instances)

When you have data loaded into a `CSV` instance (not streaming row-by-row from a file initially), these methods allow concurrent processing of rows in batches.

```typescript
import CSV from '@doeixd/csv-utils';
const csvData = CSV.fromFile<MyData>('dataset.csv'); // Assumes dataset.csv fits in memory

// Process 100 rows at a time, with up to 5 batches running concurrently
await csvData.forEachAsync(async (row) => {
  // await ioBoundOperation(row.id);
}, { batchSize: 100, batchConcurrency: 5 });

const results = await csvData.mapAsync(async (row) => {
  // const apiResult = await fetchFromApi(row.key);
  // return { ...row, apiData: apiResult };
  return row; // Placeholder
}, { batchSize: 50, batchConcurrency: 10 });
```
**Note:** These operate on an in-memory `CSV` instance. For true streaming concurrency, you'd typically combine `CSVStreamProcessor` or generators with tools like `Promise.all` on batches, or use libraries designed for stream concurrency (e.g., `through2-concurrent`).

#### `CSVUtils.processInWorker`: Offloading Single CPU-Intensive Tasks

For a single, heavy computation that would block the main thread, you can offload it to a worker thread. The operation and data must be serializable.

```typescript
import { CSVUtils } from '@doeixd/csv-utils';

function complexCalculation(data: { values: number[] }): number {
  // Simulate heavy CPU work
  let sum = 0;
  for (let i = 0; i < 1e8; i++) sum += Math.random(); // Placeholder
  return data.values.reduce((acc, v) => acc + v, 0) + sum;
}

const inputData = { values: [1, 2, 3, 4, 5, /* ... large array ... */] };
const result = await CSVUtils.processInWorker(complexCalculation, inputData);
console.log('Worker result:', result);
```

#### `CSVUtils.processInParallel`: Distributing Array Processing

If you have an array of items and an operation to apply to each (or to chunks), this can distribute the work across multiple worker threads.

```typescript
import { CSVUtils } from '@doeixd/csv-utils';
const itemsToProcess: MyItem[] = [ /* ... large array of items ... */ ];

// Operation takes a chunk of items and returns a chunk of results
function processItemChunk(chunk: MyItem[]): ProcessedItem[] {
  return chunk.map(item => {
    // Simulate CPU-intensive work per item
    // for (let i = 0; i < 1e6; i++) {}
    return { id: item.id, processedValue: item.value * 2 }; // Example
  });
}

const allProcessedItems = await CSVUtils.processInParallel(
  itemsToProcess,
  processItemChunk,
  { maxWorkers: 4 } // Use up to 4 worker threads
);
console.log(`Processed ${allProcessedItems.length} items in parallel.`);
```
**Important Limitation**: `processInParallel` is for operations where chunk processing order and simple concatenation of results is acceptable (like `map`). It's **not** suitable for operations like sorting that require a final merge step across all chunks. For parallel sorting of large datasets, more specialized algorithms or libraries would be needed beyond what `sortByAsync` (which currently delegates to in-memory sort) provides for true parallelism.

#### Considerations for Parallel Operations

*   **Overhead**: Creating worker threads has overhead. For very small tasks or datasets, parallel processing might be slower.
*   **Serialization**: Data passed to/from workers must be serializable (e.g., via `JSON.stringify` or structured cloning). Functions themselves are passed as strings and `eval`'d in the worker, so they must be self-contained or rely only on `workerData`.
*   **I/O vs. CPU Bound**: Worker threads are most effective for CPU-bound tasks. For I/O-bound tasks (like many API calls), Node.js's native async/await with `Promise.all` on a limited number of concurrent requests is often more efficient than worker threads.
*   **State Management**: Workers are isolated. Managing shared state across workers requires explicit inter-process communication mechanisms, which are not directly handled by these utilities.

### 6. Best Practices and Use Cases

*   **Large File Ingestion & ETL**: Use `CSVStreamProcessor` or `csvGenerator` to read large CSVs, transform data (clean, enrich, reshape), and then write to another file (`prepareToFile().run()`), a database (`prepareForEach().run()` with DB inserts), or another system (`pipe()` to an API client stream).
*   **Real-time Data Feeds**: If CSV data arrives continuously (e.g., log files), streaming mechanisms can process it incrementally.
*   **Memory-Constrained Environments**: Streaming is essential when running on servers or containers with limited RAM.
*   **Complex Transformations on Large Data**: Chain multiple `filter`, `map`, and `addColumn` operations on a `CSVStreamProcessor` to build sophisticated pipelines without loading everything into memory.
*   **Reporting on Large Datasets**: Use streaming to iterate through data, perform aggregations "on the fly" (if possible, or by collecting intermediate results carefully), and generate reports.
*   **CPU-Intensive Row Processing**: If individual row processing is very CPU-heavy *and* independent, consider a hybrid: use `CSVStreamProcessor` to get rows, then within the `prepareForEach` callback (or `for await...of` loop), dispatch batches of these rows to `CSVUtils.processInParallel` if the overhead is justified.
*   **Prioritize `CSVStreamProcessor`**: For most streaming and transformation tasks involving CSV files, `CSVStreamProcessor` offers the best balance of features, ease of use, and performance. Use async generators for more direct control or when integrating with other generator-based systems.

By understanding and leveraging these streaming and concurrent processing features, you can build highly efficient and scalable CSV data manipulation applications with `csv-utils`.
