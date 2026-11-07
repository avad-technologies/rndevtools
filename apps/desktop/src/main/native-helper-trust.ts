import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runSimulatorCommand } from './simulator-command-runner';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const EXPECTED_PROTOCOL_VERSION = 2;
const EXPECTED_CATALOG_VERSION =
	'simslim-v0.14.0-7e374b38-rndevtools.1-presets.3';
const EXPECTED_UPSTREAM_COMMIT = '7e374b3839d49608a681d1f8b9ca0dd83d35189e';
const EXPECTED_PATCH_SET = 'rndevtools.1';
const EXPECTED_UPSTREAM_SOURCE_MANIFEST_SHA256 =
	'cd8843eca8ac08e7b44fcab27582bc8d76ca29ee80a8334e6873c3c7dd568056';
const EXPECTED_PATCH_SHA256 =
	'045c1b21248398f066d20766bf178dc307fdee3ca5ef5fcea11f889dcddc1063';
const EXPECTED_VENDORED_SOURCE_MANIFEST_SHA256 =
	'f5082751ccb44251861356158fce6a88a5c736dfe52844929db77bacf99af694';

const helperManifestEntrySchema = z.strictObject({
	name: z.string().regex(/^rndevtools(?:-[a-z-]+)?$/),
	file: z.string().regex(/^rndevtools(?:-[a-z-]+)?$/),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().positive().max(MAX_HELPER_BYTES),
});

const nativeResourceManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	platform: z.literal('darwin'),
	architecture: z.enum(['arm64', 'x64']),
	appVersion: z.string().trim().min(1).max(128),
	buildCommit: z.string().regex(/^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$/),
	protocolVersion: z.literal(EXPECTED_PROTOCOL_VERSION),
	compatibilityMatrixVersion: z.string().trim().min(1).max(256),
	catalog: z.strictObject({
		version: z.literal(EXPECTED_CATALOG_VERSION),
		upstreamRepository: z.literal('https://github.com/MobAI-App/simslim'),
		upstreamCommit: z.literal(EXPECTED_UPSTREAM_COMMIT),
		patchSet: z.literal(EXPECTED_PATCH_SET),
		upstreamSourceManifestSha256: z.literal(
			EXPECTED_UPSTREAM_SOURCE_MANIFEST_SHA256
		),
		patchSha256: z.literal(EXPECTED_PATCH_SHA256),
		vendoredSourceManifestSha256: z.literal(
			EXPECTED_VENDORED_SOURCE_MANIFEST_SHA256
		),
	}),
	helpers: z.strictObject({
		simulator: helperManifestEntrySchema,
		nativeHost: helperManifestEntrySchema,
		cli: helperManifestEntrySchema,
	}),
});
type NativeResourceManifest = z.infer<typeof nativeResourceManifestSchema>;

export type VerifiedNativeHelper = {
	executablePath: string;
	manifest: NativeResourceManifest;
	verifiedAt: number;
};
export type VerifiedSimulatorHelper = VerifiedNativeHelper;
export type VerifiedAgentCli = VerifiedNativeHelper;

export class NativeHelperTrustError extends Error {
	readonly kind: 'unavailable' | 'untrusted';

	constructor(
		message: string,
		kind: 'unavailable' | 'untrusted',
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'NativeHelperTrustError';
		this.kind = kind;
	}
}

type SignatureVerifier = (executablePath: string) => Promise<void>;

async function verifyCodeSignature(executablePath: string): Promise<void> {
	await runSimulatorCommand(
		'/usr/bin/codesign',
		['--verify', '--strict', '--all-architectures', executablePath],
		{ timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }
	);
}

async function sha256File(filePath: string): Promise<Buffer> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath))
		hash.update(chunk as Buffer);
	return hash.digest();
}

function expectedArchitecture(
	architecture: NodeJS.Architecture
): 'arm64' | 'x64' {
	if (architecture === 'arm64' || architecture === 'x64') return architecture;
	throw new NativeHelperTrustError(
		`Native Simulator helpers do not support ${architecture}.`,
		'unavailable'
	);
}

function containedPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
	);
}

async function verifyNativeHelper({
	resourceDirectory,
	appVersion,
	helperKind,
	expectedName,
	architecture = process.arch,
	platform = process.platform,
	signatureVerifier = verifyCodeSignature,
}: {
	resourceDirectory: string;
	appVersion: string;
	helperKind: 'simulator' | 'nativeHost' | 'cli';
	expectedName:
		| 'rndevtools-sim-helper'
		| 'rndevtools-native-host'
		| 'rndevtools';
	architecture?: NodeJS.Architecture;
	platform?: NodeJS.Platform;
	signatureVerifier?: SignatureVerifier;
}): Promise<VerifiedNativeHelper> {
	if (platform !== 'darwin') {
		throw new NativeHelperTrustError(
			'Experimental Simulator slimming requires macOS.',
			'unavailable'
		);
	}
	const architectureName = expectedArchitecture(architecture);
	const requestedRoot = path.resolve(resourceDirectory);
	let root: string;
	try {
		root = await realpath(requestedRoot);
	} catch (cause) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper resources are not installed.',
			'unavailable',
			{ cause }
		);
	}

	const manifestPath = path.join(root, 'manifest.json');
	let manifest: NativeResourceManifest;
	try {
		const manifestMetadata = await lstat(manifestPath);
		if (
			!manifestMetadata.isFile() ||
			manifestMetadata.isSymbolicLink() ||
			manifestMetadata.size > MAX_MANIFEST_BYTES
		) {
			throw new Error('invalid manifest file');
		}
		manifest = nativeResourceManifestSchema.parse(
			JSON.parse(await readFile(manifestPath, 'utf8'))
		);
	} catch (cause) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper manifest failed validation.',
			'untrusted',
			{ cause }
		);
	}
	if (
		manifest.architecture !== architectureName ||
		manifest.appVersion !== appVersion
	) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper does not match this desktop build.',
			'untrusted'
		);
	}

	const helper = manifest.helpers[helperKind];
	if (helper.name !== expectedName || helper.file !== helper.name) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper identity is invalid.',
			'untrusted'
		);
	}
	const executablePath = path.join(root, helper.file);
	if (!containedPath(root, executablePath)) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper escaped its resource directory.',
			'untrusted'
		);
	}

	try {
		const before = await lstat(executablePath);
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			(before.mode & 0o111) === 0 ||
			before.size !== helper.size
		) {
			throw new Error('invalid helper file');
		}
		const resolvedExecutable = await realpath(executablePath);
		if (!containedPath(root, resolvedExecutable))
			throw new Error('helper path escaped root');
		const actualDigest = await sha256File(resolvedExecutable);
		const expectedDigest = Buffer.from(helper.sha256, 'hex');
		if (
			actualDigest.byteLength !== expectedDigest.byteLength ||
			!timingSafeEqual(actualDigest, expectedDigest)
		) {
			throw new Error('helper digest mismatch');
		}
		await signatureVerifier(resolvedExecutable);
		const after = await lstat(resolvedExecutable);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		) {
			throw new Error('helper changed during verification');
		}
		return {
			executablePath: resolvedExecutable,
			manifest,
			verifiedAt: Date.now(),
		};
	} catch (cause) {
		throw new NativeHelperTrustError(
			'Bundled Simulator helper failed integrity or code-signature verification.',
			'untrusted',
			{ cause }
		);
	}
}

export function verifySimulatorHelper(options: {
	resourceDirectory: string;
	appVersion: string;
	architecture?: NodeJS.Architecture;
	platform?: NodeJS.Platform;
	signatureVerifier?: SignatureVerifier;
}): Promise<VerifiedSimulatorHelper> {
	return verifyNativeHelper({
		...options,
		helperKind: 'simulator',
		expectedName: 'rndevtools-sim-helper',
	});
}

export function verifyNativeHost(options: {
	resourceDirectory: string;
	appVersion: string;
	architecture?: NodeJS.Architecture;
	platform?: NodeJS.Platform;
	signatureVerifier?: SignatureVerifier;
}): Promise<VerifiedNativeHelper> {
	return verifyNativeHelper({
		...options,
		helperKind: 'nativeHost',
		expectedName: 'rndevtools-native-host',
	});
}

export function verifyAgentCli(options: {
	resourceDirectory: string;
	appVersion: string;
	architecture?: NodeJS.Architecture;
	platform?: NodeJS.Platform;
	signatureVerifier?: SignatureVerifier;
}): Promise<VerifiedAgentCli> {
	return verifyNativeHelper({
		...options,
		helperKind: 'cli',
		expectedName: 'rndevtools',
	});
}
