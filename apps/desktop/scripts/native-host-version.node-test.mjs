import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
	desktopVersion,
	nativeHostVersionDrift,
	nativeHostVersionSource,
	syncNativeHostVersionSource,
} from './native-host-version.mjs';

const sourceDirectory = path.join(
	'native',
	'rndevtools-native-host',
	'Sources',
	'RNDevtoolsNativeHost'
);
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('the committed host version source matches the desktop package version', () => {
	assert.equal(nativeHostVersionDrift(), undefined);
});

test('generates a swift-format-clean literal for the desktop version', () => {
	const source = nativeHostVersionSource('1.2.3-beta.1+build.5');
	assert.match(
		source,
		/^ {2}static let helperVersion = "1\.2\.3-beta\.1\+build\.5"$/m
	);
	assert.equal(source.endsWith('}\n'), true);
	for (const line of source.split('\n')) {
		assert.ok(line.length <= 100, `line exceeds swift-format's limit: ${line}`);
	}
});

test('rejects a host version source that lags the desktop package version', () => {
	const desktop = fixture('0.2.0', nativeHostVersionSource('0.1.0'));
	assert.match(
		nativeHostVersionDrift(desktop),
		/HelperVersion\.swift must declare the desktop package version 0\.2\.0; it declares 0\.1\.0\. Run `pnpm --filter @rndevtools\/desktop native:sync-version`/
	);
});

test('rejects a missing or hand-edited host version source', () => {
	assert.match(nativeHostVersionDrift(fixture('0.2.0')), /; it is missing\./);
	assert.match(
		nativeHostVersionDrift(
			fixture('0.2.0', `${nativeHostVersionSource('0.2.0')}// edited\n`)
		),
		/; its content differs from the generated source\./
	);
});

test('regenerates the host version source only when it changed', () => {
	const desktop = fixture('0.3.0', nativeHostVersionSource('0.2.0'));
	assert.deepEqual(syncNativeHostVersionSource(desktop), {
		version: '0.3.0',
		changed: true,
	});
	assert.equal(nativeHostVersionDrift(desktop), undefined);
	const file = path.join(desktop, sourceDirectory, 'HelperVersion.swift');
	const modified = statSync(file).mtimeMs;
	assert.deepEqual(syncNativeHostVersionSource(desktop), {
		version: '0.3.0',
		changed: false,
	});
	assert.equal(statSync(file).mtimeMs, modified);
});

test('refuses a desktop version that is not a safe semantic version', () => {
	const committed = nativeHostVersionSource('0.2.0');
	for (const version of ['', 'v0.2.0', '0.2', '0.2.0"; exit(1) //', 42]) {
		const desktop = fixture(version, committed);
		assert.throws(() => desktopVersion(desktop), /semantic version/);
		assert.throws(
			() => syncNativeHostVersionSource(desktop),
			/semantic version/
		);
		assert.equal(
			readFileSync(
				path.join(desktop, sourceDirectory, 'HelperVersion.swift'),
				'utf8'
			),
			committed
		);
	}
});

function fixture(version, source) {
	const root = mkdtempSync(path.join(tmpdir(), 'rndevtools-host-version-'));
	temporaryDirectories.push(root);
	writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
	mkdirSync(path.join(root, sourceDirectory), { recursive: true });
	if (source !== undefined) {
		writeFileSync(
			path.join(root, sourceDirectory, 'HelperVersion.swift'),
			source
		);
	}
	return root;
}
