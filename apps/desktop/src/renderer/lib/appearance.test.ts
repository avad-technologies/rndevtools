import { describe, expect, it } from 'vitest';
import { applyTheme, resolveTheme } from './appearance';

function root() {
	const classes = new Set<string>();
	return {
		classes,
		element: {
			classList: {
				toggle: (name: string, force?: boolean) => {
					if (force) classes.add(name);
					else classes.delete(name);
					return Boolean(force);
				},
			} as unknown as DOMTokenList,
			dataset: {} as DOMStringMap,
		},
	};
}

describe('appearance', () => {
	it('follows macOS only for the system preference', () => {
		expect(resolveTheme('system', true)).toBe('dark');
		expect(resolveTheme('system', false)).toBe('light');
		expect(resolveTheme('light', true)).toBe('light');
		expect(resolveTheme('dark', false)).toBe('dark');
	});

	it('leaves exactly one theme on the root element', () => {
		const { classes, element } = root();
		applyTheme(element, 'dark');
		expect([...classes]).toEqual(['dark']);
		expect(element.dataset.theme).toBe('dark');
		applyTheme(element, 'light');
		expect([...classes]).toEqual(['light']);
		expect(element.dataset.theme).toBe('light');
	});
});
