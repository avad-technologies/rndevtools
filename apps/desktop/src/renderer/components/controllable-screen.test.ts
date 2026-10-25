import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllableScreen, pointerToRatio } from './controllable-screen';

const useLiveScreen = vi.hoisted(() =>
	vi.fn((_udid: string, _quality: string, _active: boolean) => ({
		screen: undefined,
		status: undefined,
	}))
);
vi.mock('@/state/simulator-stream-runtime', () => ({ useLiveScreen }));

const UDID = 'AAAAAAAA-0000-4000-8000-000000000001';

describe('pointerToRatio', () => {
	const frame = { left: 100, top: 50, width: 300, height: 650 };

	it('maps a pointer inside the rendered frame to 0…1 ratios of the device screen', () => {
		expect(pointerToRatio(frame, 100, 50)).toEqual({ x: 0, y: 0 });
		expect(pointerToRatio(frame, 400, 700)).toEqual({ x: 1, y: 1 });
		expect(pointerToRatio(frame, 250, 375)).toEqual({ x: 0.5, y: 0.5 });
		// Rounded to four places so an agent reading the log sees stable numbers.
		expect(pointerToRatio(frame, 100 + 100 / 3, 50)).toEqual({
			// 33.3 px of 300
			x: 0.1111,
			y: 0,
		});
	});

	it('ignores pointers in the letterbox outside the frame and degenerate frames', () => {
		expect(pointerToRatio(frame, 99, 300)).toBeUndefined();
		expect(pointerToRatio(frame, 250, 701)).toBeUndefined();
		expect(pointerToRatio({ ...frame, width: 0 }, 100, 50)).toBeUndefined();
	});
});

describe('ControllableScreen', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		useLiveScreen.mockClear();
	});

	it('streams the focus screen only once it has been seen on screen', () => {
		vi.stubGlobal('window', {});
		const html = renderToStaticMarkup(
			createElement(ControllableScreen, {
				udid: UDID,
				name: 'iPhone 17 Pro',
				live: true,
			})
		);
		// A collapsed Live screen or a detail scrolled past it never reports
		// visible, so the 250 ms poller is never asked for.
		expect(useLiveScreen).toHaveBeenCalledWith(UDID, 'focus', false);
		expect(useLiveScreen).not.toHaveBeenCalledWith(UDID, 'focus', true);
		// DeviceScreen watches its own `.device-screen` box, with no wrapper: the
		// `display: contents` one wall tiles used to watch never intersects.
		expect(html).toMatch(
			/<div class="controllable-screen-surface"><div class="device-screen /
		);
	});
});
