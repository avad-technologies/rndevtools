import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
	isPathStrictlyWithin,
	isPathWithin,
	readBoundedText,
} from './bounded-read';
import { parseSupabaseVersion } from './cli-contract';
import type { SupabaseCliRunner } from './cli-runner';
import {
	buildSupabaseArgv,
	resolveSupabaseDialect,
	type SupabaseDialect,
	supabaseOperationBudget,
} from './dialect';

/**
 * Finds the Supabase CLI a worktree pins, the one its agents run through
 * `pnpm exec supabase`, and proves it is safe to execute from the desktop.
 *
 * The lookup mirrors the npm shim (apps/cli/src/shared/cli/bin.ts:24-40 at
 * v2.121.0): find `node_modules/supabase` from the app directory (and the
 * project root) up to the worktree root, then resolve the platform package
 * the way Node resolves it from the shim, and run its `bin/supabase`. There is
 * no fallback to PATH, Homebrew, npx or a bundled binary: an owner only serves
 * clients of its own release, and a binary outside the worktree is not the one
 * its agents run.
 *
 * The binary must resolve inside the worktree or the repository's main
 * checkout (worktrees may symlink node_modules there), be a regular file owned
 * by this user without group or world write, and match its package's version,
 * which `--version` must confirm. Probes are cached by realpath, size, mtime
 * and inode.
 */

const SHIM_PACKAGE = 'supabase';
const PLATFORM_PACKAGE = '@supabase/cli-darwin-arm64';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CACHED_PROBES = 64;
const SEMVER =
	/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

type SupabaseCliUnavailableReason =
	| 'unsupported-platform'
	| 'not-installed'
	| 'invalid-package'
	| 'platform-package-missing'
	| 'version-mismatch'
	| 'binary-missing'
	| 'binary-symlink'
	| 'binary-not-regular'
	| 'outside-worktree'
	| 'foreign-owner'
	| 'world-writable'
	| 'group-writable'
	| 'not-executable'
	| 'version-probe-failed'
	| 'binary-version-mismatch'
	| 'binary-changed';

const REASON_COPY: Readonly<
	Record<
		SupabaseCliUnavailableReason,
		Readonly<{ message: string; recovery: string }>
	>
> = {
	'unsupported-platform': {
		message: 'local Supabase stacks need an Apple-silicon Mac',
		recovery: 'Run local Supabase stacks on an Apple-silicon Mac.',
	},
	'not-installed': {
		message: 'CLI not installed in this worktree',
		recovery:
			'Install dependencies in this worktree. The repository should pin supabase as an exact devDependency.',
	},
	'invalid-package': {
		message: 'the supabase package in this worktree is unreadable or invalid',
		recovery: 'Reinstall dependencies in this worktree.',
	},
	'platform-package-missing': {
		message: 'supabase is installed without its macOS arm64 binary package',
		recovery:
			'Reinstall dependencies in this worktree with optional dependencies enabled.',
	},
	'version-mismatch': {
		message: 'version mismatch between supabase and its platform package',
		recovery: 'Reinstall dependencies in this worktree so both packages match.',
	},
	'binary-missing': {
		message: 'the CLI binary is missing from its platform package',
		recovery: 'Reinstall dependencies in this worktree.',
	},
	'binary-symlink': {
		message: 'binary is a symbolic link',
		recovery:
			'Reinstall dependencies so the CLI binary is a regular file inside the worktree.',
	},
	'binary-not-regular': {
		message: 'binary is not a regular file',
		recovery: 'Reinstall dependencies in this worktree.',
	},
	'outside-worktree': {
		message: 'CLI resolves outside this worktree and its main checkout',
		recovery:
			'Install supabase inside the repository; RN Devtools does not run CLIs from elsewhere.',
	},
	'foreign-owner': {
		message: 'binary is owned by another user',
		recovery: 'Reinstall dependencies in this worktree as yourself.',
	},
	'world-writable': {
		message: 'binary is world-writable',
		recovery:
			'Remove write access for others from the CLI binary, or reinstall.',
	},
	'group-writable': {
		message: 'binary is group-writable',
		recovery: 'Remove group write access from the CLI binary, or reinstall.',
	},
	'not-executable': {
		message: 'binary is not executable',
		recovery: 'Reinstall dependencies in this worktree.',
	},
	'version-probe-failed': {
		message: 'the CLI did not report its version',
		recovery: 'Reinstall dependencies in this worktree, then retry.',
	},
	'binary-version-mismatch': {
		message: 'the CLI binary reports a different version than its package',
		recovery: 'Reinstall dependencies in this worktree.',
	},
	'binary-changed': {
		message: 'the CLI binary changed while it was being verified',
		recovery: 'Wait for any install to finish, then retry.',
	},
};

/**
 * The minimal file metadata the resolver checks.
 */
export type SupabaseResolverFileStats = Readonly<{
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	uid: number;
	mode: number;
	size: number;
	mtimeMs: number;
	ino: number;
	dev: number;
}>;

export type SupabaseResolverFsPort = Readonly<{
	stat: (filePath: string) => Promise<SupabaseResolverFileStats>;
	lstat: (filePath: string) => Promise<SupabaseResolverFileStats>;
	realpath: (filePath: string) => Promise<string>;
	/** Reads a regular file (not through a final symlink), failing above maxBytes. */
	readTextFile: (filePath: string, maxBytes: number) => Promise<string>;
}>;

async function readBoundedTextFile(
	filePath: string,
	maxBytes: number
): Promise<string> {
	const read = await readBoundedText(filePath, maxBytes, { noFollow: true });
	if (read.status !== 'ok') throw new Error('unexpected file');
	return read.text;
}

const nodeResolverFs: SupabaseResolverFsPort = {
	stat: (filePath) => stat(filePath),
	lstat: (filePath) => lstat(filePath),
	realpath: (filePath) => realpath(filePath),
	readTextFile: readBoundedTextFile,
};

export type ResolvedSupabaseCli = Readonly<{
	/** Realpath of the platform binary; the only path the runner should spawn. */
	binaryPath: string;
	binaryDirectory: string;
	/** Realpath of the `supabase` shim package, when resolved from a worktree. */
	packageRoot: string | undefined;
	platformPackageRoot: string;
	version: string;
	dialect: SupabaseDialect;
	/** Identity of the file that was probed; a change means probe again. */
	fingerprint: Readonly<{
		dev: number;
		ino: number;
		size: number;
		mtimeMs: number;
	}>;
}>;

export type SupabaseCliResolution =
	| Readonly<{ ok: true; cli: ResolvedSupabaseCli }>
	| Readonly<{
			ok: false;
			reason: SupabaseCliUnavailableReason;
			/** Short UI text, for example "binary is group-writable". */
			message: string;
			recovery: string;
			/** The file the check stopped at, for display. */
			path: string | undefined;
	  }>;

export type SupabaseCliResolveInput = Readonly<{
	/** The app directory a lane runs. */
	appPath: string;
	/** The Supabase project root (holds supabase/config.toml), when it differs. */
	projectRoot?: string;
	/** The git worktree root; the lookup never climbs above it. */
	worktreeRoot: string;
	/** The repository's main checkout, for worktrees that symlink node_modules. */
	mainCheckoutRoot?: string;
	/** Manage newer patches of a verified minor (see SupabaseDialect.manageable). */
	allowUnverifiedPatch?: boolean;
}>;

export type SupabaseCliResolverOptions = Readonly<{
	runner: Pick<SupabaseCliRunner, 'run'>;
	/** Neutral directory the version probe runs in. */
	probeCwd: string;
	fs?: SupabaseResolverFsPort;
	uid?: number;
	platform?: NodeJS.Platform;
	arch?: string;
}>;

function unavailable(
	reason: SupabaseCliUnavailableReason,
	filePath?: string
): SupabaseCliResolution {
	const copy = REASON_COPY[reason];
	return Object.freeze({
		ok: false,
		reason,
		message: copy.message,
		recovery: copy.recovery,
		path: filePath,
	});
}

function absoluteInput(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		!path.isAbsolute(value) ||
		value.includes('\0')
	) {
		throw new TypeError(`${field} must be an absolute path.`);
	}
	return path.resolve(value);
}

/** `start` and each ancestor up to and including `root`. */
function lineage(start: string, root: string, field: string): string[] {
	if (!isPathWithin(root, start)) {
		throw new TypeError(`${field} must be inside the worktree root.`);
	}
	const directories: string[] = [];
	let current = start;
	for (;;) {
		directories.push(current);
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return directories;
}

/**
 * The directories Node searches for a bare specifier imported from `from`:
 * every ancestor's `node_modules`, skipping directories that are themselves
 * named `node_modules` (Module._nodeModulePaths).
 */
function nodeModuleLookupPaths(from: string): string[] {
	const lookups: string[] = [];
	let current = from;
	for (;;) {
		if (path.basename(current) !== 'node_modules') {
			lookups.push(path.join(current, 'node_modules'));
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return lookups;
}

function fingerprintOf(stats: SupabaseResolverFileStats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

export class SupabaseCliResolver {
	readonly #runner: Pick<SupabaseCliRunner, 'run'>;
	readonly #probeCwd: string;
	readonly #fs: SupabaseResolverFsPort;
	readonly #uid: number;
	readonly #platform: NodeJS.Platform;
	readonly #arch: string;
	readonly #probes = new Map<
		string,
		Readonly<{ fingerprint: string; version: string }>
	>();

	constructor(options: SupabaseCliResolverOptions) {
		this.#runner = options.runner;
		this.#probeCwd = options.probeCwd;
		this.#fs = options.fs ?? nodeResolverFs;
		this.#uid = options.uid ?? process.getuid?.() ?? -1;
		this.#platform = options.platform ?? process.platform;
		this.#arch = options.arch ?? process.arch;
	}

	/** Resolves and validates the CLI a worktree's agents would run. */
	async resolve(
		input: SupabaseCliResolveInput
	): Promise<SupabaseCliResolution> {
		if (!this.#supportedPlatform()) return unavailable('unsupported-platform');
		const worktreeRoot = absoluteInput(input.worktreeRoot, 'worktreeRoot');
		const appPath = absoluteInput(input.appPath, 'appPath');
		const searchDirectories = lineage(appPath, worktreeRoot, 'appPath');
		if (input.projectRoot !== undefined) {
			const projectRoot = absoluteInput(input.projectRoot, 'projectRoot');
			for (const directory of lineage(
				projectRoot,
				worktreeRoot,
				'projectRoot'
			)) {
				if (!searchDirectories.includes(directory))
					searchDirectories.push(directory);
			}
		}
		const allowedRoots = await this.#allowedRoots([
			worktreeRoot,
			...(input.mainCheckoutRoot === undefined
				? []
				: [absoluteInput(input.mainCheckoutRoot, 'mainCheckoutRoot')]),
		]);
		if (allowedRoots.length === 0)
			return unavailable('not-installed', worktreeRoot);

		let shimManifest: string | undefined;
		for (const directory of searchDirectories) {
			const candidate = path.join(
				directory,
				'node_modules',
				SHIM_PACKAGE,
				'package.json'
			);
			if (await this.#isFile(candidate)) {
				shimManifest = candidate;
				break;
			}
		}
		if (shimManifest === undefined)
			return unavailable('not-installed', worktreeRoot);
		const shimRoot = await this.#realpath(path.dirname(shimManifest));
		if (shimRoot === undefined)
			return unavailable('invalid-package', shimManifest);
		if (!allowedRoots.some((root) => isPathStrictlyWithin(root, shimRoot))) {
			return unavailable('outside-worktree', shimRoot);
		}
		const shimVersion = await this.#packageVersion(shimRoot, SHIM_PACKAGE);
		if (shimVersion === undefined) {
			return unavailable(
				'invalid-package',
				path.join(shimRoot, 'package.json')
			);
		}

		// The shim resolves its platform package from its own location.
		let platformManifest: string | undefined;
		for (const lookup of nodeModuleLookupPaths(path.join(shimRoot, 'dist'))) {
			const candidate = path.join(lookup, PLATFORM_PACKAGE, 'package.json');
			if (await this.#isFile(candidate)) {
				platformManifest = candidate;
				break;
			}
		}
		if (platformManifest === undefined) {
			return unavailable('platform-package-missing', shimRoot);
		}
		const platformRoot = await this.#realpath(path.dirname(platformManifest));
		if (platformRoot === undefined) {
			return unavailable('platform-package-missing', platformManifest);
		}
		if (
			!allowedRoots.some((root) => isPathStrictlyWithin(root, platformRoot))
		) {
			return unavailable('outside-worktree', platformRoot);
		}
		const platformVersion = await this.#packageVersion(
			platformRoot,
			PLATFORM_PACKAGE
		);
		if (platformVersion === undefined) {
			return unavailable(
				'invalid-package',
				path.join(platformRoot, 'package.json')
			);
		}
		if (platformVersion !== shimVersion) {
			return unavailable('version-mismatch', platformRoot);
		}
		return this.#validateBinaryFile({
			candidate: path.join(platformRoot, 'bin', 'supabase'),
			allowedRoots,
			packageVersion: platformVersion,
			packageRoot: shimRoot,
			platformPackageRoot: platformRoot,
			allowUnverifiedPatch: input.allowUnverifiedPatch === true,
		});
	}

	/**
	 * Validates a binary path that came from elsewhere, such as a running
	 * owner's argv[0], which any process of this user can set. It is executed
	 * only when it is a platform package's binary inside an allowed root and
	 * passes every check `resolve` applies.
	 */
	async validateBinary(
		input: Readonly<{
			binaryPath: string;
			allowedRoots: readonly string[];
			allowUnverifiedPatch?: boolean;
		}>
	): Promise<SupabaseCliResolution> {
		if (!this.#supportedPlatform()) return unavailable('unsupported-platform');
		const candidate = absoluteInput(input.binaryPath, 'binaryPath');
		const allowedRoots = await this.#allowedRoots(
			input.allowedRoots.map((root) => absoluteInput(root, 'allowedRoots'))
		);
		const platformRoot = await this.#realpath(
			path.dirname(path.dirname(candidate))
		);
		if (platformRoot === undefined)
			return unavailable('binary-missing', candidate);
		const platformVersion = await this.#packageVersion(
			platformRoot,
			PLATFORM_PACKAGE
		);
		if (
			platformVersion === undefined ||
			path.basename(candidate) !== 'supabase' ||
			path.basename(path.dirname(candidate)) !== 'bin'
		) {
			return unavailable('invalid-package', candidate);
		}
		const resolution = await this.#validateBinaryFile({
			candidate,
			allowedRoots,
			packageVersion: platformVersion,
			packageRoot: undefined,
			platformPackageRoot: platformRoot,
			allowUnverifiedPatch: input.allowUnverifiedPatch === true,
		});
		if (
			resolution.ok &&
			resolution.cli.binaryPath !== path.join(platformRoot, 'bin', 'supabase')
		) {
			return unavailable('invalid-package', candidate);
		}
		return resolution;
	}

	#supportedPlatform(): boolean {
		return this.#platform === 'darwin' && this.#arch === 'arm64';
	}

	async #allowedRoots(roots: readonly string[]): Promise<string[]> {
		const resolved: string[] = [];
		for (const root of roots) {
			const real = await this.#realpath(root);
			if (real !== undefined && !resolved.includes(real)) resolved.push(real);
		}
		return resolved;
	}

	async #realpath(filePath: string): Promise<string | undefined> {
		try {
			return await this.#fs.realpath(filePath);
		} catch {
			return undefined;
		}
	}

	async #isFile(filePath: string): Promise<boolean> {
		try {
			return (await this.#fs.stat(filePath)).isFile();
		} catch {
			return false;
		}
	}

	async #packageVersion(
		packageRoot: string,
		expectedName: string
	): Promise<string | undefined> {
		try {
			const manifest = JSON.parse(
				await this.#fs.readTextFile(
					path.join(packageRoot, 'package.json'),
					MAX_MANIFEST_BYTES
				)
			) as unknown;
			if (typeof manifest !== 'object' || manifest === null) return undefined;
			const { name, version } = manifest as {
				name?: unknown;
				version?: unknown;
			};
			return name === expectedName &&
				typeof version === 'string' &&
				SEMVER.test(version)
				? version
				: undefined;
		} catch {
			return undefined;
		}
	}

	async #validateBinaryFile(
		input: Readonly<{
			candidate: string;
			allowedRoots: readonly string[];
			packageVersion: string;
			packageRoot: string | undefined;
			platformPackageRoot: string;
			allowUnverifiedPatch: boolean;
		}>
	): Promise<SupabaseCliResolution> {
		let before: SupabaseResolverFileStats;
		try {
			before = await this.#fs.lstat(input.candidate);
		} catch {
			return unavailable('binary-missing', input.candidate);
		}
		if (before.isSymbolicLink())
			return unavailable('binary-symlink', input.candidate);
		if (!before.isFile())
			return unavailable('binary-not-regular', input.candidate);
		const binaryPath = await this.#realpath(input.candidate);
		if (binaryPath === undefined)
			return unavailable('binary-missing', input.candidate);
		if (
			!input.allowedRoots.some((root) => isPathStrictlyWithin(root, binaryPath))
		) {
			return unavailable('outside-worktree', binaryPath);
		}
		if (before.uid !== this.#uid)
			return unavailable('foreign-owner', binaryPath);
		if ((before.mode & 0o002) !== 0)
			return unavailable('world-writable', binaryPath);
		if ((before.mode & 0o020) !== 0)
			return unavailable('group-writable', binaryPath);
		if ((before.mode & 0o100) === 0)
			return unavailable('not-executable', binaryPath);
		const version = await this.#probeVersion(binaryPath, before);
		if (version === undefined)
			return unavailable('version-probe-failed', binaryPath);
		if (version !== input.packageVersion) {
			return unavailable('binary-version-mismatch', binaryPath);
		}
		let after: SupabaseResolverFileStats;
		try {
			after = await this.#fs.lstat(binaryPath);
		} catch {
			return unavailable('binary-changed', binaryPath);
		}
		if (fingerprintOf(after) !== fingerprintOf(before)) {
			return unavailable('binary-changed', binaryPath);
		}
		return Object.freeze({
			ok: true,
			cli: Object.freeze({
				binaryPath,
				binaryDirectory: path.dirname(binaryPath),
				packageRoot: input.packageRoot,
				platformPackageRoot: input.platformPackageRoot,
				version,
				dialect: resolveSupabaseDialect(version, {
					allowUnverifiedPatch: input.allowUnverifiedPatch,
				}),
				fingerprint: Object.freeze({
					dev: before.dev,
					ino: before.ino,
					size: before.size,
					mtimeMs: before.mtimeMs,
				}),
			}),
		});
	}

	async #probeVersion(
		binaryPath: string,
		stats: SupabaseResolverFileStats
	): Promise<string | undefined> {
		const fingerprint = fingerprintOf(stats);
		const cached = this.#probes.get(binaryPath);
		if (cached?.fingerprint === fingerprint) return cached.version;
		const operation = { kind: 'version' } as const;
		const budget = supabaseOperationBudget(operation);
		let version: string | undefined;
		try {
			const result = await this.#runner.run({
				binaryPath,
				argv: buildSupabaseArgv(null, operation),
				readOnly: true,
				cwd: this.#probeCwd,
				timeoutMs: budget.timeoutMs,
				interruptGraceMs: budget.interruptGraceMs,
				...(budget.forceKillAfterMs === undefined
					? {}
					: { forceKillAfterMs: budget.forceKillAfterMs }),
			});
			const stdout = result.takeStdout();
			version = result.succeeded ? parseSupabaseVersion(stdout) : undefined;
		} catch {
			version = undefined;
		}
		// Failures are not cached, so a transient probe failure is retried.
		if (version !== undefined) {
			this.#probes.delete(binaryPath);
			this.#probes.set(binaryPath, { fingerprint, version });
			if (this.#probes.size > MAX_CACHED_PROBES) {
				const oldest = this.#probes.keys().next().value;
				if (oldest !== undefined) this.#probes.delete(oldest);
			}
		}
		return version;
	}
}
