const { createHash, randomUUID } = require('node:crypto');
const {
	lstatSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} = require('node:fs');
const path = require('node:path');

const expectedHelperFiles = Object.freeze({
	simulator: 'rndevtools-sim-helper',
	nativeHost: 'rndevtools-native-host',
	cli: 'rndevtools',
});

function verifyNativeResources(resourcesDirectory) {
	const resolvedDirectory = path.resolve(resourcesDirectory);
	const manifest = readSupportedManifest(resolvedDirectory);
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const { data, stats } = inspectHelper(resolvedDirectory, key, expectedFile);
		const helper = manifest.helpers[key];
		const digest = createHash('sha256').update(data).digest('hex');
		if (stats.size !== helper.size || digest !== helper.sha256) {
			throw new Error(
				`Native helper ${key} does not match its integrity manifest.`
			);
		}
	}
	return manifest;
}

function readSupportedManifest(resolvedDirectory) {
	const manifestPath = path.join(resolvedDirectory, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (
		manifest.schemaVersion !== 1 ||
		manifest.platform !== 'darwin' ||
		!['arm64', 'x64'].includes(manifest.architecture) ||
		manifest.protocolVersion !== 2 ||
		manifest.compatibilityMatrixVersion !== '2026-09-03-v2' ||
		manifest.catalog?.version !==
			'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3' ||
		manifest.catalog?.upstreamCommit !==
			'6518ba7eab1123d7e1d7797b0e05f51043b42a5b' ||
		manifest.catalog?.patchSet !== 'rndevtools.1' ||
		manifest.catalog?.upstreamSourceManifestSha256 !==
			'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172' ||
		manifest.catalog?.patchSha256 !==
			'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0' ||
		manifest.catalog?.vendoredSourceManifestSha256 !==
			'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2'
	) {
		throw new Error('Native resource manifest has an unsupported format.');
	}
	if (
		typeof manifest.buildCommit !== 'string' ||
		!/^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$/.test(manifest.buildCommit)
	) {
		throw new Error(
			'Native resource manifest has an unsupported build identity.'
		);
	}
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const helper = manifest.helpers?.[key];
		if (
			!helper ||
			helper.name !== expectedFile ||
			helper.file !== expectedFile
		) {
			throw new Error(`Native resource manifest is missing ${key}.`);
		}
	}
	return manifest;
}

function inspectHelper(resolvedDirectory, key, expectedFile) {
	const helperPath = path.join(resolvedDirectory, expectedFile);
	const stats = lstatSync(helperPath);
	if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
		throw new Error(`Native helper ${key} is not a regular executable file.`);
	}
	return { data: readFileSync(helperPath), stats };
}

function refreshNativeResourceManifest(resourcesDirectory, verifiedManifest) {
	const resolvedDirectory = path.resolve(resourcesDirectory);
	const manifestPath = path.join(resolvedDirectory, 'manifest.json');
	const manifest = readSupportedManifest(resolvedDirectory);
	if (
		!verifiedManifest ||
		JSON.stringify(manifest) !== JSON.stringify(verifiedManifest)
	) {
		throw new Error(
			'Refreshing a native resource manifest requires the exact previously verified manifest.'
		);
	}
	const helpers = {};
	for (const [key, expectedFile] of Object.entries(expectedHelperFiles)) {
		const { data, stats } = inspectHelper(resolvedDirectory, key, expectedFile);
		helpers[key] = {
			...manifest.helpers[key],
			sha256: createHash('sha256').update(data).digest('hex'),
			size: stats.size,
		};
	}

	const refreshedManifest = { ...manifest, helpers };
	const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(
			temporaryPath,
			`${JSON.stringify(refreshedManifest, null, 2)}\n`,
			{
				encoding: 'utf8',
				flag: 'wx',
				mode: 0o644,
			}
		);
		renameSync(temporaryPath, manifestPath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (cleanupError?.code !== 'ENOENT') {
				throw new AggregateError(
					[error, cleanupError],
					'Failed to refresh the native resource manifest and clean up its temporary file.'
				);
			}
		}
		throw error;
	}
	return refreshedManifest;
}

if (require.main === module) {
	if (process.argv.length > 3) {
		process.stderr.write(
			'Usage: node verify-native-resources.cjs [resources-directory]\n'
		);
		process.exit(2);
	}
	try {
		const resourcesDirectory =
			process.argv[2] ??
			path.join(__dirname, '..', 'build', 'native', `mac-${process.arch}`);
		const manifest = verifyNativeResources(resourcesDirectory);
		process.stdout.write(
			`Verified native resources for mac-${manifest.architecture}.\n`
		);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}
}

module.exports = verifyNativeResources;
module.exports.refreshNativeResourceManifest = refreshNativeResourceManifest;
