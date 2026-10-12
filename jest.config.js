module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: { '^.+\\.(ts|js)$': 'babel-jest' },
  // ethers v6 (the test-only reference encoder) / @noble publish ESM that
  // needs Babel; everything else in node_modules loads as CJS.
  transformIgnorePatterns: ['node_modules/(?!(ethers|@noble|@adraffy)/)'],
};
