import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SIMSLIM_UPSTREAM_VERSION = 'v0.14.0';
export const SIMSLIM_UPSTREAM_COMMIT =
	'7e374b3839d49608a681d1f8b9ca0dd83d35189e';
export const SIMSLIM_PATCH_SET = 'rndevtools.1';
export const SIMSLIM_VENDORED_MANIFEST_SHA256 =
	'f5082751ccb44251861356158fce6a88a5c736dfe52844929db77bacf99af694';
export const SIMSLIM_UPSTREAM_MANIFEST_SHA256 =
	'cd8843eca8ac08e7b44fcab27582bc8d76ca29ee80a8334e6873c3c7dd568056';
export const SIMSLIM_PATCH_SHA256 =
	'045c1b21248398f066d20766bf178dc307fdee3ca5ef5fcea11f889dcddc1063';

const PATCHED_UPSTREAM_FILES = new Set([
	'clone.go',
	'disk_cleanup.go',
	'simctl.go',
]);

const EXPECTED_MODULE_FILE = `module github.com/adalloul0928/rndevtools-sim-helper

go 1.27.0

require github.com/mobai-app/simslim v0.14.0
`;
const EXPECTED_VENDOR_MODULES = `# github.com/mobai-app/simslim v0.14.0
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
	const actualFiles = collectRegularFiles(vendorDirectory, 'SimSlim')
		.map((filePath) => relativeFromHelper(resolvedHelper, filePath, 'SimSlim'))
		.sort();
	const expectedFiles = [...expected.keys()].sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(
			`Vendored SimSlim file coverage drifted.\nExpected:\n${expectedFiles.join('\n')}\nActual:\n${actualFiles.join('\n')}`
		);
	}

	for (const [relativePath, digest] of expected) {
		const filePath = resolve(resolvedHelper, relativePath);
		if (
			relativeFromHelper(resolvedHelper, filePath, 'SimSlim') !== relativePath
		) {
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
		upstreamFiles.size !== 22 ||
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

// The helpers below are shared with verify-vendored-go-toml.mjs; `label` names
// the vendored source in their errors.

export function parseChecksumManifest(contents, pattern, label) {
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

export function collectRegularFiles(directory, label) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = resolve(directory, entry.name);
		const metadata = lstatSync(entryPath);
		if (metadata.isSymbolicLink()) {
			throw new Error(
				`Vendored ${label} source contains a symbolic link: ${entryPath}`
			);
		}
		if (metadata.isDirectory())
			files.push(...collectRegularFiles(entryPath, label));
		else if (metadata.isFile()) files.push(entryPath);
		else
			throw new Error(
				`Vendored ${label} source contains a non-regular file: ${entryPath}`
			);
	}
	return files;
}

export function relativeFromHelper(helperDirectory, filePath, label) {
	const prefix = `${resolve(helperDirectory)}/`;
	const resolvedPath = resolve(filePath);
	if (!resolvedPath.startsWith(prefix)) {
		throw new Error(`Vendored ${label} path escaped the helper: ${filePath}`);
	}
	return resolvedPath.slice(prefix.length);
}

export function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}
