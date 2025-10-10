import fs from 'fs';
import path from 'path';
import * as os from 'os';
import CSV, {
  CSVError,
  csvBatchGenerator,
} from '../src';

describe('Integration Tests', () => {
  // Create temporary directory and files for integration tests
  const tempDir = path.join(process.cwd(), 'test-temp');
  const tempFilePath = path.join(tempDir, 'test.csv');
  const outputFilePath = path.join(tempDir, 'output.csv');

  beforeEach(() => {
    // Ensure temp dir exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    if (fs.existsSync(outputFilePath)) {
      fs.unlinkSync(outputFilePath);
    }
  });

  // Real file system tests
  it('reads and writes CSV files with real file system', () => {
    const csvContent = 'id,name,price\n1,Product A,100\n2,Product B,200';
    fs.writeFileSync(tempFilePath, csvContent, 'utf8');

    // Read CSV
    const csv = CSV.fromFile(tempFilePath);
    expect(csv.count()).toBe(2);
    expect(csv.findRow('1', 'id')?.name).toBe('Product A');

    // Transform
    const transformed = csv.updateColumn('price', value => `${value}`);

    // Write back
    transformed.writeToFile(outputFilePath);

    // Verify output
    const outputContent = fs.readFileSync(outputFilePath, 'utf8');
    expect(outputContent).toContain('id,name,price');
    expect(outputContent).toContain('1,Product A,$100');
    expect(outputContent).toContain('2,Product B,$200');
  });

  it('handles header mapping with real files', () => {
    const csvContent = 'user_id,first_name,last_name\n1,John,Doe\n2,Jane,Smith';
    fs.writeFileSync(tempFilePath, csvContent, 'utf8');

    // Read with header mapping
    const headerMap = {
      'user_id': 'id',
      'first_name': 'profile.firstName',
      'last_name': 'profile.lastName'
    };

    const users = CSV.fromFile(tempFilePath, { headerMap });

    // Verify transformation
    expect(users.count()).toBe(2);
    expect(users.toArray()[0]).toEqual({
      id: '1',
      profile: {
        firstName: 'John',
        lastName: 'Doe'
      }
    });

    // Write with header mapping
    users.writeToFile(outputFilePath, {
      headerMap: {
        'id': 'ID',
        'profile.firstName': 'First Name',
        'profile.lastName': 'Last Name'
      }
    });

    // Verify output format
    const outputContent = fs.readFileSync(outputFilePath, 'utf8');
    expect(outputContent).toContain('ID,First Name,Last Name');
    expect(outputContent).toContain('1,John,Doe');
    expect(outputContent).toContain('2,Jane,Smith');
  });

  it('works with streaming and large files', async () => {
    // Generate a large CSV file
    const generateCsv = (rows: number) => {
      let content = 'id,value\n';
      for (let i = 0; i < rows; i++) {
        content += `${i + 1},${Math.random()}\n`;
      }
      return content;
    };

    // Write large file
    const largeContent = generateCsv(1000);
    fs.writeFileSync(tempFilePath, largeContent, 'utf8');

    // Read using streaming
    let sum = 0;
    let count = 0;

    for await (const batch of csvBatchGenerator(tempFilePath, { batchSize: 100 })) {
      count += batch.length;
      sum += batch.reduce((acc, row) => acc + parseFloat(row.value), 0);
    }

    expect(count).toBe(1000);
    expect(sum).toBeGreaterThan(0);

    // Write back using streaming
    await CSV.fromFileAsync(tempFilePath).then(csv =>
      csv.writeToFileAsync(outputFilePath)
    );

    // Verify output
    const outputContent = fs.readFileSync(outputFilePath, 'utf8');
    expect(outputContent).toContain('id,value');
  });
});