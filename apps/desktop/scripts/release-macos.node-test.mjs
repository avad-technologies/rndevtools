import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	assertCompiledTeam,
	assertNoBuildHome,
	assertSignature,
	releaseSettings,
} from './release-macos.mjs';

const team = 'ABCDE12345';
const environment = {
	APPLE_TEAM_ID: team,
	CSC_NAME: '0123456789ABCDEF0123456789ABCDEF01234567',
	APPLE_KEYCHAIN_PROFILE: 'example-notary',
};
const signature = [
	'Authority=Developer ID Application: Example Team (ABCDE12345)',
	`TeamIdentifier=${team}`,
	'CodeDirectory v=20500 size=300 flags=0x10000(runtime) hashes=5+7',
	'Timestamp=Oct 20, 2026 at 10:00:00',
].join('\n');

test('public and local candidates have separate names and notarization policies', () => {
	assert.deepEqual(releaseSettings(false, environment, '0.1.0'), {
		mode: 'public',
		artifactName: 'RN-Devtools-0.1.0-arm64.dmg',
		type: 'distribution',
		notarize: true,
	});
	const local = releaseSettings(
		true,
		{ ...environment, APPLE_KEYCHAIN_PROFILE: undefined },
		'0.1.0'
	);
	assert.equal(
		local.artifactName,
		'RN-Devtools-0.1.0-local-development-arm64.dmg'
	);
	assert.equal(local.type, 'development');
	assert.equal(local.notarize, false);
});

for (const [name, changes] of [
	['missing team', { APPLE_TEAM_ID: '' }],
	['malformed team', { APPLE_TEAM_ID: 'ABC --option' }],
	['missing identity', { CSC_NAME: '' }],
	['disabled certificate discovery', { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }],
	['missing notarization credentials', { APPLE_KEYCHAIN_PROFILE: '' }],
]) {
	test(`public preflight rejects ${name}`, () => {
		assert.throws(() =>
			releaseSettings(false, { ...environment, ...changes }, '0.1.0')
		);
	});
}

test('public signature gate accepts a timestamped Developer ID runtime signature', () => {
	assert.doesNotThrow(() => assertSignature(signature, team, false));
});

for (const [name, details] of [
	[
		'Apple Development',
		signature.replace('Developer ID Application:', 'Apple Development:'),
	],
	['ad-hoc', signature.replace(/^Authority=.+\n/m, '')],
	[
		'another team',
		signature.replace(`TeamIdentifier=${team}`, 'TeamIdentifier=OTHER12345'),
	],
	[
		'no hardened runtime',
		signature.replace('flags=0x10000(runtime)', 'flags=0x0(none)'),
	],
	['no timestamp', signature.replace(/^Timestamp=.+$/m, '')],
]) {
	test(`public signature gate rejects ${name}`, () => {
		assert.throws(() => assertSignature(details, team, false));
	});
}

test('local signature gate accepts Apple Development while enforcing team and runtime', () => {
	const local = signature.replace(
		'Developer ID Application:',
		'Apple Development:'
	);
	assert.doesNotThrow(() => assertSignature(local, team, true));
	assert.throws(() => assertSignature(local, 'OTHER12345', true));
});

test('DMG signature does not require an executable runtime flag', () => {
	assert.doesNotThrow(() =>
		assertSignature(
			signature.replace('flags=0x10000(runtime)', ''),
			team,
			false,
			false
		)
	);
});

test('compiled pin check uses the read-only helper response and rejects absent or mismatched pins', () => {
	const response = {
		protocolVersion: 2,
		requestId: 'release-team-verification',
		ok: true,
		result: { signingTeamIdentifier: team },
	};
	assert.doesNotThrow(() => assertCompiledTeam(response, team));
	for (const pin of [undefined, '', 'OTHER12345']) {
		assert.throws(() =>
			assertCompiledTeam(
				{ ...response, result: { signingTeamIdentifier: pin } },
				team
			)
		);
	}
	assert.throws(() =>
		assertCompiledTeam({ ...response, requestId: 'different' }, team)
	);
	assert.throws(() => assertCompiledTeam({ ...response, ok: false }, team));
});

test('native helper privacy gate detects build paths anywhere in the full binary', () => {
	assert.throws(() =>
		assertNoBuildHome(
			Buffer.from('\0symbol\0/Users/example/build/object.o\0'),
			'/Users/example'
		)
	);
	assert.doesNotThrow(() =>
		assertNoBuildHome(
			Buffer.from('\0symbol\0/rndevtools/native/helper.swift\0'),
			'/Users/example'
		)
	);
});
