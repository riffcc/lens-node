import { beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

// Clean up test data directories before and after tests
const TEST_DATA_DIR = './test-data';

beforeAll(async () => {
  // Clean up any existing test data
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  
  // Create fresh test data directories
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'replicator'), { recursive: true });
});

afterAll(async () => {
  // Clean up test data after tests complete
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

// Extend Jest timeout for DHT operations
jest.setTimeout(60000);