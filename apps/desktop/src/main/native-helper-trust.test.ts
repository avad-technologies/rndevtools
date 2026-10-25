import { createHash } from 'node:crypto';
import {
	chmod,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAgentCli, verifySimulatorHelper } from './native-helper-trust';

const directories: string[] = [];

async function fixture() {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-helper-trust-')
	);
	directories.push(directory);
	const executable = path.join(directory, 'rndevtools-sim-helper');
	const nativeHost = path.join(directory, 'rndevtools-native-host');
	const cli = path.join(directory, 'rndevtools');
	await writeFile(executable, 'simulator helper');
	await writeFile(nativeHost, 'native helper');
	await writeFile(cli, 'agent cli');
	await chmod(executable, 0o755);
	await chmod(nativeHost, 0o755);
	await chmod(cli, 0o755);
	const entry = (name: string, body: string) => ({
		name,
		file: name,
		sha256: createHash('sha256').update(body).digest('hex'),
		size: Buffer.byteLength(body),
	});
	const manifest = {
		schemaVersion: 1,
		platform: 'darwin',
		architecture: 'arm64',
		appVersion: '0.1.0',
		buildCommit: 'a'.repeat(40),
		protocolVersion: 2,
		compatibilityMatrixVersion: '2026-09-03-v2',
		catalog: {
			version: 'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3',
			upstreamRepository: 'https://github.com/MobAI-App/simslim',
			upstreamCommit: '6518ba7eab1123d7e1d7797b0e05f51043b42a5b',
			patchSet: 'rndevtools.1',
			upstreamSourceManifestSha256:
				'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172',
			patchSha256:
				'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0',
			vendoredSourceManifestSha256:
				'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2',
		},
		helpers: {
			simulator: entry('rndevtools-sim-helper', 'simulator helper'),
			nativeHost: entry('rndevtools-native-host', 'native helper'),
			cli: entry('rndevtools', 'agent cli'),
		},
	};
	await writeFile(
		path.join(directory, 'manifest.json'),
		JSON.stringify(manifest)
	);
	return { directory, executable };
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true }))
	);
});

describe('native helper trust', () => {
	it('verifies manifest identity, digest, executable type, and signature', async () => {
		const { directory, executable } = await fixture();
		const canonicalExecutable = await realpath(executable);
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).resolves.toMatchObject({ executablePath: canonicalExecutable });
		expect(signatureVerifier).toHaveBeenCalledWith(canonicalExecutable);
	});

	it('independently verifies the bundled local agent CLI', async () => {
		const { directory } = await fixture();
		const canonicalCli = await realpath(path.join(directory, 'rndevtools'));
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifyAgentCli({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).resolves.toMatchObject({ executablePath: canonicalCli });
		expect(signatureVerifier).toHaveBeenCalledWith(canonicalCli);
	});

	it('rejects digest changes before invoking a helper', async () => {
		const { directory, executable } = await fixture();
		await writeFile(executable, 'changed helper');
		const signatureVerifier = vi.fn(async () => undefined);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier,
			})
		).rejects.toMatchObject({ kind: 'untrusted' });
		expect(signatureVerifier).not.toHaveBeenCalled();
	});

	it('rejects symbolic-link helper substitution', async () => {
		const { directory, executable } = await fixture();
		await rm(executable);
		await symlink('/usr/bin/true', executable);
		await expect(
			verifySimulatorHelper({
				resourceDirectory: directory,
				appVersion: '0.1.0',
				architecture: 'arm64',
				platform: 'darwin',
				signatureVerifier: async () => undefined,
			})
		).rejects.toMatchObject({ kind: 'untrusted' });
	});
});
