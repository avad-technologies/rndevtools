import {
	createImageOverlayController,
	validateImageOverlaySource,
} from './image-overlay';

const limits = {
	maxBytes: 20 * 1024 * 1024,
	maxDimension: 8_192,
	maxPixels: 40_000_000,
	allowedRemoteHosts: ['designs.example.com'],
};

describe('validateImageOverlaySource', () => {
	it('accepts bounded local and allowlisted remote images', () => {
		expect(
			validateImageOverlaySource(
				{
					kind: 'file',
					uri: 'file:///tmp/reference.png',
					mimeType: 'image/png',
					bytes: 1_024,
					width: 390,
					height: 844,
				},
				limits,
			),
		).toEqual(expect.objectContaining({ kind: 'file', width: 390 }));
		expect(
			validateImageOverlaySource(
				{
					kind: 'remote',
					uri: 'https://designs.example.com/screen.png',
					renderUri: 'file:///cache/screen.png',
					mimeType: 'image/png',
					bytes: 2_048,
					width: 390,
					height: 844,
				},
				limits,
			),
		).toEqual(expect.objectContaining({ kind: 'remote' }));
	});

	it('rejects unsafe schemes, hosts, bytes, and decode dimensions', () => {
		const base = {
			kind: 'remote' as const,
			uri: 'https://designs.example.com/screen.png',
			renderUri: 'file:///cache/screen.png',
			mimeType: 'image/png' as const,
			bytes: 2_048,
			width: 390,
			height: 844,
		};
		expect(() =>
			validateImageOverlaySource(
				{ ...base, uri: 'http://designs.example.com/x' },
				limits,
			),
		).toThrow('HTTPS');
		expect(() =>
			validateImageOverlaySource(
				{ ...base, uri: 'https://evil.example/x' },
				limits,
			),
		).toThrow('allowlisted');
		expect(() =>
			validateImageOverlaySource(
				{ ...base, bytes: limits.maxBytes + 1 },
				limits,
			),
		).toThrow('cannot exceed');
		expect(() =>
			validateImageOverlaySource({ ...base, width: 9_000 }, limits),
		).toThrow('decode budget');
		expect(() =>
			validateImageOverlaySource(
				{
					...base,
					kind: 'clipboard',
					uri: 'data:image/webp;base64,AAAA',
					renderUri: undefined,
				},
				limits,
			),
		).toThrow('matching base64');
	});
});

describe('createImageOverlayController', () => {
	it('clamps transforms, follows an anchor, and clears exactly', () => {
		const controller = createImageOverlayController(limits);
		const listener = jest.fn();
		controller.subscribe(listener);
		controller.setSource({
			kind: 'file',
			uri: 'file:///tmp/reference.png',
			mimeType: 'image/png',
			bytes: 1_024,
			width: 390,
			height: 844,
		});
		controller.patch({
			opacity: 2,
			scale: 10,
			offsetX: 50,
			anchorTargetId: ' target-1 ',
			fit: 'cover',
		});
		expect(controller.getSnapshot()).toEqual(
			expect.objectContaining({
				opacity: 1,
				scale: 5,
				offsetX: 50,
				anchorTargetId: 'target-1',
				fit: 'cover',
			}),
		);
		controller.patch({ anchorTargetId: null });
		expect(controller.getSnapshot().anchorTargetId).toBeUndefined();
		controller.clear();
		expect(controller.getSnapshot()).toEqual(
			expect.objectContaining({ opacity: 0.5, scale: 1 }),
		);
		expect(controller.getSnapshot().source).toBeUndefined();
		expect(listener).toHaveBeenCalled();
	});
});
