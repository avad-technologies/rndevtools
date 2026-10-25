import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
	readFileSync(join(desktopDirectory, 'package.json'))
);

export function releaseSettings(localDevelopment, env, version) {
	if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID ?? '')) {
		throw new Error(
			'APPLE_TEAM_ID must be the signing certificate’s 10-character team ID.'
		);
	}
	if (!env.CSC_NAME && !env.CSC_LINK) {
		throw new Error(
			'Set CSC_NAME to an installed signing identity or CSC_LINK to its private P12.'
		);
	}
	if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
		throw new Error(
			'Certificate discovery must be enabled; ad-hoc signing is not a release candidate.'
		);
	}
	if (!localDevelopment && !env.APPLE_KEYCHAIN_PROFILE) {
		throw new Error(
			'Public releases require APPLE_KEYCHAIN_PROFILE with validated notarytool credentials.'
		);
	}
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error('The desktop version must be a release version.');
	}
	return {
		mode: localDevelopment ? 'local-development' : 'public',
		artifactName: `RN-Devtools-${version}${localDevelopment ? '-local-development' : ''}-arm64.dmg`,
		type: localDevelopment ? 'development' : 'distribution',
		notarize: !localDevelopment,
	};
}

export function assertSignature(
	details,
	team,
	localDevelopment,
	executable = true
) {
	const authority = localDevelopment
		? 'Apple Development:'
		: 'Developer ID Application:';
	if (!details.includes(`Authority=${authority}`)) {
		throw new Error(
			`Expected ${authority} signing; development and ad-hoc signatures cannot pass the public gate.`
		);
	}
	if (!details.split('\n').includes(`TeamIdentifier=${team}`)) {
		throw new Error(
			'App and native helpers must use the requested signing team.'
		);
	}
	if (executable && !/flags=0x[0-9a-f]+\([^\n)]*runtime\b/i.test(details)) {
		throw new Error('Hardened runtime is required for every executable.');
	}
	if (!/^Timestamp=.+$/m.test(details)) {
		throw new Error('A secure signing timestamp is required.');
	}
}

export function assertCompiledTeam(handshake, team) {
	if (
		handshake.protocolVersion !== 2 ||
		handshake.requestId !== 'release-team-verification' ||
		handshake.ok !== true ||
		handshake.result?.signingTeamIdentifier !== team
	) {
		throw new Error(
			'The simulator helper did not report the matching compiled Apple team pin.'
		);
	}
}

export function assertNoBuildHome(binary, buildHome = homedir()) {
	if (binary.includes(Buffer.from(`${buildHome}/`))) {
		throw new Error(
			'A native helper embeds the builder’s home directory. Strip debug paths before distribution.'
		);
	}
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: desktopDirectory,
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
		...options,
	});
}

async function verifyApp(appPath, settings, team) {
	const { spawnSync } = await import('node:child_process');
	const verifyNative = require('./verify-native-resources.cjs');
	const { getCurrentFuseWire, FuseV1Options, FuseState } = await import(
		'@electron/fuses'
	);
	run('/usr/bin/codesign', [
		'--verify',
		'--deep',
		'--strict',
		'--verbose=2',
		appPath,
	]);
	const nativeDirectory = join(appPath, 'Contents', 'Resources', 'native');
	const nativeManifest = verifyNative(nativeDirectory);
	for (const helper of Object.values(nativeManifest.helpers)) {
		assertNoBuildHome(readFileSync(join(nativeDirectory, helper.file)));
	}
	const targets = [
		appPath,
		...Object.values(nativeManifest.helpers).map((h) =>
			join(nativeDirectory, h.file)
		),
	];
	for (const target of targets) {
		const result = spawnSync(
			'/usr/bin/codesign',
			['-d', '--verbose=4', target],
			{ encoding: 'utf8' }
		);
		if (result.status !== 0)
			throw new Error('Could not inspect a packaged code signature.');
		assertSignature(result.stderr, team, settings.mode === 'local-development');
	}
	// Go intentionally omits ldflags from build info with -trimpath. Ask the
	// signed executable for its actual linked pin; handshake probes no devices.
	const handshake = JSON.parse(
		run(join(nativeDirectory, 'rndevtools-sim-helper'), [], {
			input: `${JSON.stringify({
				protocolVersion: 2,
				requestId: 'release-team-verification',
				operation: 'handshake',
				payload: {},
			})}\n`,
			timeout: 15_000,
			maxBuffer: 256 * 1024,
		})
	);
	assertCompiledTeam(handshake, team);
	const minimum = run('/usr/libexec/PlistBuddy', [
		'-c',
		'Print :LSMinimumSystemVersion',
		join(appPath, 'Contents', 'Info.plist'),
	]).trim();
	if (minimum !== '14.0')
		throw new Error('The supported minimum macOS version must be 14.0.');
	const fuses = await getCurrentFuseWire(appPath);
	for (const [option, enabled] of Object.entries(
		require('./after-pack.cjs').fuseOptions
	)) {
		if (!/^\d+$/.test(option)) continue;
		if (fuses[option] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
			throw new Error(
				`Packaged Electron fuse ${FuseV1Options[option]} has the wrong state.`
			);
		}
	}
	if (settings.notarize) {
		run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
		run('/usr/sbin/spctl', [
			'--assess',
			'--type',
			'execute',
			'--verbose=2',
			appPath,
		]);
	}
	return nativeManifest;
}

export async function main(args = process.argv.slice(2)) {
	if (args.some((a) => !['--local-development', '--preflight'].includes(a))) {
		throw new Error(
			'Usage: release-macos.mjs [--local-development] [--preflight]'
		);
	}
	if (process.platform !== 'darwin' || process.arch !== 'arm64') {
		throw new Error('The supported DMG must be built on an Apple silicon Mac.');
	}
	const settings = releaseSettings(
		args.includes('--local-development'),
		process.env,
		manifest.version
	);
	if (settings.mode === 'public') {
		if (
			run('git', ['status', '--porcelain', '--untracked-files=normal']).trim()
		) {
			throw new Error(
				'Public artifacts must be built from a clean, committed checkout.'
			);
		}
		if (
			process.env.GITHUB_REF_TYPE === 'tag' &&
			process.env.GITHUB_REF_NAME !== `v${manifest.version}`
		) {
			throw new Error(
				'The release tag must match the desktop package version.'
			);
		}
	}
	if (args.includes('--preflight')) {
		console.log(`Validated ${settings.mode} release inputs.`);
		return;
	}
	process.env.RNDEVTOOLS_RELEASE_MODE = settings.mode;
	// Use only the prevalidated Keychain profile for both app and DMG notarization.
	for (const name of [
		'APPLE_ID',
		'APPLE_APP_SPECIFIC_PASSWORD',
		'APPLE_API_KEY',
		'APPLE_API_KEY_ID',
		'APPLE_API_ISSUER',
	])
		delete process.env[name];
	const output = join(desktopDirectory, 'release', settings.mode);
	mkdirSync(output, { recursive: true });
	run('pnpm', ['native:build'], { stdio: 'inherit' });
	run('pnpm', ['build'], { stdio: 'inherit' });
	const { build, Platform, Arch } = require('electron-builder');
	const appPath = join(output, 'mac-arm64', `${manifest.productName}.app`);
	await build({
		projectDir: desktopDirectory,
		targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
		publish: 'never',
		config: {
			forceCodeSigning: true,
			artifactName: settings.artifactName,
			directories: { output },
			mac: {
				type: settings.type,
				identity: process.env.CSC_NAME,
				hardenedRuntime: true,
				minimumSystemVersion: '14.0',
				notarize: settings.notarize,
			},
			dmg: { sign: settings.notarize },
			afterSign: () => verifyApp(appPath, settings, process.env.APPLE_TEAM_ID),
		},
	});
	// Recheck the exact final bundle even if a future builder skips afterSign.
	const nativeManifest = await verifyApp(
		appPath,
		settings,
		process.env.APPLE_TEAM_ID
	);
	const dmgPath = join(output, settings.artifactName);
	run('/usr/bin/hdiutil', ['verify', dmgPath]);
	if (settings.notarize) {
		const authentication = [
			'--keychain-profile',
			process.env.APPLE_KEYCHAIN_PROFILE,
		];
		if (process.env.APPLE_KEYCHAIN)
			authentication.push('--keychain', process.env.APPLE_KEYCHAIN);
		const submission = JSON.parse(
			run(
				'/usr/bin/xcrun',
				[
					'notarytool',
					'submit',
					dmgPath,
					...authentication,
					'--wait',
					'--output-format',
					'json',
				],
				{ timeout: 30 * 60_000 }
			)
		);
		if (submission.status !== 'Accepted')
			throw new Error('Apple did not accept the DMG for notarization.');
		run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
		run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
		run('/usr/bin/codesign', ['--verify', '--strict', dmgPath]);
		const { spawnSync } = await import('node:child_process');
		const details = spawnSync(
			'/usr/bin/codesign',
			['-d', '--verbose=4', dmgPath],
			{ encoding: 'utf8' }
		);
		if (details.status !== 0)
			throw new Error('Could not inspect the DMG signature.');
		assertSignature(details.stderr, process.env.APPLE_TEAM_ID, false, false);
		run('/usr/sbin/spctl', [
			'--assess',
			'--type',
			'open',
			'--context',
			'context:primary-signature',
			'--verbose=2',
			dmgPath,
		]);
	}
	const releaseManifest = {
		version: manifest.version,
		mode: settings.mode,
		architecture: 'arm64',
		minimumMacOS: '14.0',
		artifact: settings.artifactName,
		signingTeam: process.env.APPLE_TEAM_ID,
		notarized: settings.notarize,
		nativeBuildCommit: nativeManifest.buildCommit,
	};
	writeFileSync(
		join(output, 'release-manifest.json'),
		`${JSON.stringify(releaseManifest, null, 2)}\n`
	);
	const sums = [settings.artifactName, 'release-manifest.json']
		.map(
			(name) =>
				`${createHash('sha256')
					.update(readFileSync(join(output, name)))
					.digest('hex')}  ${name}\n`
		)
		.join('');
	writeFileSync(join(output, 'SHA256SUMS.txt'), sums);
	console.log(`Verified ${settings.mode} DMG: ${settings.artifactName}`);
	if (!settings.notarize)
		console.log(
			'LOCAL DEVELOPMENT ONLY: this candidate is not notarized or approved for public installation.'
		);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
