import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Swift native host cannot take a string at link time the way the Go
// helpers take `-ldflags -X main.version`, so its version is a generated source
// file. It is committed so a plain `swift build` still compiles, and it must
// equal package.json: Electron trusts the host only when its handshake reports
// the manifest's appVersion, which build-native-helpers.mjs writes from there.
const defaultDesktopDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..'
);
const sourcePath = [
	'native',
	'rndevtools-native-host',
	'Sources',
	'RNDevtoolsNativeHost',
	'HelperVersion.swift',
];
// A semantic version cannot contain a quote, backslash or `\(`, so it is also a
// safe Swift string literal.
const semanticVersion =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const declaredVersion = /static let helperVersion = "([^"]*)"/;
const syncCommand = 'pnpm --filter @rndevtools/desktop native:sync-version';

/** The desktop app version that the bundled helpers' handshakes must report. */
export function desktopVersion(desktopDirectory = defaultDesktopDirectory) {
	const { version } = JSON.parse(
		readFileSync(join(desktopDirectory, 'package.json'), 'utf8')
	);
	if (
		typeof version !== 'string' ||
		version.length > 128 ||
		!semanticVersion.test(version)
	) {
		throw new Error(
			'The desktop package version must be a semantic version of at most 128 characters.'
		);
	}
	return version;
}

/** The exact HelperVersion.swift generated for `version`. */
export function nativeHostVersionSource(version) {
	return [
		'// Generated from apps/desktop/package.json by scripts/native-host-version.mjs. Do not edit.',
		'// To update it after changing the desktop version, run:',
		`//   ${syncCommand}`,
		'extension NativeHost {',
		'  /// The desktop version this host is built for. Electron trusts the host only when its',
		'  /// handshake reports the version recorded in the verified native manifest.',
		`  static let helperVersion = "${version}"`,
		'}',
		'',
	].join('\n');
}

/**
 * Describes how the committed host version source differs from the one
 * generated for the desktop package version, or returns undefined when it
 * does not.
 */
export function nativeHostVersionDrift(
	desktopDirectory = defaultDesktopDirectory
) {
	const version = desktopVersion(desktopDirectory);
	const source = readSource(desktopDirectory);
	if (source === nativeHostVersionSource(version)) return undefined;
	const declared =
		source === undefined ? undefined : declaredVersion.exec(source)?.[1];
	const detail =
		source === undefined
			? 'it is missing'
			: declared !== undefined && declared !== version
				? `it declares ${declared}`
				: 'its content differs from the generated source';
	return `${relative(desktopDirectory, sourceFile(desktopDirectory))} must declare the desktop package version ${version}; ${detail}. Run \`${syncCommand}\` and commit the result.`;
}

/** Regenerates the host version source, writing only when it changed. */
export function syncNativeHostVersionSource(
	desktopDirectory = defaultDesktopDirectory
) {
	const version = desktopVersion(desktopDirectory);
	const expected = nativeHostVersionSource(version);
	if (readSource(desktopDirectory) === expected) {
		return { version, changed: false };
	}
	writeFileSync(sourceFile(desktopDirectory), expected);
	return { version, changed: true };
}

function sourceFile(desktopDirectory) {
	return join(desktopDirectory, ...sourcePath);
}

function readSource(desktopDirectory) {
	try {
		return readFileSync(sourceFile(desktopDirectory), 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (process.argv.length > 2) {
		process.stderr.write('Usage: node native-host-version.mjs\n');
		process.exit(2);
	}
	const { version, changed } = syncNativeHostVersionSource();
	const file = relative(process.cwd(), sourceFile(defaultDesktopDirectory));
	process.stdout.write(
		changed
			? `Updated ${file} to ${version}. Commit it with the version change.\n`
			: `${file} already declares ${version}.\n`
	);
}
