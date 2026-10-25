import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	type ElectronApplication,
	_electron as electron,
	expect,
	type Page,
} from '@playwright/test';

const appRoot = resolve(__dirname, '..');
const rendererEntry = join(appRoot, 'dist', 'renderer', 'index.html');
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const LOOPBACK = '127.0.0.1';

/**
 * Connected-app tool ids, mirrored from `src/renderer/tool-config.ts`. The
 * source list is not importable here (the renderer bundle pulls in browser-only
 * modules), so the smoke spec checks these lists against the built bundle:
 * each id must open the panel named in `panelHeadings`, and each sidebar must
 * offer exactly as many tools.
 */
export const connectedToolIds = [
	'network',
	'console',
	'storage',
	'query',
	'zustand',
	'restore',
	'scenarios',
	'identity',
	'routes',
	'environment',
	'components',
	'camera',
	'performance',
	'diagnostics',
] as const;

/**
 * Simulator tool ids, mirrored from
 * `src/renderer/simulator/simulator-config.ts`.
 */
export const simulatorToolIds = [
	'fleet',
	'actions',
	'slimming',
	'captures',
	'automation',
	'builds',
	'lanes',
	'supabase',
	'settings',
] as const;

type ConnectedToolId = (typeof connectedToolIds)[number];
type SimulatorToolId = (typeof simulatorToolIds)[number];
export type PanelId = ConnectedToolId | `simulator/${SimulatorToolId}`;

/** Every panel the harness knows how to open, in navigation order. */
export const allPanelIds: PanelId[] = [
	...connectedToolIds,
	...simulatorToolIds.map((id): PanelId => `simulator/${id}`),
];

/**
 * The heading each panel renders, mirrored from its panel header. A hash the
 * app does not know silently falls back to the Simulators panel, so the smoke
 * spec checks that every id opens the panel with this heading.
 */
export const panelHeadings: Record<PanelId, string> = {
	network: 'Network',
	console: 'Console',
	storage: 'Storage',
	query: 'React Query',
	zustand: 'Zustand',
	restore: 'Restore Points',
	scenarios: 'Scenarios',
	identity: 'Test Identities',
	routes: 'Routes',
	environment: 'Environment',
	components: 'Components',
	camera: 'Camera Fixtures',
	performance: 'Performance',
	diagnostics: 'Diagnostics',
	'simulator/fleet': 'Simulators',
	'simulator/actions': 'App Actions',
	'simulator/slimming': 'SimSlim',
	'simulator/captures': 'Captures',
	'simulator/automation': 'Automation',
	'simulator/builds': 'Build Insights',
	'simulator/lanes': 'Lanes',
	'simulator/supabase': 'Supabase',
	'simulator/settings': 'Settings',
};

const screenshotDir =
	process.env.RNDEVTOOLS_E2E_SCREENSHOT_DIR ?? '/tmp/rndevtools-ux/baseline';

/**
 * Asks the OS for a free port for one launch's broker, which rejects port 0 as
 * a configuration error and would then never start its demo ticker. The probe
 * listens on loopback only and closes before Electron starts; the broker's
 * fallback to the next ports covers the short race.
 */
function freeLoopbackPort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const probe = createServer();
		probe.unref();
		probe.once('error', reject);
		probe.listen(0, LOOPBACK, () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close((error) => {
				if (error) reject(error);
				else if (port > 0) resolvePort(port);
				else reject(new Error('The OS assigned no loopback port.'));
			});
		});
	});
}

/** Build the app if the renderer or main bundle is missing. */
function ensureBuilt(): void {
	if (existsSync(rendererEntry) && existsSync(mainEntry)) return;
	execFileSync('pnpm', ['--filter', '@rndevtools/desktop', 'build'], {
		cwd: resolve(appRoot, '..', '..'),
		stdio: 'inherit',
	});
}

export class DesktopHarness {
	private constructor(
		readonly app: ElectronApplication,
		readonly window: Page
	) {}

	static async launch(): Promise<DesktopHarness> {
		ensureBuilt();
		// Each launch gets its own userData dir so Electron's single-instance
		// lock (src/main/index.ts) does not evict concurrent or back-to-back
		// runs, and its own free broker port so brokers never collide.
		const userDataDir = mkdtempSync(join(tmpdir(), 'rndevtools-e2e-'));
		const brokerPort = await freeLoopbackPort();
		const app = await electron.launch({
			args: [
				mainEntry,
				'--no-sandbox',
				'--disable-gpu',
				`--user-data-dir=${userDataDir}`,
			],
			cwd: appRoot,
			env: {
				...process.env,
				RNDEVTOOLS_DEMO: 'true',
				// The host the port was probed on; an inherited LAN bind setting
				// must never widen a test broker.
				RNDEVTOOLS_BIND_ADDRESS: LOOPBACK,
				RNDEVTOOLS_PORT: String(brokerPort),
				NODE_ENV: 'production',
			},
		});
		const window = await app.firstWindow();
		await window.waitForLoadState('domcontentloaded');
		await window.waitForSelector('.desktop-provider', { timeout: 30_000 });
		// A fresh profile would open first-run setup over the panels under test.
		await window.evaluate(() =>
			window.localStorage.setItem('rndevtools.desktop.onboarding.setup', 'done')
		);
		await window.reload();
		await window.waitForSelector('.desktop-provider', { timeout: 30_000 });
		return new DesktopHarness(app, window);
	}

	/**
	 * Navigate to a panel by id. Connected tools use `#connected/<id>`;
	 * simulator tools use `#simulator/<id>`. Resolves once the panel's Suspense
	 * fallback has cleared.
	 */
	async openPanel(id: PanelId): Promise<void> {
		const hash = id.startsWith('simulator/') ? `#${id}` : `#connected/${id}`;
		await this.window.evaluate((target) => {
			window.location.hash = target;
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		}, hash);
		await this.window
			.waitForSelector('.panel-loading', {
				state: 'detached',
				timeout: 15_000,
			})
			.catch(() => {
				// No loading shim rendered (panel resolved synchronously) — fine.
			});
		await this.window.waitForTimeout(250);
	}

	/** Capture a full-window screenshot into the baseline directory. */
	async screenshot(name: string): Promise<string> {
		mkdirSync(screenshotDir, { recursive: true });
		const path = join(screenshotDir, `${name}.png`);
		await this.window.screenshot({ path });
		return path;
	}

	/**
	 * The heading of the panel on screen once it reads `expected`, or the one
	 * it settled on instead. Null means no panel header rendered in time.
	 */
	async panelHeading(
		expected: string,
		timeout = 5_000
	): Promise<string | null> {
		const heading = this.window
			.locator('.desktop-content .panel-header h1')
			.first();
		try {
			await expect(heading).toHaveText(expected, { timeout });
			return expected;
		} catch {
			const actual = await heading
				.textContent({ timeout: 1_000 })
				.catch(() => null);
			return actual?.trim() ?? null;
		}
	}

	/** True when the root or a panel error boundary is currently showing. */
	async hasErrorBoundary(): Promise<boolean> {
		return (await this.window.locator('.fatal-error').count()) > 0;
	}

	async close(): Promise<void> {
		await this.app.close();
	}
}
