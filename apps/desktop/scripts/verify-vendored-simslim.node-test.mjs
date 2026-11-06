import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyVendoredSimSlim } from './verify-vendored-simslim.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceHelper = path.resolve(
	scriptDirectory,
	'..',
	'native',
	'rndevtools-sim-helper'
);
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('accepts only the anchored reviewed SimSlim patch set', () => {
	assert.deepEqual(verifyVendoredSimSlim(sourceHelper), {
		upstreamVersion: 'v0.14.0',
		upstreamCommit: '7e374b3839d49608a681d1f8b9ca0dd83d35189e',
		patchSet: 'rndevtools.1',
		upstreamSourceManifestSha256:
			'cd8843eca8ac08e7b44fcab27582bc8d76ca29ee80a8334e6873c3c7dd568056',
		patchSha256:
			'045c1b21248398f066d20766bf178dc307fdee3ca5ef5fcea11f889dcddc1063',
		vendoredSourceManifestSha256:
			'f5082751ccb44251861356158fce6a88a5c736dfe52844929db77bacf99af694',
		files: 23,
	});
});

test('rejects source tampering even when the checksum manifest is unchanged', () => {
	const helper = copyFixture();
	const clonePath = path.join(
		helper,
		'vendor/github.com/mobai-app/simslim/clone.go'
	);
	writeFileSync(clonePath, `${readFileSync(clonePath, 'utf8')}\n// tampered\n`);
	assert.throws(
		() => verifyVendoredSimSlim(helper),
		/Vendored SimSlim source checksum mismatch/
	);
});

test('the anchored patch reverses the final tree to the anchored upstream base', () => {
	const root = mkdtempSync(
		path.join(tmpdir(), 'rndevtools-simslim-derivation-')
	);
	temporaryDirectories.push(root);
	const finalSource = path.join(
		sourceHelper,
		'vendor/github.com/mobai-app/simslim'
	);
	const reconstructedBase = path.join(root, 'simslim');
	cpSync(finalSource, reconstructedBase, { recursive: true });
	const patchPath = path.join(
		sourceHelper,
		'RNDEVTOOLS_PATCHSET_rndevtools.1.patch'
	);
	const result = spawnSync('git', ['apply', '--reverse', patchPath], {
		cwd: reconstructedBase,
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, result.stderr);
	for (const line of readFileSync(
		path.join(sourceHelper, 'UPSTREAM_SOURCE_SHA256SUMS'),
		'utf8'
	)
		.trim()
		.split('\n')) {
		const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
		assert.ok(match);
		const [, expected, file] = match;
		const actual = createHash('sha256')
			.update(readFileSync(path.join(reconstructedBase, file)))
			.digest('hex');
		assert.equal(actual, expected, file);
	}
});

test('rejects coordinated source and editable checksum-manifest tampering', () => {
	const helper = copyFixture();
	const clonePath = path.join(
		helper,
		'vendor/github.com/mobai-app/simslim/clone.go'
	);
	const checksumPath = path.join(helper, 'VENDORED_SOURCE_SHA256SUMS');
	writeFileSync(clonePath, `${readFileSync(clonePath, 'utf8')}\n// tampered\n`);
	writeFileSync(
		checksumPath,
		readFileSync(checksumPath, 'utf8').replace(
			/^[a-f0-9]{64}( {2}vendor\/github\.com\/mobai-app\/simslim\/clone\.go)$/m,
			`${'0'.repeat(64)}$1`
		)
	);
	assert.throws(
		() => verifyVendoredSimSlim(helper),
		/checksum manifest is not the reviewed rndevtools\.1 manifest/
	);
});

function copyFixture() {
	const root = mkdtempSync(path.join(tmpdir(), 'rndevtools-vendored-simslim-'));
	temporaryDirectories.push(root);
	const helper = path.join(root, 'rndevtools-sim-helper');
	cpSync(sourceHelper, helper, { recursive: true });
	return helper;
}
