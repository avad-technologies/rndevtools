import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkRepository, scanPublicContent } from './check-public-content.mjs';

function scan(content, options) {
	return scanPublicContent([{ path: 'example.txt', content }], options);
}

test('reports token formats without returning matched values', () => {
	const tokens = [
		`ghp_${'A'.repeat(36)}`,
		`github_pat_${'A'.repeat(60)}`,
		`npm_${'A'.repeat(36)}`,
		`xoxb-${'1234-'.repeat(8)}`,
		`sk-proj-${'a'.repeat(40)}`,
		`sk_live_${'a'.repeat(30)}`,
		`sb_secret_${'a'.repeat(30)}`,
		`AKIA${'A'.repeat(16)}`,
	];
	for (const token of tokens) {
		const findings = scan(`first line\n${token}\n`);
		assert.equal(findings.length, 1);
		assert.equal(findings[0].line, 2);
		assert.ok(
			['provider-token', 'cloud-access-key'].includes(findings[0].code),
		);
		assert.ok(!JSON.stringify(findings).includes(token));
	}
});

test('distinguishes private keys from public certificates and invalid-header tests', () => {
	const key = [
		'-----BEGIN ',
		'PRIVATE KEY-----\n',
		'A'.repeat(96),
		'\n-----END ',
		'PRIVATE KEY-----',
	].join('');
	assert.equal(scan(key)[0]?.code, 'private-key');
	assert.deepEqual(
		scan(
			'-----BEGIN CERTIFICATE-----\n' +
				'A'.repeat(96) +
				'\n-----END CERTIFICATE-----',
		),
		[],
	);
	assert.deepEqual(
		scan(
			[
				'-----BEGIN ',
				'PRIVATE KEY-----\nAAAA\n-----END ',
				'PRIVATE KEY-----',
			].join(''),
		),
		[],
	);
});

test('detects signed JWTs and leaves explicit placeholder redaction fixtures alone', () => {
	const encode = (value) =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	const prefix = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'anon', exp: 2_000_000_000 })}`;
	assert.equal(scan(`${prefix}.${'a'.repeat(43)}`)[0]?.code, 'signed-jwt');
	assert.deepEqual(scan(`${prefix}.${'EXAMPLE_PLACEHOLDER'.repeat(3)}`), []);
	assert.deepEqual(scan(`eyJinvalid.payload.${'a'.repeat(43)}`), []);
});

test('requires reserved or loopback hosts for credential URL examples', () => {
	for (const host of [
		'localhost',
		'127.0.0.1',
		'[::1]',
		'db.example.com',
		'example.invalid',
		'db.test',
		'192.0.2.20',
		'198.51.100.4',
		'203.0.113.2',
	]) {
		assert.deepEqual(scan(`postgresql://user:password@${host}/db`), []);
	}
	assert.equal(
		scan('postgresql://user:password@' + 'production.company.net/db')[0]?.code,
		'credential-url',
	);
	assert.equal(
		scan('https://app.' + 'department.corp/path')[0]?.code,
		'internal-host',
	);
	assert.deepEqual(
		scan('if (!entry.internal) addresses.add(entry.address);'),
		[],
	);
	assert.deepEqual(scan('`postgresql://user:password@…`'), []);
});

test('catches personal paths without flagging neutral fixture users or nested scratch directories', () => {
	const personal = 'private' + '-person';
	for (const home of [
		`/Users/${personal}/repo`,
		`/home/${personal}/repo`,
		`file:///Users/${personal}/repo`,
		`C:\\Users\\${personal}\\repo`,
	]) {
		assert.equal(scan(home)[0]?.code, 'personal-home-path');
	}
	for (const home of [
		'/Users/example/repo',
		'/Users/developer/Example App',
		'file:///Users/example%20user/repo',
		'/home/dev/repo',
		'/tmp/native/home/stacks',
		'C:\\Users\\example\\repo',
	]) {
		assert.deepEqual(scan(home), []);
	}
	assert.deepEqual(scan(['/Users/', '$', '{user}', '/repo'].join('')), []);
});

test('optional private terms return only locations and leave public legal/dependency text alone', () => {
	const term = 'private' + '-project';
	assert.deepEqual(scan(`first\n${term}`, { denyTerms: [term] }), [
		{ path: 'example.txt', line: 2, code: 'private-term' },
	]);
	assert.deepEqual(
		scan(
			'Copyright 2026 Example Contributors\n@aws-sdk/client-s3@3.0.0\nAPPLE_TEAM_ID=env(APPLE_TEAM_ID)',
		),
		[],
	);
});

test('repository scan includes untracked publishable files, excludes ignored output and external symlinks', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'public-content-test-'));
	try {
		execFileSync('git', ['init', '-q'], { cwd: root });
		await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
		await writeFile(path.join(root, 'tracked.txt'), 'Public example\n');
		execFileSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root });
		const token = `ghp_${'A'.repeat(36)}`;
		await writeFile(path.join(root, 'untracked file.txt'), token);
		await mkdir(path.join(root, 'ignored'));
		await writeFile(path.join(root, 'ignored', 'output.txt'), token);
		await symlink(
			path.join(root, 'ignored', 'output.txt'),
			path.join(root, 'linked.txt'),
		);
		const result = await checkRepository(root);
		assert.equal(result.checkedFiles, 3);
		assert.deepEqual(result.findings, [
			{ path: 'untracked file.txt', line: 1, code: 'provider-token' },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
