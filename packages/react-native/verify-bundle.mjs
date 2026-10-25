#!/usr/bin/env node
/**
 * Asserts that a production bundle contains no devtools code.
 *
 * `withDevtoolsPruning` cuts the module graph, but a new import added months
 * later can quietly reconnect it. Running this over an exported bundle turns
 * that regression into a build failure instead of a shipped diagnostic panel.
 *
 * Opt-in checks also catch a release bundle that was built against a
 * developer's machine: `--forbid-loopback-urls` fails on literal loopback
 * URLs, and `--preset supabase-local` fails on Supabase secret keys,
 * service-role JWTs, and the local stack's default JWTs.
 *
 * Usage:
 *   npx rndevtools-verify-bundle <bundle-directory-or-file>
 *     [--marker "Extra String"] [--forbid-loopback-urls]
 *     [--preset supabase-local]
 */
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strings that only appear when devtools code is present. These are panel
 * copy and internal identifiers, not import specifiers, because a production
 * bundle drops specifiers and module paths but keeps string literals intact.
 */
export const DEFAULT_MARKERS = Object.freeze([
	'@rndevtools/core',
	'packages/core/src',
	'DebugCameraFixtureError',
	'rndevtools-debug-camera-',
	'rndevtools-restore-points',
	'rndevtools-scenarios',
	'Registered application storage adapters',

	// Each marker below sits on the runtime path of an entry point that the
	// ones above cannot see. `src/verify-bundle.test.ts` pins each to its
	// source and runs that source through Expo's production transform.

	// `@rndevtools/react-native/desktop`
	'Desktop diagnostics client started.',
	// The scope of the errors these two entry points throw, a string literal in
	// their own code rather than the import specifier it matches.
	'@rndevtools/react-native/authorization',
	'@rndevtools/react-native/adapters/storage',
	// `@rndevtools/core/desktop-protocol`
	'scenarios.discardRecovery',
	// `@rndevtools/core/plugins/images`
	'Clear image diagnostics',
	// `@rndevtools/core/plugins/image-overlay`, which the react-native image
	// overlay builds its controller on.
	'Reference image dimensions exceed the safe decode budget.',
	// `@rndevtools/core/redact`, which `/serialize` loads too: the label for a
	// property whose getter the sanitizer does not run.
	'[Accessor omitted]',
	// `@rndevtools/core/plugins/network-presentation`
	'[URL omitted: export limit]',
]);

const USAGE =
	'Usage: rndevtools-verify-bundle <bundle-directory-or-file> [--marker "Extra String"] [--forbid-loopback-urls] [--preset supabase-local]';

// Exported web and Hermes output (`.js`, `.hbc`), and the embedded bundles
// that Xcode, Gradle and `expo export:embed` write (`main.jsbundle`,
// `index.android.bundle`).
const BUNDLE_FILE = /\.(?:[cm]?js|hbc|bundle|jsbundle)$/i;

// Literal loopback hosts, including `*.localhost` (RFC 6761) and JSON-escaped
// slashes. Hostnames that merely start with `localhost.` are not loopback.
const LOOPBACK_URL =
	/\b(?:https?|wss?):(?:\/\/|\\\/\\\/)(?:(?:[a-z\d-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?![\w.-])/gi;

// A key body follows the prefix. supabase-js itself ships the bare prefix in
// its key-type check, so the prefix alone is not a finding.
const SUPABASE_SECRET_KEY = /sb_secret_[A-Za-z\d_-]{20,}/;
// Each match consumes its whole run of token characters, so scanning stays
// linear however a bundle repeats `eyJ`.
const JWT_CANDIDATE = /eyJ[A-Za-z\d_-]*(?:\.[A-Za-z\d_-]*){0,2}/g;
// The issuer of the default anon and service_role keys that every local
// Supabase stack shares (supabase/cli apps/cli/src/command-internal/go-jwt.ts).
const SUPABASE_LOCAL_ISSUER = 'supabase-demo';

function jwtPayload(candidate) {
	const [header, payload, signature] = candidate.split('.');
	if (!header || !payload || signature === undefined) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
		return claims !== null && typeof claims === 'object' ? claims : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Findings name what was found, never the value, so a failing CI log does not
 * leak the key it caught.
 */
function supabaseLocalFindings(contents) {
	const findings = [];
	if (SUPABASE_SECRET_KEY.test(contents)) {
		findings.push('Supabase secret key (sb_secret_…)');
	}
	for (const [candidate] of contents.matchAll(JWT_CANDIDATE)) {
		const claims = jwtPayload(candidate);
		if (!claims) continue;
		const role =
			typeof claims.role === 'string' && /^[a-z_]{1,32}$/.test(claims.role)
				? claims.role
				: undefined;
		if (claims.role === 'service_role') {
			findings.push('JWT with role service_role');
		}
		if (claims.iss === SUPABASE_LOCAL_ISSUER) {
			findings.push(
				`local Supabase JWT (iss ${SUPABASE_LOCAL_ISSUER}${role ? `, role ${role}` : ''})`,
			);
		}
	}
	return findings;
}

const LOOPBACK_CHECK = Object.freeze({
	title: 'Production bundle contains loopback URLs',
	label: 'loopback URLs',
	find: (contents) =>
		Array.from(contents.matchAll(LOOPBACK_URL), ([url]) => url),
});

const PRESET_CHECKS = new Map([
	[
		'supabase-local',
		Object.freeze({
			title: 'Production bundle contains Supabase secrets or local keys',
			label: 'preset supabase-local',
			find: supabaseLocalFindings,
		}),
	],
]);

function markerCheck(markers) {
	return {
		title: 'Production bundle contains devtools code',
		find: (contents) => markers.filter((marker) => contents.includes(marker)),
	};
}

/**
 * @param {{ forbidLoopbackUrls?: boolean, presets?: readonly string[] }} options
 */
function optionalChecks(options) {
	const checks = options.forbidLoopbackUrls ? [LOOPBACK_CHECK] : [];
	for (const preset of new Set(options.presets ?? [])) {
		const check = PRESET_CHECKS.get(preset);
		if (!check) {
			throw new Error(
				`Unknown preset: ${preset}. Known presets: ${[...PRESET_CHECKS.keys()].join(', ')}`,
			);
		}
		checks.push(check);
	}
	return checks;
}

async function bundleFilesIn(directory) {
	const files = [];
	// Sorted, so a failing report lists files in the same order on every run.
	for (const entry of (await readdir(directory)).sort()) {
		const absolute = path.join(directory, entry);
		const details = await stat(absolute);
		if (details.isDirectory()) files.push(...(await bundleFilesIn(absolute)));
		else if (BUNDLE_FILE.test(entry)) files.push(absolute);
	}
	return files;
}

async function bundleFiles(root) {
	// A file named directly is checked whatever its extension.
	const files = (await stat(root)).isDirectory()
		? await bundleFilesIn(root)
		: [root];
	// An empty or mistyped output directory must not pass as a clean bundle.
	if (files.length === 0) {
		throw new Error(
			`No bundle files (.js, .hbc, .bundle, .jsbundle, .mjs, .cjs) found in ${root}.`,
		);
	}
	return files;
}

/**
 * @param {string} root Exported bundle directory, or a single bundle file.
 * @param {readonly string[]} [markers] Strings that must not appear, checked
 *   in addition to `DEFAULT_MARKERS`.
 * @param {{ forbidLoopbackUrls?: boolean, presets?: readonly string[] }} [options]
 *   Opt-in checks: literal loopback URLs, and named presets such as
 *   `supabase-local`.
 * @returns {Promise<string[]>} The files that were checked.
 * @throws when there is no bundle file to check, or when any check finds
 *   something, naming every file and finding.
 */
export async function verifyPrunedBundle(root, markers = [], options = {}) {
	const results = [
		markerCheck([...new Set([...DEFAULT_MARKERS, ...markers])]),
		...optionalChecks(options),
	].map((check) => ({ check, lines: [] }));
	const files = await bundleFiles(root);
	for (const file of files) {
		const contents = await readFile(file, 'utf8');
		for (const { check, lines } of results) {
			for (const finding of new Set(check.find(contents))) {
				lines.push(`${file}: ${finding}`);
			}
		}
	}
	const sections = results
		.filter(({ lines }) => lines.length)
		.map(({ check, lines }) => `${check.title}:\n${lines.join('\n')}`);
	if (sections.length) throw new Error(sections.join('\n'));
	return files;
}

function parseArguments(argv) {
	const parsed = {
		root: undefined,
		markers: [],
		forbidLoopbackUrls: false,
		presets: [],
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--marker' || argument === '--preset') {
			const value = argv[index + 1];
			// An empty marker would match every file.
			if (!value) throw new Error(`${argument} needs a value.\n${USAGE}`);
			(argument === '--marker' ? parsed.markers : parsed.presets).push(value);
			index += 1;
		} else if (argument === '--forbid-loopback-urls') {
			parsed.forbidLoopbackUrls = true;
		} else if (argument === '--help' || argument === '-h') {
			parsed.help = true;
		} else if (argument.startsWith('-') || parsed.root !== undefined) {
			// A misspelled opt-in flag must fail rather than silently skip its check.
			throw new Error(`Unexpected argument: ${argument}\n${USAGE}`);
		} else {
			parsed.root = argument;
		}
	}
	return parsed;
}

function isInvokedAsCli() {
	if (!process.argv[1]) return false;
	// Package managers expose this file through a `node_modules/.bin` symlink,
	// and `--preserve-symlinks-main` keeps that symlink in `import.meta.url`.
	// Compare real paths on both sides, or the guard never fires and the check
	// silently passes.
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(process.argv[1])
		);
	} catch {
		return false;
	}
}

if (isInvokedAsCli()) {
	const { root, markers, help, ...options } = parseArguments(
		process.argv.slice(2),
	);
	if (help) {
		console.log(USAGE);
	} else {
		if (!root) throw new Error(USAGE);
		const files = await verifyPrunedBundle(
			path.resolve(root),
			markers,
			options,
		);
		const checked = `${root} (${files.length} ${files.length === 1 ? 'file' : 'files'})`;
		const extras = optionalChecks(options).map((check) => check.label);
		console.log(
			extras.length
				? `No devtools markers found in ${checked}; also checked: ${extras.join(', ')}`
				: `No devtools markers found in ${checked}`,
		);
	}
}
