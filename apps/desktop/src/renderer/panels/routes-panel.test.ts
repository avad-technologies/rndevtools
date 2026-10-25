import { describe, expect, it } from 'vitest';
import type { RouteEntry } from '../../shared/protocol';
import { navigateDisabledReason } from './routes-panel';

function route(overrides: Partial<RouteEntry>): RouteEntry {
	return {
		id: 'r',
		path: '/x',
		name: 'X',
		kind: 'static',
		isCurrent: false,
		isVisible: false,
		depth: 0,
		...overrides,
	};
}

describe('navigateDisabledReason', () => {
	it('requires a selected route', () => {
		expect(navigateDisabledReason(null, null)).toBe('Select a route first.');
	});

	it('blocks the currently visible route', () => {
		expect(navigateDisabledReason(route({ isCurrent: true }), null)).toBe(
			'This route is already visible.'
		);
	});

	it('blocks routes that need parameters', () => {
		expect(navigateDisabledReason(route({ kind: 'dynamic' }), null)).toBe(
			'Dynamic and layout routes need parameters supplied on the device.'
		);
		expect(
			navigateDisabledReason(route({ kind: 'layout' }), null)
		).toBeTruthy();
	});

	it('surfaces the device action reason for a navigable route', () => {
		expect(
			navigateDisabledReason(route({}), 'The selected device is offline.')
		).toBe('The selected device is offline.');
	});

	it('allows navigation for a static non-current route with no action block', () => {
		expect(navigateDisabledReason(route({}), null)).toBeNull();
		expect(navigateDisabledReason(route({ kind: 'group' }), null)).toBeNull();
	});
});
