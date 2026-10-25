import { withDevtoolsPruning } from '../metro.js';

/**
 * Pruning checks real files, so each test builds a small project on disk.
 * Node's modules are reached through a typed `require` rather than adding
 * @types/node to a React Native package.
 */
declare const require: (id: string) => unknown;

type Fs = {
	mkdtempSync: (prefix: string) => string;
	mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
	rmSync: (
		p: string,
		options?: { recursive?: boolean; force?: boolean },
	) => void;
	realpathSync: (p: string) => string;
	statSync: (p: string) => { isFile: () => boolean };
	symlinkSync: (target: string, p: string) => void;
	writeFileSync: (p: string, data: string) => void;
};
type Path = {
	dirname: (p: string) => string;
	join: (...parts: string[]) => string;
	relative: (from: string, to: string) => string;
	resolve: (...parts: string[]) => string;
};
type Os = { tmpdir: () => string };
type Resolution =
	| { type: 'sourceFile'; filePath: string }
	| { type: 'assetFiles'; filePaths: readonly string[] };
type ResolveRequest = (
	context: {
		originModulePath: string;
		resolveRequest: ResolveRequest;
		/** Set by Metro for the bundle being built, as it sets `__DEV__`. */
		dev?: boolean;
	},
	moduleName: string,
	platform: string | null,
) => Resolution;
type ReplaceEntry = { module: string; path?: string; stub: string };
type Options = Parameters<typeof withDevtoolsPruning>[1];

const fs = require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;

const stub = 'src/lib/devtools-disabled.tsx';
let projectRoot: string;

function write(file: string, contents = 'export {};\n'): void {
	const absolute = path.join(projectRoot, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents);
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolves the way Metro does for these fixtures: `@/` is the project's
 * `src`, bare names are packages, and a path may omit its extension or name
 * a directory index.
 */
const metroLike: ResolveRequest = (context, moduleName) => {
	const base = moduleName.startsWith('@/')
		? path.join(projectRoot, 'src', moduleName.slice(2))
		: moduleName.startsWith('.')
			? path.resolve(path.dirname(context.originModulePath), moduleName)
			: moduleName.startsWith('/')
				? moduleName
				: path.join(projectRoot, 'node_modules', moduleName);
	const extensions = ['.ts', '.tsx', '.js'];
	const filePath = [
		base,
		...extensions.map((extension) => `${base}${extension}`),
		...extensions.map((extension) => path.join(base, `index${extension}`)),
	].find(isFile);
	if (!filePath) throw new Error(`Unable to resolve ${moduleName}`);
	return { type: 'sourceFile', filePath };
};

function configure(
	options: Options,
	previous?: ResolveRequest,
): ResolveRequest {
	const config = withDevtoolsPruning(
		{ resolver: previous ? { resolveRequest: previous } : {} },
		options,
	) as { resolver: { resolveRequest: ResolveRequest } };
	return config.resolver.resolveRequest;
}

function pruning(
	replace: readonly ReplaceEntry[],
	previous?: ResolveRequest,
): ResolveRequest {
	return configure({ enabled: true, projectRoot, replace }, previous);
}

/** Resolves as Metro does while building a bundle with this `dev` flag. */
function inBundle(resolve: ResolveRequest, dev: boolean): ResolveRequest {
	return (context, moduleName, platform) =>
		resolve({ ...context, dev }, moduleName, platform);
}

/** Project-relative file that `moduleName` ends up as when imported from `origin`. */
function resolveWith(
	resolve: ResolveRequest,
	moduleName: string,
	origin = 'src/app/_layout.tsx',
): string {
	const resolution = resolve(
		{
			originModulePath: path.join(projectRoot, origin),
			resolveRequest: metroLike,
		},
		moduleName,
		'ios',
	);
	if (resolution.type !== 'sourceFile') {
		throw new Error(`${moduleName} resolved to ${resolution.type}`);
	}
	return path.relative(projectRoot, fs.realpathSync(resolution.filePath));
}

/** An installed devtools package, laid out the way `metroLike` resolves it. */
function devtoolsPackage(directory = 'node_modules/@rndevtools/core'): void {
	write(
		`${directory}/package.json`,
		JSON.stringify({ name: '@rndevtools/core', main: 'index.ts' }),
	);
	write(`${directory}/index.ts`, 'export const panel = "real";\n');
	write(`${directory}/src/redact.ts`);
}

/** How a pruned bundle's refusal of a devtools import begins. */
const leak = (moduleName: string, importer: string, file: string) =>
	`withDevtoolsPruning: ${moduleName}, imported by ${importer}, resolves to ${file} in @rndevtools/core. A pruned bundle must not contain @rndevtools/core`;

const host = {
	module: '@/lib/devtools/host',
	path: 'src/lib/devtools/host',
	stub,
};

beforeEach(() => {
	// Real, as Metro reports importers; the symlink test adds a linked root.
	projectRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'rndevtools-metro-')),
	);
	write('src/app/_layout.tsx');
	write('src/lib/devtools/host.ts', 'export const host = "real";\n');
	write('src/lib/devtools/other.ts');
	write(stub, 'export const host = "stub";\n');
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('withDevtoolsPruning', () => {
	it('replaces the alias specifier', () => {
		expect(resolveWith(pruning([host]), '@/lib/devtools/host')).toBe(stub);
	});

	it('replaces the absolute path with or without an extension', () => {
		const resolve = pruning([host]);
		const absolute = path.join(projectRoot, 'src/lib/devtools/host');
		expect(resolveWith(resolve, absolute)).toBe(stub);
		expect(resolveWith(resolve, `${absolute}.ts`)).toBe(stub);
	});

	it('replaces a relative specifier resolved against the importer', () => {
		// babel-plugin-module-resolver rewrites `@/…` to this before Metro sees it.
		expect(resolveWith(pruning([host]), '../lib/devtools/host')).toBe(stub);
	});

	it('replaces every import of a path written with its extension', () => {
		const resolve = pruning([{ ...host, path: 'src/lib/devtools/host.ts' }]);
		expect(resolveWith(resolve, '../lib/devtools/host')).toBe(stub);
		expect(resolveWith(resolve, './host', 'src/lib/devtools/other.ts')).toBe(
			stub,
		);
	});

	it('replaces /index imports of a directory module and explicit .js imports', () => {
		write('src/devtools/panel/index.ts');
		write('src/devtools/legacy.js');
		const resolve = pruning([
			{ module: '@/devtools/panel', path: 'src/devtools/panel', stub },
			{ module: '@/devtools/legacy', path: 'src/devtools/legacy', stub },
		]);
		expect(resolveWith(resolve, '../devtools/panel/index')).toBe(stub);
		expect(resolveWith(resolve, '@/devtools/panel/index')).toBe(stub);
		expect(resolveWith(resolve, '../devtools/legacy.js')).toBe(stub);
	});

	it('checks what an earlier resolver returns', () => {
		const target = path.join(projectRoot, 'src/lib/devtools/host.ts');
		const previous: ResolveRequest = (context, moduleName, platform) =>
			moduleName === '~devtools'
				? { type: 'sourceFile', filePath: target }
				: context.resolveRequest(context, moduleName, platform);
		expect(resolveWith(pruning([host], previous), '~devtools')).toBe(stub);
	});

	it('replaces an installed package named without a path', () => {
		write(
			'node_modules/example-devtools/package.json',
			'{"name":"example-devtools","main":"index.js"}',
		);
		write('node_modules/example-devtools/index.js');
		const resolve = pruning([{ module: 'example-devtools', stub }]);
		expect(resolveWith(resolve, 'example-devtools')).toBe(stub);
		expect(resolveWith(resolve, 'example-devtools/index')).toBe(stub);
	});

	it('matches when projectRoot is reached through a symlink', () => {
		const linked = `${projectRoot}-link`;
		fs.symlinkSync(projectRoot, linked);
		try {
			const config = withDevtoolsPruning(
				{ resolver: {} },
				{ enabled: true, projectRoot: linked, replace: [host] },
			) as { resolver: { resolveRequest: ResolveRequest } };
			expect(
				resolveWith(config.resolver.resolveRequest, '../lib/devtools/host'),
			).toBe(stub);
		} finally {
			fs.rmSync(linked, { force: true });
		}
	});

	it('leaves unrelated imports alone', () => {
		expect(resolveWith(pruning([host]), '../lib/devtools/other')).toBe(
			'src/lib/devtools/other.ts',
		);
	});

	it('refuses an entry whose stub or path names no file', () => {
		expect(() =>
			pruning([{ ...host, stub: 'src/lib/missing-stub.tsx' }]),
		).toThrow(
			/the stub for @\/lib\/devtools\/host, src\/lib\/missing-stub\.tsx/,
		);
		expect(() =>
			pruning([{ ...host, path: 'src/lib/devtools/moved' }]),
		).toThrow(/the path for @\/lib\/devtools\/host, src\/lib\/devtools\/moved/);
	});

	it('refuses an alias without a path, which relative imports would miss', () => {
		expect(() => pruning([{ module: host.module, stub }])).toThrow(
			/cannot find the file @\/lib\/devtools\/host resolves to\. Set its `path`/,
		);
	});
});

describe('which bundles are pruned', () => {
	it('prunes a release bundle without being enabled', () => {
		const resolve = configure({ projectRoot, replace: [host] });
		expect(resolveWith(inBundle(resolve, false), '@/lib/devtools/host')).toBe(
			stub,
		);
		expect(resolveWith(inBundle(resolve, false), '../lib/devtools/host')).toBe(
			stub,
		);
	});

	it('treats a resolution context without a dev flag as a release', () => {
		const resolve = configure({ projectRoot, replace: [host] });
		expect(resolveWith(resolve, '@/lib/devtools/host')).toBe(stub);
	});

	it('leaves a development bundle untouched, devtools packages included', () => {
		devtoolsPackage();
		for (const enabled of [undefined, false]) {
			const development = inBundle(
				configure({ enabled, projectRoot, replace: [host] }),
				true,
			);
			expect(resolveWith(development, '@/lib/devtools/host')).toBe(
				'src/lib/devtools/host.ts',
			);
			expect(resolveWith(development, '@rndevtools/core')).toBe(
				'node_modules/@rndevtools/core/index.ts',
			);
		}
	});

	it('still runs an earlier resolver for a development bundle', () => {
		const target = path.join(projectRoot, 'src/lib/devtools/host.ts');
		const previous: ResolveRequest = (context, moduleName, platform) =>
			moduleName === '~devtools'
				? { type: 'sourceFile', filePath: target }
				: context.resolveRequest(context, moduleName, platform);
		const resolve = configure({ projectRoot, replace: [host] }, previous);
		expect(resolveWith(inBundle(resolve, true), '~devtools')).toBe(
			'src/lib/devtools/host.ts',
		);
		expect(resolveWith(inBundle(resolve, false), '~devtools')).toBe(stub);
	});

	it('prunes a development bundle too when enabled', () => {
		const resolve = configure({ enabled: true, projectRoot, replace: [host] });
		expect(resolveWith(inBundle(resolve, true), '@/lib/devtools/host')).toBe(
			stub,
		);
	});

	it('turns pruning off only when told to keep devtools in release bundles', () => {
		const previous: ResolveRequest = (context, moduleName, platform) =>
			context.resolveRequest(context, moduleName, platform);
		// Nothing to validate when nothing is pruned, as an empty list shows.
		const config = withDevtoolsPruning(
			{ resolver: { resolveRequest: previous } },
			{ keepInReleaseBundles: true, projectRoot, replace: [] },
		) as { resolver: { resolveRequest?: ResolveRequest } };
		expect(config.resolver.resolveRequest).toBe(previous);
	});

	it('refuses switches that are not booleans or that contradict each other', () => {
		// An environment variable passed straight through is a string.
		const fromEnvironment = () =>
			configure({
				enabled: 'false',
				projectRoot,
				replace: [host],
			} as unknown as Options);
		expect(fromEnvironment).toThrow(TypeError);
		expect(fromEnvironment).toThrow(
			'withDevtoolsPruning: `enabled` must be true or false, not the string "false". Compare an environment variable with the value you mean instead of passing it through.',
		);
		expect(() =>
			configure({
				keepInReleaseBundles: 1,
				projectRoot,
				replace: [host],
			} as unknown as Options),
		).toThrow('`keepInReleaseBundles` must be true or false, not number.');
		expect(() =>
			configure({
				enabled: true,
				keepInReleaseBundles: true,
				projectRoot,
				replace: [host],
			}),
		).toThrow(
			'`enabled: true` prunes every bundle and `keepInReleaseBundles: true` prunes none',
		);
	});

	it('validates projectRoot and the replace list whenever it may prune', () => {
		for (const enabled of [undefined, false, true]) {
			expect(() =>
				configure({ enabled, replace: [host] } as unknown as Options),
			).toThrow('withDevtoolsPruning requires projectRoot');
			expect(() => configure({ enabled, projectRoot, replace: [] })).toThrow(
				'withDevtoolsPruning requires a non-empty replace list',
			);
		}
		expect(() =>
			withDevtoolsPruning({ resolver: {} }, undefined as unknown as Options),
		).toThrow('withDevtoolsPruning requires projectRoot');
	});
});

describe('a pruned bundle that reaches a devtools package', () => {
	const release = (replace: readonly ReplaceEntry[] = [host]) =>
		inBundle(configure({ projectRoot, replace }), false);

	it('fails the build, naming the import, the importer and the package', () => {
		devtoolsPackage();
		const importCore = () => resolveWith(release(), '@rndevtools/core');
		expect(importCore).toThrow(
			leak(
				'@rndevtools/core',
				'src/app/_layout.tsx',
				'node_modules/@rndevtools/core/index.ts',
			),
		);
		expect(importCore).toThrow(
			'Import devtools only through a module listed in `replace`, which Metro swaps for its stub, or pass `keepInReleaseBundles: true` for a build that deliberately ships devtools.',
		);
	});

	it('fails however the import reaches the package', () => {
		devtoolsPackage();
		expect(() =>
			resolveWith(release(), '../../node_modules/@rndevtools/core/src/redact'),
		).toThrow(
			leak(
				'../../node_modules/@rndevtools/core/src/redact',
				'src/app/_layout.tsx',
				'node_modules/@rndevtools/core/src/redact.ts',
			),
		);
		// A stub must not pull devtools back in either.
		expect(() => resolveWith(release(), '@rndevtools/core', stub)).toThrow(
			leak('@rndevtools/core', stub, 'node_modules/@rndevtools/core/index.ts'),
		);
	});

	it('recognises a workspace install by its package name, outside node_modules', () => {
		// Metro reports a linked package by its real path.
		devtoolsPackage('packages/core');
		const linked = path.join(projectRoot, 'packages/core/index.ts');
		const previous: ResolveRequest = (context, moduleName, platform) =>
			moduleName === '@rndevtools/core'
				? { type: 'sourceFile', filePath: linked }
				: context.resolveRequest(context, moduleName, platform);
		const resolve = inBundle(
			configure({ projectRoot, replace: [host] }, previous),
			false,
		);
		expect(() => resolveWith(resolve, '@rndevtools/core')).toThrow(
			leak('@rndevtools/core', 'src/app/_layout.tsx', 'packages/core/index.ts'),
		);
	});

	it('refuses a devtools asset like devtools code', () => {
		devtoolsPackage();
		const image = path.join(
			projectRoot,
			'node_modules/@rndevtools/core/icon.png',
		);
		const previous: ResolveRequest = (context, moduleName, platform) =>
			moduleName.endsWith('.png')
				? { type: 'assetFiles', filePaths: [image] }
				: context.resolveRequest(context, moduleName, platform);
		const resolve = inBundle(
			configure({ projectRoot, replace: [host] }, previous),
			false,
		);
		expect(() =>
			resolve(
				{
					originModulePath: path.join(projectRoot, 'src/app/_layout.tsx'),
					resolveRequest: metroLike,
				},
				'@rndevtools/core/icon.png',
				'ios',
			),
		).toThrow(
			leak(
				'@rndevtools/core/icon.png',
				'src/app/_layout.tsx',
				'node_modules/@rndevtools/core/icon.png',
			),
		);
	});

	it('still swaps a devtools module listed in replace for its stub', () => {
		devtoolsPackage();
		const resolve = release([host, { module: '@rndevtools/core', stub }]);
		expect(resolveWith(resolve, '@rndevtools/core')).toBe(stub);
		expect(
			resolveWith(resolve, '../../node_modules/@rndevtools/core/index'),
		).toBe(stub);
		expect(resolveWith(resolve, '@/lib/devtools/host')).toBe(stub);
		// Listing one module of a package does not let the rest through.
		expect(() => resolveWith(resolve, '@rndevtools/core/src/redact')).toThrow(
			leak(
				'@rndevtools/core/src/redact',
				'src/app/_layout.tsx',
				'node_modules/@rndevtools/core/src/redact.ts',
			),
		);
	});

	it("does not count the app's own package as devtools", () => {
		write('package.json', JSON.stringify({ name: '@rndevtools/example-app' }));
		devtoolsPackage();
		expect(resolveWith(release(), '../lib/devtools/other')).toBe(
			'src/lib/devtools/other.ts',
		);
		expect(() => resolveWith(release(), '@rndevtools/core')).toThrow(
			'in @rndevtools/core.',
		);
	});
});
