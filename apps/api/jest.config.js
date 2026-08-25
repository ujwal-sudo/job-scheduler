/** Jest configuration for the API test suite (ts-jest). */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true, strict: false, resolveJsonModule: true } }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  testTimeout: 30000,
};
