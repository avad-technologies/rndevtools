import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import { z } from 'zod';
import { childEnvironmentStrip } from './agent-harness-env';
import { resolveToolPath, type ToolPathResolver } from './lane-tool-path';
import { sanitizeDialogText } from './security';
import { stripTerminalControls } from './supabase/cli-redact';

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
/**
 * How much of the child's output an error quotes, on one line: enough for an
 * error after a Node deprecation warning.
 */
const MAX_PLAN_DETAIL_LENGTH = 500;

/**
 * Starts the stdout line the plan script writes its result on. Project code
 * shares that stdout (an `app.config.js` that logs, a build cache provider),
 * so the result is the last line with this prefix and the rest is ignored.
 */
export const PLAN_RESULT_PREFIX = 'rndevtools-native-plan-result:';

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
    // silent mutes the fingerprint's own console output, such as the timings
    // it prints to stdout whenever DEBUG is set. It is not hashed.
    const fingerprint = await Fingerprint.createFingerprintAsync(projectRoot, { silent: true });
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
  // A line of its own, even after output project code left unfinished.
  process.stdout.write('\\n' + ${JSON.stringify(PLAN_RESULT_PREFIX)} + JSON.stringify({
    projectRoot, platform, configuration, fingerprintHash, sourceCount,
    ...(provider ? { provider } : {}), cache,
    ...(artifactPath ? { artifactPath } : {}),
    ...(bundleIdentifier ? { bundleIdentifier } : {}),
    ...(schemes[0] ? { scheme: schemes[0] } : {}),
  }) + '\\n');
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
 * The plan child's environment: the desktop's, with the tool PATH, Expo told
 * it runs in CI and without telemetry, no DEBUG, and nothing `stripped`
 * names. Agent sessions often export DEBUG=1; under it `@expo/fingerprint`
 * prints timings to stdout and `debug` loggers fill stderr, where the
 * script's result and error go. The plan evaluates the worktree's
 * app.config.js, which must not see the identity and tokens of the agent
 * session the desktop was launched from (agent-harness-env.ts). Everything
 * else stays, RNDEVTOOLS_BUILD_CACHE_DIR included: the plan must find the
 * cache entry `expo run:ios` would.
 */
function planEnvironment(
	inherited: NodeJS.ProcessEnv,
	stripped: (name: string) => boolean,
	searchPath: string | undefined
): NodeJS.ProcessEnv {
	const kept: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && name !== 'DEBUG' && !stripped(name)) {
			kept[name] = value;
		}
	}
	return {
		...kept,
		...(searchPath !== undefined ? { PATH: searchPath } : {}),
		CI: '1',
		EXPO_NO_TELEMETRY: '1',
	};
}

/**
 * Bounded child process in the project directory. `runSimulatorCommand`
 * pins a minimal PATH for Apple tooling, which is right for simctl and wrong
 * for a project's Node (version managers live in the user's PATH), so this
 * runner is separate: the plan environment, a hard timeout, output caps, and
 * a kill on abort.
 */
function runProjectNode(
	node: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined
): Promise<{
	stdout: string;
	/** Whether older stdout was dropped to keep within the bound. */
	stdoutCut: boolean;
	stderr: string;
	exitCode: number | null;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [...args], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		let stdout = '';
		let stdoutCut = false;
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
		// Decoded as streams, so a character split across chunks stays whole.
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			// The result is the script's last line, so the newest output is
			// kept: project code may print any amount before it.
			const output = stdout + chunk;
			if (output.length > MAX_PLAN_OUTPUT_BYTES) stdoutCut = true;
			stdout = output.slice(-MAX_PLAN_OUTPUT_BYTES);
		});
		child.stderr.on('data', (chunk: string) => {
			if (stderr.length < MAX_PLAN_OUTPUT_BYTES) stderr += chunk;
		});
		child.on('error', (error) => finish(() => reject(error)));
		child.on('close', (exitCode) =>
			finish(() => resolve({ stdout, stdoutCut, stderr, exitCode }))
		);
		if (signal?.aborted) onAbort();
	});
}

/**
 * Child output as one line an error may quote: without escape sequences and
 * control characters, redacted, then bounded. The sequences go first, whole,
 * as failureText does: in colored output a credential follows `\x1b[32m`
 * directly, with no word boundary for the redaction rules to start at.
 */
function outputDetail(output: string): string {
	return sanitizeDialogText(
		redactDiagnosticText(stripTerminalControls(output, false)),
		{ maxLength: MAX_PLAN_DETAIL_LENGTH }
	);
}

/**
 * The newest whole lines of the script's stdout as one line an error may
 * quote, without escape sequences and control characters, redacted, then
 * bounded, after an ellipsis when older output is left out. When the output
 * outgrew its bound (`cut`), the window kept starts inside a line, and a line
 * cut at its head can begin inside a secret whose name was cut off, which no
 * redactor can recognise afterwards (as readLogTail says of lane logs). That
 * line is never quoted, and the rest is redacted whole before any of it is
 * left out.
 */
function stdoutDetail(stdout: string, cut: boolean): string {
	let whole = stdout;
	if (cut) {
		const newline = stdout.indexOf('\n');
		whole = newline === -1 ? '' : stdout.slice(newline + 1);
	}
	const lines = redactDiagnosticText(stripTerminalControls(whole, true)).split(
		'\n'
	);
	const quoted: string[] = [];
	let length = 0;
	let index = lines.length - 1;
	for (; index >= 0; index -= 1) {
		const line = sanitizeDialogText(lines[index], {
			maxLength: MAX_PLAN_DETAIL_LENGTH,
		});
		if (!line) continue;
		if (quoted.length > 0 && length + 1 + line.length > MAX_PLAN_DETAIL_LENGTH)
			break;
		length += (quoted.length > 0 ? 1 : 0) + line.length;
		quoted.unshift(line);
	}
	const leftOut = cut || index >= 0;
	if (quoted.length === 0) return leftOut ? '…' : '';
	return `${leftOut ? '… ' : ''}${quoted.join(' ')}`;
}

/** Where a result fails the schema, from its first issue. */
function schemaIssueText(error: z.ZodError): string {
	const [first] = error.issues;
	if (!first) return 'it does not match the plan schema';
	const at = first.path.map(String).join('.') || 'its root';
	const more =
		error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : '';
	return `${at}: ${first.message}${more}`;
}

/**
 * The plan in the script's stdout: its last result line, parsed and checked.
 * Whatever else project code printed there is ignored. A missing or
 * unreadable result is an error that says which, never a bare SyntaxError,
 * and quotes the output only redacted and bounded.
 */
function parsePlanOutput(
	stdout: string,
	stdoutCut: boolean,
	projectRoot: string
): NativePlanResult {
	const line = stdout
		.split('\n')
		.findLast((candidate) => candidate.startsWith(PLAN_RESULT_PREFIX));
	if (line === undefined) {
		const printed = stdoutDetail(stdout, stdoutCut);
		throw new Error(
			`Fingerprinting ${projectRoot} exited without reporting a plan${printed ? `; it printed: ${printed}` : ' and printed nothing'}.`
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(line.slice(PLAN_RESULT_PREFIX.length));
	} catch {
		throw new Error(
			`Fingerprinting ${projectRoot} reported a plan that is not valid JSON.`
		);
	}
	const parsed = nativePlanResultSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`Fingerprinting ${projectRoot} reported a plan RN Devtools cannot read: ${outputDetail(schemaIssueText(parsed.error))}.`
		);
	}
	return parsed.data;
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
		// A malformed list of what to strip fails the plan before anything runs.
		const stripped = childEnvironmentStrip(process.env);
		const env = planEnvironment(
			process.env,
			stripped,
			await toolPath(process.env.PATH)
		);
		const node = resolveProjectNode(projectRoot, env);
		if (!node) {
			throw new Error(
				"Node was not found for this worktree. Install the project's Node version and confirm `node --version` works in a new Terminal, then retry; RN Devtools reads your login shell PATH."
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
			const detail = outputDetail(
				result.stderr.trim().split('\n').slice(0, 3).join(' ')
			);
			throw new Error(
				`Fingerprinting ${projectRoot} failed: ${detail || `exit ${result.exitCode}`}. Is @expo/fingerprint installed in the worktree?`
			);
		}
		return parsePlanOutput(result.stdout, result.stdoutCut, projectRoot);
	};
}

export const runNativePlan: NativePlanRunner = createNativePlanRunner();
