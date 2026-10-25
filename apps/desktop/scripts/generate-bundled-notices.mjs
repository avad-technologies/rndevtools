import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NOTICES_HEADER = 'RN Devtools — bundled third-party licenses';

async function filesUnder(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const file = path.join(directory, entry.name);
			return entry.isDirectory() ? filesUnder(file) : [file];
		})
	);
	return files.flat().sort();
}

async function packageFor(file) {
	if (!file.split(path.sep).includes('node_modules')) return null;
	let directory = path.dirname(file);
	while (directory !== path.dirname(directory)) {
		if (path.basename(directory) === 'node_modules') break;
		try {
			const metadata = JSON.parse(
				await readFile(path.join(directory, 'package.json'), 'utf8')
			);
			if (metadata.name && metadata.version) return { directory, metadata };
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		directory = path.dirname(directory);
	}
	throw new Error(`Cannot resolve the package owning bundled input ${file}`);
}

function sourceFile(source, mapFile, sourceRoot = '') {
	if (source.startsWith('\0') || /^(?:virtual|rolldown):/.test(source)) {
		return null;
	}
	const base = pathToFileURL(`${path.dirname(mapFile)}${path.sep}`);
	const root = sourceRoot
		? new URL(`${sourceRoot.replace(/\/$/, '')}/`, base)
		: base;
	const url = new URL(source, root);
	return url.protocol === 'file:' ? fileURLToPath(url) : null;
}

export async function generateBundledNotices(appDirectory) {
	const dist = path.join(appDirectory, 'dist');
	const maps = (await filesUnder(dist)).filter((file) => file.endsWith('.map'));
	if (maps.length === 0) {
		throw new Error(
			'Build sourcemaps are required to generate bundled licenses.'
		);
	}
	const sources = new Set();
	for (const mapFile of maps) {
		const map = JSON.parse(await readFile(mapFile, 'utf8'));
		for (const source of map.sources) {
			const file = sourceFile(source, mapFile, map.sourceRoot);
			if (file) sources.add(file);
		}
	}

	const packages = new Map();
	const visited = new Set();
	async function visit(file) {
		if (visited.has(file)) return;
		visited.add(file);
		const owner = await packageFor(file);
		if (owner) packages.set(owner.directory, owner);
		const content = await readFile(file, 'utf8');
		const imports = file.endsWith('.css')
			? /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g
			: /\bimport\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
		for (const match of content.matchAll(imports)) {
			const specifier = match[1];
			if (/^(?:https?:|data:|node:)/.test(specifier)) continue;
			let resolved;
			try {
				resolved = createRequire(file).resolve(specifier);
			} catch (error) {
				if (file.endsWith('.css') || specifier.endsWith('.css')) throw error;
				continue;
			}
			// CSS and font imports do not appear in JavaScript sourcemaps.
			if (resolved.endsWith('.css')) await visit(resolved);
		}
	}
	for (const source of [...sources].sort()) await visit(source);
	if (packages.size === 0)
		throw new Error('No bundled dependencies were found.');

	const sections = [];
	for (const { directory, metadata } of packages.values()) {
		const legalFiles = (await readdir(directory)).filter((name) =>
			/^(?:licen[sc]e|notice|copying)(?:[.-].*)?$/i.test(name)
		);
		const texts = [];
		for (const name of legalFiles.sort()) {
			const file = path.join(directory, name);
			if ((await stat(file)).isFile()) {
				const text = (await readFile(file, 'utf8')).trim();
				if (text) texts.push(`${name}\n\n${text}`);
			}
		}
		if (texts.length === 0) {
			throw new Error(
				`Missing license text for ${metadata.name}@${metadata.version}`
			);
		}
		sections.push({
			id: `${metadata.name}@${metadata.version}`,
			text: texts.join('\n\n'),
		});
	}
	const unique = new Map();
	for (const section of sections) {
		const previous = unique.get(section.id);
		if (previous && previous.text !== section.text) {
			throw new Error(`Conflicting license texts for ${section.id}`);
		}
		unique.set(section.id, section);
	}
	const ordered = [...unique.values()].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	);
	const output = [
		NOTICES_HEADER,
		'Generated from built JavaScript sourcemaps and their CSS/font imports.',
		'Each dependency retains its own license. HeroUI Pro is commercially licensed.',
		'Electron/Chromium and native helper notices are distributed separately.',
		...ordered.map(({ id, text }) => `\n${'='.repeat(72)}\n${id}\n\n${text}`),
		'',
	].join('\n');
	const destination = path.join(dist, 'THIRD_PARTY_LICENSES.txt');
	await writeFile(destination, output, 'utf8');
	return { destination, packages: ordered.map(({ id }) => id) };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const appDirectory = path.resolve(
		fileURLToPath(new URL('..', import.meta.url))
	);
	const result = await generateBundledNotices(appDirectory);
	console.log(
		`Generated bundled notices for ${result.packages.length} packages.`
	);
}
