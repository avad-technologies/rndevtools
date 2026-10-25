const fs = require('node:fs');
const path = require('node:path');

// Metro's own defaults, for a config that does not list its own.
const DEFAULT_SOURCE_EXTS = ['js', 'jsx', 'json', 'ts', 'tsx'];
const DEFAULT_PLATFORMS = ['ios', 'android'];

// Every package in this scope is devtools code. A pruned bundle may reach one
// only through a `replace` stub.
const DEVTOOLS_SCOPE = '@rndevtools/';

function isFile(candidate) {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Real paths of the files a module path can resolve to: the path itself, the
 * path with a source or platform extension, or the index of that directory.
 */
function moduleFiles(base, sourceExts, platforms) {
	const extensions = sourceExts.flatMap((extension) => [
		`.${extension}`,
		...platforms.map((platform) => `.${platform}.${extension}`),
	]);
	const candidates = [
		base,
		...extensions.map((extension) => `${base}${extension}`),
		...extensions.map((extension) => path.join(base, `index${extension}`)),
	];
	return [
		...new Set(
			candidates
				.filter((candidate) => isFile(candidate))
				.map((candidate) => fs.realpathSync(candidate)),
		),
	];
}

/** The file Node resolves an installed package specifier to, if any. */
function packageFiles(specifier, projectRoot) {
	try {
		return [
			fs.realpathSync(require.resolve(specifier, { paths: [projectRoot] })),
		];
	} catch {
		return [];
	}
}

/** The `name` in `directory/package.json`, when that file exists and has one. */
function packageNameIn(directory) {
	try {
		const { name } = JSON.parse(
			fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
		);
		return typeof name === 'string' ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Looks up the package a directory belongs to: the `name` of the nearest
 * `package.json` at or above it that has one. Going by name rather than by a
 * `node_modules/@rndevtools/` path also catches a workspace or `link:`
 * install, which Metro reports by its real path outside node_modules. Each
 * directory is read once.
 */
function packageLookup() {
	const names = new Map();
	const nameOf = (directory) => {
		if (names.has(directory)) return names.get(directory);
		const parent = path.dirname(directory);
		const name =
			packageNameIn(directory) ??
			(parent === directory ? undefined : nameOf(parent));
		names.set(directory, name);
		return name;
	};
	return nameOf;
}

/**
 * Reads an on/off option. Only a boolean counts: an environment variable
 * passed straight through is a string whatever it says, so it is refused
 * rather than guessed at.
 */
function switchOption(options, name) {
	const value = options[name];
	if (value === undefined || typeof value === 'boolean') return value === true;
	const given =
		typeof value === 'string'
			? `the string ${JSON.stringify(value)}`
			: value === null
				? 'null'
				: typeof value;
	throw new TypeError(
		`withDevtoolsPruning: \`${name}\` must be true or false, not ${given}. Compare an environment variable with the value you mean instead of passing it through.`,
	);
}

/**
 * Metro resolver that swaps devtools modules for inert stubs in release
 * bundles.
 *
 * Devtools code is only safe to ship because it never reaches a production
 * bundle. Tree shaking is not a strong enough guarantee for that: a single
 * retained import pulls in panels, adapters, and the diagnostics they reach.
 * This replaces the modules at resolution time instead, so the graph is cut
 * rather than trimmed, and pairs with `verifyPrunedBundle` to prove it.
 *
 * Pruning fails closed. It applies to every bundle Metro does not build as a
 * development bundle, read from the `dev` flag of Metro's resolution context,
 * the flag that also sets `__DEV__`. A release build is pruned without the app
 * setting any variable, and a context that carries no flag is treated as a
 * release. While pruning, an import that resolves into an `@rndevtools/*`
 * package without going through a `replace` entry throws, naming the import,
 * instead of adding that package to the bundle.
 *
 * Each entry names a module the app imports, the file it resolves to, and the
 * stub to use instead. The stub must export the same shape as the real module
 * with no-op implementations.
 *
 * Imports are matched by the file they resolve to, not by how they are
 * written, so the alias, a relative path (babel-plugin-module-resolver
 * rewrites aliases to those before Metro sees them), an explicit extension
 * and an `/index` import of the file all get the stub. Every `path` and stub
 * must name an existing file: a stale entry throws here instead of silently
 * leaving the real module in the bundle.
 *
 * @example
 * const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');
 *
 * module.exports = withDevtoolsPruning(config, {
 *   projectRoot: __dirname,
 *   replace: [
 *     {
 *       module: '@/features/dev-menu/dev-menu-host',
 *       path: 'src/features/dev-menu/dev-menu-host',
 *       stub: 'src/lib/dev-menu-host-disabled.tsx',
 *     },
 *   ],
 * });
 *
 * @param {object} config Metro config to extend.
 * @param {object} options
 * @param {string} options.projectRoot Absolute root that relative paths resolve against.
 * @param {ReadonlyArray<{module: string, path?: string, stub: string}>} options.replace
 *   `path` is the file `module` resolves to, relative to `projectRoot`, with or
 *   without its extension. Leave it out only when `module` is itself such a
 *   path or an installed package.
 * @param {boolean} [options.enabled] `true` prunes development bundles too.
 *   Left out, or `false`, release bundles alone are pruned: it never turns
 *   pruning off.
 * @param {boolean} [options.keepInReleaseBundles] `true` turns pruning off,
 *   so release bundles keep their devtools. Only for an internal build that
 *   deliberately ships them; `rndevtools-verify-bundle` fails on its bundle.
 * @returns {object} The same config, with `resolver.resolveRequest` wrapped.
 */
function withDevtoolsPruning(config, options) {
	const settings = options ?? {};
	const always = switchOption(settings, 'enabled');
	const keep = switchOption(settings, 'keepInReleaseBundles');
	if (always && keep) {
		throw new Error(
			'withDevtoolsPruning: `enabled: true` prunes every bundle and `keepInReleaseBundles: true` prunes none. Pass one or the other.',
		);
	}
	// The one deliberate way to ship devtools in a release bundle.
	if (keep) return config;
	const { projectRoot, replace } = settings;
	if (!projectRoot) throw new Error('withDevtoolsPruning requires projectRoot');
	if (!Array.isArray(replace) || replace.length === 0) {
		throw new Error('withDevtoolsPruning requires a non-empty replace list');
	}

	const resolver = config.resolver ?? {};
	const sourceExts = Array.isArray(resolver.sourceExts)
		? resolver.sourceExts
		: DEFAULT_SOURCE_EXTS;
	// Metro can also resolve `.native.*` files; they are the same module.
	const platforms = [
		...new Set([
			...(Array.isArray(resolver.platforms)
				? resolver.platforms
				: DEFAULT_PLATFORMS),
			'native',
		]),
	];

	const targets = new Map();
	const entries = replace.map((entry) => {
		if (!entry?.module || !entry.stub) {
			throw new Error('Each replace entry needs a `module` and a `stub` path.');
		}
		const stub = path.resolve(projectRoot, entry.stub);
		if (moduleFiles(stub, sourceExts, platforms).length === 0) {
			throw new Error(
				`withDevtoolsPruning: the stub for ${entry.module}, ${entry.stub}, is not a file under ${projectRoot}.`,
			);
		}
		const files =
			entry.path === undefined
				? [
						...moduleFiles(
							path.resolve(projectRoot, entry.module),
							sourceExts,
							platforms,
						),
						...packageFiles(entry.module, projectRoot),
					]
				: moduleFiles(
						path.resolve(projectRoot, entry.path),
						sourceExts,
						platforms,
					);
		if (files.length === 0) {
			throw new Error(
				entry.path === undefined
					? `withDevtoolsPruning: cannot find the file ${entry.module} resolves to. Set its \`path\` to that file, relative to ${projectRoot}.`
					: `withDevtoolsPruning: the path for ${entry.module}, ${entry.path}, is not a file under ${projectRoot}.`,
			);
		}
		const pruned = { module: entry.module, stub };
		for (const file of files) targets.set(file, pruned);
		return pruned;
	});

	// Metro hands back real paths, so a lookup by name settles almost every
	// resolution; only a file named like a target pays for a realpath.
	const targetNames = new Set(
		[...targets.keys()].map((file) => path.basename(file)),
	);
	const targetFor = (filePath) => {
		const direct = targets.get(filePath);
		if (direct || !targetNames.has(path.basename(filePath))) return direct;
		try {
			return targets.get(fs.realpathSync(filePath));
		} catch {
			return undefined;
		}
	};

	// Metro reports real paths, so messages name files from the real root.
	let root = projectRoot;
	try {
		root = fs.realpathSync(projectRoot);
	} catch {
		// A missing root already failed the stub check above.
	}
	const shown = (file) => {
		const relative = path.relative(root, file);
		return relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
			? file
			: relative;
	};

	// The app is never devtools code itself, even when its package is named
	// in the scope, as an example app in this toolkit's own workspace is.
	const packageOf = packageLookup();
	const appPackage = packageOf(root);
	const devtoolsPackageOf = (file) => {
		const name = packageOf(path.dirname(file));
		return name?.startsWith(DEVTOOLS_SCOPE) && name !== appPackage
			? name
			: undefined;
	};
	// An asset request resolves to files too, so a devtools image is refused
	// like devtools code.
	const filesOf = (resolution) =>
		resolution?.type === 'sourceFile'
			? [resolution.filePath]
			: resolution?.type === 'assetFiles'
				? resolution.filePaths
				: [];
	const refuseDevtools = (context, moduleName, resolution) => {
		for (const file of filesOf(resolution)) {
			const name = devtoolsPackageOf(file);
			if (!name) continue;
			const importer = context.originModulePath
				? shown(context.originModulePath)
				: 'the bundle';
			throw new Error(
				`withDevtoolsPruning: ${moduleName}, imported by ${importer}, resolves to ${shown(file)} in ${name}. A pruned bundle must not contain ${name}, so the build stops here instead of shipping it. Import devtools only through a module listed in \`replace\`, which Metro swaps for its stub, or pass \`keepInReleaseBundles: true\` for a build that deliberately ships devtools.`,
			);
		}
	};

	const previous = resolver.resolveRequest;
	const resolveNext = (context, moduleName, platform) =>
		previous
			? previous(context, moduleName, platform)
			: context.resolveRequest(context, moduleName, platform);
	resolver.resolveRequest = (context, moduleName, platform) => {
		// A development bundle keeps its devtools. Only Metro's own `true`
		// marks one, so a context without the flag is pruned like a release.
		if (!always && context.dev === true) {
			return resolveNext(context, moduleName, platform);
		}
		// An alias may only be resolvable by Babel, so it is matched by name
		// before anything tries to resolve it.
		const aliased = entries.find((entry) => moduleName === entry.module);
		if (aliased) return context.resolveRequest(context, aliased.stub, platform);
		const resolution = resolveNext(context, moduleName, platform);
		const pruned =
			resolution?.type === 'sourceFile'
				? targetFor(resolution.filePath)
				: undefined;
		if (pruned) return context.resolveRequest(context, pruned.stub, platform);
		refuseDevtools(context, moduleName, resolution);
		return resolution;
	};
	config.resolver = resolver;
	return config;
}

module.exports = { withDevtoolsPruning };
