import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
// electron-vite is pinned to 6.0.0-beta.8, which is byte-identical to 6.0.0
// apart from its version string. Move the pin to 6.0.0 once 6.0.0 clears the
// seven-day release age on 2026-10-21.
import type { UserConfig } from 'electron-vite';
import { defineConfig } from 'electron-vite';

export const WS_OPTIONAL_NATIVE_PEERS = [
	'bufferutil',
	'utf-8-validate',
] as const;

const rendererAliases = {
	'@': path.resolve(__dirname, 'src/renderer'),
};

export const electronViteConfig = {
	main: {
		build: {
			outDir: 'dist/main',
			sourcemap: true,
			// `ws` requires these native accelerators inside a try/catch and falls back to
			// its JS implementations. Bundling them makes Vite hoist an unresolved-import
			// `throw` to module scope, outside that try/catch, which crashes main on load.
			rolldownOptions: { external: [...WS_OPTIONAL_NATIVE_PEERS] },
		},
	},
	preload: {
		build: { outDir: 'dist/preload', sourcemap: true },
	},
	renderer: {
		plugins: [react(), tailwindcss()],
		resolve: { alias: rendererAliases },
		build: { outDir: 'dist/renderer', sourcemap: true },
	},
} satisfies UserConfig;

export default defineConfig(electronViteConfig);
