import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../build'
);
const representations = [
	['icon_16x16.png', 16],
	['icon_16x16@2x.png', 32],
	['icon_32x32.png', 32],
	['icon_32x32@2x.png', 64],
	['icon_128x128.png', 128],
	['icon_128x128@2x.png', 256],
	['icon_256x256.png', 256],
	['icon_256x256@2x.png', 512],
	['icon_512x512.png', 512],
	['icon_512x512@2x.png', 1024],
];

function run(command, args) {
	return execFileSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function generate() {
	if (process.platform !== 'darwin') {
		throw new Error('App icon generation requires macOS sips and iconutil.');
	}
	if (process.argv.length !== 2) {
		throw new Error('Usage: node scripts/generate-app-icons.mjs');
	}
	const temporary = mkdtempSync(join(tmpdir(), 'rndevtools-icons-'));
	try {
		const png = join(temporary, 'icon.png');
		// PNG keeps the SVG's transparent margins; never flatten onto a background.
		run('/usr/bin/sips', [
			'-s',
			'format',
			'png',
			'-z',
			'1024',
			'1024',
			join(buildDirectory, 'icon.svg'),
			'--out',
			png,
		]);
		const properties = run('/usr/bin/sips', [
			'-g',
			'pixelWidth',
			'-g',
			'pixelHeight',
			'-g',
			'hasAlpha',
			png,
		]);
		const property = (name) =>
			properties.match(new RegExp(`^\\s*${name}:\\s*(\\S+)`, 'm'))?.[1];
		if (
			Number(property('pixelWidth')) !== 1024 ||
			Number(property('pixelHeight')) !== 1024 ||
			property('hasAlpha') !== 'yes'
		) {
			throw new Error('Generated icon must be 1024×1024 PNG with alpha.');
		}
		const iconset = join(temporary, 'AppIcon.iconset');
		mkdirSync(iconset);
		for (const [filename, size] of representations) {
			run('/usr/bin/sips', [
				'-z',
				String(size),
				String(size),
				png,
				'--out',
				join(iconset, filename),
			]);
		}
		const icns = join(temporary, 'icon.icns');
		run('/usr/bin/iconutil', ['--convert', 'icns', '--output', icns, iconset]);
		const data = readFileSync(icns);
		if (
			data.length < 8 ||
			data.toString('ascii', 0, 4) !== 'icns' ||
			data.readUInt32BE(4) !== data.length
		) {
			throw new Error('iconutil did not generate a complete ICNS container.');
		}
		copyFileSync(png, join(buildDirectory, 'icon.png'));
		copyFileSync(icns, join(buildDirectory, 'icon.icns'));
		console.log(
			'Generated build/icon.png and build/icon.icns from build/icon.svg.'
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

try {
	generate();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
