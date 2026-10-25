import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createNativePlanRunner,
	nativePlanResultSchema,
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
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-native-plan-run-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('finds Node on the tool PATH and runs the plan with that PATH', async () => {
		const tools = path.join(root, 'tools');
		const project = path.join(root, 'app');
		mkdirSync(tools);
		mkdirSync(project);
		const seenPath = path.join(root, 'seen-path');
		const plan = {
			projectRoot: project,
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: '78f81f7cf5a5717ebff99c9fbd6abf28831d1bf8',
			sourceCount: 3,
			cache: 'no-provider',
		};
		// Stands in for the user's Node: it records the PATH it was given and
		// prints what the in-project script would.
		writeFileSync(
			path.join(tools, 'node'),
			`#!/bin/sh\nprintf '%s' "$PATH" > '${seenPath}'\nprintf '%s' '${JSON.stringify(plan)}'\n`,
			{ mode: 0o755 }
		);
		const toolPath = `${tools}${path.delimiter}/usr/bin${path.delimiter}/bin`;
		const run = createNativePlanRunner({ toolPath: async () => toolPath });
		await expect(
			run({ projectRoot: project, platform: 'ios', configuration: 'Debug' })
		).resolves.toEqual(plan);
		expect(readFileSync(seenPath, 'utf8')).toBe(toolPath);
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
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

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
