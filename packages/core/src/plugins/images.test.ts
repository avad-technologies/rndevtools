import {
	analyzeImageDiagnostic,
	createImageDiagnosticsPlugin,
	describeImageSource,
	type ImageDiagnosticEntry,
	summarizeImageDiagnostics,
} from '@rndevtools/core/plugins/images';
import { DevtoolsEventStore } from '../core/event-store';

function install(
	diagnostics: ReturnType<typeof createImageDiagnosticsPlugin>,
): () => void {
	const dispose = diagnostics.plugin.install?.();
	expect(dispose).toEqual(expect.any(Function));
	return dispose ?? (() => {});
}

function entry(
	overrides: Partial<ImageDiagnosticEntry> = {},
): ImageDiagnosticEntry {
	return Object.freeze({
		id: 'image-1',
		source: describeImageSource('https://images.example.com/example.png'),
		state: 'displayed',
		startedAt: 100,
		accessibility: 'labeled',
		...overrides,
	});
}

describe('describeImageSource', () => {
	it('strips remote credentials, signed queries, and fragments', () => {
		const descriptor = describeImageSource(
			'https://user:secret@images.example.com/avatar.png?token=top-secret&signature=signed#private',
		);

		expect(descriptor).toMatchObject({
			kind: 'remote',
			label: 'https://images.example.com/avatar.png',
			redacted: true,
		});
		const serialized = JSON.stringify(descriptor);
		expect(serialized).not.toContain('secret');
		expect(serialized).not.toContain('token');
		expect(serialized).not.toContain('signature');
		expect(serialized).not.toContain('private');
	});

	it('never invokes image-source accessors and hides local paths and data', () => {
		const uriGetter = jest.fn(() => {
			throw new Error('must not execute');
		});
		const hostile = Object.defineProperty({}, 'uri', { get: uriGetter });

		expect(describeImageSource(hostile)).toMatchObject({
			kind: 'native',
			label: '[native image reference]',
		});
		expect(uriGetter).not.toHaveBeenCalled();
		expect(
			describeImageSource('file:///private/user/portrait.JPEG'),
		).toMatchObject({
			kind: 'local',
			label: 'file://[local].jpeg',
			redacted: true,
		});
		expect(
			describeImageSource('data:image/png;base64,super-private-payload'),
		).toMatchObject({
			kind: 'data',
			label: 'data:image/png;[payload redacted]',
			redacted: true,
		});
	});
});

describe('createImageDiagnosticsPlugin', () => {
	it('does no collection outside an installed plugin lifetime', () => {
		const diagnostics = createImageDiagnosticsPlugin();
		expect(
			diagnostics.beginLoad({ source: 'https://images.example.com/a.png' }),
		).toBeNull();

		const disposeFirst = install(diagnostics);
		const disposeSecond = install(diagnostics);
		expect(
			diagnostics.beginLoad({ source: 'https://images.example.com/a.png' }),
		).toBe('image-1');
		disposeFirst();
		expect(
			diagnostics.beginLoad({ source: 'https://images.example.com/b.png' }),
		).toBe('image-2');
		disposeSecond();
		expect(
			diagnostics.beginLoad({ source: 'https://images.example.com/c.png' }),
		).toBeNull();
		expect(diagnostics.getEntries()).toHaveLength(2);
	});

	it('records a bounded load lifecycle and rate-limits intermediate progress', () => {
		let now = 1_000;
		const diagnostics = createImageDiagnosticsPlugin({ now: () => now });
		const dispose = install(diagnostics);
		const id = diagnostics.beginLoad({
			source: { uri: 'https://images.example.com/a.png?token=secret' },
			targetId: ' hero-image ',
			renderedSize: { width: 200, height: 100 },
			cachePolicy: 'memory-disk',
			contentFit: 'cover',
			accessibilityLabel: 'Hero',
		});
		expect(id).toBe('image-1');

		now = 1_100;
		diagnostics.recordProgress(id ?? '', 10, 100);
		expect(diagnostics.getEntries()[0]?.progressAt).toBe(1_100);
		now = 1_200;
		diagnostics.recordProgress(id ?? '', 30, 100);
		expect(diagnostics.getEntries()[0]?.loadedBytes).toBe(10);
		now = 1_350;
		diagnostics.recordProgress(id ?? '', 40, 100);
		now = 1_400;
		diagnostics.recordProgress(id ?? '', 100, 100);
		now = 1_500;
		diagnostics.recordLoad(id ?? '', {
			intrinsicSize: { width: 800, height: 400 },
			cacheType: 'disk',
		});
		now = 1_650;
		diagnostics.recordDisplay(id ?? '');

		expect(diagnostics.getEntries()[0]).toEqual(
			expect.objectContaining({
				id,
				targetId: 'hero-image',
				state: 'displayed',
				progressAt: 1_400,
				loadedBytes: 100,
				totalBytes: 100,
				loadedAt: 1_500,
				displayedAt: 1_650,
				intrinsicSize: { width: 800, height: 400 },
				renderedSize: { width: 200, height: 100 },
				cachePolicy: 'memory-disk',
				cacheType: 'disk',
				contentFit: 'cover',
				accessibility: 'labeled',
			}),
		);
		dispose();
	});

	it('redacts errors and emits correlated bounded timeline events', () => {
		let now = 10;
		const events = new DevtoolsEventStore({
			maxEvents: 20,
			maxBytes: 64 * 1024,
			now: () => now,
		});
		const diagnostics = createImageDiagnosticsPlugin({
			eventStore: events,
			now: () => now,
		});
		const dispose = install(diagnostics);
		const id = diagnostics.beginLoad({
			source: 'https://images.example.com/a.png?token=source-secret',
		});
		now = 20;
		diagnostics.recordError(
			id ?? '',
			new Error('failed token=error-secret https://private.example/path?key=x'),
		);

		const captured = diagnostics.getEntries()[0];
		expect(captured?.state).toBe('error');
		expect(JSON.stringify(captured)).not.toContain('source-secret');
		expect(JSON.stringify(captured)).not.toContain('error-secret');
		expect(events.getEvents().map((event) => event.kind)).toEqual([
			'image.load.started',
			'image.load.failed',
		]);
		expect(events.getEvents()[1]?.resourceRef).toEqual({
			toolId: 'images',
			resourceId: id,
		});
		dispose();
	});

	it('evicts old entries by count and rejects entries outside the byte budget', () => {
		const diagnostics = createImageDiagnosticsPlugin({
			maxEntries: 2,
			maxBytes: 8 * 1024,
		});
		const dispose = install(diagnostics);
		diagnostics.beginLoad({ source: 1 });
		diagnostics.beginLoad({ source: 2 });
		diagnostics.beginLoad({ source: 3 });
		expect(diagnostics.getEntries().map((candidate) => candidate.id)).toEqual([
			'image-2',
			'image-3',
		]);
		dispose();

		const tooSmall = createImageDiagnosticsPlugin({ maxBytes: 1 });
		const disposeSmall = install(tooSmall);
		expect(tooSmall.beginLoad({ source: 1 })).toBeNull();
		expect(tooSmall.getEntries()).toEqual([]);
		disposeSmall();
	});
});

describe('image diagnostic analysis', () => {
	it('reports unavailable intrinsic findings instead of guessing', () => {
		expect(
			analyzeImageDiagnostic(
				entry({
					intrinsicSize: undefined,
					renderedSize: { width: 500, height: 500 },
				}),
			),
		).toMatchObject({
			upscaling: 'unavailable',
			excessiveDecodedPixels: 'unavailable',
			aspectMismatch: 'unavailable',
		});
	});

	it('finds likely scale, decode, aspect, accessibility, and repeated failures', () => {
		const failedOne = entry({
			id: 'image-1',
			state: 'error',
			accessibility: 'missing',
			intrinsicSize: { width: 4_000, height: 2_000 },
			renderedSize: { width: 2_500, height: 2_500 },
			errorAt: 200,
		});
		const failedTwo = entry({ ...failedOne, id: 'image-2' });
		const analysis = analyzeImageDiagnostic(failedOne, [failedOne, failedTwo]);

		expect(analysis).toMatchObject({
			upscaling: 'likely',
			excessiveDecodedPixels: 'not-detected',
			aspectMismatch: 'likely',
			repeatedFailure: true,
			missingAccessibilityLabel: true,
			decodedPixels: 8_000_000,
			decodedBytes: 32_000_000,
		});
		expect(summarizeImageDiagnostics([failedOne, failedTwo])).toEqual({
			total: 2,
			loading: 0,
			displayed: 0,
			failed: 2,
			likelyIssues: 2,
		});
	});

	it('detects excessive decoded pixels when the render target is much smaller', () => {
		expect(
			analyzeImageDiagnostic(
				entry({
					intrinsicSize: { width: 4_000, height: 2_000 },
					renderedSize: { width: 400, height: 200 },
				}),
			).excessiveDecodedPixels,
		).toBe('likely');
	});
});
