import { describe, expect, it } from 'vitest';
import {
	electronViteConfig,
	WS_OPTIONAL_NATIVE_PEERS,
} from './electron.vite.config';
import vitestConfig from './vitest.config';

describe('Electron Vite configuration', () => {
	it('preserves ws optional-native-peer fallbacks in the main bundle', () => {
		expect(WS_OPTIONAL_NATIVE_PEERS).toEqual(['bufferutil', 'utf-8-validate']);
		expect(electronViteConfig.main.build.rolldownOptions.external).toEqual(
			WS_OPTIONAL_NATIVE_PEERS
		);
	});

	it('gives Vitest the same path aliases as the renderer build', () => {
		expect(vitestConfig.resolve?.alias).toEqual(
			electronViteConfig.renderer.resolve.alias
		);
	});
});
