const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Expo build cache provider that shares native builds across git worktrees on
 * one machine.
 *
 * Lanes run several worktrees of the same app side by side, each on its own
 * Simulator. Every worktree would otherwise run its own `expo run:ios`, and
 * for the same native fingerprint that is the same twenty-minute build, N
 * times, in parallel. This provider stores the finished binary once under the
 * user's cache directory, keyed by Expo's fingerprint hash, and hands it back
 * to any other worktree whose fingerprint matches. A JavaScript-only change
 * leaves the fingerprint untouched, so a new branch of the same native shell
 * is installed in seconds instead of built.
 *
 * Expo computes the fingerprint (`@expo/fingerprint`) and calls this plugin
 * from `expo run:ios` / `expo run:android` for Simulator and emulator builds:
 *
 *   resolveBuildCache  → return a cached `.app` / `.apk` path, or null to build
 *   uploadBuildCache   → copy the fresh binary into the cache
 *
 * Concurrency: the first worktree to miss claims a lock file for the entry and
 * builds; later worktrees with the same fingerprint wait for it rather than
 * building a duplicate. The claim appears with its owner already written, and
 * a lock whose owner process has died is reclaimed by one waiter only. Once an
 * entry holds a binary it is never replaced, so a duplicate upload cannot pull
 * an app out from under a worktree that is installing it.
 *
 * Wire it up in `app.config.js` (plugins must be loaded by Node, so a static
 * `app.json` cannot reference one):
 *
 *   module.exports = ({ config }) => ({
 *     ...config,
 *     experiments: {
 *       ...config.experiments,
 *       buildCacheProvider: {
 *         plugin: '@rndevtools/react-native/build-cache',
 *         // options: { cacheDirectory: '~/Library/Caches/my-app/native' },
 *       },
 *     },
 *   });
 *
 * Nothing here is app-specific: the cache root is a neutral default under
 * `~/Library/Caches/rndevtools` (or `$XDG_CACHE_HOME`), overridable per
 * project, and entries are namespaced by platform, configuration, and the
 * fingerprint hash Expo already computed from the project's own inputs.
 */

const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1_000;
const LOCK_POLL_INTERVAL_MS = 1_000;
/**
 * How long a lock whose owner cannot be read still counts as held. This
 * provider writes a claim in one step, but on a filesystem without hard links
 * (or from an older version) the file exists for a moment before its owner.
 */
const UNREADABLE_LOCK_GRACE_MS = 10_000;
const LOCK_FILE = 'build.lock';
const MAX_LOCK_GENERATIONS = 128;
const LOCK_RECORD =
	/^build\.lock(?:\.[a-f0-9]{64}\.(?:next|released)|\.released)?$/;
const ARTIFACT_FILE = 'artifact.json';
// What `link` fails with where a filesystem has no hard links.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

function defaultCacheRoot(env = process.env, homedir = os.homedir()) {
	if (env.RNDEVTOOLS_BUILD_CACHE_DIR) return env.RNDEVTOOLS_BUILD_CACHE_DIR;
	const base =
		process.platform === 'darwin'
			? path.join(homedir, 'Library', 'Caches')
			: env.XDG_CACHE_HOME || path.join(homedir, '.cache');
	return path.join(base, 'rndevtools', 'native');
}

function expandHome(value, homedir = os.homedir()) {
	return value.replace(/^~(?=$|\/)/, homedir);
}

/** A single path segment that cannot escape the entry directory. */
function safeSegment(value, fallback = 'default') {
	const text = String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-');
	const trimmed = text.replace(/^[.-]+/, '').slice(0, 96);
	return trimmed || fallback;
}

function configurationOf(runOptions = {}) {
	// iOS uses `configuration` (Debug/Release); Android uses `variant` (debug).
	return runOptions.configuration || runOptions.variant || 'Debug';
}

let xcodeIdentityCache;
/**
 * `xcodebuild -version` output ("Xcode 26.6\nBuild version 17F…"), read once
 * per process. Expo's fingerprint does not include the toolchain, so without
 * this an `.app` built by an older Xcode would still be served after an
 * upgrade and fail to install or run against the new runtime.
 */
function xcodeIdentity() {
	if (xcodeIdentityCache !== undefined) return xcodeIdentityCache;
	try {
		xcodeIdentityCache = execFileSync('xcodebuild', ['-version'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 15_000,
		}).trim();
	} catch {
		xcodeIdentityCache = 'xcode-unknown';
	}
	return xcodeIdentityCache;
}

/**
 * Short, stable id for the host toolchain a binary was produced with. iOS
 * builds depend on the Xcode version and the CPU architecture; Android APKs
 * only on the architecture of the emulator image being targeted, which Expo
 * folds into the build itself, so arch alone keeps distinct hosts apart.
 */
function toolchainSegment(platform, internals = {}) {
	const arch = internals.arch || process.arch;
	const parts =
		platform === 'ios'
			? [arch, (internals.xcodeIdentity || xcodeIdentity)()]
			: [arch];
	const digest = crypto
		.createHash('sha256')
		.update(parts.join('\n'))
		.digest('hex')
		.slice(0, 12);
	return `${safeSegment(arch)}-${digest}`;
}

/**
 * Directory for one cache entry. Expo's fingerprint already covers native
 * inputs; the platform, configuration, and toolchain are split out so a
 * Release build, or a build from another Xcode, is never handed to a Debug
 * run of the same fingerprint.
 */
function entryDirectory(context, options = {}, internals = {}) {
	if (!context || typeof context.fingerprintHash !== 'string') {
		throw new TypeError('build-cache: a fingerprintHash is required.');
	}
	const root = options.cacheDirectory
		? path.resolve(expandHome(options.cacheDirectory))
		: defaultCacheRoot();
	return path.join(
		root,
		'v2',
		safeSegment(context.platform, 'unknown-platform'),
		safeSegment(configurationOf(context.runOptions)),
		toolchainSegment(context.platform, internals),
		safeSegment(context.fingerprintHash, 'no-fingerprint'),
	);
}

function expectedArtifactExtension(platform) {
	return platform === 'android' ? '.apk' : '.app';
}

/** An `.app` is a bundle directory and an `.apk` a file. */
function hasArtifactShape(artifactPath, stat) {
	if (artifactPath.endsWith('.app')) return stat.isDirectory();
	if (artifactPath.endsWith('.apk')) return stat.isFile();
	return true;
}

function readArtifact(entry) {
	try {
		const metadata = JSON.parse(
			fs.readFileSync(path.join(entry, ARTIFACT_FILE), 'utf8'),
		);
		if (typeof metadata.artifact !== 'string') return null;
		// The recorded name is a bare file name; refuse anything else.
		if (metadata.artifact !== path.basename(metadata.artifact)) return null;
		const artifactPath = path.join(entry, metadata.artifact);
		return hasArtifactShape(artifactPath, fs.statSync(artifactPath))
			? artifactPath
			: null;
	} catch {
		return null;
	}
}

function uniqueSuffix() {
	return `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Creates `target` holding `contents` unless something is already there,
 * with no moment where it exists but is empty: the contents go to a private
 * file that is hard-linked into place, and linking fails if the target exists.
 */
function createExclusive(target, contents) {
	const temporary = `${target}.${uniqueSuffix()}.tmp`;
	fs.writeFileSync(temporary, contents, { flag: 'wx' });
	try {
		fs.linkSync(temporary, target);
		return true;
	} catch (error) {
		if (error && error.code === 'EEXIST') return false;
		if (!(error && NO_HARD_LINKS.has(error.code))) throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	// No hard links here: create in place. UNREADABLE_LOCK_GRACE_MS covers the
	// moment before the contents land.
	try {
		fs.writeFileSync(target, contents, { flag: 'wx' });
		return true;
	} catch (error) {
		if (error && error.code === 'EEXIST') return false;
		throw error;
	}
}

/** Replaces `file` in one step, so a reader never sees it half-written. */
function writeFileAtomically(file, contents) {
	const temporary = `${file}.${uniqueSuffix()}.tmp`;
	try {
		fs.writeFileSync(temporary, contents);
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/**
 * Renames a finished copy into place. A complete copy that is already there,
 * from another upload of this fingerprint, is kept: a worktree may be
 * installing from it. Only something readers would reject is cleared.
 */
function moveIntoPlace(staging, finalPath) {
	const existing = fs.statSync(finalPath, { throwIfNoEntry: false });
	if (existing && !hasArtifactShape(finalPath, existing)) {
		fs.rmSync(finalPath, { recursive: true, force: true });
	}
	try {
		fs.renameSync(staging, finalPath);
	} catch (error) {
		if (!(error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))) {
			throw error;
		}
	}
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return error && error.code === 'EPERM';
	}
}

/** The PID a lock names, or 0 when its contents cannot be read as one. */
function lockOwner(text) {
	try {
		const pid = Number(JSON.parse(text).pid);
		return Number.isInteger(pid) && pid > 0 ? pid : 0;
	} catch {
		return 0;
	}
}

/** The lock's text, owner and write time, or null when there is no lock. */
function readLock(lockPath) {
	let handle;
	try {
		handle = fs.openSync(lockPath, 'r');
	} catch (error) {
		if (error && error.code === 'ENOENT') return null;
		throw error;
	}
	try {
		const text = fs.readFileSync(handle, 'utf8');
		return {
			text,
			owner: lockOwner(text),
			writtenAt: fs.fstatSync(handle).mtimeMs,
		};
	} finally {
		fs.closeSync(handle);
	}
}

function isAbandoned(lock) {
	if (lock.owner) return !processAlive(lock.owner);
	// No readable owner yet: a claim mid-write, until it is too old to be one.
	// File times are wall-clock, so this uses Date.now(), not the injectable
	// clock.
	return Date.now() - lock.writtenAt > UNREADABLE_LOCK_GRACE_MS;
}

/** An immutable claim has one successor, so stale readers cannot move a live lock. */
function claimRecord(entry, text, kind) {
	const digest = crypto.createHash('sha256').update(text).digest('hex');
	return path.join(entry, `${LOCK_FILE}.${digest}.${kind}`);
}

function tryClaimLock(lockPath) {
	const text = `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: uniqueSuffix() })}\n`;
	return createExclusive(lockPath, text) ? text : null;
}

function clearPublishedClaims(entry) {
	for (const name of fs.readdirSync(entry)) {
		if (LOCK_RECORD.test(name))
			fs.rmSync(path.join(entry, name), { force: true });
	}
}

function throwWaitTimeout(lock, lockPath, waitTimeoutMs) {
	throw new Error(
		`build-cache: timed out after ${Math.round(waitTimeoutMs / 1_000)}s waiting for ${lock.owner ? `PID ${lock.owner}` : 'another process'} to finish building this fingerprint (${lockPath}).`,
	);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the cached artifact path, or `null` after claiming the right to
 * build it. Waits while another process holds the claim, so parallel lanes
 * with the same fingerprint produce one build.
 */
async function claimOrWait(entry, { waitTimeoutMs, now, sleep: wait, claims }) {
	fs.mkdirSync(entry, { recursive: true });
	const initialLock = path.join(entry, LOCK_FILE);
	let lockPath = initialLock;
	const visited = new Set([lockPath]);
	const deadline = now() + waitTimeoutMs;
	for (;;) {
		const hit = readArtifact(entry);
		if (hit) return hit;
		const text = tryClaimLock(lockPath);
		if (text) {
			// An uploader may have published between our first read and the claim.
			const published = readArtifact(entry);
			if (published) {
				clearPublishedClaims(entry);
				return published;
			}
			claims.set(entry, { path: lockPath, text });
			return null;
		}
		const lock = readLock(lockPath);
		// Released since the claim attempt: try again straight away.
		if (!lock) continue;
		if (
			isAbandoned(lock) ||
			fs.existsSync(claimRecord(entry, lock.text, 'released'))
		) {
			const next = claimRecord(entry, lock.text, 'next');
			if (visited.has(next) || visited.size >= MAX_LOCK_GENERATIONS) {
				throw new Error(
					'build-cache: corrupt or excessive cache lock generations. Clear this cache entry and retry.',
				);
			}
			if (visited.size > 1 && now() >= deadline) {
				throwWaitTimeout(lock, lockPath, waitTimeoutMs);
			}
			visited.add(next);
			lockPath = next;
			continue;
		}
		if (now() >= deadline) {
			throwWaitTimeout(lock, lockPath, waitTimeoutMs);
		}
		await wait(LOCK_POLL_INTERVAL_MS);
		lockPath = initialLock;
		visited.clear();
		visited.add(lockPath);
	}
}

function createBuildCacheProvider(internals = {}) {
	const now = internals.now || Date.now;
	const wait = internals.sleep || sleep;
	const claims = new Map();

	async function resolveBuildCache(context, options = {}) {
		const entry = entryDirectory(context, options, internals);
		const waitTimeoutMs =
			Number.isFinite(options.waitTimeoutMs) && options.waitTimeoutMs >= 0
				? options.waitTimeoutMs
				: DEFAULT_WAIT_TIMEOUT_MS;
		return claimOrWait(entry, { waitTimeoutMs, now, sleep: wait, claims });
	}

	async function uploadBuildCache(context, options = {}) {
		const entry = entryDirectory(context, options, internals);
		const claim = claims.get(entry);
		try {
			const buildPath = path.resolve(String(context.buildPath || ''));
			const name = path.basename(buildPath);
			const extension = expectedArtifactExtension(context.platform);
			let stat;
			try {
				stat = fs.statSync(buildPath);
			} catch {
				throw new Error(
					`build-cache: build output ${buildPath} does not exist.`,
				);
			}
			const shapeOk =
				name.endsWith(extension) && hasArtifactShape(buildPath, stat);
			if (!shapeOk) {
				throw new Error(
					`build-cache: expected a ${extension} ${extension === '.app' ? 'bundle' : 'file'} for ${context.platform}, received ${buildPath}.`,
				);
			}
			fs.mkdirSync(entry, { recursive: true });
			// An entry is written once. A second build of this fingerprint, from a
			// worktree that raced the lock, leaves the published copy alone: another
			// worktree may be installing from it.
			const published = readArtifact(entry);
			if (published) return published;
			// Copy to a private sibling and rename so a reader never sees a
			// half-written artifact: `artifact.json` is only written once the copy
			// is complete.
			const staging = path.join(entry, `${name}.uploading-${uniqueSuffix()}`);
			const finalPath = path.join(entry, name);
			try {
				fs.cpSync(buildPath, staging, { recursive: true });
				moveIntoPlace(staging, finalPath);
				writeFileAtomically(
					path.join(entry, ARTIFACT_FILE),
					`${JSON.stringify(
						{
							artifact: name,
							platform: context.platform,
							configuration: configurationOf(context.runOptions),
							toolchain: toolchainSegment(context.platform, internals),
							fingerprintHash: context.fingerprintHash,
							createdAt: new Date(now()).toISOString(),
							sourceProject: context.projectRoot,
						},
						null,
						'\t',
					)}\n`,
				);
			} finally {
				fs.rmSync(staging, { recursive: true, force: true });
			}
			return finalPath;
		} finally {
			if (readArtifact(entry)) {
				clearPublishedClaims(entry);
			} else if (claim && readLock(claim.path)?.text === claim.text) {
				// Failed claims remain immutable: reusing their path would let a
				// delayed reader create a second branch of the ownership chain.
				createExclusive(
					claimRecord(entry, claim.text, 'released'),
					'released\n',
				);
			}
			if (claims.get(entry) === claim) claims.delete(entry);
		}
	}

	return { resolveBuildCache, uploadBuildCache };
}

const provider = createBuildCacheProvider();

module.exports = {
	resolveBuildCache: provider.resolveBuildCache,
	uploadBuildCache: provider.uploadBuildCache,
	/** For tests and tooling; not part of the Expo plugin contract. */
	createBuildCacheProvider,
	entryDirectory,
	defaultCacheRoot,
	toolchainSegment,
};
