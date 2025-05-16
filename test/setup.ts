import { vi } from 'vitest';

// Define any global mock configuration here
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  }
}));

vi.mock('path', () => ({
  resolve: vi.fn((p) => p),
  join: vi.fn((dir, file) => `${dir}/${file}`),
}));

// Mock for 'csv' module that's reused across multiple tests
const mockParserFactory = () => ({
  on: vi.fn().mockImplementation(function(event, callback) {
    if (event === 'readable') {
      setTimeout(() => callback(), 10);
    }
    return this;
  }),
  read: vi.fn()
    .mockReturnValueOnce({ id: '1', name: 'Product A', price: '100' })
    .mockReturnValueOnce({ id: '2', name: 'Product B', price: '200' })
    .mockReturnValueOnce({ id: '3', name: 'Product C', price: '300' })
    .mockReturnValueOnce(null),
  pipe: vi.fn().mockImplementation(function() { return this; })
});

const mockStringifierFactory = () => ({
  write: vi.fn().mockReturnValue(true),
  pipe: vi.fn().mockImplementation(function() { return this; }),
  end: vi.fn().mockReturnValue(true)
});

vi.mock('csv', () => {
  return {
    parse: vi.fn().mockReturnValue(mockParserFactory()),
    stringify: vi.fn().mockReturnValue(mockStringifierFactory()),
  };
});

vi.mock('stream', () => {
  const actual = vi.importActual('stream');
  return {
    ...actual,
    Transform: vi.fn().mockImplementation(() => ({
      write: vi.fn().mockReturnValue(true),
      pipe: vi.fn().mockReturnValue({
        write: vi.fn().mockReturnValue(true),
        pipe: vi.fn().mockReturnValue({
          write: vi.fn().mockReturnValue(true)
        }),
        end: vi.fn().mockReturnValue(true)
      }),
      end: vi.fn().mockReturnValue(true)
    }))
  };
});