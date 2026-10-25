import {
	fetchBoundedRemoteImage,
	inspectReferenceImageBytes,
	type RemoteImageFetcher,
} from './image-overlay-import';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const limits = {
	maxBytes: 1_024,
	maxDimension: 1_000,
	maxPixels: 1_000_000,
	allowedRemoteHosts: ['designs.example.com'],
};

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
	return Uint8Array.from([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0,
		7,
		8,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
	]);
}

function webp(width: number, height: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(30);
	bytes.set(new TextEncoder().encode('RIFF'), 0);
	bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
	new DataView(bytes.buffer).setUint32(16, 10, true);
	const widthMinusOne = width - 1;
	const heightMinusOne = height - 1;
	bytes.set(
		[
			widthMinusOne & 0xff,
			(widthMinusOne >> 8) & 0xff,
			(widthMinusOne >> 16) & 0xff,
			heightMinusOne & 0xff,
			(heightMinusOne >> 8) & 0xff,
			(heightMinusOne >> 16) & 0xff,
		],
		24,
	);
	return bytes;
}

function response(
	chunks: readonly Uint8Array<ArrayBuffer>[],
	options: { contentLength?: string; redirected?: boolean } = {},
): Awaited<ReturnType<RemoteImageFetcher>> {
	return {
		body: new ReadableStream<Uint8Array<ArrayBuffer>>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
		headers: new Headers(
			options.contentLength
				? { 'content-length': options.contentLength }
				: undefined,
		),
		ok: true,
		redirected: options.redirected ?? false,
		status: 200,
		url: 'https://designs.example.com/reference.png',
	};
}

describe('reference image header inspection', () => {
	it('reads PNG, JPEG, and WebP dimensions without a native decode', () => {
		expect(inspectReferenceImageBytes(png(390, 844))).toEqual({
			mimeType: 'image/png',
			width: 390,
			height: 844,
		});
		expect(inspectReferenceImageBytes(jpeg(320, 640))).toEqual({
			mimeType: 'image/jpeg',
			width: 320,
			height: 640,
		});
		expect(inspectReferenceImageBytes(webp(428, 926))).toEqual({
			mimeType: 'image/webp',
			width: 428,
			height: 926,
		});
	});

	it('rejects unrecognized payloads', () => {
		expect(() => inspectReferenceImageBytes(new Uint8Array(64))).toThrow(
			'valid PNG, JPEG, or WebP',
		);
	});
});

describe('fetchBoundedRemoteImage', () => {
	it('streams an allowlisted image with credentials omitted and no redirects', async () => {
		const bytes = png(390, 844);
		const fetcher = jest.fn(async () => response([bytes]));
		await expect(
			fetchBoundedRemoteImage(
				'https://designs.example.com/reference.png',
				limits,
				fetcher,
			),
		).resolves.toEqual(
			expect.objectContaining({
				mimeType: 'image/png',
				width: 390,
				height: 844,
			}),
		);
		expect(fetcher).toHaveBeenCalledWith(
			'https://designs.example.com/reference.png',
			expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
		);
	});

	it('rejects unsafe URLs, declared oversize, redirects, and streamed oversize', async () => {
		const fetcher = jest.fn(async () => response([png(20, 20)]));
		await expect(
			fetchBoundedRemoteImage(
				'http://designs.example.com/reference.png',
				limits,
				fetcher,
			),
		).rejects.toThrow('HTTPS');
		await expect(
			fetchBoundedRemoteImage(
				'https://designs.example.com/reference.png',
				limits,
				async () => response([], { contentLength: '2048' }),
			),
		).rejects.toThrow('cannot exceed');
		await expect(
			fetchBoundedRemoteImage(
				'https://designs.example.com/reference.png',
				limits,
				async () => response([], { redirected: true }),
			),
		).rejects.toThrow('redirects');
		await expect(
			fetchBoundedRemoteImage(
				'https://designs.example.com/reference.png',
				limits,
				async () => response([new Uint8Array(limits.maxBytes + 1)]),
			),
		).rejects.toThrow('cannot exceed');
	});
});
