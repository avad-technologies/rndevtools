import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createNativePlanRunner,
	nativePlanResultSchema,
	PLAN_RESULT_PREFIX,
	resolveProjectNode,
} from './native-plan';

describe('resolveProjectNode', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-native-plan-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('prefers a Node pinned in the project tree, walking up through a workspace', () => {
		const app = path.join(root, 'apps', 'mobile');
		mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
		mkdirSync(app, { recursive: true });
		writeFileSync(
			path.join(root, 'node_modules', '.bin', 'node'),
			'#!/bin/sh\n'
		);
		expect(resolveProjectNode(app, { PATH: '/nowhere' })).toBe(
			path.join(root, 'node_modules', '.bin', 'node')
		);
	});

	it('falls back to the Node on the inherited PATH and never the Electron binary', () => {
		const bin = path.join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n');
		expect(
			resolveProjectNode(root, { PATH: `/nowhere${path.delimiter}${bin}` })
		).toBe(path.join(bin, 'node'));
		expect(resolveProjectNode(root, { PATH: '/nowhere' })).toBeUndefined();
	});
});

describe('runNativePlan', () => {
	let root: string;
	let tools: string;
	let project: string;
	let plan: Record<string, unknown>;
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-native-plan-run-'));
		tools = path.join(root, 'tools');
		project = path.join(root, 'app');
		mkdirSync(tools);
		mkdirSync(project);
		plan = {
			projectRoot: project,
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: '78f81f7cf5a5717ebff99c9fbd6abf28831d1bf8',
			sourceCount: 3,
			cache: 'no-provider',
		};
		// Whatever list the shell running the tests exports is not this test's.
		vi.stubEnv('RNDEVTOOLS_CHILD_ENV_STRIP', undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * Stands in for the user's Node on the tool PATH: a shell script that runs
	 * `body` instead of the in-project script.
	 */
	function fakeNode(body: string) {
		writeFileSync(path.join(tools, 'node'), `#!/bin/sh\n${body}\n`, {
			mode: 0o755,
		});
		const toolPath = `${tools}${path.delimiter}/usr/bin${path.delimiter}/bin`;
		const run = createNativePlanRunner({ toolPath: async () => toolPath });
		return {
			toolPath,
			plan: () =>
				run({ projectRoot: project, platform: 'ios', configuration: 'Debug' }),
		};
	}

	/** Prints `value` as the in-project script ends: on a line of its own. */
	const printResult = (value: unknown) =>
		`printf '\\n%s\\n' '${PLAN_RESULT_PREFIX}${JSON.stringify(value)}'`;

	it('finds Node on the tool PATH and runs the plan with that PATH', async () => {
		const seenPath = path.join(root, 'seen-path');
		const node = fakeNode(
			`printf '%s' "$PATH" > '${seenPath}'\n${printResult(plan)}`
		);
		await expect(node.plan()).resolves.toEqual(plan);
		expect(readFileSync(seenPath, 'utf8')).toBe(node.toolPath);
	});

	it('runs the plan without the DEBUG an agent session exports', async () => {
		// Under DEBUG, @expo/fingerprint prints its timings to stdout.
		vi.stubEnv('DEBUG', '1');
		const seenEnv = path.join(root, 'seen-env');
		const node = fakeNode(
			`printf '%s %s %s' "\${DEBUG-unset}" "$CI" "$EXPO_NO_TELEMETRY" > '${seenEnv}'\n${printResult(plan)}`
		);
		await expect(node.plan()).resolves.toEqual(plan);
		expect(readFileSync(seenEnv, 'utf8')).toBe('unset 1 1');
	});

	it("runs the plan without the launching agent session's identity and tokens", async () => {
		// app.config.js runs in the plan child, so it must not see them.
		vi.stubEnv('CLAUDECODE', '1');
		vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'session-1');
		vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'messaging-token');
		vi.stubEnv('CODEX_THREAD_ID', 'thread-1');
		vi.stubEnv('AI_AGENT', 'example-agent');
		vi.stubEnv('EXAMPLE_CLAUDE_MODEL', 'kept');
		// The build cache provider reads its own variables; they stay.
		vi.stubEnv('RNDEVTOOLS_BUILD_CACHE_DIR', '/tmp/example-cache');
		const seenEnv = path.join(root, 'seen-agent-env');
		const node = fakeNode(
			`printf '%s %s %s %s %s %s %s' "\${CLAUDECODE-unset}" "\${CLAUDE_CODE_SESSION_ID-unset}" "\${CLAUDE_CODE_MESSAGING_TOKEN-unset}" "\${CODEX_THREAD_ID-unset}" "\${AI_AGENT-unset}" "\${EXAMPLE_CLAUDE_MODEL-unset}" "\${RNDEVTOOLS_BUILD_CACHE_DIR-unset}" > '${seenEnv}'\n${printResult(plan)}`
		);
		await expect(node.plan()).resolves.toEqual(plan);
		expect(readFileSync(seenEnv, 'utf8')).toBe(
			'unset unset unset unset unset kept /tmp/example-cache'
		);
	});

	it("runs the plan without what the desktop's RNDEVTOOLS_CHILD_ENV_STRIP names", async () => {
		vi.stubEnv('RNDEVTOOLS_CHILD_ENV_STRIP', 'EXAMPLE_AGENT_*,EXAMPLE_TOKEN');
		vi.stubEnv('EXAMPLE_AGENT_AUTH_TOKEN', 'harness-token');
		vi.stubEnv('EXAMPLE_TOKEN', 'token');
		vi.stubEnv('EXAMPLE_TOKEN_TTL', 'kept');
		const seenEnv = path.join(root, 'seen-extra-env');
		const node = fakeNode(
			`printf '%s %s %s' "\${EXAMPLE_AGENT_AUTH_TOKEN-unset}" "\${EXAMPLE_TOKEN-unset}" "\${EXAMPLE_TOKEN_TTL-unset}" > '${seenEnv}'\n${printResult(plan)}`
		);
		await expect(node.plan()).resolves.toEqual(plan);
		expect(readFileSync(seenEnv, 'utf8')).toBe('unset unset kept');
	});

	it('refuses a malformed RNDEVTOOLS_CHILD_ENV_STRIP before anything runs', async () => {
		vi.stubEnv('RNDEVTOOLS_CHILD_ENV_STRIP', 'EXAMPLE TOKEN');
		const ran = path.join(root, 'ran');
		writeFileSync(
			path.join(tools, 'node'),
			`#!/bin/sh\n: > '${ran}'\n${printResult(plan)}\n`,
			{ mode: 0o755 }
		);
		let toolPathAsked = false;
		const run = createNativePlanRunner({
			toolPath: async () => {
				toolPathAsked = true;
				return tools;
			},
		});
		await expect(
			run({ projectRoot: project, platform: 'ios', configuration: 'Debug' })
		).rejects.toThrow(
			/^RNDEVTOOLS_CHILD_ENV_STRIP entry 1 is not a variable name/
		);
		expect(toolPathAsked).toBe(false);
		expect(() => readFileSync(ran)).toThrow();
	});

	it('reads the plan from its own line, past any amount of other output', async () => {
		// Profiler timings, more logging than the output bound holds, a line
		// left unfinished, the result, and output after it.
		const node = fakeNode(
			[
				`printf '%s\\n' '⏱  [profile] getConfig: 12.3ms'`,
				`yes 'Loading app config' | head -n 20000`,
				`printf '%s' 'An unfinished line'`,
				printResult(plan),
				`printf '%s\\n' 'Done.'`,
			].join('\n')
		);
		await expect(node.plan()).resolves.toEqual(plan);
	});

	it('takes the last result line when more than one was printed', async () => {
		const node = fakeNode(
			[
				printResult({ ...plan, fingerprintHash: 'stale' }),
				printResult(plan),
			].join('\n')
		);
		await expect(node.plan()).resolves.toEqual(plan);
	});

	it.each([
		[
			'nothing',
			'true',
			/exited without reporting a plan and printed nothing\.$/,
		],
		[
			'output but no plan',
			`printf '%s\\n' '⏱  [profile] getConfig: 12.3ms' 'API_KEY=example-secret-value'`,
			/exited without reporting a plan; it printed: ⏱ \[profile\] getConfig: 12\.3ms API_KEY=\[REDACTED\]\.$/,
		],
		[
			'more than an error quotes',
			`yes 'Loading app config' | head -n 20000`,
			// The newest whole lines, after an ellipsis for what came before.
			/exited without reporting a plan; it printed: … (?:Loading app config ){10,}Loading app config\.$/,
		],
		[
			'a plan that is not JSON',
			`printf '\\n%s\\n' '${PLAN_RESULT_PREFIX}{"projectRoot":'`,
			/reported a plan that is not valid JSON\.$/,
		],
		[
			'a plan with an unknown cache state',
			printResult({
				projectRoot: '/Users/dev/app',
				platform: 'ios',
				configuration: 'Debug',
				fingerprintHash: null,
				sourceCount: 0,
				cache: 'maybe',
			}),
			/reported a plan RN Devtools cannot read: cache: .*"no-provider".*\.$/,
		],
		[
			'an error and exits',
			`printf '%s\\n' 'Error: Cannot find module' 'API_KEY=example-secret-value' >&2\nexit 2`,
			/failed: Error: Cannot find module API_KEY=\[REDACTED\]\. Is @expo\/fingerprint installed in the worktree\?$/,
		],
	])(
		'says what went wrong when the script prints %s',
		async (_, body, message) => {
			const failure: unknown = await fakeNode(body)
				.plan()
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			const text = (failure as Error).message;
			expect(text).toMatch(message);
			expect(text).not.toMatch(/SyntaxError|Unexpected token|example-secret/);
			expect(text.length).toBeLessThan(project.length + 700);
		}
	);

	it.each([
		['an error on stderr', '>&2\nexit 2', /failed: Error: rejected /],
		[
			'output on stdout with no plan',
			'',
			/exited without reporting a plan; it printed: Error: rejected /,
		],
	])('redacts a token printed in color in %s', async (_, redirect, message) => {
		// In colored output a credential follows an escape sequence's final
		// letter directly, where the redaction rules find no word boundary.
		const jwt =
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.ZXhhbXBsZS1zaWduYXR1cmU';
		const failure: unknown = await fakeNode(
			`printf 'Error: rejected \\033[32m%s\\033[39m and \\033[1;33mBearer %s\\033[0m\\n' '${jwt}' 'example-bearer-value' ${redirect}`
		)
			.plan()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const text = (failure as Error).message;
		expect(text).toMatch(message);
		expect(text).toContain('rejected [REDACTED JWT] and Bearer [REDACTED]');
		// The sequences go whole, not only their escape characters.
		expect(text).not.toMatch(/eyJ|example-bearer-value|\[\d+(?:;\d+)*m/);
	});

	it.each([
		['an SGR sequence', 'fetching\\033[32m', 'fetching[REDACTED JWT]'],
		['a two-byte escape', 'fetching\\0337', 'fetching[REDACTED JWT]'],
		['the 8-bit CSI', 'fetching\\302\\23332m', 'fetching[REDACTED JWT]'],
		['a lone ESC', 'fetching\\033', 'fetching[REDACTED JWT]'],
		['an SGR sequence after Bearer', 'Bearer\\033[1m', 'Bearer [REDACTED]'],
		// Redacting the raw text first cut this sequence at the `;` between
		// its parameters, and left the rest of it, `32m`, on the token.
		[
			'a sequence of two parameters after a code parameter',
			'GET /callback?code=\\033[1;32m',
			'GET /callback?code=[REDACTED',
		],
	])(
		'redacts a token that %s glues to the word before it',
		async (_, before, redacted) => {
			// The JWT and Bearer rules start at a word boundary, which neither
			// the letter that ends a sequence nor the word left once it is
			// removed has before the token.
			const token = before.startsWith('Bearer')
				? 'example-bearer-value'
				: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.ZXhhbXBsZS1zaWduYXR1cmU';
			for (const [redirect, message] of [
				['>&2\nexit 2', /failed: Error: /],
				['', /exited without reporting a plan; it printed: Error: /],
			] as const) {
				const failure: unknown = await fakeNode(
					`printf 'Error: ${before}%s\\n' '${token}' ${redirect}`
				)
					.plan()
					.catch((error: unknown) => error);
				expect(failure).toBeInstanceOf(Error);
				const text = (failure as Error).message;
				expect(text).toMatch(message);
				expect(text).toContain(`Error: ${redacted}`);
				expect(text).not.toMatch(/eyJ|example-bearer-value|32m/);
			}
		}
	);

	it.each([
		['a JWT after a carriage return', 'fetching\\r', 'fetching[REDACTED JWT]'],
		['a JWT after a vertical tab', 'fetching\\v', 'fetching[REDACTED JWT]'],
		['a JWT after a backspace', 'fetching\\b', 'fetching[REDACTED JWT]'],
		[
			'a JWT after a zero-width space',
			'fetching\\342\\200\\213',
			'fetching[REDACTED JWT]',
		],
		[
			'a Bearer token after a carriage return',
			'Bearer\\r',
			'Bearer [REDACTED]',
		],
		['a Bearer token after a vertical tab', 'Bearer\\v', 'Bearer [REDACTED]'],
	])(
		'redacts %s, which removing that character joins to the word before it',
		async (_, before, redacted) => {
			// The JWT and Bearer rules start at a word boundary, and a removed
			// control leaves none between the word and the token it parted.
			const token = before.startsWith('Bearer')
				? 'example-bearer-value'
				: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.ZXhhbXBsZS1zaWduYXR1cmU';
			for (const [redirect, message] of [
				['>&2\nexit 2', /failed: Error: /],
				['', /exited without reporting a plan; it printed: Error: /],
			] as const) {
				const failure: unknown = await fakeNode(
					`printf 'Error: ${before}%s\\n' '${token}' ${redirect}`
				)
					.plan()
					.catch((error: unknown) => error);
				expect(failure).toBeInstanceOf(Error);
				const text = (failure as Error).message;
				expect(text).toMatch(message);
				expect(text).toContain(`Error: ${redacted}`);
				expect(text).not.toMatch(/eyJ|example-bearer-value/);
			}
		}
	);

	it.each([
		['a zero-width space', 'Bearer\\342\\200\\213', 'Bearer [REDACTED]'],
		['a zero-width joiner', 'Bearer\\342\\200\\215', 'Bearer [REDACTED]'],
		['a word joiner', 'Bearer\\342\\201\\240', 'Bearer [REDACTED]'],
		['a left-to-right mark', 'Bearer\\342\\200\\216', 'Bearer [REDACTED]'],
		['a backspace', 'Bearer\\b', 'Bearer [REDACTED]'],
		[
			'a zero-width space after an Authorization name',
			'Authorization:\\342\\200\\213Bearer ',
			'Authorization:[REDACTED]',
		],
	])(
		'redacts a Bearer token after %s, which is not white space',
		async (_, before, redacted) => {
			// Bearer and an Authorization scheme take the token after white
			// space, and a format character or a backspace is none, so the rules
			// have to read one as a separator before it is removed.
			for (const [redirect, message] of [
				['>&2\nexit 2', /failed: Error: /],
				['', /exited without reporting a plan; it printed: Error: /],
			] as const) {
				const failure: unknown = await fakeNode(
					`printf 'Error: ${before}%s\\n' 'example-bearer-value' ${redirect}`
				)
					.plan()
					.catch((error: unknown) => error);
				expect(failure).toBeInstanceOf(Error);
				const text = (failure as Error).message;
				expect(text).toMatch(message);
				expect(text).toContain(`Error: ${redacted}`);
				expect(text).not.toMatch(/example-bearer-value/);
			}
		}
	);

	it.each([
		['nothing after it', ''],
		['one newline after it', '\n'],
	])(
		'never quotes the line its output bound cut through, with %s',
		async (_, end) => {
			// The plan keeps the newest 256 KiB of stdout. One line longer than
			// that leaves a window that starts inside it, past a secret's name,
			// where no redactor could recognise what is left of it as one. Quoted
			// from its head, that line would begin with the secret.
			const kept = 256 * 1024;
			const secret = 'DATABASE_PASSWORD=hunter2-example-secret-value';
			const tail = secret.slice(secret.indexOf('hunter2'));
			const output = path.join(root, 'output.txt');
			writeFileSync(
				output,
				`${secret}${'x'.repeat(kept - tail.length - end.length)}${end}`
			);
			const failure: unknown = await fakeNode(`cat '${output}'`)
				.plan()
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			const text = (failure as Error).message;
			expect(text).toMatch(/exited without reporting a plan; it printed: …\.$/);
			expect(text).not.toMatch(/secret|hunter2/);
		}
	);

	it('quotes only the newest whole lines once its output outgrew the bound', async () => {
		// The plan keeps the newest 256 KiB of stdout. Fill it so the window
		// kept starts inside a secret, past its name, where no redactor could
		// recognise what is left of it as one.
		const kept = 256 * 1024;
		const secret = 'DATABASE_PASSWORD=hunter2-example-secret-value\n';
		const cutAt = secret.indexOf('example-secret');
		const filler = 'Loading app config\n';
		const last = 'Done\n';
		const after = kept - (secret.length - cutAt);
		const lines = Math.floor((after - last.length - 1) / filler.length);
		const padding = after - last.length - lines * filler.length;
		const failure: unknown = await fakeNode(
			[
				`printf '%s' '${secret}'`,
				`printf '%s\\n' '${'x'.repeat(padding - 1)}'`,
				`yes '${filler.trim()}' | head -n ${lines}`,
				`printf '%s' '${last}'`,
			].join('\n')
		)
			.plan()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const text = (failure as Error).message;
		expect(text).toMatch(
			/exited without reporting a plan; it printed: … (?:Loading app config ){10,}Done\.$/
		);
		expect(text).not.toMatch(/secret|hunter2|x{8}/);
		expect(text.length).toBeLessThan(project.length + 700);
	});
});

describe('native plan project script', () => {
	let root: string;
	let entry: string;
	const run = createNativePlanRunner({
		toolPath: async () => path.dirname(process.execPath),
	});
	beforeEach(() => {
		root = mkdtempSync(
			path.join(os.tmpdir(), 'rndevtools-native-plan-project-')
		);
		entry = path.join(root, 'cache');
		mkdirSync(entry);
		writeModule(
			'@expo/config',
			`exports.getConfig = () => ({ exp: require(${JSON.stringify(path.join(root, 'config.json'))}) });`
		);
		writeModule(
			'@expo/fingerprint',
			`exports.createFingerprintAsync = async () => ({ hash: 'deadbeef', sources: [{}, {}, {}] });`
		);
		// Whatever list the shell running the tests exports is not this test's.
		vi.stubEnv('RNDEVTOOLS_CHILD_ENV_STRIP', undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function writeModule(name: string, source: string) {
		const directory = path.join(root, 'node_modules', name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, 'index.js'), source);
	}

	function configure(customHash?: string | null) {
		writeFileSync(
			path.join(root, 'config.json'),
			JSON.stringify({
				buildCacheProvider: {
					plugin: './provider.cjs',
					options: { entry, hash: customHash },
				},
			})
		);
		writeFileSync(
			path.join(root, 'provider.cjs'),
			`
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  ${
		customHash !== undefined
			? `calculateFingerprintHash: async (context, options) => {
    fs.writeFileSync(path.join(context.projectRoot, 'hash-call.json'), JSON.stringify({ context, options }));
    return options.hash;
  },`
			: ''
	}
  entryDirectory: (context, options) => {
    fs.writeFileSync(path.join(context.projectRoot, 'entry-call.json'), JSON.stringify({ context, options }));
    return options.entry;
  },
  resolveBuildCache: () => { throw new Error('Planning must not acquire build locks'); },
  uploadBuildCache: () => { throw new Error('Planning must not publish artifacts'); },
};
`
		);
	}

	it('fingerprints silently without DEBUG and reads the plan past what project code prints', async () => {
		vi.stubEnv('DEBUG', '1');
		writeModule(
			'@expo/config',
			`exports.getConfig = () => {
  // An app config that logs: a line left unfinished, JSON, and later output.
  process.stdout.write('Loading app config');
  console.log('{"environment":"development"}');
  setTimeout(() => console.log('Done.'), 0);
  return { exp: { ios: { bundleIdentifier: 'com.example.app' }, scheme: 'exampleapp' } };
};`
		);
		writeModule(
			'@expo/fingerprint',
			`const fs = require('node:fs');
const path = require('node:path');
exports.createFingerprintAsync = async (projectRoot, options) => {
  fs.writeFileSync(path.join(projectRoot, 'fingerprint-call.json'), JSON.stringify({ options: options ?? null, debug: process.env.DEBUG ?? null }));
  // What its profiler prints to stdout under DEBUG unless silent.
  if (process.env.DEBUG && !(options && options.silent)) console.log('⏱  [profile] createFingerprintAsync: 1.234s');
  return { hash: 'deadbeef', sources: [{}, {}, {}] };
};`
		);
		await expect(
			run({ projectRoot: root, platform: 'ios', configuration: 'Debug' })
		).resolves.toEqual({
			projectRoot: root,
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: 'deadbeef',
			sourceCount: 3,
			cache: 'no-provider',
			bundleIdentifier: 'com.example.app',
			scheme: 'exampleapp',
		});
		expect(
			JSON.parse(readFileSync(path.join(root, 'fingerprint-call.json'), 'utf8'))
		).toEqual({ options: { silent: true }, debug: null });
	});

	it.each(['ios', 'android'] as const)(
		'uses a custom %s provider hash and options without loading @expo/fingerprint',
		async (platform) => {
			configure('native-shell-v1');
			writeModule(
				'@expo/fingerprint',
				`throw new Error('The provider owns fingerprinting');`
			);
			const plan = await run({
				projectRoot: root,
				platform,
				configuration: 'Release',
			});
			expect(plan.fingerprintHash).toBe('native-shell-v1');
			expect(plan.sourceCount).toBe(0);
			const expectedContext = {
				projectRoot: root,
				platform,
				runOptions:
					platform === 'ios'
						? { configuration: 'Release' }
						: { variant: 'release' },
			};
			expect(
				JSON.parse(readFileSync(path.join(root, 'hash-call.json'), 'utf8'))
			).toEqual({
				context: expectedContext,
				options: { entry, hash: 'native-shell-v1' },
			});
			expect(
				JSON.parse(readFileSync(path.join(root, 'entry-call.json'), 'utf8'))
					.context
			).toEqual({
				...expectedContext,
				fingerprintHash: 'native-shell-v1',
			});
		}
	);

	it('does not inspect a cache when its provider declines to fingerprint', async () => {
		configure(null);
		writeModule(
			'@expo/fingerprint',
			`throw new Error('The provider owns fingerprinting');`
		);
		await expect(
			run({ projectRoot: root, platform: 'ios', configuration: 'Debug' })
		).resolves.toMatchObject({
			fingerprintHash: null,
			sourceCount: 0,
			cache: 'miss',
			provider: { plugin: './provider.cjs' },
		});
		expect(() => readFileSync(path.join(root, 'entry-call.json'))).toThrow();
	});

	it.each([
		['ios', 'Example.app', 'directory', 'hit'],
		['ios', 'Example.app', 'file', 'miss'],
		['android', 'Example.apk', 'file', 'hit'],
		['android', 'Example.apk', 'directory', 'miss'],
		['ios', 'Missing.app', 'missing', 'miss'],
		['ios', '../Outside.app', 'directory', 'miss'],
	] as const)(
		'reports %s artifact %s (%s) as a cache %s',
		async (platform, artifact, shape, cache) => {
			configure();
			const artifactPath = path.join(entry, artifact);
			if (shape === 'directory') mkdirSync(artifactPath);
			else if (shape === 'file') writeFileSync(artifactPath, 'binary');
			writeFileSync(
				path.join(entry, 'artifact.json'),
				JSON.stringify({ artifact })
			);
			const plan = await run({
				projectRoot: root,
				platform,
				configuration: 'Debug',
			});
			expect(plan).toMatchObject({
				fingerprintHash: 'deadbeef',
				sourceCount: 3,
				cache,
			});
			expect(plan.artifactPath).toBe(
				cache === 'hit' ? artifactPath : undefined
			);
		}
	);
});

describe('nativePlanResultSchema', () => {
	it('accepts what the in-project script emits and rejects an empty fingerprint', () => {
		const result = nativePlanResultSchema.parse({
			projectRoot: '/Users/dev/app',
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: '78f81f7cf5a5717ebff99c9fbd6abf28831d1bf8',
			sourceCount: 33,
			provider: {
				plugin: '@rndevtools/react-native/build-cache',
				cacheEntry:
					'/Users/dev/Library/Caches/rndevtools/native/ios/Debug/arm64-x/78f8',
			},
			cache: 'miss',
			bundleIdentifier: 'com.example.app',
			scheme: 'exampleapp',
		});
		expect(result.cache).toBe('miss');
		expect(() =>
			nativePlanResultSchema.parse({
				projectRoot: '/Users/dev/app',
				platform: 'ios',
				configuration: 'Debug',
				fingerprintHash: '',
				sourceCount: 1,
				cache: 'no-provider',
			})
		).toThrow();
	});
});
