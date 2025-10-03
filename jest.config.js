// jest.config.js – basic config for TypeScript tests in lens-node
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // Increase timeout for long‑running sync test
  testTimeout: 300000,
};
