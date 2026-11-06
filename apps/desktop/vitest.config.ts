import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Vitest does not read electron.vite.config.ts, so this repeats the renderer's
// `@/` alias, and electron.vite.config.test.ts checks the two stay equal.
// Without it, a test that reaches a renderer module importing `@/...` fails to
// resolve.
export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src/renderer'),
		},
	},
	test: {
		// Many suites create git repositories and child processes. Bound
		// concurrency so real simulator/Metro work can continue on the same Mac.
		maxWorkers: 4,
		include: ['*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
	},
});
