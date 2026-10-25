module.exports = {
	preset: 'jest-expo',
	testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
	testPathIgnorePatterns: ['/node_modules/'],
	watchman: false,
};
