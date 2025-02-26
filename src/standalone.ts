/**
 * @fileoverview Standalone utility functions for CSV data manipulation
 * This module provides access to all CSV utility functions as standalone functions
 * that take an array of objects as the first argument and return the results as an array of objects.
 */

import CSV, { 
  CSVError, 
  ComparisonCallback, 
  ModificationCallback, 
  TransformCallback, 
  EqualityCallback, 
  MergeCallback, 
  SortDirection, 
  AggregateOperation,
  SimilarityMatch,
  CSVArrayUtils
} from './index';

/**
 * Find the first row where column matches value exactly
 * @param data - Array of objects to search
 * @param value - The value to match
 * @param column - The column to check (default: 'id')
 * @returns The matching row or undefined
 * @example
 * ```typescript
 * const product = findRow(products, 'P123', 'productId');
 * ```
 */
export function findRow<T extends Record<string, any>>(
  data: T[], 
  value: any, 
  column: keyof T = 'id' as keyof T
): T | undefined {
  return CSV.fromData(data).findRow(value, column);
}

/**
 * Find rows that match a regular expression
 * @param data - Array of objects to search
 * @param regex - The pattern to match
 * @param column - The column to check (default: 'id')
 * @returns The matching row or undefined
 * @example
 * ```typescript
 * const product = findRowByRegex(products, /^P\d{3}$/, 'productId');
 * ```
 */
export function findRowByRegex<T extends Record<string, any>>(
  data: T[], 
  regex: RegExp, 
  column: keyof T = 'id' as keyof T
): T | undefined {
  return CSV.fromData(data).findRowByRegex(regex, column);
}

/**
 * Find all rows containing a value
 * @param data - Array of objects to search
 * @param value - The value to search for
 * @param column - The column to check (default: 'id')
 * @returns Array of matching rows
 * @example
 * ```typescript
 * const electronicsProducts = findRows(products, 'Electronics', 'category');
 * ```
 */
export function findRows<T extends Record<string, any>>(
  data: T[], 
  value: any, 
  column: keyof T = 'id' as keyof T
): T[] {
  return CSV.fromData(data).findRows(value, column);
}

/**
 * Find the first row matching a condition
 * @param data - Array of objects to search
 * @param predicate - Function to test each row
 * @returns The first matching row or undefined
 * @example
 * ```typescript
 * const expensiveProduct = findRowWhere(products, p => p.price > 100);
 * ```
 */
export function findRowWhere<T extends Record<string, any>>(
  data: T[], 
  predicate: ComparisonCallback<T>
): T | undefined {
  return CSV.fromData(data).findRowWhere(predicate);
}

/**
 * Find all rows matching a condition
 * @param data - Array of objects to search
 * @param predicate - Function to test each row
 * @returns Array of matching rows
 * @example
 * ```typescript
 * const inStockProducts = findRowsWhere(products, p => p.inStock === true);
 * ```
 */
export function findRowsWhere<T extends Record<string, any>>(
  data: T[], 
  predicate: ComparisonCallback<T>
): T[] {
  return CSV.fromData(data).findRowsWhere(predicate);
}

/**
 * Find rows by similarity to a string value
 * @param data - Array of objects to search
 * @param str - The string to compare with
 * @param column - The column to check
 * @returns Array of matches with similarity scores
 * @example
 * ```typescript
 * const similarProducts = findSimilarRows(products, 'Labtop', 'name');
 * ```
 */
export function findSimilarRows<T extends Record<string, any>>(
  data: T[], 
  str: string, 
  column: keyof T
): SimilarityMatch<T>[] {
  return CSV.fromData(data).findSimilarRows(str, column);
}

/**
 * Find the most similar row to a string value
 * @param data - Array of objects to search
 * @param str - The string to compare with
 * @param column - The column to check
 * @returns The best match or undefined
 * @example
 * ```typescript
 * const closestMatch = findMostSimilarRow(products, 'Labtop', 'name');
 * ```
 */
export function findMostSimilarRow<T extends Record<string, any>>(
  data: T[], 
  str: string, 
  column: keyof T
): SimilarityMatch<T> | undefined {
  return CSV.fromData(data).findMostSimilarRow(str, column);
}

/**
 * Group rows by values in a column
 * @param data - Array of objects to group
 * @param column - The column to group by
 * @returns Object with groups of rows
 * @example
 * ```typescript
 * const productsByCategory = groupBy(products, 'category');
 * ```
 */
export function groupBy<T extends Record<string, any>>(
  data: T[], 
  column: keyof T
): Record<string, T[]> {
  return CSV.fromData(data).groupBy(column);
}

/**
 * Update all rows with new values
 * @param data - Array of objects to update
 * @param modifications - Object with new values or function that returns them
 * @returns Updated array of objects
 * @example
 * ```typescript
 * const updatedProducts = update(products, { currency: 'USD' });
 * ```
 */
export function update<T extends Record<string, any>, E extends Partial<T> = T>(
  data: T[], 
  modifications: (Partial<T> | ModificationCallback<T>) & E
): T[] {
  return CSV.fromData(data).update(modifications).toArray();
}

/**
 * Update rows that match a condition
 * @param data - Array of objects to update
 * @param condition - The condition to match
 * @param modifications - Object with new values or function that returns them
 * @returns Updated array of objects
 * @example
 * ```typescript
 * const discounted = updateWhere(
 *   products, 
 *   p => p.price > 100, 
 *   p => ({ price: p.price * 0.9, discounted: true })
 * );
 * ```
 */
export function updateWhere<T extends Record<string, any>>(
  data: T[], 
  condition: ComparisonCallback<T>,
  modifications: Partial<T> | ModificationCallback<T>
): T[] {
  return CSV.fromData(data).updateWhere(condition, modifications).toArray();
}

/**
 * Update a specific column for all rows
 * @param data - Array of objects to update
 * @param column - The column to update
 * @param value - New value or function to calculate it
 * @returns Updated array of objects
 * @example
 * ```typescript
 * const withTax = updateColumn(products, 'price', p => p * 1.2);
 * ```
 */
export function updateColumn<T extends Record<string, any>, K extends keyof T>(
  data: T[], 
  column: K,
  value: T[K] | ((current: T[K], row: T) => T[K])
): T[] {
  return CSV.fromData(data).updateColumn(column, value).toArray();
}

/**
 * Transform rows into a different structure
 * @param data - Array of objects to transform
 * @param transformer - Function to transform each row
 * @returns Transformed array of objects
 * @example
 * ```typescript
 * interface ProductSummary { id: string; display: string; value: number }
 * 
 * const summaries = transform<Product, ProductSummary>(products, 
 *   p => ({ 
 *     id: p.id, 
 *     display: `${p.name} (${p.category})`,
 *     value: p.price * p.stock
 *   })
 * );
 * ```
 */
export function transform<T extends Record<string, any>, R extends Record<string, any>>(
  data: T[], 
  transformer: TransformCallback<T, R>
): R[] {
  return CSV.fromData(data).transform(transformer).toArray();
}

/**
 * Remove rows matching a condition
 * @param data - Array of objects to filter
 * @param condition - The condition to match
 * @returns Filtered array of objects
 * @example
 * ```typescript
 * const inStockOnly = removeWhere(products, p => !p.inStock);
 * ```
 */
export function removeWhere<T extends Record<string, any>>(
  data: T[], 
  condition: ComparisonCallback<T>
): T[] {
  return CSV.fromData(data).removeWhere(condition).toArray();
}

/**
 * Add new rows to the data
 * @param data - Original array of objects
 * @param rows - The rows to add
 * @returns Combined array of objects
 * @example
 * ```typescript
 * const expanded = append(products, 
 *   { id: 'P004', name: 'Keyboard', price: 49.99, inStock: true },
 *   { id: 'P005', name: 'Mouse', price: 29.99, inStock: true }
 * );
 * ```
 */
export function append<T extends Record<string, any>>(
  data: T[], 
  ...rows: T[]
): T[] {
  return CSV.fromData(data).append(...rows).toArray();
}

/**
 * Sort rows by a column
 * @param data - Array of objects to sort
 * @param column - The column to sort by
 * @param direction - Sort direction (default: 'asc')
 * @returns Sorted array of objects
 * @example
 * ```typescript
 * const byPriceDesc = sortBy(products, 'price', 'desc');
 * ```
 */
export function sortBy<T extends Record<string, any>, K extends keyof T>(
  data: T[], 
  column: K,
  direction: SortDirection = 'asc'
): T[] {
  return CSV.fromData(data).sortBy(column, direction).toArray();
}

/**
 * Calculate aggregate values for a column
 * @param data - Array of objects to aggregate
 * @param column - The column to aggregate
 * @param operation - The aggregation operation
 * @returns The calculated value
 * @example
 * ```typescript
 * const totalRevenue = aggregate(sales, 'amount', 'sum');
 * const averagePrice = aggregate(products, 'price', 'avg');
 * ```
 */
export function aggregate<T extends Record<string, any>, K extends keyof T>(
  data: T[], 
  column: K,
  operation: AggregateOperation = 'sum'
): number {
  return CSV.fromData(data).aggregate(column, operation);
}

/**
 * Get unique values from a column
 * @param data - Array of objects to process
 * @param column - The column to get values from
 * @returns Array of unique values
 * @example
 * ```typescript
 * const categories = distinct(products, 'category');
 * ```
 */
export function distinct<T extends Record<string, any>, K extends keyof T>(
  data: T[], 
  column: K
): Array<T[K]> {
  return CSV.fromData(data).distinct(column);
}

/**
 * Create a pivot table from the data
 * @param data - Array of objects to pivot
 * @param rowColumn - Column for row labels
 * @param colColumn - Column for column labels
 * @param valueColumn - Column for values
 * @returns Pivot table as nested object
 * @example
 * ```typescript
 * const salesByProductAndMonth = pivot(sales, 'product', 'month', 'amount');
 * ```
 */
export function pivot<T extends Record<string, any>>(
  data: T[], 
  rowColumn: keyof T,
  colColumn: keyof T,
  valueColumn: keyof T
): Record<string, Record<string, unknown>> {
  return CSV.fromData(data).pivot(rowColumn, colColumn, valueColumn);
}

/**
 * Merge two datasets
 * @param dataA - First array of objects
 * @param dataB - Second array of objects
 * @param equalityFn - Function to determine equality
 * @param mergeFn - Function to merge equal rows
 * @returns Merged array of objects
 * @example
 * ```typescript
 * const merged = merge(
 *   localInventory,
 *   warehouseInventory,
 *   (a, b) => a.id === b.id,
 *   (a, b) => ({ ...a, stock: a.stock + b.stock })
 * );
 * ```
 */
export function merge<T extends Record<string, any>, E extends Record<string, any>>(
  dataA: T[], 
  dataB: E[],
  equalityFn: EqualityCallback<T | E>,
  mergeFn: MergeCallback<T, E>
): T[] {
  return CSV.fromData(dataA).mergeWith(dataB, equalityFn, mergeFn).toArray();
}

/**
 * Sample rows from the data
 * @param data - Array of objects to sample
 * @param count - Number of rows to sample (default: 1)
 * @returns Sampled array of objects
 * @example
 * ```typescript
 * const randomSample = sample(products, 3);
 * ```
 */
export function sample<T extends Record<string, any>>(
  data: T[], 
  count: number = 1
): T[] {
  return CSV.fromData(data).sample(count).toArray();
}

/**
 * Get the first n rows
 * @param data - Array of objects
 * @param count - Number of rows to get
 * @returns First n rows
 * @example
 * ```typescript
 * const topProducts = head(products, 5);
 * ```
 */
export function head<T extends Record<string, any>>(
  data: T[], 
  count: number = 10
): T[] {
  return CSV.fromData(data).head(count).toArray();
}

/**
 * Get the last n rows
 * @param data - Array of objects
 * @param count - Number of rows to get
 * @returns Last n rows
 * @example
 * ```typescript
 * const lastOrders = tail(orders, 5);
 * ```
 */
export function tail<T extends Record<string, any>>(
  data: T[], 
  count: number = 10
): T[] {
  return CSV.fromData(data).tail(count).toArray();
}

/**
 * Creates a base row with the structure of the data
 * @param data - Array of objects
 * @param defaults - Optional default values
 * @returns A new object with the data structure
 * @example
 * ```typescript
 * const template = getBaseRow(products);
 * const template = getBaseRow(products, { inStock: true });
 * ```
 */
export function getBaseRow<T extends Record<string, any>, R extends { [K in keyof T]?: any } = { [K in keyof T]?: undefined }>(
  data: T[],
  defaults?: Partial<T>
): R {
  if (data.length === 0) {
    throw new CSVError('Cannot create base row from empty data');
  }
  return CSV.fromData(data).getBaseRow(defaults);
}

/**
 * Create a new row with the structure of the data
 * @param data - Template array of objects
 * @param rowData - The data to populate the row with
 * @returns A new object with all data fields
 * @example
 * ```typescript
 * const newProduct = createRow(products, { 
 *   id: 'P006', 
 *   name: 'Headphones', 
 *   price: 79.99 
 * });
 * ```
 */
export function createRow<T extends Record<string, any>>(
  data: T[],
  rowData: Partial<T> = {}
): T {
  return CSV.fromData(data).createRow(rowData);
}

/**
 * Map over an array of objects using the provided function
 * Shorthand for data.map(), but included for consistency
 * @param data - Array of objects
 * @param mapFn - Mapping function
 * @returns Mapped array
 * @example
 * ```typescript
 * const prices = mapData(products, p => p.price);
 * ```
 */
export function mapData<T extends Record<string, any>, R>(
  data: T[],
  mapFn: (row: T, index: number) => R
): R[] {
  return data.map(mapFn);
}

/**
 * Filter an array of objects using the provided predicate
 * Shorthand for data.filter(), but included for consistency
 * @param data - Array of objects
 * @param predicate - Filter predicate
 * @returns Filtered array
 * @example
 * ```typescript
 * const availableProducts = filterData(products, p => p.stock > 0);
 * ```
 */
export function filterData<T extends Record<string, any>>(
  data: T[],
  predicate: (row: T, index: number) => boolean
): T[] {
  return data.filter(predicate);
}

/**
 * Reduce an array of objects to a single value
 * Shorthand for data.reduce(), but included for consistency
 * @param data - Array of objects
 * @param reduceFn - Reducer function
 * @param initialValue - Initial value
 * @returns Reduced value
 * @example
 * ```typescript
 * const totalValue = reduceData(
 *   products, 
 *   (total, p) => total + (p.price * p.stock), 
 *   0
 * );
 * ```
 */
export function reduceData<T extends Record<string, any>, R>(
  data: T[],
  reduceFn: (acc: R, row: T, index: number) => R,
  initialValue: R
): R {
  return data.reduce(reduceFn, initialValue);
}

// Export array transformation utilities
export const arrayTransformations = {
  /**
   * Transform arrays to structured objects
   * @param data - Array of arrays or objects
   * @param headerMap - Mapping configuration
   * @param headerRow - Optional header row
   * @returns Array of structured objects
   */
  arrayToObjArray: CSVArrayUtils.arrayToObjArray,
  
  /**
   * Transform objects to arrays
   * @param data - Array of structured objects
   * @param headerMap - Mapping configuration
   * @param headers - Column headers
   * @param includeHeaders - Whether to include headers
   * @returns Array of arrays
   */
  objArrayToArray: CSVArrayUtils.objArrayToArray,
  
  /**
   * Group objects by field
   * @param data - Array of objects
   * @param field - Field to group by
   * @returns Grouped objects
   */
  groupByField: CSVArrayUtils.groupByField
};

// Export all the functions as a default object
export default {
  findRow,
  findRowByRegex,
  findRows,
  findRowWhere,
  findRowsWhere,
  findSimilarRows,
  findMostSimilarRow,
  groupBy,
  update,
  updateWhere,
  updateColumn,
  transform,
  removeWhere,
  append,
  sortBy,
  aggregate,
  distinct,
  pivot,
  merge,
  sample,
  head,
  tail,
  getBaseRow,
  createRow,
  mapData,
  filterData,
  reduceData,
  arrayTransformations
};