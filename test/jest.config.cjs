/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }] },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^(\\.{1,2}/.*)\\.ts$': '$1',
    },
    extensionsToTreatAsEsm: ['.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    setupFiles: ['<rootDir>/jest.env.js'],
    roots: ['<rootDir>'],
};
