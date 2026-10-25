#!/usr/bin/env node
/**
 * Asserts the production pruning seam is complete, without running Metro.
 *
 * `withDevtoolsPruning` only helps if every path from the app entry to
 * `@rndevtools/*` passes through a replaced module. One direct import anywhere
 * else reconnects the graph and ships the panels. This walks the import graph
 * from the entry point, applies the same replacement table Metro is given, and
 * fails if any devtools package is still reachable.
 *
 * It complements `rndevtools-verify-bundle`, which checks a real export: this
 * one is fast enough to run on every change and names the offending import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Read the replacement table from the real Metro config rather than restating
// it, so this can never drift from what Metro actually does.
function replacementTable() {
	const captured = [];
	const metroPath = require.resolve('@rndevtools/react-native/metro');
	const real = require(metroPath);
	const original = real.withDevtoolsPruning;
	real.withDevtoolsPruning = (config, options) => {
		captured.push(...options.replace);
		return config;
	};
	try {
		delete require.cache[path.join(projectRoot, 'metro.config.js')];
		require(path.join(projectRoot, 'metro.config.js'));
	} finally {
		real.withDevtoolsPruning = original;
	}
	return captured.map((entry) => ({
		module: entry.module,
		resolved: path.resolve(projectRoot, entry.path ?? entry.module),
		stub: path.resolve(projectRoot, entry.stub),
	}));
}

const IMPORT_PATTERN =
	/(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const TYPE_ONLY_PATTERN = /^(?:import|export)\s+type\s/;

function resolveLocal(specifier, importer) {
	const base = specifier.startsWith('@/')
		? path.join(projectRoot, 'src', specifier.slice(2))
		: path.resolve(path.dirname(importer), specifier);
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, 'index.ts'),
		path.join(base, 'index.tsx'),
	]) {
		if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
			try {
				readFileSync(candidate);
				return candidate;
			} catch {
				// A directory; keep looking.
			}
		}
	}
	throw new Error(`Cannot resolve '${specifier}' from ${importer}`);
}

function reachableDevtoolsImports({ pruned }) {
	const table = pruned ? replacementTable() : [];
	const seen = new Set();
	const offenders = [];
	const queue = [path.join(projectRoot, 'index.ts')];

	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(IMPORT_PATTERN)) {
			// Type-only imports are erased before bundling and cannot ship code.
			if (TYPE_ONLY_PATTERN.test(match[0])) continue;
			const specifier = match[1] ?? match[2];
			if (specifier.startsWith('@rndevtools/')) {
				offenders.push({ file: path.relative(projectRoot, file), specifier });
				continue;
			}
			if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;
			const target = resolveLocal(specifier, file);
			const replaced = table.find(
				(entry) =>
					specifier === entry.module ||
					target === entry.resolved ||
					target === `${entry.resolved}.ts` ||
					target === `${entry.resolved}.tsx`,
			);
			queue.push(replaced ? replaced.stub : target);
		}
	}
	return offenders;
}

// Guard against a vacuous pass: if the unpruned graph reaches no devtools, the
// walker is broken or the entry point moved, and a clean pruned result would
// prove nothing.
const unpruned = reachableDevtoolsImports({ pruned: false });
if (unpruned.length === 0) {
	console.error('Sanity check failed: the development graph reaches no devtools imports.');
	process.exit(1);
}

const offenders = reachableDevtoolsImports({ pruned: true });
if (offenders.length > 0) {
	console.error('Devtools are still reachable in a production build:');
	for (const { file, specifier } of offenders) console.error(`  ${file} -> ${specifier}`);
	console.error('\nRoute these through a module listed in metro.config.js `replace`.');
	process.exit(1);
}

console.log(
	`Pruning seam is complete: ${unpruned.length} devtools import(s) in development, 0 reachable in production.`,
);
