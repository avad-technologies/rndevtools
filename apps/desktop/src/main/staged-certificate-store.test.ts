import { createHash, X509Certificate } from 'node:crypto';
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SimulatorAction } from '../shared/simulator-protocol';
import {
	StagedCertificateStore,
	stagedCertificateIdentitySchema,
} from './staged-certificate-store';

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDSTCCAjGgAwIBAgIUSckWrt77tfLlr/c5mKpLJ2lsWUEwDQYJKoZIhvcNAQEL
BQAwNDEaMBgGA1UEAwwRRXhhbXBsZSBUZXN0IFJvb3QxFjAUBgNVBAoMDUV4YW1w
bGUgVGVzdHMwHhcNMjYwOTE2MDQ0MTU2WhcNMjcwOTE2MDQ0MTU2WjA0MRowGAYD
VQQDDBFFeGFtcGxlIFRlc3QgUm9vdDEWMBQGA1UECgwNRXhhbXBsZSBUZXN0czCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKMC85Z/VnfqyJfGraPJkr58
sfO91+ia3w2+uUME3xRV80ZaDCpi4jRXGanwKlKYYZ7X1rl5rgmDKvRPJmt7WdsS
OCLqYrxDBPi68J/h6s+Md/5l/nf/jVEC6LfkYEgCo9P3XlIMTBwTzX2sR/S98Uei
sM5Kx2Kr2Zgngv7n7PB2KQWEF21SEeQbajDb2zBJxZIleBDbUalHcSsVQwLog2kC
3ePoA5MXhbJYtWspqvSMdx7pocZFFEmIMx0fz3We+GS6PdMGL+E9Im6Y6OmlMGag
mS0vNhChv5jiwcr5zpIniixANMJ1lQ+66d8kbt1/o7lnJohOnKbMnEVPF5Y7tssC
AwEAAaNTMFEwHQYDVR0OBBYEFEeVsIsMcKKGMeG2OIZ65Li4y8ScMB8GA1UdIwQY
MBaAFEeVsIsMcKKGMeG2OIZ65Li4y8ScMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBACq673odmdYhr/T+PTs4wkfZ67mZBl5DybB5VZNTqkh6P5dJ
wC03a14+eiYRZYsB7M9fca2XvJ7BAwN79Ki5o3zCTNVPg8s8lSJfPT3rddwcCFix
TyAp4ptjic+K6OV8xDoE0U2bnRRUN1ClOOPvi9MTQRMCr3y8DZHaXn2ugUkXFw7j
pYFVFxoGDwxNnH8ZhPcD8Mqq/FUhdVNP3IoPzgWbMGbbNHn2wp4e03AdboOM+508
gC01UEk42xWbUWIgSt/6bPIsDPHkTRzIc6YzWY/KZiM0dUQM7blQE3pUVjE7bIF7
Q7jRi0NIYZQeZUSKywiNpDSAi7kfis/XlS2i/E4=
-----END CERTIFICATE-----
`;
const UDID = '11111111-2222-3333-4444-555555555555';
const ACTION = {
	actionId: 'trust-root',
	kind: 'keychain.addCertificate',
	udid: UDID,
	trustRoot: true,
} satisfies SimulatorAction;
const CANONICAL_CERTIFICATE = Buffer.from(new X509Certificate(CERTIFICATE).raw);
const CANONICAL_SHA256 = createHash('sha256')
	.update(CANONICAL_CERTIFICATE)
	.digest('hex');
const temporaryDirectories: string[] = [];

async function setup(now: () => number = Date.now) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-certificate-test-')
	);
	temporaryDirectories.push(directory);
	const sourcePath = path.join(directory, 'source.pem');
	await writeFile(sourcePath, CERTIFICATE);
	const store = new StagedCertificateStore({
		directory: path.join(directory, 'staged'),
		now,
		ttlMs: 100,
	});
	await store.start();
	return { directory, sourcePath, store };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe('staged certificate store', () => {
	it('copies and identifies the selected certificate before approval', async () => {
		const { sourcePath, store } = await setup();
		const artifact = await store.stage(sourcePath, 7);
		expect(artifact.identity).toMatchObject({
			sha256: CANONICAL_SHA256,
			sizeBytes: CANONICAL_CERTIFICATE.byteLength,
			subject: expect.stringContaining('Example Test Root'),
		});
		const approvedBytes = Buffer.from(artifact.bytes);
		expect(approvedBytes).toEqual(CANONICAL_CERTIFICATE);

		await writeFile(sourcePath, 'replaced after selection');
		store.bind('confirmation-source-replaced', 7, ACTION, artifact);
		const claimed = await store.claim(
			'confirmation-source-replaced',
			7,
			ACTION
		);
		expect(claimed?.identity).toEqual(artifact.identity);
		expect(claimed?.bytes).toEqual(approvedBytes);
		const materialized = await claimed?.materialize();
		expect(materialized).toBeDefined();
		expect(await readFile(materialized?.path ?? '')).toEqual(approvedBytes);
		expect(
			(await stat(path.dirname(materialized?.path ?? ''))).mode & 0o777
		).toBe(0o700);
		expect((await stat(materialized?.path ?? '')).mode & 0o777).toBe(0o400);
		await expect(claimed?.materialize()).rejects.toThrow(
			'already been materialized'
		);
		await materialized?.cleanup();
		await expect(readFile(materialized?.path ?? '')).rejects.toThrow();
		await claimed?.cleanup();
		expect(artifact.bytes.every((byte) => byte === 0)).toBe(true);
		await store.stop();
	});

	it('rejects trailing data, certificate bundles, and private-key content', async () => {
		const { sourcePath, store } = await setup();
		for (const invalid of [
			`${CERTIFICATE}\ntrailing-data`,
			`${CERTIFICATE}\n${CERTIFICATE}`,
			`${CERTIFICATE}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----`,
			Buffer.concat([CANONICAL_CERTIFICATE, Buffer.from('trailing-data')]),
			Buffer.concat([CANONICAL_CERTIFICATE, CANONICAL_CERTIFICATE]),
		]) {
			await writeFile(sourcePath, invalid);
			await expect(store.stage(sourcePath, 7)).rejects.toThrow(
				'exactly one valid X.509 certificate'
			);
		}
		await store.stop();
	});

	it('accepts exact DER input and fingerprints its canonical bytes', async () => {
		const { sourcePath, store } = await setup();
		await writeFile(sourcePath, CANONICAL_CERTIFICATE);
		const artifact = await store.stage(sourcePath, 7);
		expect(artifact.bytes).toEqual(CANONICAL_CERTIFICATE);
		expect(artifact.identity).toMatchObject({
			sha256: CANONICAL_SHA256,
			sizeBytes: CANONICAL_CERTIFICATE.byteLength,
		});
		await artifact.cleanup();
		await store.stop();
	});

	it('materializes only after an approval is claimed', async () => {
		const { sourcePath, store } = await setup();
		const artifact = await store.stage(sourcePath, 7);
		await expect(artifact.materialize()).rejects.toThrow('no longer available');
		await artifact.cleanup();
		await store.stop();
	});

	it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
		'retries materialized cleanup after a transient filesystem failure',
		async () => {
			const { sourcePath, store } = await setup();
			const artifact = await store.stage(sourcePath, 7);
			store.bind('confirmation-cleanup-retry', 7, ACTION, artifact);
			const claimed = await store.claim(
				'confirmation-cleanup-retry',
				7,
				ACTION
			);
			const materialized = await claimed?.materialize();
			const stagingRoot = path.dirname(path.dirname(materialized?.path ?? ''));
			await chmod(stagingRoot, 0o500);
			try {
				await expect(materialized?.cleanup()).rejects.toThrow();
			} finally {
				await chmod(stagingRoot, 0o700);
			}
			await materialized?.cleanup();
			await expect(
				access(path.dirname(materialized?.path ?? ''))
			).rejects.toThrow();
			await claimed?.cleanup();
			await store.stop();
		}
	);

	it('removes stale materialized artifacts and restores private root permissions', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'rndevtools-certificate-stale-')
		);
		temporaryDirectories.push(directory);
		const stagedDirectory = path.join(directory, 'staged');
		const staleDirectory = path.join(stagedDirectory, 'certificate-stale');
		const stalePath = path.join(staleDirectory, 'certificate.cer');
		await mkdir(staleDirectory, { recursive: true });
		await writeFile(stalePath, CERTIFICATE);
		const store = new StagedCertificateStore({ directory: stagedDirectory });
		await store.start();
		await expect(access(stalePath)).rejects.toThrow();
		expect((await stat(stagedDirectory)).mode & 0o777).toBe(0o700);
		await store.stop();
	});

	it('rejects action mismatches and cleans the staged artifact', async () => {
		const { sourcePath, store } = await setup();
		const artifact = await store.stage(sourcePath, 7);
		store.bind('confirmation-mismatch', 7, ACTION, artifact);
		const mismatched = {
			...ACTION,
			udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
		};
		expect(
			await store.claim('confirmation-mismatch', 7, mismatched)
		).toBeUndefined();
		expect(artifact.bytes.every((byte) => byte === 0)).toBe(true);
		await store.stop();
	});

	it('rejects in-memory staged content replacement before use and cleans it', async () => {
		const { sourcePath, store } = await setup();
		const artifact = await store.stage(sourcePath, 7);
		store.bind('confirmation-tampered', 7, ACTION, artifact);
		artifact.bytes[0] = artifact.bytes[0] === 0 ? 1 : 0;
		expect(
			await store.claim('confirmation-tampered', 7, ACTION)
		).toBeUndefined();
		expect(artifact.bytes.every((byte) => byte === 0)).toBe(true);
		await store.stop();
	});

	it('cleans abandoned artifacts on sender teardown and store shutdown', async () => {
		const { sourcePath, store } = await setup();
		const senderArtifact = await store.stage(sourcePath, 7);
		store.bind('confirmation-sender', 7, ACTION, senderArtifact);
		await store.revokeSender(7);
		expect(senderArtifact.bytes.every((byte) => byte === 0)).toBe(true);

		const shutdownArtifact = await store.stage(sourcePath, 8);
		store.bind('confirmation-shutdown', 8, ACTION, shutdownArtifact);
		await store.stop();
		expect(shutdownArtifact.bytes.every((byte) => byte === 0)).toBe(true);
		await expect(store.stage(sourcePath, 8)).rejects.toThrow('unavailable');
	});

	it('transfers an accepted artifact from the renderer to the queued job', async () => {
		const { sourcePath, store } = await setup();
		const artifact = await store.stage(sourcePath, 7);
		store.bind('confirmation-accepted', 7, ACTION, artifact);
		const claimed = await store.claim('confirmation-accepted', 7, ACTION);
		expect(claimed).toBeDefined();

		await store.revokeSender(7);
		expect(artifact.bytes.some((byte) => byte !== 0)).toBe(true);
		const materialized = await claimed?.materialize();
		expect(await readFile(materialized?.path ?? '')).toEqual(
			CANONICAL_CERTIFICATE
		);
		await materialized?.cleanup();
		await claimed?.cleanup();
		expect(artifact.bytes.every((byte) => byte === 0)).toBe(true);
		await store.stop();
	});

	it('rejects expired approvals and zeroes their exact staged bytes', async () => {
		let now = 1;
		const { sourcePath, store } = await setup(() => now);
		const artifact = await store.stage(sourcePath, 7);
		store.bind('confirmation-expired', 7, ACTION, artifact);
		now = 102;
		expect(
			await store.claim('confirmation-expired', 7, ACTION)
		).toBeUndefined();
		expect(artifact.bytes.every((byte) => byte === 0)).toBe(true);
		await store.stop();
	});

	it('does not retain bytes for a renderer sender revoked during selection', async () => {
		const { sourcePath, store } = await setup();
		await store.revokeSender(7);
		await expect(store.stage(sourcePath, 7)).rejects.toThrow('unavailable');
		store.registerSender(7);
		const artifact = await store.stage(sourcePath, 7);
		await artifact.cleanup();
		await store.stop();
	});

	it('caps the pending in-memory certificate count', async () => {
		const { sourcePath, store } = await setup();
		const artifacts = await Promise.all(
			Array.from({ length: 8 }, () => store.stage(sourcePath, 7))
		);
		await expect(store.stage(sourcePath, 7)).rejects.toThrow('queue is full');
		await Promise.all(artifacts.map((artifact) => artifact.cleanup()));
		await store.stop();
	});

	it('strictly validates internal certificate identities', () => {
		expect(
			stagedCertificateIdentitySchema.safeParse({
				sha256: 'a'.repeat(64),
				sizeBytes: 512,
				subject: 'CN=Example Test Root',
			}).success
		).toBe(true);
		expect(
			stagedCertificateIdentitySchema.safeParse({
				sha256: 'a'.repeat(64),
				sizeBytes: 512,
				subject: 'CN=Example Test Root',
				path: '/tmp/renderer-controlled.pem',
			}).success
		).toBe(false);
		expect(
			stagedCertificateIdentitySchema.safeParse({
				sha256: 'a'.repeat(64),
				sizeBytes: 512,
				subject: 'unsafe\nsubject',
			}).success
		).toBe(false);
	});
});
