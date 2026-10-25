import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	generateBundledNotices,
	NOTICES_HEADER,
} from './generate-bundled-notices.mjs';

const beforeBuild = createRequire(import.meta.url)('./before-build.cjs');

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-licenses-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = path.join(root, 'apps', 'desktop');
	async function write(relative, content) {
		const file = path.join(root, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content);
		return file;
	}
	await write('apps/desktop/src/main.tsx', 'export const privateSource = 42;');
	await write(
		'apps/desktop/dist/main/index.js.map',
		JSON.stringify({
			version: 3,
			sources: [
				'../../src/main.tsx',
				'../../../../node_modules/example/index.js',
			],
			sourcesContent: ['DO NOT SHIP SOURCE CONTENT'],
		})
	);
	await write(
		'node_modules/example/package.json',
		JSON.stringify({ name: 'example', version: '1.2.3', main: 'index.js' })
	);
	await write('node_modules/example/index.js', 'export const example = true;');
	await write(
		'node_modules/example/LICENSE',
		'Copyright Example Authors\nMIT text'
	);
	return { root, app, write };
}

test('preserves license and NOTICE texts without source content or local paths', async (t) => {
	const { root, app, write } = await fixture(t);
	await write('node_modules/example/NOTICE', 'Additional attribution');
	const result = await generateBundledNotices(app);
	const text = await readFile(result.destination, 'utf8');
	assert.deepEqual(result.packages, ['example@1.2.3']);
	assert.ok(text.startsWith(`${NOTICES_HEADER}\n`));
	assert.ok(text.includes('Copyright Example Authors\nMIT text'));
	assert.ok(text.includes('NOTICE\n\nAdditional attribution'));
	assert.ok(!text.includes(root));
	assert.ok(!text.includes('privateSource'));
	assert.ok(!text.includes('DO NOT SHIP SOURCE CONTENT'));
	await generateBundledNotices(app);
	assert.equal(await readFile(result.destination, 'utf8'), text);
});

test('includes transitive CSS and font package licenses absent from JS maps', async (t) => {
	const { app, write } = await fixture(t);
	await write(
		'apps/desktop/src/main.tsx',
		"import '@example/font'; import './styles.css';"
	);
	await write(
		'apps/desktop/src/styles.css',
		'@import "@example/theme" layer(base);'
	);
	for (const [name, license] of [
		['font', 'OFL font copyright and conditions'],
		['theme', 'Theme license'],
	]) {
		await write(
			`node_modules/@example/${name}/package.json`,
			JSON.stringify({
				name: `@example/${name}`,
				version: '2.0.0',
				exports: { '.': { style: './index.css' } },
			})
		);
		await write(`node_modules/@example/${name}/index.css`, '@font-face {}');
		await write(`node_modules/@example/${name}/LICENSE`, license);
	}
	const result = await generateBundledNotices(app);
	assert.deepEqual(result.packages, [
		'@example/font@2.0.0',
		'@example/theme@2.0.0',
		'example@1.2.3',
	]);
	assert.ok(
		(await readFile(result.destination, 'utf8')).includes('OFL font copyright')
	);
});

test('resolves nested package versions from actual bundled source locations', async (t) => {
	const { app, write } = await fixture(t);
	await write(
		'apps/desktop/dist/preload/index.js.map',
		JSON.stringify({ sources: ['../../node_modules/example/index.js'] })
	);
	await write(
		'apps/desktop/node_modules/example/package.json',
		JSON.stringify({ name: 'example', version: '4.5.6' })
	);
	await write('apps/desktop/node_modules/example/index.js', 'export {};');
	await write(
		'apps/desktop/node_modules/example/LICENSE',
		'Different version license'
	);
	assert.deepEqual((await generateBundledNotices(app)).packages, [
		'example@1.2.3',
		'example@4.5.6',
	]);
});

test('fails closed on missing legal text without replacing previous notices', async (t) => {
	const { app, root, write } = await fixture(t);
	await write('apps/desktop/dist/THIRD_PARTY_LICENSES.txt', 'previous notices');
	await rm(path.join(root, 'node_modules/example/LICENSE'));
	await assert.rejects(
		generateBundledNotices(app),
		/Missing license text for example@1.2.3/
	);
	assert.equal(
		await readFile(path.join(app, 'dist/THIRD_PARTY_LICENSES.txt'), 'utf8'),
		'previous notices'
	);
});

test('requires the original build sourcemaps and readable dependency inputs', async (t) => {
	const { app, root } = await fixture(t);
	await rm(path.join(root, 'node_modules/example/index.js'));
	await assert.rejects(generateBundledNotices(app), /ENOENT/);
	await rm(path.join(app, 'dist/main/index.js.map'));
	await assert.rejects(
		generateBundledNotices(app),
		/Build sourcemaps are required/
	);
});

test('rejects empty licenses and cannot mistake the repository license for a dependency', async (t) => {
	const { app, root, write } = await fixture(t);
	await write('node_modules/example/LICENSE', ' \n');
	await assert.rejects(generateBundledNotices(app), /Missing license text/);
	await write(
		'package.json',
		JSON.stringify({ name: 'first-party', version: '1.0.0' })
	);
	await write('LICENSE', 'First-party MIT license');
	await rm(path.join(root, 'node_modules/example/package.json'));
	await assert.rejects(
		generateBundledNotices(app),
		/Cannot resolve the package owning/
	);
});

test('packaging requires valid generated notices and still skips dependency traversal', async (t) => {
	const { app, write } = await fixture(t);
	await assert.rejects(
		beforeBuild({ appDir: app }),
		/license notices are missing/
	);
	await write('apps/desktop/dist/THIRD_PARTY_LICENSES.txt', 'invalid notices');
	await assert.rejects(
		beforeBuild({ appDir: app }),
		/license notices are invalid/
	);
	await generateBundledNotices(app);
	assert.equal(await beforeBuild({ appDir: app }), false);
});
