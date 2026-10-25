import { defineConfig } from '@playwright/test';

/**
 * Electron end-to-end configuration.
 *
 * These specs launch the built Electron app through Playwright's Electron
 * driver, so they need a display and the produced `dist/` bundle. They are
 * intentionally kept out of the `quality` gate (which runs headless in CI);
 * run them with `pnpm --filter @rndevtools/desktop test:e2e`.
 */
export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	// Electron launches are serial by nature: a single app instance per worker
	// and a shared broker port make parallelism unhelpful here.
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
	outputDir: 'e2e/.artifacts',
});
