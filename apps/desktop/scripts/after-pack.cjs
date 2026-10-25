const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');
const verifyNativeResources = require('./verify-native-resources.cjs');

const { refreshNativeResourceManifest } = verifyNativeResources;

const execFileAsync = promisify(execFile);

const fuseOptions = Object.freeze({
	version: FuseVersion.V1,
	strictlyRequireAllFuses: true,
	[FuseV1Options.RunAsNode]: false,
	[FuseV1Options.EnableCookieEncryption]: true,
	[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
	[FuseV1Options.EnableNodeCliInspectArguments]: false,
	[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
	[FuseV1Options.OnlyLoadAppFromAsar]: true,
	[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
	[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
	[FuseV1Options.WasmTrapHandlers]: true,
});

module.exports = async function afterPack(context) {
	const executableName = context.packager.appInfo.productFilename;
	const appPath =
		context.electronPlatformName === 'darwin'
			? path.join(context.appOutDir, `${executableName}.app`)
			: null;
	const nativeResourcesPath = appPath
		? path.join(appPath, 'Contents', 'Resources', 'native')
		: null;
	const manifest = nativeResourcesPath
		? verifyNativeResources(nativeResourcesPath)
		: null;
	const executablePath =
		context.electronPlatformName === 'darwin'
			? path.join(appPath, 'Contents', 'MacOS', executableName)
			: path.join(
					context.appOutDir,
					context.electronPlatformName === 'win32'
						? `${executableName}.exe`
						: executableName
				);

	// On macOS the fuse wire lives inside the nested Electron Framework. It must
	// reach its final bytes before any nested code is signed.
	await flipFuses(executablePath, fuseOptions);

	if (context.electronPlatformName === 'darwin') {
		const signing = await resolveNativeSigning(context);
		if (
			process.env.RNDEVTOOLS_RELEASE_MODE === 'public' &&
			(!signing?.builderIdentity.name.startsWith('Developer ID Application:') ||
				!signing.hardenedRuntime ||
				signing.timestamp === 'none')
		) {
			throw new Error(
				'Public releases require a Developer ID Application identity, hardened runtime and secure timestamps.'
			);
		}
		const helperSigning = signing || localAdHocSigning();
		for (const helper of Object.values(manifest.helpers)) {
			await signNativeHelper(
				path.join(nativeResourcesPath, helper.file),
				helperSigning
			);
		}

		for (const helper of Object.values(manifest.helpers)) {
			await execFileAsync('/usr/bin/codesign', [
				'--verify',
				'--strict',
				'--verbose=2',
				path.join(nativeResourcesPath, helper.file),
			]);
		}
		refreshNativeResourceManifest(nativeResourcesPath, manifest);
		verifyNativeResources(nativeResourcesPath);

		// A distribution build is signed by electron-builder after this hook. Its
		// signing pass excludes the finalized, already-hashed native executables.
		// When certificate discovery is explicitly disabled, run that same signing
		// implementation here with an ad-hoc identity so Electron's nested
		// entitlements and code requirements remain internally consistent on a true
		// cold launch.
		if (signing?.localAdHoc) {
			const signOptions = await context.packager.helper.buildSignOptions(
				appPath,
				signing.builderIdentity,
				signing.type,
				false,
				signing.config,
				signing.keychainFile,
				context.arch
			);
			await context.packager.doSign(
				signOptions,
				signing.config,
				signing.builderIdentity
			);
		} else if (!signing) {
			// Flipping fuses invalidates Electron's upstream ad-hoc signature. When
			// no distribution identity is configured or discoverable, always reseal
			// the complete app so a local package remains launchable.
			await execFileAsync('/usr/bin/codesign', [
				'--force',
				'--deep',
				'--sign',
				'-',
				appPath,
			]);
		}
	}
};

module.exports.fuseOptions = fuseOptions;

function localAdHocSigning() {
	return {
		identity: '-',
		keychainFile: null,
		hardenedRuntime: false,
		timestamp: 'none',
	};
}

async function resolveNativeSigning(context) {
	const packager = context.packager;
	const config = packager.platformSpecificBuildOptions;
	if (config.identity === null) {
		return null;
	}
	const signingInfo = await packager.codeSigningInfo.value;
	const type = config.type || 'distribution';
	let identity = await packager.helper.findSigningIdentity(
		false,
		type === 'development',
		config.identity,
		signingInfo.keychainFile,
		config
	);
	let localAdHoc = false;
	if (!identity && process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
		identity = await packager.helper.findSigningIdentity(
			false,
			type === 'development',
			'-',
			signingInfo.keychainFile,
			config
		);
		localAdHoc = true;
	}
	return identity
		? {
				identity: identity.hash || identity.name,
				builderIdentity: identity,
				config,
				keychainFile: signingInfo.keychainFile,
				hardenedRuntime: config.hardenedRuntime !== false,
				localAdHoc,
				timestamp: identity.name === '-' ? 'none' : config.timestamp,
				type,
			}
		: null;
}

async function signNativeHelper(helperPath, signing) {
	await execFileAsync(
		'/usr/bin/codesign',
		buildNativeCodeSignArguments(helperPath, signing)
	);
}

function buildNativeCodeSignArguments(helperPath, signing) {
	const arguments_ = [
		'--force',
		'--sign',
		signing.identity,
		'--identifier',
		path.basename(helperPath),
	];
	if (signing.keychainFile) {
		arguments_.push('--keychain', signing.keychainFile);
	}
	if (signing.hardenedRuntime) {
		arguments_.push('--options', 'runtime');
	}
	arguments_.push(
		signing.timestamp ? `--timestamp=${signing.timestamp}` : '--timestamp',
		helperPath
	);
	return arguments_;
}
