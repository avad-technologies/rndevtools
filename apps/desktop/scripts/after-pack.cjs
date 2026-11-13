const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');
const verifyNativeResources = require('./verify-native-resources.cjs');

const { refreshNativeResourceManifest } = verifyNativeResources;

const execFileAsync = promisify(execFile);
const adHocEntitlements = path.join(
	__dirname,
	'..',
	'build',
	'entitlements.mac.adhoc.plist'
);

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
			(!signing.builderIdentity.name.startsWith('Developer ID Application:') ||
				!signing.hardenedRuntime ||
				signing.timestamp === 'none')
		) {
			throw new Error(
				'Public releases require a Developer ID Application identity, hardened runtime and secure timestamps.'
			);
		}
		for (const helper of Object.values(manifest.helpers)) {
			await signNativeHelper(
				path.join(nativeResourcesPath, helper.file),
				signing
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
		// Ad-hoc signatures lack a team ID. Sign the app and Electron helpers
		// with local entitlements so macOS can load the bundled framework.
		if (signing.identity === '-') {
			// The standard pass can run again with an explicit ad-hoc identity.
			// It needs the same entitlements as the pass here.
			Object.assign(
				context.packager.platformSpecificBuildOptions,
				signing.config
			);
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
		}
	}
};

module.exports.fuseOptions = fuseOptions;

async function resolveNativeSigning(context) {
	const packager = context.packager;
	const config = packager.platformSpecificBuildOptions;
	const signingInfo = await packager.codeSigningInfo.value;
	const type = config.type || 'distribution';
	const keychainFile = signingInfo.keychainFile;
	const identity =
		config.identity === null || config.identity === '-'
			? null
			: await packager.helper.findSigningIdentity(
					false,
					type === 'development',
					config.identity,
					keychainFile,
					config
				);
	if (identity && identity.name !== '-') {
		return {
			identity: identity.hash || identity.name,
			builderIdentity: identity,
			config,
			keychainFile,
			hardenedRuntime: config.hardenedRuntime !== false,
			timestamp: config.timestamp,
			type,
		};
	}
	const localConfig = {
		...config,
		entitlements: adHocEntitlements,
		entitlementsInherit: adHocEntitlements,
		timestamp: 'none',
	};
	return {
		identity: '-',
		builderIdentity: { name: '-' },
		config: localConfig,
		keychainFile,
		hardenedRuntime: localConfig.hardenedRuntime !== false,
		timestamp: localConfig.timestamp,
		type,
	};
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
