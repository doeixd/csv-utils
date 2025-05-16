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
  CSVArrayUtils,
  CSVSchemaConfig
} from './index';
import { stringify as stringifyCSV } from 'csv/sync';

/**
 * Adds a new column to each row in the data array.
 * The new column's value can be a fixed default or derived from a function.
 * If the column name already exists, its values will be overwritten.
 *
 * @template T - The type of objects in the input array.
 * @template NewKey - The type of the new column's name (string literal).
 * @template NewValue - The type of the new column's value.
 * @param data - Array of objects to modify.
 * @param columnName - The name of the new column.
 * @param valueOrFn - A fixed value for the new column, or a function that
 *                    takes the current row and returns the value for the new column.
 * @returns A new array of objects with the added/updated column.
 * @example
 * ```typescript
 * // interface User { id: number; name: string; }
 * // const users: User[] = [{ id: 1, name: 'Alice' }];
 *
 * // Add a column with a fixed value
 * const usersWithRole = addColumn(users, 'role', 'user');
 * // usersWithRole is [{ id: 1, name: 'Alice', role: 'user' }]
 *
 * // Add a column with a derived value
 * const usersWithLen = addColumn(users, 'nameLength', row => row.name.length);
 * // usersWithLen is [{ id: 1, name: 'Alice', nameLength: 5 }]
 * ```
 */
export function addColumn<
  T extends Record<string, any>,
  NewKey extends string,
  NewValue
>(
  data: T[],
  columnName: NewKey,
  valueOrFn: NewValue | ((row: T) => NewValue)
): Array<T & Record<NewKey, NewValue>> {
  return CSV.fromData(data).addColumn(columnName, valueOrFn).toArray();
}

/**
 * Removes one or more columns from each row in the data array.
 * If a specified column does not exist, it's silently ignored.
 *
 * @template T - The type of objects in the input array.
 * @template K - Union of the keys to be removed.
 * @param data - Array of objects to modify.
 * @param columnNames - A single column name or an array of column names to remove.
 *                      Can be `keyof T` or a string.
 * @returns A new array of objects with the specified columns removed.
 * @example
 * ```typescript
 * // interface User { id: number; name: string; email: string; }
 * // const users: User[] = [{ id: 1, name: 'Alice', email: 'a@ex.com' }];
 *
 * // Remove a single column
 * const usersWithoutEmail = removeColumn(users, 'email');
 * // usersWithoutEmail is [{ id: 1, name: 'Alice' }]
 *
 * // Remove multiple columns
 * const usersOnlyId = removeColumn(users, ['name', 'email']);
 * // usersOnlyId is [{ id: 1 }]
 * ```
 */
export function removeColumn<
  T extends Record<string, any>,
  K extends keyof T | string
>(
  data: T[],
  columnNames: K | K[]
): Array<Omit<T, Extract<K, keyof T>>> {
  return CSV.fromData(data).removeColumn(columnNames).toArray();
}

/**
 * Renames a column in each row of the data array.
 * If the old column name does not exist in a row, that row remains unchanged (but its type signature adapts).
 * If the new column name already exists and is different from the old name, it will be overwritten.
 *
 * @template T - The type of objects in the input array.
 * @template OldK - The type of the old column name.
 * @template NewK - The type of the new column name (string literal).
 * @param data - Array of objects to modify.
 * @param oldName - The current name of the column. Can be `keyof T` or a string.
 * @param newName - The new name for the column.
 * @returns A new array of objects with the column renamed.
 * @example
 * ```typescript
 * // interface User { userId: number; userName: string; }
 * // const users: User[] = [{ userId: 1, userName: 'Alice' }];
 *
 * // Rename 'userId' to 'id'
 * const usersRenamedId = renameColumn(users, 'userId', 'id');
 * // usersRenamedId is [{ id: 1, userName: 'Alice' }]
 * ```
 */
export function renameColumn<
  T extends Record<string, any>,
  OldK extends keyof T | string,
  NewK extends string
>(
  data: T[],
  oldName: OldK,
  newName: NewK
): Array<Omit<T, Extract<OldK, keyof T>> & Record<NewK, OldK extends keyof T ? T[OldK] : any>> {
  return CSV.fromData(data).renameColumn(oldName, newName).toArray();
}

/**
 * Reorders columns in each row of the data array according to the specified order.
 * Columns not included in `orderedColumnNames` will be placed after the ordered ones,
 * maintaining their original relative order among themselves.
 * If `orderedColumnNames` contains names not present in the data, they are ignored.
 *
 * @template T - The type of objects in the input array.
 * @param data - Array of objects to modify.
 * @param orderedColumnNames - An array of column names (or `keyof T`) in the desired order.
 * @returns A new array of objects with columns reordered.
 * @example
 * ```typescript
 * // interface User { id: number; name: string; email: string; age: number }
 * // const users: User[] = [{ id: 1, name: 'Alice', email: 'a@ex.com', age: 30 }];
 *
 * // Reorder to: name, id, email, age
 * const reorderedUsers = reorderColumns(users, ['name', 'id']);
 * // The keys in reorderedUsers[0] will be 'name', 'id', 'email', 'age' (in that order when iterated).
 * ```
 */
export function reorderColumns<T extends Record<string, any>>(
  data: T[],
  orderedColumnNames: (keyof T | string)[]
): T[] {
  return CSV.fromData(data).reorderColumns(orderedColumnNames).toArray();
}

/**
 * Attempts to cast the values in a specified column to a given data type.
 * If casting fails for a value (e.g., 'abc' to number), it becomes `null`.
 * The generic type `T` of the array objects does not change in the function signature
 * due to runtime casting limitations, but the underlying data's types will change.
 *
 * @template T - The type of objects in the input array.
 * @param data - Array of objects to modify.
 * @param columnName - The name of the column to cast. Can be `keyof T` or a string.
 * @param targetType - The target data type: 'string', 'number', 'boolean', or 'date'.
 * @returns A new array of objects with the column values cast.
 * @example
 * ```typescript
 * // interface Product { id: string; price: string; available: string; }
 * // const products: Product[] = [
 * //   { id: '1', price: '19.99', available: 'true' },
 * //   { id: '2', price: ' N/A ', available: '0' }
 * // ];
 *
 * let castedProducts = castColumnType(products, 'id', 'number');
 * castedProducts = castColumnType(castedProducts, 'price', 'number');
 * castedProducts = castColumnType(castedProducts, 'available', 'boolean');
 * // castedProducts might be:
 * // [
 * //   { id: 1, price: 19.99, available: true },
 * //   { id: '2', price: null, available: false }
 * // ] (Note: id for 2nd product became '2' due to Product interface, but underlying cast was attempted)
 * // Actual type of castedProducts elements at runtime will differ from Product interface.
 * ```
 */
export function castColumnType<T extends Record<string, any>>(
  data: T[],
  columnName: keyof T | string,
  targetType: 'string' | 'number' | 'boolean' | 'date'
): T[] {
  // The CSV class method returns CSV<T>, so the generic T is preserved.
  // When calling toArray(), it becomes T[], which is accurate for the structure,
  // but the runtime types of values within the objects will have changed.
  return CSV.fromData(data).castColumnType(columnName, targetType).toArray();
}

/**
 * Removes duplicate rows from the data array based on all columns or a specified subset of columns.
 * The first occurrence of a unique row (or unique combination of values in `columnsToCheck`) is kept.
 *
 * @template T - The type of objects in the input array.
 * @param data - Array of objects to deduplicate.
 * @param columnsToCheck - Optional array of column names (`keyof T`) to check for duplication.
 *                         If omitted or empty, all columns in a row are used.
 * @returns A new array of objects with duplicate rows removed.
 * @example
 * ```typescript
 * // interface Item { id: number; category: string; value: number }
 * // const items: Item[] = [
 * //   { id: 1, category: 'A', value: 10 }, { id: 2, category: 'B', value: 20 },
 * //   { id: 1, category: 'A', value: 10 }, { id: 3, category: 'A', value: 30 }
 * // ];
 *
 * const dedupedAll = deduplicate(items);
 * // dedupedAll: [{ id: 1, category: 'A', value: 10 }, { id: 2, category: 'B', value: 20 }, { id: 3, category: 'A', value: 30 }]
 *
 * const dedupedByCat = deduplicate(items, ['category']);
 * // dedupedByCat: [{ id: 1, category: 'A', value: 10 }, { id: 2, category: 'B', value: 20 }]
 * ```
 */
export function deduplicate<T extends Record<string, any>>(
  data: T[],
  columnsToCheck?: (keyof T)[]
): T[] {
  return CSV.fromData(data).deduplicate(columnsToCheck).toArray();
}

/**
 * Splits the data array into two new arrays based on a condition.
 * Rows for which the condition is true go into the `pass` array; others go into the `fail` array.
 *
 * @template T - The type of objects in the input array.
 * @param data - Array of objects to split.
 * @param condition - A function that takes a row and returns `true` if it should
 *                    be included in the `pass` array.
 * @returns An object containing two new arrays: `pass` and `fail`.
 * @example
 * ```typescript
 * // interface User { id: number; name: string; age: number }
 * // const users: User[] = [
 * //   { id: 1, name: 'Alice', age: 30 }, { id: 2, name: 'Bob', age: 22 },
 * //   { id: 3, name: 'Carol', age: 35 }
 * // ];
 *
 * const { pass: adults, fail: minors } = split(users, row => row.age >= 30);
 * // adults is [{ id: 1, name: 'Alice', age: 30 }, { id: 3, name: 'Carol', age: 35 }]
 * // minors is [{ id: 2, name: 'Bob', age: 22 }]
 * ```
 */
export function split<T extends Record<string, any>>(
  data: T[],
  condition: (row: T) => boolean
): { pass: T[]; fail: T[] } {
  const { pass: passCsv, fail: failCsv } = CSV.fromData(data).split(condition);
  return {
    pass: passCsv.toArray(),
    fail: failCsv.toArray(),
  };
}

/**
 * Joins the current data array (left table) with another data array (right table).
 *
 * @template T - Row type of the left data array.
 * @template OtherRowType - Row type of the right data array.
 * @template JoinedRowType - Row type of the resulting joined data.
 * @param dataLeft - The left array of objects.
 * @param dataRight - The right array of objects to join with.
 * @param onConfig - An object specifying the join keys and type:
 *             `left`: The key (column name) from the `dataLeft`.
 *             `right`: The key (column name) from the `dataRight`.
 *             `type`: Optional join type: 'inner' (default), 'left', 'right', 'outer'.
 * @param select - Optional function to transform the combined row. It receives `leftRow`
 *                 (or `null`) and `rightRow` (or `null`).
 *                 Default merge is `{ ...leftRow, ...rightRow }`.
 * @returns A new array of objects with the joined data.
 * @example
 * ```typescript
 * // interface User { id: number; name: string; cityId: number; }
 * // interface City { cityId: number; cityName: string; }
 * // const users: User[] = [{ id: 1, name: 'Alice', cityId: 101 }];
 * // const cities: City[] = [{ cityId: 101, cityName: 'New York' }];
 *
 * const innerJoined = join(
 *   users,
 *   cities,
 *   { left: 'cityId', right: 'cityId', type: 'inner' }
 * );
 * // innerJoined: [{ id: 1, name: 'Alice', cityId: 101, cityName: 'New York' }]
 * ```
 */
export function join<
  T extends Record<string, any>,
  OtherRowType extends Record<string, any>,
  JoinedRowType extends Record<string, any> = T & Partial<OtherRowType>
>(
  dataLeft: T[],
  dataRight: OtherRowType[],
  onConfig: {
    left: keyof T;
    right: keyof OtherRowType;
    type?: 'inner' | 'left' | 'right' | 'outer';
  },
  select?: (leftRow: T | null, rightRow: OtherRowType | null) => JoinedRowType
): JoinedRowType[] {
  const csvLeft = CSV.fromData(dataLeft);
  const csvRight = CSV.fromData(dataRight);
  return csvLeft.join<OtherRowType, JoinedRowType>(csvRight, onConfig, select).toArray();
}

/**
 * Transforms data from a wide format to a long format (unpivots or melts).
 * Specified `valueCols` are converted into two new columns: one for the original
 * column name (variable) and one for its value. `idCols` are repeated.
 *
 * @template T - Row type of the input data.
 * @template IdKeys - Keys of the identifier columns.
 * @template ValueKeys - Keys of the value columns being unpivoted.
 * @template VarNameCol - Type of the new variable name column.
 * @template ValueNameCol - Type of the new value name column.
 * @param data - Array of objects to unpivot.
 * @param idCols - Array of column names (`keyof T`) that identify each observation.
 * @param valueCols - Array of column names (`keyof T`) whose values will be unpivoted.
 * @param varName - Name for the new column holding original column names. Defaults to 'variable'.
 * @param valueName - Name for the new column holding values. Defaults to 'value'.
 * @returns A new array of objects with the unpivoted data.
 * @example
 * ```typescript
 * // interface Sales { product: string; q1_sales: number; q2_sales: number; }
 * // const salesData: Sales[] = [{ product: 'A', q1_sales: 100, q2_sales: 150 }];
 *
 * const unpivoted = unpivot(
 *   salesData,
 *   ['product'],
 *   ['q1_sales', 'q2_sales'],
 *   'quarter',
 *   'amount'
 * );
 * // unpivoted:
 * // [
 * //   { product: 'A', quarter: 'q1_sales', amount: 100 },
 * //   { product: 'A', quarter: 'q2_sales', amount: 150 }
 * // ]
 * ```
 */
export function unpivot<
  T extends Record<string, any>,
  IdKeys extends keyof T,
  ValueKeys extends keyof T,
  VarNameCol extends string = 'variable',
  ValueNameCol extends string = 'value'
>(
  data: T[],
  idCols: IdKeys[],
  valueCols: ValueKeys[],
  varName: VarNameCol = 'variable' as VarNameCol,
  valueName: ValueNameCol = 'value' as ValueNameCol
): Array<
  Pick<T, IdKeys> &
  Record<VarNameCol, ValueKeys extends string ? ValueKeys : string> &
  Record<ValueNameCol, T[ValueKeys]>
> {
  return CSV.fromData(data)
    .unpivot<IdKeys, ValueKeys, VarNameCol, ValueNameCol>(idCols, valueCols, varName, valueName)
    .toArray();
}

/**
 * Fills missing values (`null` or `undefined`) in a specified column of the data array.
 * The generic type T of array objects does not change, but underlying data types might.
 *
 * @template T - The type of objects in the input array.
 * @template K - The key of the column to fill.
 * @param data - Array of objects to modify.
 * @param columnName - The name of the column to fill missing values in.
 * @param valueOrFn - The value to fill with, or a function that takes the current row
 *                    and returns the value to fill with. Can be of `any` type for flexibility.
 * @returns A new array of objects with missing values filled.
 * @example
 * ```typescript
 * // interface Product { name: string; price?: number | null; }
 * // const products: Product[] = [ { name: 'Apple', price: 1.0 }, { name: 'Banana', price: null }];
 *
 * const filledProducts = fillMissingValues(products, 'price', 0);
 * // filledProducts: [{ name: 'Apple', price: 1.0 }, { name: 'Banana', price: 0 }]
 * ```
 */
export function fillMissingValues<T extends Record<string, any>, K extends keyof T>(
  data: T[],
  columnName: K,
  valueOrFn: T[K] | any | ((row: T) => T[K] | any)
): T[] {
  return CSV.fromData(data).fillMissingValues(columnName, valueOrFn).toArray();
}

/**
 * Normalizes the text case of string values in a specified column of the data array.
 * Non-string values or missing columns are not affected.
 *
 * @template T - The type of objects in the input array.
 * @template K - The key of the column to normalize.
 * @param data - Array of objects to modify.
 * @param columnName - The name of the column to normalize.
 * @param normalizationType - The type of normalization: 'lowercase', 'uppercase', or 'capitalize'.
 * @returns A new array of objects with text normalized.
 * @example
 * ```typescript
 * // interface City { name: string; countryCode: string; }
 * // const cities: City[] = [{ name: 'new york city', countryCode: 'us' }];
 *
 * const capNames = normalizeText(cities, 'name', 'capitalize');
 * // capNames[0].name is 'New York City'
 * const upperCodes = normalizeText(cities, 'countryCode', 'uppercase');
 * // upperCodes[0].countryCode is 'US'
 * ```
 */
export function normalizeText<T extends Record<string, any>, K extends keyof T>(
  data: T[],
  columnName: K,
  normalizationType: 'lowercase' | 'uppercase' | 'capitalize'
): T[] {
  return CSV.fromData(data).normalizeText(columnName, normalizationType).toArray();
}

/**
 * Trims leading and trailing whitespace from string values in specified columns of the data array.
 * If no columns are specified, it attempts to trim all string values in all columns.
 * Non-string values are not affected.
 *
 * @template T - The type of objects in the input array.
 * @param data - Array of objects to modify.
 * @param columns - Optional array of column names (`keyof T` or string) to trim.
 *                  If omitted, all columns with string values are processed.
 * @returns A new array of objects with whitespace trimmed.
 * @example
 * ```typescript
 * // interface Contact { name: string; city: string; }
 * // const contacts: Contact[] = [{ name: '  Alice  ', city: ' New York ' }];
 *
 * const trimmedContacts = trimWhitespace(contacts, ['name', 'city']);
 * // trimmedContacts[0] is { name: 'Alice', city: 'New York' }
 *
 * const trimmedAll = trimWhitespace(contacts); // Also trims 'name' and 'city'
 * ```
 */
export function trimWhitespace<T extends Record<string, any>>(
  data: T[],
  columns?: (keyof T | string)[]
): T[] {
  return CSV.fromData(data).trimWhitespace(columns).toArray();
}


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
  get arrayToObjArray() { return CSVArrayUtils.arrayToObjArray; },
  
  /**
   * Transform objects to arrays
   * @param data - Array of structured objects
   * @param headerMap - Mapping configuration
   * @param headers - Column headers
   * @param includeHeaders - Whether to include headers
   * @returns Array of arrays
   */
  get objArrayToArray() { return CSVArrayUtils.objArrayToArray; },
  
  /**
   * Group objects by field
   * @param data - Array of objects
   * @param field - Field to group by
   * @returns Grouped objects
   */
  get groupByField() { return CSVArrayUtils.groupByField; }
};

/**
 * Get the number of rows in the data
 * @param data - Array of objects
 * @returns The number of rows
 * @example
 * ```typescript
 * const rowCount = count(products);
 * ```
 */
export function count<T extends Record<string, any>>(
  data: T[]
): number {
  return data.length;
}

/**
 * Converts data to a CSV string
 * @param data - Array of objects to convert
 * @param options - Stringify options
 * @returns CSV content as a string
 * @example
 * ```typescript
 * const csvData = toString(products, { header: true });
 * ```
 */
export function toString<T extends Record<string, any>>(
  data: T[],
  options: Parameters<typeof stringifyCSV>[1] = { header: true }
): string {
  try {
    return stringifyCSV(data, options);
  } catch (error) {
    throw new CSVError('Failed to convert data to CSV string', error);
  }
}

/**
 * Validates data against a schema
 * @param data - Array of objects to validate
 * @param schema - The schema configuration to use for validation
 * @returns The validated data
 * @example
 * ```typescript
 * const validatedProducts = validate(products, {
 *   type: 'standard',
 *   version: 1,
 *   mode: 'strict',
 *   schema: {
 *     id: { type: 'string', required: true },
 *     price: { type: 'number', required: true }
 *   }
 * });
 * ```
 */
export function validate<T extends Record<string, any>, U extends Record<string, any> = T>(
  data: T[],
  schema: CSVSchemaConfig<U>
): U[] {
  if (data.length === 0) {
    return [];
  }
  
  return CSV.fromData(data).validate(schema).toArray();
}

/**
 * Process each row with a callback function
 * @param data - Array of objects to process
 * @param callback - Function to process each row
 * @example
 * ```typescript
 * forEach(products, (product, index) => {
 *   console.log(`Product ${index}: ${product.name}`);
 * });
 * ```
 */
export function forEach<T extends Record<string, any>>(
  data: T[],
  callback: (row: T, index: number) => void
): void {
  data.forEach(callback);
}

/**
 * Process rows with an async callback
 * @param data - Array of objects to process
 * @param callback - Async function to process each row
 * @param options - Options for batch processing
 * @returns Promise that resolves when processing is complete
 * @example
 * ```typescript
 * await forEachAsync(products, async (product) => {
 *   await api.updateProduct(product.id, product);
 * }, { batchSize: 5 });
 * ```
 */
export async function forEachAsync<T extends Record<string, any>>(
  data: T[],
  callback: (row: T, index: number) => Promise<void>,
  options: { batchSize?: number; batchConcurrency?: number } = {}
): Promise<void> {
  const batchSize = options.batchSize || 1;
  const batchConcurrency = options.batchConcurrency || 1;
  
  if (batchSize <= 1 && batchConcurrency <= 1) {
    // Original sequential processing
    for (let i = 0; i < data.length; i++) {
      await callback(data[i], i);
    }
    return;
  }
  
  // Process data in batches with concurrency
  const batches: T[][] = [];
  for (let i = 0; i < data.length; i += batchSize) {
    batches.push(data.slice(i, i + batchSize));
  }
  
  // Process batches with controlled concurrency
  for (let i = 0; i < batches.length; i += batchConcurrency) {
    const batchPromises = batches.slice(i, i + batchConcurrency).map(async (batch, batchIndex) => {
      const startIdx = i * batchSize + batchIndex * batchSize;
      const promises = batch.map((row, rowIndex) => 
        callback(row, startIdx + rowIndex)
      );
      await Promise.all(promises);
    });
    
    await Promise.all(batchPromises);
  }
}

/**
 * Map over rows asynchronously
 * @param data - Array of objects to transform
 * @param transformer - Async function to transform each row
 * @param options - Optional batch processing options
 * @returns Promise resolving to array of transformed results
 * @example
 * ```typescript
 * const enrichedProducts = await mapAsync(products, 
 *   async (product) => {
 *     const details = await api.getProductDetails(product.id);
 *     return { ...product, details };
 *   },
 *   { batchSize: 5 }
 * );
 * ```
 */
export async function mapAsync<T extends Record<string, any>, R>(
  data: T[],
  transformer: (row: T, index: number) => Promise<R>,
  options?: { batchSize?: number }
): Promise<R[]> {
  const result: R[] = [];
  const batchSize = options?.batchSize || 50;
  
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((row, index) => transformer(row, i + index))
    );
    result.push(...batchResults);
  }
  
  return result;
}

/**
 * Reduce rows asynchronously
 * @param data - Array of objects to reduce
 * @param reducer - Async reducer function
 * @param initialValue - Initial accumulator value
 * @param options - Optional processing options
 * @returns Promise resolving to final accumulated value
 * @example
 * ```typescript
 * const totalRevenue = await reduceAsync(
 *   orders,
 *   async (total, order) => {
 *     const exchangeRate = await getExchangeRate(order.currency);
 *     return total + (order.amount * exchangeRate);
 *   },
 *   0
 * );
 * ```
 */
export async function reduceAsync<T extends Record<string, any>, R>(
  data: T[],
  reducer: (accumulator: R, row: T, index: number) => Promise<R>,
  initialValue: R,
  options?: { strategy?: 'sequential' | 'mapreduce', batchSize?: number }
): Promise<R> {
  const strategy = options?.strategy || 'sequential';
  const batchSize = options?.batchSize || 100;
  
  if (strategy === 'sequential') {
    // Simple sequential reduction
    let accumulator = initialValue;
    
    for (let i = 0; i < data.length; i++) {
      accumulator = await reducer(accumulator, data[i], i);
    }
    
    return accumulator;
  } else {
    // Map-reduce strategy for better parallelism
    // First map: Process items in batches
    const batches = [];
    for (let i = 0; i < data.length; i += batchSize) {
      batches.push(data.slice(i, i + batchSize));
    }
    
    // Process each batch in parallel with its own accumulator
    const batchResults = await Promise.all(
      batches.map(async (batch, batchIndex) => {
        let batchAccumulator = initialValue;
        for (let i = 0; i < batch.length; i++) {
          const index = batchIndex * batchSize + i;
          batchAccumulator = await reducer(batchAccumulator, batch[i], index);
        }
        return batchAccumulator;
      })
    );
    
    // Then reduce: Combine batch results
    let finalResult = initialValue;
    for (const result of batchResults) {
      finalResult = await reducer(finalResult, result as unknown as T, -1);
    }
    
    return finalResult;
  }
}

/**
 * Sorts rows by a column using worker threads for large datasets
 * @param data - Array of objects to sort
 * @param column - The column to sort by
 * @param direction - Sort direction (default: 'asc')
 * @returns Promise resolving to sorted array
 * @example
 * ```typescript
 * const sortedProducts = await sortByAsync(products, 'price', 'desc');
 * ```
 */
export async function sortByAsync<T extends Record<string, any>, K extends keyof T>(
  data: T[], 
  column: K,
  direction: SortDirection = 'asc'
): Promise<T[]> {
  // For small datasets, just use the regular sort
  if (data.length <= 10000) {
    return sortBy(data, column, direction);
  }
  
  // Define the compare function based on column and direction
  const compare = (a: T, b: T): number => {
    const aVal = a[column];
    const bVal = b[column];
    
    // Handle numeric values
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return direction === 'asc' ? aVal - bVal : bVal - aVal;
    }
    
    // Default string comparison
    const aStr = String(aVal);
    const bStr = String(bVal);
    const comparison = aStr.localeCompare(bStr);
    return direction === 'asc' ? comparison : -comparison;
  };
  
  // Perform parallel sorting with merge
  try {
    const cpuCount = require('os').cpus().length;
    const workerCount = Math.min(cpuCount, 4); // Limit to 4 workers max
    
    // Split into chunks for parallel processing
    const chunkSize = Math.ceil(data.length / workerCount);
    const chunks: T[][] = [];
    
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.slice(i, i + chunkSize));
    }
    
    // Sort each chunk (could be parallelized in workers)
    const sortedChunks = await Promise.all(
      chunks.map(chunk => {
        return Promise.resolve([...chunk].sort(compare));
      })
    );
    
    // Merge the sorted chunks (k-way merge)
    return mergeKSortedArrays(sortedChunks, compare);
  } catch (error) {
    // Fallback to synchronous sort if something goes wrong
    console.warn('Parallel sort failed, falling back to synchronous sort:', error);
    return [...data].sort(compare);
  }
}

/**
 * Merges K sorted arrays into a single sorted array
 * @param arrays - Array of sorted arrays
 * @param compare - Compare function for sorting
 * @returns Single sorted array
 * @private
 */
function mergeKSortedArrays<T>(arrays: T[][], compare: (a: T, b: T) => number): T[] {
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return arrays[0];
  
  // Helper to merge two sorted arrays
  const mergeTwoArrays = (a: T[], b: T[]): T[] => {
    const result: T[] = [];
    let i = 0, j = 0;
    
    while (i < a.length && j < b.length) {
      if (compare(a[i], b[j]) <= 0) {
        result.push(a[i]);
        i++;
      } else {
        result.push(b[j]);
        j++;
      }
    }
    
    // Add remaining elements
    while (i < a.length) result.push(a[i++]);
    while (j < b.length) result.push(b[j++]);
    
    return result;
  };
  
  // Use a divide-and-conquer approach to merge all arrays
  const mergeArrays = (start: number, end: number): T[] => {
    if (start === end) {
      return arrays[start];
    }
    
    if (end - start === 1) {
      return mergeTwoArrays(arrays[start], arrays[end]);
    }
    
    const mid = Math.floor((start + end) / 2);
    const left = mergeArrays(start, mid);
    const right = mergeArrays(mid + 1, end);
    
    return mergeTwoArrays(left, right);
  };
  
  return mergeArrays(0, arrays.length - 1);
}

/**
 * Get the first n rows (alias for head)
 * @param data - Array of objects
 * @param count - Number of rows to get
 * @returns First n rows
 * @example
 * ```typescript
 * const topProducts = take(products, 5);
 * ```
 */
export function take<T extends Record<string, any>>(
  data: T[], 
  count: number = 10
): T[] {
  return head(data, count);
}

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
  sortByAsync,
  aggregate,
  distinct,
  pivot,
  merge,
  sample,
  head,
  tail,
  take,
  count,
  toString,
  validate,
  forEach,
  forEachAsync,
  mapAsync,
  reduceAsync,
  getBaseRow,
  createRow,
  mapData,
  filterData,
  reduceData,
  addColumn,
  removeColumn,
  renameColumn,
  reorderColumns,
  castColumnType,
  deduplicate,
  split,
  join,
  unpivot,
  fillMissingValues,
  normalizeText,
  trimWhitespace,
  arrayTransformations
};