// tests/validation.test.ts
import { describe, it, expect, vi } from 'vitest';
import CSV, {
  CSVSchemaConfig,
  StandardSchemaV1,
  CSVError,
  RowValidationResult,
  Caster,
  CSVReadOptions,
} from '../src/index'; // Adjust path to your library's entry point
import { z } from 'zod';

// --- Helper Schemas and Data ---

// StandardSchemaV1 Examples
const positiveNumberSchema: StandardSchemaV1<unknown, number> = {
  '~standard': {
    version: 1,
    vendor: 'test-suite',
    types: { input: undefined as unknown, output: 0 as number },
    validate: (v: unknown): StandardSchemaV1.Result<number> => {
      const n = Number(v);
      if (typeof v === 'boolean' || isNaN(n) || n <= 0) {
        return { issues: [{ message: 'Must be a positive number' }] };
      }
      return { value: n };
    },
  },
};

const skuFormatSchema: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'test-suite',
    types: { input: undefined as unknown, output: '' as string },
    validate: (v: unknown): StandardSchemaV1.Result<string> => {
      if (typeof v !== 'string') {
        return { issues: [{ message: 'Input must be a string for SKU' }] };
      }
      if (!v.startsWith('SKU-') || v.length < 5) {
        return { issues: [{ message: 'Invalid SKU format' }] };
      }
      return { value: v.toUpperCase() };
    },
  },
};

const asyncNonEmptyStringSchema: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'test-suite',
    types: { input: undefined as unknown, output: '' as string },
    validate: async (v: unknown): Promise<StandardSchemaV1.Result<string>> => {
      await new Promise(res => setTimeout(res, 5));
      if (typeof v !== 'string' || v.trim() === '') {
        return { issues: [{ message: 'String cannot be empty (async)' }] };
      }
      return { value: v.trim() };
    }
  }
};

// Zod Schemas and Adapter
const zUserObject = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().min(2, 'Name too short'),
  email: z.string().email('Invalid email'),
  role: z.enum(['admin', 'user', 'guest']).optional(),
});
type User = z.infer<typeof zUserObject>;

// Generic Adapter to make a Zod schema conform to StandardSchemaV1 for T (an object)
const ZodObjectToStandardSchema = <TInputSchema extends z.ZodTypeAny>(
  schema: TInputSchema
): StandardSchemaV1<unknown, z.infer<TInputSchema>> => {
  type OutputType = z.infer<TInputSchema>;
  return {
    '~standard': {
      version: 1,
      vendor: 'zod-adapter',
      types: { input: undefined as unknown, output: undefined as OutputType },
      validate: (input: unknown): StandardSchemaV1.Result<OutputType> => {
        const result = schema.safeParse(input);
        if (result.success) {
          return { value: result.data };
        }
        return {
          issues: result.error.errors.map(e => ({
            message: e.message,
            path: e.path.map(p => (typeof p === 'number' ? { key: p } : p)),
          })),
        };
      },
    },
  };
};
const UserRowStandardSchema = ZodObjectToStandardSchema(zUserObject);

const zProductObject = z.object({
  productId: z.string().startsWith('PROD-'),
  price: z.number().positive(),
  tags: z.array(z.string()).optional(),
});
type Product = z.infer<typeof zProductObject>;
const ProductRowStandardSchema = ZodObjectToStandardSchema(zProductObject);

// StandardSchemaV1 for a specific product ID format (for column schema testing)
const ProductIdColumnStandardSchema: StandardSchemaV1<unknown, string> = {
    '~standard': {
        version: 1, vendor: 'test-col-schema', types: {input: undefined as unknown, output:'' as string},
        validate: (v) => {
            if (typeof v !== 'string' || !v.startsWith('PROD-')) {
                return { issues: [{message: "Col: Must start with PROD-"}]};
            }
            return {value: v};
        }
    }
};


// --- Test Suite ---
describe('CSV Data Validation (with StandardSchemaV1)', () => {
  describe('StandardSchemaV1 Column Validation', () => {
    it('should validate columns and filter invalid rows', () => {
      const csvString = `sku,quantity\nSKU-A,10\nINVALID,5\nSKU-B,-2\nSKU-C,20`;
      type Item = { sku: string; quantity: number };
      const schemaConfig: CSVSchemaConfig<Item> = {
        columnSchemas: {
          sku: skuFormatSchema,
          quantity: positiveNumberSchema,
        },
        validationMode: 'filter',
      };
      const readOpts: CSVReadOptions<Item> = {
        customCasts: { columnCasts: { quantity: 'number' } },
        schema: schemaConfig,
      };

      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(2);
      expect(csv.toArray()).toEqual([
        { sku: 'SKU-A', quantity: 10 },
        { sku: 'SKU-C', quantity: 20 },
      ]);
    });

    it('should error on invalid column with mode "error"', () => {
      const csvString = `sku,quantity\nSKU-A,10\nINVALID,5`;
      type Item = { sku: string; quantity: number };
      const schemaConfig: CSVSchemaConfig<Item> = {
        columnSchemas: { sku: skuFormatSchema },
        validationMode: 'error',
      };
      const readOpts: CSVReadOptions<Item> = {
        customCasts: { columnCasts: { quantity: 'number' } },
        schema: schemaConfig,
      };
      expect(() => CSV.fromString(csvString, readOpts)).toThrowError(CSVError);
    });

    it('should keep invalid rows and provide column validation results with mode "keep"', () => {
      const csvString = `sku,value\nSKU-OK,100\nBAD,200\nSKU-FINE,not_a_number`;
      type Data = { sku: string; value: number };
      const schemaConfig: CSVSchemaConfig<Data> = {
        columnSchemas: { sku: skuFormatSchema, value: positiveNumberSchema },
        validationMode: 'keep',
      };
      const readOpts: CSVReadOptions<Data> = {
        customCasts: { columnCasts: { value: 'number' } }, // 'not_a_number' becomes NaN
        schema: schemaConfig,
      };
      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(3);
      const results = csv.validationResults!;
      expect(results.length).toBe(3);

      expect(results[0].valid).toBe(true);
      expect(results[0].validatedRow).toEqual({ sku: 'SKU-OK', value: 100 });

      expect(results[1].valid).toBe(false);
      expect(results[1].originalRow).toEqual({ sku: 'BAD', value: 200 });
      expect(results[1].columnIssues?.sku?.[0].message).toBe('Invalid SKU format');
      // validatedRow for r1: sku is BAD (original as it failed), value is 200 (passed its schema if it had one, or original)
      expect(results[1].validatedRow).toEqual({ sku: 'BAD', value: 200 });


      expect(results[2].valid).toBe(false);
      expect(results[2].originalRow).toEqual({ sku: 'SKU-FINE', value: NaN }); // value became NaN after customCast
      expect(results[2].columnIssues?.value?.[0].message).toBe('Must be a positive number');
      // validatedRow for r2: sku is SKU-FINE (coerced & valid), value is NaN (original for failing column)
      expect(results[2].validatedRow).toEqual({ sku: 'SKU-FINE', value: NaN });
    });
  });

  describe('StandardSchemaV1 Row Validation', () => {
    it('should validate rows using a StandardSchemaV1 compliant rowSchema and filter', () => {
      const csvString = `id,name,email,role\n1,Alice,alice@example.com,admin\n2,Bo,bob@invalid,user`;
      const schemaConfig: CSVSchemaConfig<User> = {
        rowSchema: UserRowStandardSchema,
        validationMode: 'filter',
      };
      const readOpts: CSVReadOptions<User> = { schema: schemaConfig };
      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(1);
      expect(csv.toArray()[0].name).toBe('Alice');
    });

    it('should error with rowSchema and mode "error"', () => {
      const csvString = `id,name,email\n1,A,not-an-email`; // Name 'A' too short
      const schemaConfig: CSVSchemaConfig<User> = {
        rowSchema: UserRowStandardSchema,
        validationMode: 'error',
      };
      const readOpts: CSVReadOptions<User> = { schema: schemaConfig };
      expect(() => CSV.fromString(csvString, readOpts)).toThrowError(CSVError);
    });

    it('should keep invalid rows with rowSchema and mode "keep", providing rowIssues', () => {
      const csvString = `id,name,email\n1,Valid User,valid@example.com\n2,Inv,invalid-email`;
      const schemaConfig: CSVSchemaConfig<User> = {
        rowSchema: UserRowStandardSchema,
        validationMode: 'keep',
      };
      const readOpts: CSVReadOptions<User> = { schema: schemaConfig };
      const csv = CSV.fromString(csvString, readOpts);
      const results = csv.validationResults!;
      const invalidResult = results.find(r => !r.valid)!;

      expect(invalidResult.originalRow.name).toBe('Inv');
      expect(invalidResult.rowIssues).toBeDefined();
      expect(invalidResult.rowIssues!.some(i => i.path?.includes('name') && i.message === 'Name too short')).toBe(true);
      expect(invalidResult.rowIssues!.some(i => i.path?.includes('email') && i.message === 'Invalid email')).toBe(true);
    });
  });

  describe('Combined Column and Row StandardSchemaV1 Validation', () => {
    it('should process columnSchemas then rowSchema', () => {
      const csvString = `productId,price,tags\nPROD-OK,19.99,tagA\nBAD-ID,10,tagC\nPROD-FINE,not_a_number,tagD`;

      const readOpts: CSVReadOptions<Product> = {
        customCasts: {
          // Price becomes number or NaN. Tags becomes string array.
          columnCasts: { price: 'number', tags: { test:() => true, parse: v => v.split(';').map(s => s.trim()).filter(Boolean) } as Caster<string[]> },
        },
        schema: {
          columnSchemas: { productId: ProductIdColumnStandardSchema }, // Validates productId format
          rowSchema: ProductRowStandardSchema, // Validates the whole Product object
          validationMode: 'keep',
        },
      };
      const csv = CSV.fromString(csvString, readOpts);
      const results = csv.validationResults!;

      // Row 1: Valid
      expect(results[0].valid).toBe(true);
      expect(results[0].validatedRow).toEqual({ productId: 'PROD-OK', price: 19.99, tags: ['tagA'] });

      // Row 2: Invalid productId from columnSchema.
      expect(results[1].valid).toBe(false);
      expect(results[1].columnIssues?.productId?.[0].message).toBe('Col: Must start with PROD-');
      // The rowSchema will also fail because ProductIdColumnStandardSchema didn't coerce "BAD-ID"
      // and ProductRowStandardSchema receives the original "BAD-ID" for productId.
      expect(results[1].rowIssues?.some(i => i.path?.includes('productId'))).toBe(true);


      // Row 3: productId column is fine, but price (NaN after customCast) fails rowSchema's positive number check.
      expect(results[2].valid).toBe(false);
      expect(results[2].columnIssues).toBeUndefined(); // productId column was fine
      expect(results[2].rowIssues?.some(i => i.path?.includes('price'))).toBe(true);
    });
  });

  describe('Sync vs. Async StandardSchemaV1 Validation', () => {
    const csvStringForNameCol = `name\nTest\n \nValidName`; // Row 2: " " should fail asyncNonEmpty
    const dataForNameCol = [{ name: 'Test' }, { name: ' ' }, { name: 'ValidName' }];
    type NameType = { name: string };

    it('should report issue if sync method used with an async COLUMN schema', () => {
      const schemaConfig: CSVSchemaConfig<NameType> = {
        columnSchemas: { name: asyncNonEmptyStringSchema },
        validationMode: 'keep',
      };
      const readOpts: CSVReadOptions<NameType> = { schema: schemaConfig };
      const csv = CSV.fromString(csvStringForNameCol, readOpts);
      const results = csv.validationResults!;

      results.forEach(result => {
        expect(result.valid).toBe(false);
        expect(result.columnIssues?.name?.[0].message).toBe("Validation is asynchronous but synchronous validation was expected.");
      });
    });

    it('should throw if sync method used with an async schema AND useAsync: true', () => {
      const schemaConfig: CSVSchemaConfig<NameType> = {
        columnSchemas: { name: asyncNonEmptyStringSchema },
        useAsync: true,
      };
      const readOpts: CSVReadOptions<NameType> = { schema: schemaConfig };
      expect(() => CSV.fromString(csvStringForNameCol, readOpts)).toThrowError(/Asynchronous schema validation is not supported/);
    });

    it('should correctly run async COLUMN validation with validateAsync', async () => {
      const csvInstance = CSV.fromData(dataForNameCol);
      const schemaConfig: CSVSchemaConfig<NameType> = {
        columnSchemas: { name: asyncNonEmptyStringSchema },
        validationMode: 'filter', // " " should be filtered out
        useAsync: true,
      };
      const validatedCsv = await csvInstance.validateAsync(schemaConfig);
      expect(validatedCsv.count()).toBe(2);
      expect(validatedCsv.toArray().map(r => r.name)).toEqual(['Test', 'ValidName']);
    });

    it('should filter with async COLUMN schema in fromFileAsync', async () => {
      const { Readable } = await import('node:stream');
      vi.mock('node:fs', async (importOriginal) => {
        const originalFs = await importOriginal() as typeof import('node:fs');
        return { ...originalFs, createReadStream: vi.fn().mockImplementation(() => Readable.from([csvStringForNameCol])) };
      });
      const schemaConfig: CSVSchemaConfig<NameType> = {
        columnSchemas: { name: asyncNonEmptyStringSchema },
        validationMode: 'filter',
      };
      const readOpts: CSVReadOptions<NameType> = { schema: schemaConfig }; // fromFileAsync implies useAsync: true
      const csv = await CSV.fromFileAsync('dummy.csv', readOpts);
      expect(csv.count()).toBe(2);
      expect(csv.toArray().map(r => r.name)).toEqual(['Test', 'ValidName']);
      vi.restoreAllMocks();
    });
  });

  describe('StandardSchemaV1 Interaction with CustomCasts', () => {
    it('customCasts run before StandardSchemaV1 column validation', () => {
      const csvString = `value\n"TRUE"\n"100"`;
      type MixedData = { value: boolean | number };

      const stringToBoolCaster: Caster<boolean> = {
        test: v => typeof v === 'string' && (v.toUpperCase() === 'TRUE' || v.toUpperCase() === 'FALSE'),
        parse: v => v.toUpperCase() === 'TRUE',
      };

      const strictBooleanSchema: StandardSchemaV1<unknown, boolean> = {
        '~standard': {
          version: 1, vendor: 'test', types: { input: undefined as unknown, output: true as boolean },
          validate: (v: unknown) => typeof v === 'boolean' ? { value: v } : { issues: [{ message: 'Must be a strict boolean' }] }
        }
      };

      const readOpts: CSVReadOptions<MixedData> = {
        customCasts: { columnCasts: { value: [stringToBoolCaster, 'number'] } }, // Tries bool, then number caster
        schema: {
          columnSchemas: { value: strictBooleanSchema as StandardSchemaV1<unknown, boolean> }, // Schema expects boolean
          validationMode: 'keep',
        },
      };
      const csv = CSV.fromString(csvString, readOpts);
      const results = csv.validationResults!;

      expect(results[0].valid).toBe(true); // "TRUE" -> true (caster) -> true (schema)
      expect(results[0].validatedRow?.value).toBe(true);

      expect(results[1].valid).toBe(false); // "100" -> 100 (caster) -> fails strictBooleanSchema
      expect(results[1].columnIssues?.value?.[0].message).toBe('Must be a strict boolean');
      expect(results[1].originalRow?.value).toBe(100); // Value after customCasts
    });
  });

  describe('StandardSchemaV1 Validation Edge Cases', () => {
    it('handles empty CSV input gracefully with schema', () => {
      const csvString = ``;
      const schemaConfig: CSVSchemaConfig<User> = { rowSchema: UserRowStandardSchema };
      const readOpts: CSVReadOptions<User> = { schema: schemaConfig };
      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(0);
      expect(csv.validationResults).toBeUndefined(); // Or empty array depending on internal logic for no data
    });

    it('handles CSV with only headers and schema', () => {
      const csvString = `id,name,email`;
      const schemaConfig: CSVSchemaConfig<User> = { rowSchema: UserRowStandardSchema, validationMode: 'filter' };
      const readOpts: CSVReadOptions<User> = { schema: schemaConfig };
      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(0);
    });

    it('columnSchemas applied even if rowSchema is not present', () => {
      const csvString = `sku\nINVALIDSKU`; // skuFormatSchema expects "SKU-" prefix and length >= 5
      type Item = {sku: string};
      const schemaConfig: CSVSchemaConfig<Item> = {
        columnSchemas: { sku: skuFormatSchema },
        validationMode: 'filter'
      };
      const readOpts: CSVReadOptions<Item> = { schema: schemaConfig };
      const csv = CSV.fromString(csvString, readOpts);
      expect(csv.count()).toBe(0); // Filtered due to column schema failure
    });

    it('validate() method on CSV instance works correctly with StandardSchemaV1', async () => {
      type DataType = { name: string, value: number | string }; // Initial data can have string value
      type TargetType = { name: string, value: number };    // Target after validation

      const csvData: DataType[] = [{ name: " Test ", value: "100" }];
      const csvInstance = CSV.fromData(csvData);

      const schemaConf: CSVSchemaConfig<TargetType> = {
        columnSchemas: {
          name: asyncNonEmptyStringSchema, // Async schema for name
          value: positiveNumberSchema      // Sync schema for value
        },
        validationMode: 'keep'
      };

      // Test with sync validate() - need to provide customCasts here if data isn't already correct type
      // The validate method itself does not take a CSVReadOptions, customCasts would need to be on schemaConf or data prepped
      // Let's assume the CSV instance data should be prepped or schema should handle coercion.
      // For this test, to make `positiveNumberSchema` work, `value` needs to be a number.
      // We can do this by creating a new CSV instance with casted data.
      const castedCsvInstance = CSV.fromData(csvData, {
        customCasts: { columnCasts: { value: 'number' } }
      } as any); // 'as any' to simplify for fromData which doesn't take readOptions.

      const validatedCsvSync = castedCsvInstance.validate({ ...schemaConf, useAsync: false }); // Force sync
      const syncResults = validatedCsvSync.validationResults!;
      expect(syncResults[0].valid).toBe(false); // Name validation will issue "async expected"
      expect(syncResults[0].columnIssues?.name![0].message).toBe("Validation is asynchronous but synchronous validation was expected.");
      // Value (now number 100) should pass positiveNumberSchema
      expect(syncResults[0].columnIssues?.value).toBeUndefined();
      expect(validatedCsvSync.toArray()[0].value).toBe(100); // Even if row invalid, validated parts are there

      // Test with async validateAsync()
      const asyncValidatedCsv = await castedCsvInstance.validateAsync({ ...schemaConf, useAsync: true });
      const asyncResults = asyncValidatedCsv.validationResults!;
      expect(asyncResults[0].valid).toBe(true);
      expect(asyncResults[0].validatedRow).toEqual({ name: 'Test', value: 100 });
    });
  });
});