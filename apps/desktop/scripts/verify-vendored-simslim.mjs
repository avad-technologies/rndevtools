import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SIMSLIM_UPSTREAM_VERSION = 'v0.12.2';
export const SIMSLIM_UPSTREAM_COMMIT =
	'6518ba7eab1123d7e1d7797b0e05f51043b42a5b';
export const SIMSLIM_PATCH_SET = 'rndevtools.1';
export const SIMSLIM_VENDORED_MANIFEST_SHA256 =
	'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2';
export const SIMSLIM_UPSTREAM_MANIFEST_SHA256 =
	'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172';
export const SIMSLIM_PATCH_SHA256 =
	'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0';

const PATCHED_UPSTREAM_FILES = new Set([
	'clone.go',
	'disk_cleanup.go',
	'simctl.go',
]);

const EXPECTED_MODULE_FILE = `module github.com/adalloul0928/rndevtools-sim-helper

go 1.27.0

require github.com/mobai-app/simslim v0.12.2
`;
const EXPECTED_VENDOR_MODULES = `# github.com/mobai-app/simslim v0.12.2
## explicit; go 1.26
github.com/mobai-app/simslim
`;

export function verifyVendoredSimSlim(helperDirectory) {
	const resolvedHelper = resolve(helperDirectory);
	const upstreamManifestBytes = readFileSync(
		resolve(resolvedHelper, 'UPSTREAM_SOURCE_SHA256SUMS')
	);
	if (sha256(upstreamManifestBytes) !== SIMSLIM_UPSTREAM_MANIFEST_SHA256) {
		throw new Error(
			`Vendored SimSlim upstream-source manifest is not the reviewed ${SIMSLIM_UPSTREAM_COMMIT} manifest.`
		);
	}
	const upstreamFiles = parseChecksumManifest(
		upstreamManifestBytes.toString('utf8'),
		/^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/,
		'upstream SimSlim'
	);
	const patchBytes = readFileSync(
		resolve(resolvedHelper, `RNDEVTOOLS_PATCHSET_${SIMSLIM_PATCH_SET}.patch`)
	);
	if (sha256(patchBytes) !== SIMSLIM_PATCH_SHA256) {
		throw new Error(
			`Vendored SimSlim patch is not the reviewed ${SIMSLIM_PATCH_SET} patch.`
		);
	}
	const patchText = patchBytes.toString('utf8');
	const patchedHeaders = [
		...patchText.matchAll(/^diff --git a\/([^ ]+) b\/\1$/gm),
	].map((match) => match[1]);
	if (
		patchedHeaders.length !== PATCHED_UPSTREAM_FILES.size ||
		patchedHeaders.some((file) => !PATCHED_UPSTREAM_FILES.has(file))
	) {
		throw new Error(
			`Vendored SimSlim patch does not contain exactly ${SIMSLIM_PATCH_SET}.`
		);
	}
	const checksumPath = resolve(resolvedHelper, 'VENDORED_SOURCE_SHA256SUMS');
	const checksumBytes = readFileSync(checksumPath);
	const manifestDigest = sha256(checksumBytes);
	if (manifestDigest !== SIMSLIM_VENDORED_MANIFEST_SHA256) {
		throw new Error(
			`Vendored SimSlim checksum manifest is not the reviewed ${SIMSLIM_PATCH_SET} manifest.`
		);
	}

	const expected = parseChecksumManifest(
		checksumBytes.toString('utf8'),
		/^([a-f0-9]{64}) {2}(vendor\/[A-Za-z0-9_./-]+)$/,
		'vendored SimSlim'
	);

	const vendorDirectory = resolve(resolvedHelper, 'vendor');
	const actualFiles = collectRegularFiles(vendorDirectory)
		.map((filePath) => relativeFromHelper(resolvedHelper, filePath))
		.sort();
	const expectedFiles = [...expected.keys()].sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(
			`Vendored SimSlim file coverage drifted.\nExpected:\n${expectedFiles.join('\n')}\nActual:\n${actualFiles.join('\n')}`
		);
	}

	for (const [relativePath, digest] of expected) {
		const filePath = resolve(resolvedHelper, relativePath);
		if (relativeFromHelper(resolvedHelper, filePath) !== relativePath) {
			throw new Error(
				`Vendored SimSlim checksum path escaped the helper: ${relativePath}`
			);
		}
		if (sha256(readFileSync(filePath)) !== digest) {
			throw new Error(
				`Vendored SimSlim source checksum mismatch: ${relativePath}`
			);
		}
		const upstreamName = relativePath.replace(
			'vendor/github.com/mobai-app/simslim/',
			''
		);
		if (upstreamName === relativePath) continue;
		const upstreamDigest = upstreamFiles.get(upstreamName);
		if (!upstreamDigest) {
			throw new Error(
				`Vendored SimSlim source is absent from the anchored upstream base: ${upstreamName}`
			);
		}
		if (PATCHED_UPSTREAM_FILES.has(upstreamName)) {
			if (digest === upstreamDigest) {
				throw new Error(
					`Declared vendor patch did not change ${upstreamName}.`
				);
			}
		} else if (digest !== upstreamDigest) {
			throw new Error(
				`Undisclosed vendored SimSlim patch detected: ${upstreamName}`
			);
		}
	}
	if (
		upstreamFiles.size !== 18 ||
		[...upstreamFiles.keys()].some(
			(name) => !expected.has(`vendor/github.com/mobai-app/simslim/${name}`)
		)
	) {
		throw new Error('Anchored upstream SimSlim source coverage is incomplete.');
	}

	if (
		readFileSync(resolve(resolvedHelper, 'go.mod'), 'utf8') !==
		EXPECTED_MODULE_FILE
	) {
		throw new Error(
			`Simulator helper go.mod must contain only the pinned SimSlim ${SIMSLIM_UPSTREAM_VERSION} dependency.`
		);
	}
	if (
		readFileSync(resolve(resolvedHelper, 'vendor', 'modules.txt'), 'utf8') !==
		EXPECTED_VENDOR_MODULES
	) {
		throw new Error(
			'Vendored SimSlim module metadata does not match the pinned module graph.'
		);
	}

	const cloneSource = readFileSync(
		resolve(resolvedHelper, 'vendor/github.com/mobai-app/simslim/clone.go'),
		'utf8'
	);
	if (
		cloneSource.includes('"eww"') ||
		!cloneSource.includes('SimulatorProcessTreePIDsFromPS') ||
		!cloneSource.includes('simLaunchdPID(ctx, paths.cloneUDID)')
	) {
		throw new Error(
			'The reviewed clone privacy patch is missing or reintroduced process-environment scanning.'
		);
	}
	const measureSource = readFileSync(
		resolve(resolvedHelper, 'vendor/github.com/mobai-app/simslim/measure.go'),
		'utf8'
	);
	if (!measureSource.includes('udid+"/data/var/run/launchd_bootstrap"')) {
		throw new Error('The exact Simulator launchd-root selector is missing.');
	}
	const simctlSource = readFileSync(
		resolve(resolvedHelper, 'vendor/github.com/mobai-app/simslim/simctl.go'),
		'utf8'
	);
	if (!simctlSource.includes('func ParseDisabledOutput(')) {
		throw new Error('The reviewed launchd-status parser patch is missing.');
	}

	return {
		upstreamVersion: SIMSLIM_UPSTREAM_VERSION,
		upstreamCommit: SIMSLIM_UPSTREAM_COMMIT,
		patchSet: SIMSLIM_PATCH_SET,
		upstreamSourceManifestSha256: SIMSLIM_UPSTREAM_MANIFEST_SHA256,
		patchSha256: SIMSLIM_PATCH_SHA256,
		vendoredSourceManifestSha256: manifestDigest,
		files: expectedFiles.length,
	};
}

function parseChecksumManifest(contents, pattern, label) {
	const entries = new Map();
	for (const line of contents.trim().split('\n')) {
		const match = pattern.exec(line);
		if (!match) throw new Error(`Invalid ${label} checksum entry: ${line}`);
		const [, digest, relativePath] = match;
		if (entries.has(relativePath)) {
			throw new Error(`Duplicate ${label} checksum entry: ${relativePath}`);
		}
		entries.set(relativePath, digest);
	}
	return entries;
}

function collectRegularFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = resolve(directory, entry.name);
		const metadata = lstatSync(entryPath);
		if (metadata.isSymbolicLink()) {
			throw new Error(
				`Vendored SimSlim source contains a symbolic link: ${entryPath}`
			);
		}
		if (metadata.isDirectory()) files.push(...collectRegularFiles(entryPath));
		else if (metadata.isFile()) files.push(entryPath);
		else
			throw new Error(
				`Vendored SimSlim source contains a non-regular file: ${entryPath}`
			);
	}
	return files;
}

function relativeFromHelper(helperDirectory, filePath) {
	const prefix = `${resolve(helperDirectory)}/`;
	const resolvedPath = resolve(filePath);
	if (!resolvedPath.startsWith(prefix)) {
		throw new Error(`Vendored SimSlim path escaped the helper: ${filePath}`);
	}
	return resolvedPath.slice(prefix.length);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}
