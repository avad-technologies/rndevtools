import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rendererRoot = fileURLToPath(new URL('./renderer/', import.meta.url));
const forbiddenSourceRoots = [
	fileURLToPath(new URL('./main/', import.meta.url)),
	fileURLToPath(new URL('./preload/', import.meta.url)),
];

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(entryPath);
		return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
	});
}

function importedModules(source: string): string[] {
	return Array.from(
		source.matchAll(
			/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
		),
		(match) => match[1] ?? ''
	).filter(Boolean);
}

describe('renderer process boundaries', () => {
	it('does not import Electron, Node, main-process, or preload modules', () => {
		const violations: string[] = [];

		for (const file of sourceFiles(rendererRoot)) {
			const source = fs.readFileSync(file, 'utf8');
			for (const moduleId of importedModules(source)) {
				const isForbiddenPackage =
					moduleId === 'electron' ||
					moduleId.startsWith('electron/') ||
					moduleId.startsWith('node:') ||
					moduleId === '@main' ||
					moduleId.startsWith('@main/');
				const resolvedRelativeImport = moduleId.startsWith('.')
					? path.resolve(path.dirname(file), moduleId)
					: null;
				const crossesProcessBoundary =
					resolvedRelativeImport !== null &&
					forbiddenSourceRoots.some((root) =>
						resolvedRelativeImport.startsWith(root)
					);

				if (isForbiddenPackage || crossesProcessBoundary) {
					violations.push(
						`${path.relative(rendererRoot, file)} imports ${moduleId}`
					);
				}
			}
		}

		expect(violations).toEqual([]);
	});

	it('does not use Node globals', () => {
		const violations = sourceFiles(rendererRoot).flatMap((file) => {
			const source = fs.readFileSync(file, 'utf8');
			return /\b(?:process\s*\.|Buffer\b)/.test(source)
				? [path.relative(rendererRoot, file)]
				: [];
		});

		expect(violations).toEqual([]);
	});
});
