import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesktopErrorBoundary, PanelErrorBoundary } from './error-boundary';

// Server rendering never runs error boundaries, so these subclasses start in
// the state a caught error leaves behind.
function failedPanel(error: unknown, panel: string, label: string): string {
	class FailedPanel extends PanelErrorBoundary {
		override state = { failure: { error } };
	}
	return renderToStaticMarkup(
		createElement(FailedPanel, { panel, label, children: 'panel content' })
	);
}

function failedRoot(error: unknown): string {
	class FailedRoot extends DesktopErrorBoundary {
		override state = { failure: { error } };
	}
	return renderToStaticMarkup(
		createElement(FailedRoot, { children: 'app content' })
	);
}

describe('PanelErrorBoundary', () => {
	it('renders its panel until something throws', () => {
		expect(
			renderToStaticMarkup(
				createElement(PanelErrorBoundary, {
					panel: 'simulator/lanes',
					label: 'Lanes',
					children: 'panel content',
				})
			)
		).toBe('panel content');
	});

	it('replaces only the failed panel and offers the Simulators panel', () => {
		const html = failedPanel(
			new Error('Lane list exploded'),
			'simulator/lanes',
			'Lanes'
		);
		// The e2e harness detects both boundaries by this class.
		expect(html).toContain('class="fatal-error"');
		expect(html).toContain('Lanes could not render');
		expect(html).toContain('Lane list exploded');
		expect(html).toContain('Open Simulators');
		expect(html).not.toContain('panel content');
	});

	it('retries in place when the Simulators panel itself failed', () => {
		const html = failedPanel(
			new Error('boom'),
			'simulator/fleet',
			'Simulators'
		);
		expect(html).toContain('Try again');
		expect(html).not.toContain('Open Simulators');
	});

	it('shows the error redacted and bounded', () => {
		const html = failedPanel(
			new Error(`token=example-secret ${'x'.repeat(20_000)}`),
			'connected/network',
			'Network'
		);
		expect(html).not.toContain('example-secret');
		expect(html).not.toContain('x'.repeat(8 * 1024));
	});

	it('treats a thrown undefined as a failure', () => {
		expect(PanelErrorBoundary.getDerivedStateFromError(undefined)).toEqual({
			failure: { error: undefined },
		});
		expect(failedPanel(undefined, 'simulator/lanes', 'Lanes')).toContain(
			'Unknown error'
		);
	});
});

describe('DesktopErrorBoundary', () => {
	it('treats a thrown undefined as a failure', () => {
		expect(DesktopErrorBoundary.getDerivedStateFromError(undefined)).toEqual({
			failure: { error: undefined },
		});
		const html = failedRoot(undefined);
		expect(html).toContain('class="fatal-error"');
		expect(html).toContain('Unknown error');
		expect(html).toContain('Reload desktop app');
		expect(html).not.toContain('app content');
	});
});
