import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveToolPath, type ToolPathResolver } from './lane-tool-path';

/**
 * Native build planning for a worktree: what Expo's fingerprint says, whether
 * the configured build cache already holds a binary for it, and whether that
 * binary is on a given Simulator. It builds nothing. Agents call this before
 * `expo run:ios` so ten worktrees of one native shell produce one build.
 *
 * The fingerprint has to be computed by the worktree's own `@expo/fingerprint`
 * and config loader, with its `app.config.js` evaluated, or the hash would not
 * match what `expo run:ios` computes. So the work runs in a child Node process
 * inside the project directory, with a small script that mirrors
 * `@expo/cli`'s build-cache-provider resolution. The desktop never requires
 * project code into its own process.
 */

const PLAN_TIMEOUT_MS = 120_000;
const MAX_PLAN_OUTPUT_BYTES = 256 * 1024;

export const nativePlanResultSchema = z.strictObject({
	projectRoot: z.string(),
	platform: z.enum(['ios', 'android']),
	configuration: z.string(),
	// Providers may use a custom hash or decline fingerprinting, as Expo permits.
	fingerprintHash: z.string().min(1).max(1_024).nullable(),
	/** Expo sources that contributed; zero for a provider's custom hash. */
	sourceCount: z.number().int().nonnegative(),
	provider: z
		.strictObject({
			plugin: z.string(),
			cacheEntry: z.string().optional(),
		})
		.optional(),
	cache: z.enum(['hit', 'miss', 'no-provider']),
	artifactPath: z.string().optional(),
	bundleIdentifier: z.string().optional(),
	scheme: z.string().optional(),
});
export type NativePlanResult = z.infer<typeof nativePlanResultSchema>;

/**
 * Runs inside the project with `node -e`. Kept as a string so the desktop
 * bundle stays independent of the project's Expo version; every `require`
 * resolves from the project root, exactly as `expo run:ios` would.
 */
const PLAN_SCRIPT = `
const path = require('node:path');
const fs = require('node:fs');
const [projectRoot, platform, configuration] = process.argv.slice(1);
const req = (id) => require(require.resolve(id, { paths: [projectRoot] }));
(async () => {
  const { getConfig } = req('@expo/config');
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });
  const runOptions = platform === 'ios' ? { configuration } : { variant: configuration.toLowerCase() };
  const declared = exp.buildCacheProvider ?? (exp.experiments && exp.experiments.buildCacheProvider);
  let plugin; let provider;
  const providerOptions = declared && declared.options;
  if (declared && typeof declared === 'object' && typeof declared.plugin === 'string') {
    const pluginPath = require.resolve(declared.plugin, { paths: [projectRoot] });
    plugin = require(pluginPath); if (plugin && plugin.default) plugin = plugin.default;
    provider = { plugin: declared.plugin };
  }
  let fingerprintHash; let sourceCount = 0;
  if (plugin && typeof plugin.calculateFingerprintHash === 'function') {
    // Expo delegates fingerprinting before loading @expo/fingerprint. A null
    // result means this provider has disabled cache use for the current run.
    fingerprintHash = await plugin.calculateFingerprintHash({ projectRoot, platform, runOptions }, providerOptions) || null;
  } else {
    const Fingerprint = req('@expo/fingerprint');
    const fingerprint = await Fingerprint.createFingerprintAsync(projectRoot);
    fingerprintHash = fingerprint.hash;
    sourceCount = Array.isArray(fingerprint.sources) ? fingerprint.sources.length : 0;
  }
  let cache = provider ? 'miss' : 'no-provider'; let artifactPath;
  if (provider && fingerprintHash && typeof plugin.entryDirectory === 'function') {
    // rndevtools provider: inspect the entry without taking the build lock.
    const context = { projectRoot, platform, runOptions, fingerprintHash };
    const entry = plugin.entryDirectory(context, providerOptions);
    provider.cacheEntry = entry;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(entry, 'artifact.json'), 'utf8'));
      if (typeof meta.artifact === 'string' && meta.artifact === path.basename(meta.artifact)) {
        const candidate = path.join(entry, meta.artifact);
        const stat = fs.statSync(candidate);
        const shapeOk = candidate.endsWith('.app') ? stat.isDirectory() : candidate.endsWith('.apk') ? stat.isFile() : true;
        if (shapeOk) { cache = 'hit'; artifactPath = candidate; }
      }
    } catch { cache = 'miss'; }
  }
  const ios = exp.ios || {}; const android = exp.android || {};
  const bundleIdentifier = platform === 'ios' ? ios.bundleIdentifier : android.package;
  const schemes = Array.isArray(exp.scheme) ? exp.scheme : exp.scheme ? [exp.scheme] : [];
  process.stdout.write(JSON.stringify({
    projectRoot, platform, configuration, fingerprintHash, sourceCount,
    ...(provider ? { provider } : {}), cache,
    ...(artifactPath ? { artifactPath } : {}),
    ...(bundleIdentifier ? { bundleIdentifier } : {}),
    ...(schemes[0] ? { scheme: schemes[0] } : {}),
  }));
})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(2); });
`;

/**
 * The project's Node, found next to its Expo binary so the fingerprint runs
 * with the same runtime that would build. Falls back to the Node on `env`'s
 * PATH (the tool PATH, which finds the user's Node even in a desktop opened
 * from Finder); never the Electron binary, whose `process.versions` and
 * native modules differ.
 */
export function resolveProjectNode(
	projectRoot: string,
	env: NodeJS.ProcessEnv = process.env
): string | undefined {
	let current = path.resolve(projectRoot);
	for (let depth = 0; depth < 6; depth += 1) {
		const candidate = path.join(current, 'node_modules', '.bin', 'node');
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const directory of (env.PATH ?? '').split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, 'node');
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export type NativePlanRunner = (
	input: {
		projectRoot: string;
		platform: 'ios' | 'android';
		configuration: string;
	},
	signal?: AbortSignal
) => Promise<NativePlanResult>;

/**
 * Bounded child process in the project directory. `runSimulatorCommand`
 * pins a minimal PATH for Apple tooling, which is right for simctl and wrong
 * for a project's Node (version managers live in the user's PATH), so this
 * runner is separate: the desktop's environment with the tool PATH, a hard
 * timeout, output caps, and a kill on abort.
 */
function runProjectNode(
	node: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [...args], {
			cwd,
			env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill('SIGTERM');
			finish(() => reject(new Error('Native plan cancelled.')));
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(() =>
				reject(
					new Error(
						`Fingerprinting did not finish within ${PLAN_TIMEOUT_MS / 1_000}s.`
					)
				)
			);
		}, PLAN_TIMEOUT_MS);
		signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length < MAX_PLAN_OUTPUT_BYTES)
				stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < MAX_PLAN_OUTPUT_BYTES)
				stderr += chunk.toString('utf8');
		});
		child.on('error', (error) => finish(() => reject(error)));
		child.on('close', (exitCode) =>
			finish(() => resolve({ stdout, stderr, exitCode }))
		);
		if (signal?.aborted) onAbort();
	});
}

/**
 * The native plan with `toolPath` deciding the PATH its Node is found on and
 * runs with; the desktop's own PATH may hold no Node at all.
 */
export function createNativePlanRunner({
	toolPath = resolveToolPath,
}: {
	toolPath?: ToolPathResolver;
} = {}): NativePlanRunner {
	return async (input, signal) => {
		const projectRoot = path.resolve(input.projectRoot);
		const searchPath = await toolPath(process.env.PATH);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(searchPath !== undefined ? { PATH: searchPath } : {}),
		};
		const node = resolveProjectNode(projectRoot, env);
		if (!node) {
			throw new Error(
				'Node was not found for this worktree; install dependencies so @expo/fingerprint can run.'
			);
		}
		const result = await runProjectNode(
			node,
			[
				'-e',
				PLAN_SCRIPT,
				'--',
				projectRoot,
				input.platform,
				input.configuration,
			],
			projectRoot,
			env,
			signal
		);
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim().split('\n').slice(0, 3).join(' ');
			throw new Error(
				`Fingerprinting ${projectRoot} failed: ${detail || `exit ${result.exitCode}`}. Is @expo/fingerprint installed in the worktree?`
			);
		}
		return nativePlanResultSchema.parse(JSON.parse(result.stdout));
	};
}

export const runNativePlan: NativePlanRunner = createNativePlanRunner();
