/**
 * Expo build cache provider that shares native builds across git worktrees.
 * See `build-cache.js` for behaviour and `README.md` for wiring.
 */

export type BuildCachePlatform = 'android' | 'ios';

export type BuildCacheRunOptions = {
	/** iOS: Xcode configuration. */
	configuration?: 'Debug' | 'Release';
	/** Android: Gradle variant. */
	variant?: string;
	[key: string]: unknown;
};

export type BuildCacheProviderOptions = {
	/**
	 * Where to keep cached binaries. `~` expands to the home directory.
	 * Default: `~/Library/Caches/rndevtools/native` on macOS, otherwise
	 * `$XDG_CACHE_HOME/rndevtools/native`; `RNDEVTOOLS_BUILD_CACHE_DIR`
	 * overrides both.
	 */
	cacheDirectory?: string;
	/**
	 * How long a worktree waits for another process that is already building
	 * the same fingerprint before giving up. Default 20 minutes.
	 */
	waitTimeoutMs?: number;
};

export type ResolveBuildCacheProps = {
	projectRoot: string;
	platform: BuildCachePlatform;
	runOptions: BuildCacheRunOptions;
	fingerprintHash: string;
};

export type UploadBuildCacheProps = ResolveBuildCacheProps & {
	buildPath: string;
};

/** Returns the cached `.app`/`.apk`, or `null` after claiming the build. */
export function resolveBuildCache(
	props: ResolveBuildCacheProps,
	options?: BuildCacheProviderOptions,
): Promise<string | null>;

/**
 * Copies a finished build into the cache and releases this process's claim.
 * An entry that already holds a binary keeps it, and that path is returned.
 */
export function uploadBuildCache(
	props: UploadBuildCacheProps,
	options?: BuildCacheProviderOptions,
): Promise<string | null>;

/** Absolute directory of one cache entry. Exposed for tooling and tests. */
export function entryDirectory(
	props: Pick<ResolveBuildCacheProps, 'fingerprintHash' | 'platform'> & {
		runOptions?: BuildCacheRunOptions;
	},
	options?: BuildCacheProviderOptions,
): string;

/**
 * The toolchain path segment for a platform: `<arch>-<12 hex>`, where the
 * digest covers the CPU architecture and, for iOS, `xcodebuild -version`.
 */
export function toolchainSegment(
	platform: BuildCachePlatform | string,
	internals?: { arch?: string; xcodeIdentity?: () => string },
): string;

/** Default cache root for this machine. */
export function defaultCacheRoot(
	env?: Record<string, string | undefined>,
	homedir?: string,
): string;

/** Builds a provider with injectable clock and sleep, for tests. */
export function createBuildCacheProvider(internals?: {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): {
	resolveBuildCache: typeof resolveBuildCache;
	uploadBuildCache: typeof uploadBuildCache;
};
