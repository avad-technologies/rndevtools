import { createDevToolsActionCoordinator } from '../core/action-policy';
import { DevtoolsEventStore } from '../core/event-store';
import { utf8ByteLength } from '../core/serialize';
import {
	exportNetworkSimulationPreference,
	getNetworkSimulationProfile,
	importNetworkSimulationPreference,
	MAX_NETWORK_SIMULATION_PREFERENCE_BYTES,
	NETWORK_SIMULATION_PROFILE_IDS,
} from '../network-profile';
import {
	buildCurlCommand,
	collapseNetworkEvents,
	createNetworkPlugin as createNetworkPluginBase,
	detailStatusText,
	formatNetworkBytes,
	formatNetworkClock,
	formatNetworkDuration,
	inferNetworkCacheStatus,
	isSupabaseNetworkEvent,
	isSystemNetworkEvent,
	matchesNetworkSegment,
	NETWORK_SIMULATION_CAPABILITY_ID,
	type NetworkEvent,
	type NetworkPluginOptions,
	networkEventLabel,
	networkReplayBlockReason,
	networkRequestPath,
	networkRowSubtitle,
	networkStatusPresentation,
	parseNetworkUrl,
	prettyNetworkBody,
	responseBodySummaryText,
	summarizeNetworkEvents,
	summarizeNetworkInsights,
} from './network';
import {
	captureHeaders,
	defaultRedactBody,
	defaultRedactUrl,
	parseContentLength,
} from './network-capture';

function createNetworkPlugin(options: NetworkPluginOptions = {}) {
	return createNetworkPluginBase({
		// Most tests exercise the explicitly trusted host boundary. Dedicated
		// noninterference tests below call the production default directly.
		trustExplicitFetchRequests: true,
		trustExplicitFetchResponses: true,
		trustGlobalFetchRequests: true,
		trustGlobalFetchResponses: true,
		...options,
	});
}

function networkEvent(overrides: Partial<NetworkEvent> = {}): NetworkEvent {
	return {
		sessionId: 'test-session',
		id: 1,
		startedAt: 0,
		method: 'GET',
		url: 'https://example.test/items',
		state: 'success',
		status: 200,
		durationMs: 120,
		requestProjectionComplete: true,
		captureTransport: 'global-fetch',
		bodyCaptureEnabled: true,
		requestHeaders: {},
		source: 'Instrumented fetch',
		...overrides,
	};
}

function streamedBodyClone(body: string) {
	const bytes = new TextEncoder().encode(body);
	let sent = false;
	return {
		body: {
			getReader: () => ({
				read: async () => {
					if (sent) return { done: true, value: undefined };
					sent = true;
					return { done: false, value: bytes };
				},
				cancel: async () => {},
			}),
		},
	};
}

function response(body: string, status = 200): Response {
	const headers = new Headers({
		'content-length': String(new TextEncoder().encode(body).byteLength),
		'content-type': 'application/json',
	});
	return new Response(body, { status, headers });
}

async function flushCapture(): Promise<void> {
	for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function confirmedSimulationOptions() {
	return {
		enableSimulation: true,
		actionCoordinator: createDevToolsActionCoordinator({
			confirm: async () => true,
		}),
	} as const;
}

describe('createNetworkPlugin', () => {
	it('parses query parameters and formats payload sizes', () => {
		expect(parseNetworkUrl('https://example.test/items?a=1&a=2')).toEqual({
			host: 'example.test',
			origin: 'https://example.test',
			path: 'https://example.test/items',
			pathname: '/items',
			query: { a: ['1', '2'] },
		});
		expect(formatNetworkBytes(1536)).toBe('1.5 KB');
	});

	it('redacts decoded sensitive values from percent-encoded URL parameters', () => {
		const redacted = new URL(
			defaultRedactUrl(
				'https://example.test/users/victim%40example.com?q=victim%40example.com&note=Bearer%20abc.def&visible=yes#Bearer%20abc.def',
			),
		);

		expect(decodeURIComponent(redacted.pathname)).toBe('/users/[REDACTED]');
		expect(redacted.searchParams.get('q')).toBe('[REDACTED]');
		expect(redacted.searchParams.get('note')).toBe('[REDACTED]');
		expect(redacted.searchParams.get('visible')).toBe('yes');
		expect(decodeURIComponent(redacted.hash)).toBe('#[REDACTED]');
	});

	it('redacts nested percent encoding in URL keys and components', () => {
		const redacted = new URL(
			defaultRedactUrl(
				'https://example.test/password%253Dhunter2?%2570assword=hunter2&safe=yes#to%256Ben%253Dhunter2',
			),
		);

		expect(decodeURIComponent(redacted.pathname)).toBe('/[REDACTED]');
		expect([...redacted.searchParams.values()]).toEqual(['[REDACTED]', 'yes']);
		expect([...redacted.searchParams.keys()]).toEqual(['[REDACTED]', 'safe']);
		expect(redacted.toString()).not.toContain('hunter2');
		expect(decodeURIComponent(redacted.hash)).toBe('#[REDACTED]');
	});

	it('fails malformed encoded URLs closed without retaining credentials', () => {
		const redacted = defaultRedactUrl(
			'http://[invalid]?token%253Dhunter2&email%253Dvictim%2540example.com',
		);

		expect(redacted).toBe('[URL omitted: invalid URL]');
		expect(redacted).not.toContain('hunter2');
		expect(redacted).not.toContain('victim');
	});

	it('omits payload-bearing and non-network URL schemes', () => {
		expect(defaultRedactUrl('data:text/plain,opaque-hunter2-secret')).toBe(
			'[URL omitted: unsupported scheme]',
		);
		expect(defaultRedactUrl('file:///tmp/token%3Dhunter2')).toBe(
			'[URL omitted: unsupported scheme]',
		);
	});

	it('redacts path values that follow sensitive key segments', () => {
		const redacted = defaultRedactUrl(
			'https://example.test/password/hunter2/public/pass%2577ord/nested-secret',
		);
		const segments = new URL(redacted).pathname
			.split('/')
			.filter(Boolean)
			.map(decodeURIComponent);

		expect(segments).toEqual([
			'[REDACTED]',
			'[REDACTED]',
			'public',
			'[REDACTED]',
			'[REDACTED]',
		]);
		expect(redacted).not.toMatch(/hunter2|nested-secret|pass%/);
	});

	it('replaces encoded sensitive header names as well as their values', () => {
		const { headers } = captureHeaders(
			new Headers([
				['pass%77ord', 'hunter2'],
				['to%256ben%253dhunter2', 'still-secret'],
				['x-safe', 'visible'],
			]),
			(_name, value) => value,
		);
		const exposed = JSON.stringify(headers);

		expect(headers['x-safe']).toBe('visible');
		expect(Object.keys(headers)).toEqual(
			expect.arrayContaining(['[header-1-redacted]', '[header-2-redacted]']),
		);
		expect(exposed).not.toMatch(/hunter2|still-secret|pass%77ord|to%/i);
	});

	it('omits XML bodies instead of attempting incomplete secret parsing', () => {
		for (const body of [
			'<root><password>hunter2</password></root>',
			'<ns:root><ns:Token>abc123</ns:Token></ns:root>',
			'<entry key="password">hunter2</entry>',
			'<field name="token">abc123</field>',
			'<root><key>password</key><value>hunter2</value></root>',
			'<!--diagnostic--><entry key="password">hunter2</entry>',
			'<!DOCTYPE root><entry key="password">hunter2</entry>',
			'<?target x?><entry key="password">hunter2</entry>',
			'<!DOCTYPE entry [<!ELEMENT entry (#PCDATA)>]><entry key="password">hunter2</entry>',
		]) {
			expect(defaultRedactBody(body)).toBe('[Body omitted: XML content]');
		}
	});
	it('passes through without collecting while the plugin is not installed', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const expectedResponse = response('{"ok":true}');
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const actualResponse = await instrumentedFetch('https://example.test');

		expect(actualResponse).toBe(expectedResponse);
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('does not inspect hostile request options while the collector is inactive', async () => {
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => {
				throw new Error('inactive capture authority must not run');
			},
		});
		const getPrototypeOf = jest.fn(() => Object.prototype);
		const ownKeys = jest.fn(() => [] as (string | symbol)[]);
		const init = new Proxy(
			{},
			{
				getPrototypeOf,
				ownKeys,
			},
		) as RequestInit;
		const fetchImplementation = jest.fn(async (_input, receivedInit) => {
			expect(receivedInit).toBe(init);
			return response('{}');
		}) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/inactive',
			init,
		);

		expect(getPrototypeOf).not.toHaveBeenCalled();
		expect(ownKeys).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('does not inspect hostile request options while capture is paused or revoked', async () => {
		for (const mode of ['paused', 'revoked'] as const) {
			const diagnostics = createNetworkPlugin(
				mode === 'revoked' ? { captureAuthority: () => null } : {},
			);
			const dispose = diagnostics.plugin.install?.();
			if (mode === 'paused') diagnostics.pause();
			const getPrototypeOf = jest.fn(() => Object.prototype);
			const ownKeys = jest.fn(() => [] as (string | symbol)[]);
			const init = new Proxy(
				{},
				{
					getPrototypeOf,
					ownKeys,
				},
			) as RequestInit;
			const fetchImplementation = jest.fn(async (_input, receivedInit) => {
				expect(receivedInit).toBe(init);
				return response('{}');
			}) as unknown as typeof fetch;

			await diagnostics.instrumentFetch(fetchImplementation)(
				`https://example.test/${mode}`,
				init,
			);

			expect(getPrototypeOf).not.toHaveBeenCalled();
			expect(ownKeys).not.toHaveBeenCalled();
			expect(diagnostics.getEvents()).toEqual([]);
			dispose?.();
		}
	});

	it('delegates stringifiable nonstandard inputs without trusting their URL shape', async () => {
		const diagnostics = createNetworkPluginBase();
		const dispose = diagnostics.plugin.install?.();
		const urlGetter = jest.fn(() => {
			throw new Error('diagnostics must not read arbitrary url getters');
		});
		const input = {
			toString: () => 'data:text/plain,ok',
		};
		Object.defineProperty(input, 'url', { get: urlGetter });
		const fetchImplementation = jest.fn(async (receivedInput) => {
			expect(String(receivedInput)).toBe('data:text/plain,ok');
			return response('{}');
		}) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			input as unknown as RequestInfo,
		);

		expect(fetchImplementation).toHaveBeenCalledWith(input, undefined);
		expect(urlGetter).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				url: '[URL unavailable]',
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('blocks replay when fetch reads inherited RequestInit credentials', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const originalCredentials = Object.getOwnPropertyDescriptor(
			Object.prototype,
			'credentials',
		);
		try {
			Object.defineProperty(Object.prototype, 'credentials', {
				configurable: true,
				enumerable: false,
				value: 'omit',
			});
			await diagnostics.instrumentFetch(
				jest.fn(async () => response('{}')) as unknown as typeof fetch,
			)('https://example.test/inherited-init', {});
			await flushCapture();
		} finally {
			if (originalCredentials) {
				Object.defineProperty(
					Object.prototype,
					'credentials',
					originalCredentials,
				);
			} else {
				Reflect.deleteProperty(Object.prototype, 'credentials');
			}
		}

		expect(diagnostics.getEvents()[0]?.requestProjectionComplete).toBe(false);
		dispose?.();
	});

	it('does not invoke RequestInit accessors before the underlying fetch', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi');
		const methodGetter = jest.fn(() => 'POST');
		const init = Object.defineProperty({}, 'method', {
			configurable: true,
			enumerable: true,
			get: methodGetter,
		}) as RequestInit;
		const fetchImplementation = jest.fn(async (_input, receivedInit) => {
			expect(receivedInit?.method).toBe('POST');
			return response('{}');
		}) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/accessor-init',
			init,
		);

		expect(methodGetter).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				method: 'GET',
				requestProjectionComplete: false,
				simulationProfileId: 'none',
			}),
		);
		dispose?.();
	});

	it('does not invoke nested header accessors or consume iterables before fetch', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const headerGetter = jest.fn(() => 'header-value');
		const accessorHeaders = Object.defineProperty({}, 'x-debug', {
			configurable: true,
			enumerable: true,
			get: headerGetter,
		}) as HeadersInit;
		const iterator = jest.fn(function* () {
			yield ['x-iterated', 'once'] as [string, string];
		});
		const iterableHeaders = {
			[Symbol.iterator]: iterator,
		} as unknown as HeadersInit;
		const fetchImplementation = jest.fn(async (_input, receivedInit) => {
			const headers = new Headers(receivedInit?.headers);
			expect(headers.get('x-debug') ?? headers.get('x-iterated')).toMatch(
				/^(?:header-value|once)$/,
			);
			return response('{}');
		}) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		await instrumented('https://example.test/accessor-headers', {
			headers: accessorHeaders,
		});
		await instrumented('https://example.test/iterable-headers', {
			headers: iterableHeaders,
		});

		expect(headerGetter).toHaveBeenCalledTimes(1);
		expect(iterator).toHaveBeenCalledTimes(1);
		expect(
			diagnostics.getEvents().map((event) => ({
				headers: event.requestHeaders,
				replayComplete: event.requestProjectionComplete,
			})),
		).toEqual([
			{ headers: {}, replayComplete: false },
			{ headers: {}, replayComplete: false },
		]);
		dispose?.();
	});

	it('does not enumerate irrelevant request or tuple properties before fetch', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi');
			const tupleOwnKeys = jest.fn(() => {
				throw new Error('tuple keys must not be enumerated');
			});
			const tupleTarget = ['x-debug', 'ok'];
			Object.defineProperty(tupleTarget, 'irrelevant', { value: 'ignored' });
			const tuple = new Proxy(tupleTarget, { ownKeys: tupleOwnKeys });
			const headersOwnKeys = jest.fn(() => {
				throw new Error('outer array keys must not be enumerated');
			});
			const headersTarget = [tuple];
			Object.defineProperty(headersTarget, 'irrelevant', { value: 'ignored' });
			const headers = new Proxy(headersTarget, { ownKeys: headersOwnKeys });
			const initTarget = {
				customTransportToken: 'keep-me',
				headers,
				method: 'POST',
			};
			Object.defineProperty(initTarget, 'irrelevant', { value: 'ignored' });
			const initOwnKeys = jest.fn(() => {
				throw new Error('RequestInit keys must not be enumerated');
			});
			const init = new Proxy(initTarget, {
				ownKeys: initOwnKeys,
			}) as RequestInit & { customTransportToken: string };
			const fetchImplementation = jest.fn(async (_input, receivedInit) => {
				const customInit = receivedInit as RequestInit & {
					customTransportToken?: string;
				};
				expect(customInit.customTransportToken).toBe('keep-me');
				expect(customInit.method).toBe('POST');
				expect(new Headers(customInit.headers).get('x-debug')).toBe('ok');
				return response('{}');
			}) as unknown as typeof fetch;

			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/bounded-descriptors',
				init,
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;

			expect(initOwnKeys).not.toHaveBeenCalled();
			expect(headersOwnKeys).not.toHaveBeenCalled();
			expect(tupleOwnKeys).not.toHaveBeenCalled();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					method: 'POST',
					requestProjectionComplete: false,
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('preserves custom RequestInit accessor receivers under timed simulation', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi');
			const init = { method: 'POST' } as RequestInit & {
				readonly customTransportToken?: string;
			};
			Object.defineProperty(init, 'customTransportToken', {
				configurable: true,
				get(this: typeof init) {
					expect(this).toBe(init);
					return 'keep-me';
				},
			});
			const fetchImplementation = jest.fn(async (_input, receivedInit) => {
				const customInit = receivedInit as typeof init;
				expect(customInit.customTransportToken).toBe('keep-me');
				expect(customInit.signal).toBeDefined();
				return response('{}');
			}) as unknown as typeof fetch;

			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/custom-accessor',
				init,
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not invoke any untrusted RequestInit proxy trap before transport', async () => {
		const diagnostics = createNetworkPluginBase();
		const dispose = diagnostics.plugin.install?.();
		let phase = 0;
		const trapCalls: string[] = [];
		const init = new Proxy({ method: 'POST' } as RequestInit, {
			get(target, key, receiver) {
				trapCalls.push(`get:${String(key)}`);
				if (key === 'method') return phase === 0 ? 'POST' : 'DELETE';
				return Reflect.get(target, key, receiver);
			},
			getOwnPropertyDescriptor(target, key) {
				trapCalls.push(`descriptor:${String(key)}`);
				phase += 1;
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			getPrototypeOf(target) {
				trapCalls.push('prototype');
				phase += 1;
				return Reflect.getPrototypeOf(target);
			},
			has(target, key) {
				trapCalls.push(`has:${String(key)}`);
				phase += 1;
				return Reflect.has(target, key);
			},
		});
		const fetchImplementation = jest.fn(async (_input, receivedInit) => {
			expect(trapCalls).toEqual([]);
			expect(receivedInit?.method).toBe('POST');
			return response('{}');
		}) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/stateful-init',
			init,
		);

		expect(trapCalls).toEqual(['get:method']);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				method: 'GET',
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('does not invoke shadowed or proxied Request getters before transport', async () => {
		for (const variant of ['shadow', 'proxy'] as const) {
			const diagnostics = createNetworkPluginBase();
			const dispose = diagnostics.plugin.install?.();
			const original = new Request(`https://example.test/${variant}`);
			const reads: string[] = [];
			const input =
				variant === 'shadow'
					? (Object.defineProperty(original, 'url', {
							configurable: true,
							get: () => {
								reads.push('url');
								return 'https://attacker.invalid/';
							},
						}) as Request)
					: (new Proxy(original, {
							get(target, key, receiver) {
								reads.push(String(key));
								return Reflect.get(target, key, receiver);
							},
						}) as Request);
			const fetchImplementation = jest.fn(async (receivedInput) => {
				expect(receivedInput).toBe(input);
				expect(reads).toEqual([]);
				return response('{}');
			}) as unknown as typeof fetch;

			await diagnostics.instrumentFetch(fetchImplementation)(input);

			expect(reads).toEqual([]);
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					requestProjectionComplete: false,
					url: '[URL unavailable]',
				}),
			);
			dispose?.();
		}
	});

	it('bounds oversized URL and method projections without changing transport input', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi');
			const oversizedMethod = 'post'.repeat(32 * 1024);
			const oversizedUrl = `https://example.test/${'a'.repeat(128 * 1024)}`;
			const fetchImplementation = jest.fn(async (input, init) => {
				expect(input).toBe(oversizedUrl);
				expect(init?.method).toBe(oversizedMethod);
				return response('{}');
			}) as unknown as typeof fetch;

			const request = diagnostics.instrumentFetch(fetchImplementation)(
				oversizedUrl,
				{ method: oversizedMethod },
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;

			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					method: 'POSTPOSTPOSTPOST',
					requestProjectionComplete: false,
					url: '[URL omitted: input limit]',
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not invoke subclass body hooks before the underlying fetch', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const toStringSpy = jest.fn(() => 'query=safe');
		class CustomSearchParams extends URLSearchParams {
			override toString(): string {
				return toStringSpy();
			}
		}
		const body = new CustomSearchParams({ query: 'safe' });
		const fetchImplementation = jest.fn(async (_input, receivedInit) => {
			expect(receivedInit?.body?.toString()).toBe('query=safe');
			return response('{}');
		}) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/subclass-body',
			{ body, method: 'POST' },
		);
		await flushCapture();

		expect(toStringSpy).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				requestBody: '[Unsupported request body omitted]',
				requestProjectionComplete: false,
				requestSizeBytes: undefined,
			}),
		);
		dispose?.();
	});

	it('exposes immutable event snapshots and nested request metadata', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/immutable', {
			headers: { 'x-safe': 'original' },
		});
		await flushCapture();

		const events = diagnostics.getEvents();
		const event = events[0];
		expect(Object.isFrozen(events)).toBe(true);
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.isFrozen(event?.requestHeaders)).toBe(true);
		try {
			Reflect.set(event ?? {}, 'url', 'https://attacker.test');
			Reflect.set(event?.requestHeaders ?? {}, 'x-safe', 'changed');
			Reflect.set(events, '1', event);
		} catch {
			// Strict runtimes throw for frozen values.
		}
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				url: 'https://example.test/immutable',
				requestHeaders: { 'x-safe': 'original' },
			}),
		);
		expect(diagnostics.getEvents()).toHaveLength(1);
		dispose?.();
	});

	it('preserves the underlying fetch authority when no profile is active', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();
		const expectedResponse = response('{"ok":true}');
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;
		const controller = new AbortController();
		controller.abort(abortedErrorForTest());

		await expect(
			diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/underlying-authority',
				{ signal: controller.signal },
			),
		).resolves.toBe(expectedResponse);
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
		dispose?.();
	});

	it('captures bodies asynchronously and redacts sensitive headers', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const expectedResponse = response('{"ok":true}', 201);
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const actualResponse = await instrumentedFetch(
			'https://example.test/items',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
				},
				body: '{"name":"Example item"}',
			},
		);
		await flushCapture();

		expect(actualResponse).toBe(expectedResponse);
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				method: 'POST',
				status: 201,
				url: 'https://example.test/items',
				requestHeaders: expect.objectContaining({
					authorization: '[REDACTED]',
				}),
				requestBody: expect.stringContaining('Example item'),
				responseBody: expect.stringContaining('ok'),
				source: 'Instrumented fetch',
				requestSizeBytes: expect.any(Number),
				responseSizeBytes: expect.any(Number),
			}),
		]);

		dispose?.();
	});

	it('omits oversized text before a redaction pattern can be cut at the boundary', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxBodyBytes: 64,
		});
		const dispose = diagnostics.plugin.install?.();
		const boundarySecret = `${'x'.repeat(60)}person@example.com`;
		const fetchImplementation = jest.fn(async () =>
			responseWithHeaders(
				boundarySecret,
				200,
				new Headers({
					'content-length': '1',
					'content-type': 'text/plain',
				}),
			),
		) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/redaction-boundary',
			{ method: 'POST', body: boundarySecret },
		);
		await flushCapture();

		const event = diagnostics.getEvents()[0];
		expect(event?.requestBody).toContain('Body omitted');
		expect(event?.responseBody).toContain('Body omitted');
		expect(JSON.stringify(event)).not.toContain('person@example.com');
		expect(JSON.stringify(event)).not.toContain(`${'x'.repeat(20)}person`);
		dispose?.();
	});

	it('derives stored content type from the bounded redacted header projection', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const headers = new Headers({
			'content-length': '2',
			'content-type': 'text/plain; owner=person@example.com',
		});

		await diagnostics.instrumentFetch(
			jest.fn(async () =>
				responseWithHeaders('{}', 200, headers),
			) as unknown as typeof fetch,
		)('https://example.test/content-type');
		await flushCapture();

		const event = diagnostics.getEvents()[0];
		expect(event?.contentType).toBe(event?.responseHeaders?.['content-type']);
		expect(event?.contentType).toContain('[REDACTED EMAIL]');
		expect(JSON.stringify(event)).not.toContain('person@example.com');
		dispose?.();
	});

	it('keeps diagnostic projection failures from changing fetch behavior', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const input = Object.create(null) as { url?: string };
		Object.defineProperty(input, 'url', {
			get() {
				throw new Error('diagnostic URL getter failed');
			},
		});
		const expectedResponse = Object.create(null) as Response;
		Object.defineProperty(expectedResponse, 'headers', {
			get() {
				throw new Error('diagnostic headers getter failed');
			},
		});
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(expectedResponse) as unknown as typeof fetch;

		const actualResponse = await diagnostics.instrumentFetch(
			fetchImplementation,
		)(input as Request);
		await flushCapture();

		expect(actualResponse).toBe(expectedResponse);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				state: 'success',
				url: '[URL unavailable]',
				responseBody: '[Body omitted: incomplete Content-Type projection]',
			}),
		);
		dispose?.();
	});

	it('records pending requests immediately and redacts URLs and JSON bodies', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		let resolveFetch: ((value: Response) => void) | undefined;
		const fetchImplementation = jest.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		const request = instrumentedFetch(
			'https://example.test/items?token=secret&visible=yes',
			{
				method: 'POST',
				body: JSON.stringify({ password: 'secret', name: 'Example' }),
			},
		);
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ state: 'pending', method: 'POST' }),
		]);
		const pendingUrl = diagnostics.getEvents()[0]?.url ?? '';
		expect(decodeURIComponent(pendingUrl)).toContain('[REDACTED]=[REDACTED]');
		expect(pendingUrl).not.toContain('token');

		resolveFetch?.(response('{"session":"secret","ok":true}'));
		await request;
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				state: 'success',
				requestBody: expect.stringContaining('[REDACTED]'),
				responseBody: expect.stringContaining('[REDACTED]'),
			}),
		);
		expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain('secret');
		dispose?.();
	});

	it.each([
		'[Body omitted: password=hunter2]',
		'[Unreadable token=abc123]',
		'[FormData omitted password=hunter2]',
	])(
		'does not trust user-controlled diagnostic-looking body %s',
		async (body) => {
			const diagnostics = createNetworkPlugin({ captureBody: true });
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.instrumentFetch(
				jest.fn(async () => response('{}')) as unknown as typeof fetch,
			)('https://example.test/marker-collision', {
				body,
				headers: { 'content-type': 'text/plain' },
				method: 'POST',
			});
			await flushCapture();

			const capture = diagnostics.getEvents()[0];
			expect(JSON.stringify(capture)).not.toMatch(/hunter2|abc123/);
			expect(capture?.requestProjectionComplete).toBe(false);
			dispose?.();
		},
	);

	it('redacts encoded form credentials from string and URLSearchParams bodies', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);
		const headers = {
			'content-type': 'application/x-www-form-urlencoded',
		};

		await instrumented('https://example.test/string-form', {
			body: 'pass%77ord=hunter2&safe=yes',
			headers,
			method: 'POST',
		});
		await instrumented('https://example.test/params-form', {
			body: new URLSearchParams([
				['pass%77ord', 'hunter2'],
				['safe', 'yes'],
			]),
			method: 'POST',
		});
		await flushCapture();

		const captures = JSON.stringify(diagnostics.getEvents());
		expect(captures).not.toContain('hunter2');
		expect(captures).not.toContain('pass%77ord');
		expect(captures).toContain('%5BREDACTED%5D');
		dispose?.();
	});

	it('uses raw MIME provenance before host header redaction for form bodies', async () => {
		for (const redactor of [
			() => '[CUSTOM]',
			() => {
				throw new Error('host header redaction failed');
			},
		]) {
			const diagnostics = createNetworkPlugin({
				captureBody: true,
				redactHeader: redactor,
			});
			const dispose = diagnostics.plugin.install?.();
			const formBody = 'pass%77ord=hunter2&safe=yes';
			const formHeaders = new Headers({
				'content-length': String(formBody.length),
				'content-type': 'application/x-www-form-urlencoded',
			});

			await diagnostics.instrumentFetch(
				jest.fn(async () => responseWithHeaders(formBody, 200, formHeaders)),
			)('https://example.test/form-provenance', {
				body: formBody,
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				method: 'POST',
			});
			await flushCapture();

			const capture = JSON.stringify(diagnostics.getEvents()[0]);
			expect(capture).not.toContain('hunter2');
			expect(capture).not.toContain('pass%77ord');
			expect(capture).toContain('REDACTED');
			dispose?.();
		}
	});

	it('keeps raw MIME parameters private from host body redactors', async () => {
		const observedContentTypes: Array<string | undefined> = [];
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			redactBody: (body, context) => {
				observedContentTypes.push(context.contentType);
				return body;
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const formBody = 'pass%77ord=hunter2&safe=yes';
		const rawContentType =
			'application/x-www-form-urlencoded; token=hunter2; charset=utf-8';
		const headers = new Headers({
			'content-length': String(formBody.length),
			'content-type': rawContentType,
		});

		await diagnostics.instrumentFetch(
			jest.fn(async () => responseWithHeaders(formBody, 200, headers)),
		)('https://example.test/private-mime-parameters', {
			body: formBody,
			headers: { 'content-type': rawContentType },
			method: 'POST',
		});
		await flushCapture();

		expect(observedContentTypes).toEqual([
			'application/x-www-form-urlencoded',
			'application/x-www-form-urlencoded',
		]);
		const captured = JSON.stringify(diagnostics.getEvents()[0]);
		expect(captured).not.toMatch(/hunter2|pass%77ord/);
		expect(captured).toContain('REDACTED');
		dispose?.();
	});

	it('fails multipart request capture closed for text and Blob bodies', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const multipartBody =
			'--boundary\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--boundary--';
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);

		await instrumented('https://example.test/multipart-text', {
			body: multipartBody,
			headers: {
				'content-type': 'multipart/form-data; boundary=boundary',
			},
			method: 'POST',
		});
		await instrumented('https://example.test/multipart-blob', {
			body: new Blob([multipartBody], {
				type: 'multipart/form-data; boundary=boundary',
			}),
			method: 'POST',
		});
		await flushCapture();

		expect(diagnostics.getEvents().map((event) => event.requestBody)).toEqual([
			'[Body omitted: multipart content]',
			'[Binary body omitted: Blob]',
		]);
		expect(JSON.stringify(diagnostics.getEvents())).not.toContain('hunter2');
		dispose?.();
	});

	it.each([
		'application/cbor',
		'application/wasm',
		'application/xml',
		'text/plain, image/png',
	])(
		'omits non-textual %s request and response bodies',
		async (contentType) => {
			const diagnostics = createNetworkPlugin({ captureBody: true });
			const dispose = diagnostics.plugin.install?.();
			const clone = jest.fn(() => streamedBodyClone('opaque-hunter2-secret'));
			const binaryResponse = {
				status: 200,
				headers: new Headers({
					'content-length': '21',
					'content-type': contentType,
				}),
				clone,
			} as unknown as Response;

			await diagnostics.instrumentFetch(
				jest.fn(async () => binaryResponse),
				{
					trustedResponse: true,
				},
			)('https://example.test/binary-mime', {
				body: 'opaque-hunter2-secret',
				headers: { 'content-type': contentType },
				method: 'POST',
			});
			await flushCapture();

			const capture = diagnostics.getEvents()[0];
			expect(capture?.requestBody).toContain('Body omitted');
			expect(capture?.responseBody).toContain('Binary body omitted');
			expect(JSON.stringify(capture)).not.toContain('opaque-hunter2-secret');
			expect(clone).not.toHaveBeenCalled();
			dispose?.();
		},
	);

	it.each(['application/cbor', 'application/xml'])(
		'does not allocate a canonical Request body reader for %s',
		async (contentType) => {
			const diagnostics = createNetworkPlugin({
				captureBody: true,
				captureUnknownLengthBodies: true,
			});
			const dispose = diagnostics.plugin.install?.();
			const input = new Request('https://example.test/non-text-request', {
				body: 'opaque-hunter2-secret',
				headers: { 'content-type': contentType },
				method: 'POST',
			});
			const clone = jest.spyOn(input, 'clone');

			await diagnostics.instrumentFetch(
				jest.fn(async () => response('{}')) as unknown as typeof fetch,
			)(input);
			await flushCapture();

			expect(clone).not.toHaveBeenCalled();
			expect(diagnostics.getEvents()[0]?.requestBody).toBe(
				'[Body omitted: non-textual or ambiguous Content-Type]',
			);
			expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain(
				'opaque-hunter2-secret',
			);
			dispose?.();
		},
	);

	it('retains exact MIME provenance when the visible header projection overflows', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const headers = new Headers({
			'content-type': 'multipart/form-data; boundary=x',
		});
		for (let index = 0; index < 100; index += 1) {
			headers.set(`x-padding-${index}`, String(index));
		}

		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/header-overflow', {
			body: 'opaque-hunter2-secret',
			headers,
			method: 'POST',
		});
		await flushCapture();

		const capture = diagnostics.getEvents()[0];
		expect(capture?.requestProjectionComplete).toBe(false);
		expect(capture?.requestBody).toBe('[Body omitted: multipart content]');
		expect(JSON.stringify(capture)).not.toContain('opaque-hunter2-secret');
		dispose?.();
	});

	it('bounds Blob MIME metadata before invoking body redaction', async () => {
		const redactBody = jest.fn((body: string) => body);
		const diagnostics = createNetworkPlugin({ captureBody: true, redactBody });
		const dispose = diagnostics.plugin.install?.();

		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/blob-type', {
			body: new Blob(['x'], { type: `text/${'x'.repeat(200_000)}` }),
			method: 'POST',
		});
		await flushCapture();

		expect(diagnostics.getEvents()[0]?.requestBody).toBe(
			'[Binary body omitted: Blob]',
		);
		expect(redactBody.mock.calls[0]?.[0]).toBe('[Binary body omitted: Blob]');
		expect(redactBody.mock.calls[0]?.[0].length).toBeLessThan(100);
		dispose?.();
	});

	it('clears captures and does not retain late response data after disposal', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		let resolveFetch: ((value: Response) => void) | undefined;
		const fetchImplementation = jest.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		) as unknown as typeof fetch;
		const request = diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/private',
		);

		dispose?.();
		expect(diagnostics.getEvents()).toEqual([]);
		resolveFetch?.(response('{"token":"late-secret"}'));
		await request;
		await flushCapture();

		expect(JSON.stringify(diagnostics.getEvents())).not.toContain(
			'late-secret',
		);
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('clears singleton captures only when the final tools owner disposes', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		timeline.append({
			source: 'custom',
			kind: 'test.unrelated',
			level: 'info',
			title: 'Unrelated event',
		});
		const diagnostics = createNetworkPlugin({ eventStore: timeline });
		const disposeFirstOwner = diagnostics.plugin.install?.();
		const disposeSecondOwner = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/first-owner');
		await flushCapture();

		disposeFirstOwner?.();
		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(timeline.getEvents()).toHaveLength(2);

		disposeSecondOwner?.();
		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'Unrelated event',
		]);
	});

	it('does not publish an old in-flight response into a replacement session', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({ eventStore: timeline });
		const firstDispose = diagnostics.plugin.install?.();
		let resolveFetch: ((value: Response) => void) | undefined;
		const request = diagnostics.instrumentFetch(
			jest.fn(
				() =>
					new Promise<Response>((resolve) => {
						resolveFetch = resolve;
					}),
			) as unknown as typeof fetch,
		)('https://example.test/old-session');

		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		resolveFetch?.(response('{}'));
		await request;
		await flushCapture();

		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents()).toEqual([]);
		secondDispose?.();
	});

	it('redacts relative URLs and bodies before applying the retained byte cap', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxBodyBytes: 96,
		});
		const dispose = diagnostics.plugin.install?.();
		const requestBody = JSON.stringify({
			password: 'body-secret',
			content: 'x'.repeat(500),
		});
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		})('/items?accessToken=url-secret&visible=yes', {
			method: 'POST',
			body: requestBody,
		});
		await flushCapture();

		const event = diagnostics.getEvents()[0];
		const captured = JSON.stringify(event);
		expect(decodeURIComponent(event?.url ?? '')).toContain('[REDACTED]');
		expect(captured).not.toContain('url-secret');
		expect(captured).not.toContain('body-secret');
		expect(diagnostics.getEvents()[0]?.requestSizeBytes).toBe(
			utf8ByteLength(requestBody),
		);
		expect(diagnostics.getEvents()[0]?.requestBody).toContain('[Body omitted:');
		dispose?.();
	});

	it('omits oversized URLs before invoking host redaction', async () => {
		const redactUrl = jest.fn((url: string) => url);
		const diagnostics = createNetworkPlugin({ redactUrl });
		const dispose = diagnostics.plugin.install?.();
		const oversizedUrl = `https://example.test/${'x'.repeat(70 * 1024)}`;

		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)(oversizedUrl);

		expect(redactUrl).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				url: '[URL omitted: input limit]',
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('omits oversized header values before invoking host redaction', async () => {
		const redactHeader = jest.fn((_name: string, value: string) => value);
		const diagnostics = createNetworkPlugin({ redactHeader });
		const dispose = diagnostics.plugin.install?.();
		const transportError = new Error('transport failed');

		await expect(
			diagnostics.instrumentFetch(
				jest.fn(async () => {
					throw transportError;
				}) as unknown as typeof fetch,
			)('https://example.test/header-limit', {
				headers: { 'x-oversized': 'x'.repeat(70 * 1024) },
			}),
		).rejects.toBe(transportError);

		expect(redactHeader).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]?.requestHeaders).toEqual({});
		expect(diagnostics.getEvents()[0]?.requestProjectionComplete).toBe(false);
		dispose?.();
	});

	it('bounds request body and URLSearchParams projection work before serialization', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const oversizedText = 'x'.repeat(70 * 1024);
		const params = new URLSearchParams();
		for (let index = 0; index < 101; index += 1) {
			params.append(`key-${index}`, 'value');
		}
		const paramsToString = jest.fn(() => 'underlying-fetch-serialization');
		Object.defineProperty(params, 'toString', {
			configurable: true,
			value: paramsToString,
		});
		const fetchImplementation = jest.fn(async (_input, init) => {
			if (init?.body === params) init.body.toString();
			return response('{}');
		}) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		await instrumented('https://example.test/oversized-text', {
			body: oversizedText,
			method: 'POST',
		});
		await instrumented('https://example.test/oversized-params', {
			body: params,
			method: 'POST',
		});
		await flushCapture();

		expect(paramsToString).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				requestBody: '[Body omitted: input limit]',
				requestSizeBytes: undefined,
			}),
			expect.objectContaining({
				requestBody: '[Body omitted: URLSearchParams input limit]',
				requestSizeBytes: undefined,
			}),
		]);
		dispose?.();
	});

	it('stops canonical header projection at the bounded entry limit', async () => {
		const redactHeader = jest.fn((_name: string, value: string) => value);
		const headers = new Headers();
		for (let index = 0; index < 101; index += 1) {
			headers.set(`x-header-${index}`, 'value');
		}
		const diagnostics = createNetworkPlugin({ redactHeader });
		const dispose = diagnostics.plugin.install?.();

		await diagnostics.instrumentFetch(
			jest.fn(async (_input, init) => {
				expect(init?.headers).toBe(headers);
				return response('{}');
			}) as unknown as typeof fetch,
		)('https://example.test/header-count-limit', { headers });

		expect(redactHeader.mock.calls.map(([name]) => name)).toEqual([
			'content-length',
			'content-type',
		]);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				requestHeaders: {},
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('never consumes arbitrary header iterables at the public projection boundary', () => {
		let pulls = 0;
		const iterableHeaders = {
			[Symbol.iterator]: () => ({
				next: () => {
					pulls += 1;
					return pulls > 1_000
						? { done: true, value: undefined }
						: { done: false, value: [`x-${pulls}`, 'value'] };
				},
			}),
		};
		const redactHeader = jest.fn((_name: string, value: string) => value);

		expect(
			captureHeaders(iterableHeaders as unknown as HeadersInit, redactHeader)
				.headers,
		).toEqual({});
		expect(pulls).toBe(0);
		expect(redactHeader).not.toHaveBeenCalled();
	});

	it('traverses hostile record headers only once before failing closed', () => {
		const headerTarget: Record<string, string> = {
			'content-type': 'text/plain',
		};
		for (let index = 0; index < 101; index += 1) {
			headerTarget[`x-overflow-${index}`] = String(index);
		}
		const ownKeys = jest.fn((target: Record<string, string>) =>
			Reflect.ownKeys(target),
		);
		const headers = new Proxy(headerTarget, { ownKeys });
		const redactHeader = jest.fn((_name: string, value: string) => value);

		expect(captureHeaders(headers, redactHeader).headers).toEqual({});
		expect(ownKeys).toHaveBeenCalledTimes(1);
		expect(redactHeader).not.toHaveBeenCalled();
	});

	it('never consumes an arbitrary response-header iterable', async () => {
		let pulls = 0;
		const headers = {
			get: () => null,
			[Symbol.iterator]: () => ({
				next: () => {
					pulls += 1;
					return { done: false, value: [`x-${pulls}`, 'value'] };
				},
			}),
		};
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => ({ status: 200, headers }) as unknown as Response),
		)('https://example.test/hostile-response-headers');

		expect(pulls).toBe(0);
		expect(diagnostics.getEvents()[0]?.responseHeaders).toEqual({});
		dispose?.();
	});

	it('omits oversized fetch errors before invoking body redaction', async () => {
		const redactBody = jest.fn((body: string) => body);
		const diagnostics = createNetworkPlugin({ redactBody });
		const dispose = diagnostics.plugin.install?.();
		const transportError = new Error('x'.repeat(70 * 1024));

		await expect(
			diagnostics.instrumentFetch(
				jest.fn(async () => {
					throw transportError;
				}) as unknown as typeof fetch,
			)('https://example.test/error-limit'),
		).rejects.toBe(transportError);

		expect(redactBody).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]?.error).toBe(
			'[Error omitted: input limit]',
		);
		dispose?.();
	});

	it('reads only fixed fields from rejected error objects', async () => {
		const errorTarget = new Error('bounded failure');
		Object.defineProperty(errorTarget, 'irrelevant', { value: 'ignored' });
		const ownKeys = jest.fn(() => {
			throw new Error('error keys must not be enumerated');
		});
		const getPrototypeOf = jest.fn(() => {
			throw new Error('error prototype must not be inspected');
		});
		const transportError = new Proxy(errorTarget, { getPrototypeOf, ownKeys });
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();

		await expect(
			diagnostics.instrumentFetch(
				jest.fn(async () => {
					throw transportError;
				}) as unknown as typeof fetch,
			)('https://example.test/bounded-error'),
		).rejects.toBe(transportError);

		expect(ownKeys).not.toHaveBeenCalled();
		expect(getPrototypeOf).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]?.error).toBe('bounded failure');
		dispose?.();
	});

	it('does not retain encoded credentials from thrown errors or string reasons', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest
				.fn()
				.mockRejectedValueOnce(new Error('failed password%253Dhunter2'))
				.mockRejectedValueOnce('token%253Dhunter2') as unknown as typeof fetch,
		);

		await expect(
			instrumented('https://example.test/error-object'),
		).rejects.toThrow('password%253Dhunter2');
		await expect(
			instrumented('https://example.test/error-string'),
		).rejects.toBe('token%253Dhunter2');
		await flushCapture();

		const retained = JSON.stringify(diagnostics.getEvents());
		expect(retained).not.toMatch(/hunter2|password%|token%/);
		expect(retained).toContain('encoded sensitive data');
		dispose?.();
	});

	it('omits unsupported request body objects instead of serializing them', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const unsupportedBody = {
			get privateValue() {
				throw new Error('body getter must not run');
			},
		};
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test',
			{ method: 'POST', body: unsupportedBody as unknown as BodyInit },
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]?.requestBody).toBe(
			'[Unsupported request body omitted]',
		);
		dispose?.();
	});

	it('does not replay a URLSearchParams body as a content-type-changing string', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/form',
			{
				method: 'POST',
				body: new URLSearchParams({ query: 'safe' }),
			},
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				requestBody: 'query=safe',
				requestHeaders: {},
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('reports known upload sizes without retaining request payloads', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: false });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{}')) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		await instrumented('https://example.test/text-upload', {
			method: 'POST',
			body: '🏋️',
		});
		await instrumented('https://example.test/blob-upload', {
			method: 'POST',
			body: new Blob(['x'.repeat(32)]),
		});
		await flushCapture();

		expect(
			diagnostics.getEvents().map((event) => event.requestSizeBytes),
		).toEqual([utf8ByteLength('🏋️'), 32]);
		expect(diagnostics.getEvents().map((event) => event.requestBody)).toEqual([
			undefined,
			undefined,
		]);
		dispose?.();
	});

	it('marks truncated or omitted request projections as ineligible for replay', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);
		const manyHeaders = Object.fromEntries(
			Array.from({ length: 101 }, (_, index) => [
				`x-header-${String(index).padStart(3, '0')}`,
				'value',
			]),
		);

		await instrumented(`https://example.test/${'x'.repeat(20 * 1024)}`);
		await instrumented('https://example.test/headers', {
			headers: manyHeaders,
		});
		await instrumented('https://example.test/method', {
			method: 'METHOD-THAT-EXCEEDS-SIXTEEN',
		});
		await instrumented('https://example.test/lowercase-method', {
			method: 'patch',
		});
		await instrumented('https://example.test/credentials', {
			credentials: 'omit',
		});
		await instrumented('https://example.test/get-with-body', {
			method: 'GET',
			body: 'unexpected',
		});
		await instrumented({
			get url() {
				throw new Error('unavailable');
			},
		} as unknown as Request);
		await flushCapture();

		for (const event of diagnostics.getEvents()) {
			expect(event.requestProjectionComplete).toBe(false);
			expect(networkReplayBlockReason(event)).toContain(
				'complete original request was not retained',
			);
		}
		expect(
			Object.keys(diagnostics.getEvents()[1]?.requestHeaders ?? {}),
		).toHaveLength(0);
		dispose?.();
	});

	it('never captures a Supabase password grant credential', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(
				response('{"access_token":"session-secret"}'),
			) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		await instrumentedFetch(
			'https://example.supabase.co/auth/v1/token?grant_type=password',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: 'maestro.power@example.com',
					password: 'shared-persona-password',
				}),
			},
		);
		await flushCapture();

		const capturedEvent = JSON.stringify(diagnostics.getEvents()[0]);
		expect(capturedEvent).toContain('[REDACTED]');
		expect(capturedEvent).not.toContain('shared-persona-password');
		expect(capturedEvent).not.toContain('session-secret');
		dispose?.();
	});

	it('fails closed before reading a body with an oversized binary content type', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const clone = jest.fn(() => {
			throw new Error('binary body must not be read');
		});
		const binaryResponse = {
			status: 200,
			headers: new Headers({
				'content-length': '4',
				'content-type': `application/octet-stream;${'x'.repeat(9 * 1024)}`,
			}),
			clone,
		} as unknown as Response;

		await diagnostics.instrumentFetch(jest.fn(async () => binaryResponse))(
			'https://example.test/binary',
		);
		await flushCapture();

		expect(clone).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]?.responseBody).toBe(
			'[Body omitted: incomplete Content-Type projection]',
		);
		dispose?.();
	});

	it('bounds Content-Length before normalization and never clones a huge-length body', async () => {
		const hugeLength = ` ${'9'.repeat(1024 * 1024)} `;
		expect(parseContentLength(hugeLength)).toBeUndefined();
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const clone = jest.fn(() => {
			throw new Error('oversized Content-Length must not reach body cloning');
		});
		const hugeLengthResponse = {
			status: 200,
			headers: new Headers({
				'content-length': hugeLength,
				'content-type': 'text/plain',
			}),
			clone,
		} as unknown as Response;

		const actual = await diagnostics.instrumentFetch(
			jest.fn(async () => hugeLengthResponse),
			{ trustedResponse: true },
		)('https://example.test/huge-content-length');
		await flushCapture();

		expect(actual).toBe(hugeLengthResponse);
		expect(clone).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]?.responseBody).toContain('Body omitted');
		dispose?.();
	});

	it('does not consume untrusted response accessors or proxies before returning them', async () => {
		for (const variant of ['accessors', 'proxy'] as const) {
			const diagnostics = createNetworkPluginBase({ captureBody: true });
			const dispose = diagnostics.plugin.install?.();
			const access = jest.fn(() => {
				throw new Error('caller-owned response accessor');
			});
			const actualResponse =
				variant === 'accessors'
					? (Object.defineProperties(
							{},
							{
								clone: { configurable: true, get: access },
								headers: { configurable: true, get: access },
								status: { configurable: true, get: access },
							},
						) as Response)
					: (new Proxy(new Response('{}'), {
							get(target, key, receiver) {
								// Promise resolution necessarily probes `then`; the collector must
								// not touch any Response diagnostic field.
								if (key === 'then') return undefined;
								if (
									key === 'body' ||
									key === 'clone' ||
									key === 'headers' ||
									key === 'status'
								) {
									return access();
								}
								return Reflect.get(target, key, receiver);
							},
						}) as Response);
			const fetchImplementation = jest.fn(async () => actualResponse);

			const returned = await diagnostics.instrumentFetch(
				fetchImplementation as unknown as typeof fetch,
			)('https://example.test/untrusted-response');

			expect(returned).toBe(actualResponse);
			expect(access).not.toHaveBeenCalled();
			if (variant === 'accessors') {
				expect(diagnostics.getEvents()[0]).toEqual(
					expect.objectContaining({
						responseHeaders: {},
						status: undefined,
					}),
				);
			}
			dispose?.();
		}
	});

	it('bypasses shadowed native Headers.get during trusted response capture', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const actualResponse = response('safe-text');
		const shadow = jest.fn(() => {
			throw new Error('shadowed Headers.get');
		});
		Object.defineProperty(actualResponse.headers, 'get', {
			configurable: true,
			value: shadow,
		});

		await diagnostics.instrumentFetch(jest.fn(async () => actualResponse))(
			'https://example.test/shadowed-header-get',
		);
		await flushCapture();

		expect(shadow).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({ status: 200, responseBody: 'safe-text' }),
		);
		dispose?.();
	});

	it('captures a bounded trusted RN Blob response through its whatwg text path', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const body = new Blob(['{"ok":true}'], { type: 'application/json' });
		const clone = jest.fn(() => ({
			_bodyInit: body,
			text: () => body.text(),
		}));
		const rnResponse = {
			_bodyInit: body,
			headers: new Headers({ 'content-type': 'application/json' }),
			status: 200,
			clone,
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => rnResponse),
			{
				trustedResponse: true,
			},
		)('https://example.test/rn-blob-response');
		await flushCapture();

		expect(clone).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '{"ok":true}',
				responseSizeBytes: body.size,
			}),
		);
		dispose?.();
	});

	it('recognizes native and RN bodyless responses before MIME admission', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const nativeResponse = new Response(null, { status: 204 });
		const nativeClone = jest.spyOn(nativeResponse, 'clone');
		const rnClone = jest.fn(() => {
			throw new Error('bodyless RN responses must not be cloned');
		});
		const rnResponse = {
			_bodyInit: null,
			body: null,
			headers: new Headers({ 'content-length': '321' }),
			status: 204,
			clone: rnClone,
		} as unknown as Response;
		const fetchImplementation = jest
			.fn()
			.mockResolvedValueOnce(nativeResponse)
			.mockResolvedValueOnce(rnResponse) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		});

		await instrumented('https://example.test/native-no-content');
		await instrumented('https://example.test/rn-head-like');
		await flushCapture();

		expect(nativeClone).not.toHaveBeenCalled();
		expect(rnClone).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				responseBody: undefined,
				responseSizeBytes: 0,
				status: 204,
			}),
			expect.objectContaining({
				responseBody: undefined,
				responseSizeBytes: 321,
				status: 204,
			}),
		]);
		dispose?.();
	});

	it('does not touch trusted adapter body getters before capture admission', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const bodyGetters: jest.Mock[] = [];
		const clones: jest.Mock[] = [];
		const adapterResponse = (headers: HeadersInit): Response => {
			const body = jest.fn(() => {
				throw new Error('adapter body getter allocated before admission');
			});
			const clone = jest.fn(() => {
				throw new Error('adapter clone allocated before admission');
			});
			bodyGetters.push(body);
			clones.push(clone);
			return Object.defineProperties(
				{ headers: new Headers(headers), status: 200 },
				{
					body: { configurable: true, get: body },
					clone: { configurable: true, value: clone },
				},
			) as unknown as Response;
		};
		const fetchImplementation = jest
			.fn()
			.mockResolvedValueOnce(adapterResponse({ 'content-type': 'text/plain' }))
			.mockResolvedValueOnce(
				adapterResponse({
					'content-length': '1',
					'content-type': 'application/cbor',
				}),
			)
			.mockResolvedValueOnce(
				adapterResponse({
					'content-length': String(100 * 1024),
					'content-type': 'text/plain',
				}),
			) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		});

		await instrumented('https://example.test/adapter-unknown');
		await instrumented('https://example.test/adapter-binary');
		await instrumented('https://example.test/adapter-oversized');
		await flushCapture();

		expect(bodyGetters.every((getter) => getter.mock.calls.length === 0)).toBe(
			true,
		);
		expect(clones.every((clone) => clone.mock.calls.length === 0)).toBe(true);
		expect(diagnostics.getEvents().map((event) => event.responseBody)).toEqual([
			'[Body omitted: unknown content length]',
			'[Binary body omitted: non-textual content type]',
			`[Body omitted: ${100 * 1024} bytes]`,
		]);
		dispose?.();
	});

	it('publishes RN Blob capture timeout promptly and ignores its late text', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin({ captureBody: true });
			const dispose = diagnostics.plugin.install?.();
			let settleText = (_text: string): void => {};
			const text = jest.fn(
				() =>
					new Promise<string>((resolve) => {
						settleText = resolve;
					}),
			);
			const body = new Blob(['safe'], { type: 'text/plain' });
			const rnResponse = {
				_bodyInit: body,
				headers: new Headers({
					'content-length': String(body.size),
					'content-type': 'text/plain',
				}),
				status: 200,
				clone: () => ({ text }),
			} as unknown as Response;

			await diagnostics.instrumentFetch(
				jest.fn(async () => rnResponse),
				{ trustedResponse: true },
			)('https://example.test/rn-blob-timeout');
			expect(text).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(10_000);
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					responseBody: '[Body capture cancelled]',
					responseSizeBytes: body.size,
				}),
			);

			settleText('late-sensitive-value');
			await flushCapture();
			expect(diagnostics.getEvents()[0]?.responseBody).toBe(
				'[Body capture cancelled]',
			);
			expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain(
				'late-sensitive-value',
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('keeps cancelled RN Blob reads inside the global capture-work bound', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxEvents: 1,
		});
		const dispose = diagnostics.plugin.install?.();
		const textSettlers: Array<(text: string) => void> = [];
		let textStarts = 0;
		const rnResponse = (): Response => {
			const body = new Blob(['safe'], { type: 'text/plain' });
			return {
				_bodyInit: body,
				headers: new Headers({
					'content-length': String(body.size),
					'content-type': 'text/plain',
				}),
				status: 200,
				clone: () => ({
					text: () => {
						textStarts += 1;
						return new Promise<string>((resolve) => {
							textSettlers.push(resolve);
						});
					},
				}),
			} as unknown as Response;
		};
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => rnResponse()),
			{ trustedResponse: true },
		);

		for (let index = 0; index < 32; index += 1) {
			await instrumented(`https://example.test/blob-${index}`);
			await Promise.resolve();
		}
		expect(textStarts).toBe(32);
		await instrumented('https://example.test/blob-over-limit');
		await flushCapture();
		expect(textStarts).toBe(32);
		expect(diagnostics.getEvents()[0]?.responseBody).toContain(
			'capture concurrency limit',
		);

		textSettlers[0]?.('safe');
		await flushCapture();
		await instrumented('https://example.test/blob-after-settle');
		await Promise.resolve();
		expect(textStarts).toBe(33);

		for (const settleText of textSettlers) settleText('safe');
		await flushCapture();
		dispose?.();
	});

	it('does not let guaranteed-discard response readers consume capture slots', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const clone = jest.fn(() => ({
			body: {
				getReader: () => ({
					cancel: async () => {},
					read: () => new Promise<never>(() => {}),
				}),
			},
		}));
		const unprojectableHeaders = {
			get: (name: string) =>
				name.toLowerCase() === 'content-type' ? 'text/plain' : null,
		};
		const discardedResponse = {
			status: 200,
			headers: unprojectableHeaders,
			clone,
		} as unknown as Response;
		const fetchImplementation = jest.fn().mockResolvedValue(discardedResponse);
		const instrumented = diagnostics.instrumentFetch(
			fetchImplementation as unknown as typeof fetch,
		);

		for (let index = 0; index < 32; index += 1) {
			await instrumented(`https://example.test/discarded-${index}`);
		}
		const retainedResponse = response('safe-text');
		fetchImplementation.mockResolvedValueOnce(retainedResponse);
		await instrumented('https://example.test/retained');
		await flushCapture();

		expect(clone).not.toHaveBeenCalled();
		expect(diagnostics.getEvents().at(-1)?.responseBody).toBe('safe-text');
		expect(diagnostics.getEvents().at(-1)?.responseBody).not.toContain(
			'capture concurrency limit',
		);
		dispose?.();
	});

	it('does not reserve work slots for body-null or reader-unavailable responses', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxEvents: 64,
		});
		const dispose = diagnostics.plugin.install?.();
		let responseIndex = 0;
		const fetchImplementation = jest.fn(async () => {
			const index = responseIndex;
			responseIndex += 1;
			return {
				status: 200,
				headers: new Headers({
					'content-length': '1',
					'content-type': 'text/plain',
				}),
				clone: () => ({ body: index % 2 === 0 ? null : {} }),
			} as unknown as Response;
		}) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		});

		await Promise.all(
			Array.from({ length: 33 }, (_, index) =>
				instrumented(`https://example.test/no-reader-${index}`),
			),
		);
		await flushCapture();

		expect(diagnostics.getEvents()).toHaveLength(33);
		expect(
			diagnostics
				.getEvents()
				.some((event) => event.responseBody?.includes('concurrency limit')),
		).toBe(false);
		dispose?.();
	});

	it('admits no extra stream clones at capacity and releases on branch cancel', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxEvents: 100,
		});
		const dispose = diagnostics.plugin.install?.();
		const cancel = jest.fn(() => new Promise<void>(() => {}));
		const clone = jest.fn(() => ({
			body: {
				getReader: () => ({
					cancel,
					read: () => new Promise<never>(() => {}),
				}),
			},
		}));
		const retainedResponses: Response[] = [];
		const fetchImplementation = jest.fn(async () => {
			const result = {
				status: 200,
				headers: new Headers({
					'content-length': '4',
					'content-type': 'text/plain',
				}),
				clone,
				text: async () => 'safe',
			} as unknown as Response;
			retainedResponses.push(result);
			return result;
		}) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		});

		for (let index = 0; index < 32; index += 1) {
			await instrumented(`https://example.test/stalled-${index}`);
		}
		expect(clone).toHaveBeenCalledTimes(32);
		for (let index = 0; index < 20; index += 1) {
			await instrumented(`https://example.test/capped-${index}`);
		}
		expect(clone).toHaveBeenCalledTimes(32);
		expect(
			diagnostics
				.getEvents()
				.filter((event) => event.responseBody?.includes('concurrency limit')),
		).toHaveLength(20);
		await expect(retainedResponses[0]?.text()).resolves.toBe('safe');

		diagnostics.clear();
		await flushCapture();
		expect(cancel).toHaveBeenCalledTimes(32);
		await instrumented('https://example.test/after-cancel');
		expect(clone).toHaveBeenCalledTimes(33);
		dispose?.();
	});

	it('patches and safely restores global fetch when requested', () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest.fn() as unknown as typeof fetch;
		globalThis.fetch = baseFetch;
		const diagnostics = createNetworkPlugin({ patchGlobalFetch: true });
		const dispose = diagnostics.plugin.install?.();

		expect(globalThis.fetch).not.toBe(baseFetch);
		dispose?.();
		expect(globalThis.fetch).toBe(baseFetch);
		globalThis.fetch = previousFetch;
	});

	it('canonicalizes the mobile global-fetch boundary once and preserves RN request replay and shaping', async () => {
		jest.useFakeTimers();
		const previousFetchDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'fetch',
		);
		const previousRequestDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'Request',
		);
		let dispose: (() => void) | undefined;
		try {
			class RnWhatwgRequest {
				readonly _bodyInit: BodyInit | null | undefined;
				readonly credentials: RequestCredentials;
				readonly headers: Headers;
				readonly method: string;
				readonly mode: RequestMode | null;
				readonly referrer = null;
				readonly signal: AbortSignal;
				readonly url: string;

				constructor(input: RequestInfo | URL, init: RequestInit = {}) {
					const source = input instanceof RnWhatwgRequest ? input : undefined;
					const inputUrl = source?.url ?? String(input);
					const cache = init.cache;
					this.url =
						cache === 'no-cache' || cache === 'no-store'
							? `${inputUrl}${inputUrl.includes('?') ? '&' : '?'}_=1234`
							: inputUrl;
					this.credentials =
						init.credentials ?? source?.credentials ?? 'same-origin';
					this.headers = new Headers(init.headers ?? source?.headers);
					this.method = (init.method ?? source?.method ?? 'GET').toUpperCase();
					this.mode = init.mode ?? source?.mode ?? null;
					this.signal =
						init.signal ?? source?.signal ?? new AbortController().signal;
					this._bodyInit = init.body ?? source?._bodyInit;
					if (
						typeof this._bodyInit === 'string' &&
						!this.headers.has('content-type')
					) {
						this.headers.set('content-type', 'text/plain;charset=UTF-8');
					}
				}

				clone() {
					return new RnWhatwgRequest(this as unknown as RequestInfo, {
						body: this._bodyInit,
					});
				}
			}
			Object.defineProperty(globalThis, 'Request', {
				configurable: true,
				value: RnWhatwgRequest,
				writable: true,
			});
			const baseFetch = jest.fn(async (input: RequestInfo | URL) => {
				expect(input).toBeInstanceOf(RnWhatwgRequest);
				return response('{}');
			}) as unknown as typeof fetch;
			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				value: baseFetch,
				writable: true,
			});
			const diagnostics = createNetworkPluginBase({
				...confirmedSimulationOptions(),
				canonicalizeGlobalFetchRequests: true,
				captureBody: true,
				enableRequestReplay: true,
				patchGlobalFetch: true,
				trustGlobalFetchResponses: true,
			});
			dispose = diagnostics.plugin.install?.();

			await globalThis.fetch('https://example.test/bodyless');
			await flushCapture();
			await globalThis.fetch('https://example.test/cache', {
				cache: 'no-store',
			});
			const sourceRequest = new RnWhatwgRequest(
				'https://example.test/request-input',
				{ credentials: 'include' },
			);
			await globalThis.fetch(sourceRequest as unknown as Request);
			await flushCapture();
			await diagnostics.setSimulationProfile('wifi');
			const body = 'x'.repeat(25_000);
			const shaped = globalThis.fetch('https://example.test/canonical-post', {
				body,
				method: 'POST',
			});
			await jest.advanceTimersByTimeAsync(250);
			await shaped;
			await flushCapture();

			const [bodyless, cacheControlled, requestInput, post] =
				diagnostics.getEvents();
			expect(bodyless).toEqual(
				expect.objectContaining({
					method: 'GET',
					requestBody: undefined,
					requestProjectionComplete: true,
				}),
			);
			expect(
				networkReplayBlockReason(bodyless as NetworkEvent),
			).toBeUndefined();
			expect(cacheControlled).toEqual(
				expect.objectContaining({
					url: 'https://example.test/cache?_=1234',
					requestProjectionComplete: false,
				}),
			);
			expect(
				networkReplayBlockReason(cacheControlled as NetworkEvent),
			).toBeDefined();
			expect(requestInput).toEqual(
				expect.objectContaining({
					url: 'https://example.test/request-input',
					requestProjectionComplete: false,
				}),
			);
			expect(
				networkReplayBlockReason(requestInput as NetworkEvent),
			).toBeDefined();
			expect(post).toEqual(
				expect.objectContaining({
					method: 'POST',
					requestBody: body,
					requestProjectionComplete: true,
					requestSizeBytes: 25_000,
					timing: expect.objectContaining({ uploadDelayMs: 10 }),
				}),
			);
			expect(networkReplayBlockReason(post as NetworkEvent)).toBeUndefined();
		} finally {
			dispose?.();
			if (previousFetchDescriptor) {
				Object.defineProperty(globalThis, 'fetch', previousFetchDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, 'fetch');
			}
			if (previousRequestDescriptor) {
				Object.defineProperty(globalThis, 'Request', previousRequestDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, 'Request');
			}
			jest.useRealTimers();
		}
	});

	it('keeps data URLs out of capture, replay, and cURL export', async () => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = jest.fn(async () =>
			response('{}'),
		) as unknown as typeof fetch;
		const diagnostics = createNetworkPlugin({
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		try {
			await globalThis.fetch('data:text/plain,opaque-hunter2-secret');
			await flushCapture();
			const capture = diagnostics.getEvents()[0];

			expect(capture?.url).toBe('[URL omitted: unsupported scheme]');
			expect(capture?.requestProjectionComplete).toBe(false);
			expect(networkReplayBlockReason(capture as NetworkEvent)).toBeDefined();
			const command = buildCurlCommand(capture as NetworkEvent);
			expect(command).not.toContain('opaque-hunter2-secret');
			expect(command).toContain('[URL omitted: export limit]');
		} finally {
			dispose?.();
			globalThis.fetch = previousFetch;
		}
	});

	it('composes multiple global fetch collectors and restores either disposal order', () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest.fn() as unknown as typeof fetch;
		try {
			for (const disposeFirst of ['first', 'second'] as const) {
				globalThis.fetch = baseFetch;
				const first = createNetworkPlugin({ patchGlobalFetch: true });
				const second = createNetworkPlugin({ patchGlobalFetch: true });
				const disposeFirstPlugin = first.plugin.install?.();
				const disposeSecondPlugin = second.plugin.install?.();
				expect(globalThis.fetch).not.toBe(baseFetch);
				if (disposeFirst === 'first') {
					disposeFirstPlugin?.();
					disposeSecondPlugin?.();
				} else {
					disposeSecondPlugin?.();
					disposeFirstPlugin?.();
				}
				expect(globalThis.fetch).toBe(baseFetch);
			}
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it('makes cached global wrappers passive after a layer rebuild', async () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest
			.fn()
			.mockResolvedValue(response('{}')) as unknown as typeof fetch;
		globalThis.fetch = baseFetch;
		const first = createNetworkPlugin({ patchGlobalFetch: true });
		const disposeFirst = first.plugin.install?.();
		const cachedBeforeRebuild = globalThis.fetch;
		const second = createNetworkPlugin({ patchGlobalFetch: true });
		const disposeSecond = second.plugin.install?.();
		try {
			await cachedBeforeRebuild('https://example.test/stale-wrapper');
			await flushCapture();
			expect(first.getEvents()).toEqual([]);
			expect(second.getEvents()).toEqual([]);

			await globalThis.fetch('https://example.test/current-wrapper');
			await flushCapture();
			expect(first.getEvents()).toEqual([
				expect.objectContaining({
					captureTransport: 'global-fetch',
					url: 'https://example.test/current-wrapper',
				}),
			]);
			expect(second.getEvents()).toEqual([
				expect.objectContaining({
					captureTransport: 'global-fetch',
					url: 'https://example.test/current-wrapper',
				}),
			]);
		} finally {
			disposeSecond?.();
			disposeFirst?.();
			globalThis.fetch = previousFetch;
		}
	});

	it('rolls back global fetch bookkeeping when patch installation fails', () => {
		const previousDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'fetch',
		);
		const baseFetch = jest.fn() as unknown as typeof fetch;
		try {
			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				enumerable: previousDescriptor?.enumerable ?? true,
				get: () => baseFetch,
				set: () => {
					throw new Error('fetch is read-only');
				},
			});
			const failed = createNetworkPlugin({ patchGlobalFetch: true });
			expect(() => failed.plugin.install?.()).toThrow('fetch is read-only');

			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				enumerable: previousDescriptor?.enumerable ?? true,
				value: baseFetch,
				writable: true,
			});
			const recovered = createNetworkPlugin({ patchGlobalFetch: true });
			const dispose = recovered.plugin.install?.();
			expect(globalThis.fetch).not.toBe(baseFetch);
			dispose?.();
			expect(globalThis.fetch).toBe(baseFetch);
		} finally {
			if (previousDescriptor) {
				Object.defineProperty(globalThis, 'fetch', previousDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, 'fetch');
			}
		}
	});

	it('keeps an existing layer active when a later layer rebuild fails', async () => {
		const previousDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'fetch',
		);
		const baseFetch = jest
			.fn()
			.mockResolvedValue(response('{}')) as unknown as typeof fetch;
		let disposeFirst: (() => void) | undefined;
		try {
			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				enumerable: previousDescriptor?.enumerable ?? true,
				value: baseFetch,
				writable: true,
			});
			const first = createNetworkPlugin({ patchGlobalFetch: true });
			disposeFirst = first.plugin.install?.();
			const installedFirstFetch = globalThis.fetch;
			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				enumerable: previousDescriptor?.enumerable ?? true,
				get: () => installedFirstFetch,
				set: () => {
					throw new Error('fetch rebuild is blocked');
				},
			});

			const second = createNetworkPlugin({ patchGlobalFetch: true });
			expect(() => second.plugin.install?.()).toThrow(
				'fetch rebuild is blocked',
			);
			Object.defineProperty(globalThis, 'fetch', {
				configurable: true,
				enumerable: previousDescriptor?.enumerable ?? true,
				value: installedFirstFetch,
				writable: true,
			});

			await globalThis.fetch('https://example.test/surviving-layer');
			await flushCapture();
			expect(first.getEvents()).toEqual([
				expect.objectContaining({
					url: 'https://example.test/surviving-layer',
				}),
			]);
		} finally {
			disposeFirst?.();
			if (previousDescriptor) {
				Object.defineProperty(globalThis, 'fetch', previousDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, 'fetch');
			}
		}
	});

	it('runs baseline redaction after host-provided redactors', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			redactBody: () => '{"pass\\u0077ord":"private-body"}',
			redactHeader: () => 'token=private-header',
			redactUrl: () => 'https://example.test?pass%77ord=private-url',
			sourceLabel: 'email=person@example.com',
		});
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test?token=raw',
			{ headers: { 'x-debug': 'value' }, body: 'value', method: 'POST' },
		);
		await flushCapture();

		const captured = JSON.stringify(diagnostics.getEvents());
		expect(captured).not.toContain('private-body');
		expect(captured).not.toContain('private-header');
		expect(captured).not.toContain('private-url');
		expect(captured).not.toContain('pass%77ord');
		expect(captured).not.toContain('person@example.com');
		dispose?.();
	});

	it('omits unknown-length bodies by default without reporting a zero size', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const unknownLengthResponse = {
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			clone: () => ({ text: async () => '{"large":true}' }),
		} as unknown as Response;
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(unknownLengthResponse) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation, {
			trustedResponse: true,
		})('https://example.test');
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '[Body omitted: unknown content length]',
			}),
		);
		expect(diagnostics.getEvents()[0]?.responseSizeBytes).toBeUndefined();
		dispose?.();
	});

	it('reports the actual UTF-8 size when unknown-length capture is enabled', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain' }),
			clone: () => streamedBodyClone('🏋️'),
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => response),
			{
				trustedResponse: true,
			},
		)('https://example.test');
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '🏋️',
				responseSizeBytes: new TextEncoder().encode('🏋️').byteLength,
			}),
		);
		dispose?.();
	});

	it('stops bounded response capture when Content-Length understates the body', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			maxBodyBytes: 96,
		});
		const dispose = diagnostics.plugin.install?.();
		const oversizedBody = 'x'.repeat(4 * 1024);
		const forgedResponse = responseWithHeaders(
			oversizedBody,
			200,
			new Headers({
				'content-length': '1',
				'content-type': 'text/plain',
			}),
		);

		await diagnostics.instrumentFetch(jest.fn(async () => forgedResponse))(
			'https://example.test/forged-length',
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '[Body omitted: exceeds 96 bytes]',
				responseSizeBytes: undefined,
			}),
		);
		expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain(
			oversizedBody,
		);
		dispose?.();
	});

	it('rejects bodies above the redaction limit before allocating a reader', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const clone = jest.fn(() => streamedBodyClone('unreachable'));
		const oversizedResponse = {
			status: 200,
			headers: new Headers({
				'content-length': String(100 * 1024),
				'content-type': 'text/plain',
			}),
			clone,
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => oversizedResponse),
			{ trustedResponse: true },
		)('https://example.test/above-redaction-bound');
		await flushCapture();

		expect(clone).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: `[Body omitted: ${100 * 1024} bytes]`,
				responseSizeBytes: 100 * 1024,
			}),
		);
		dispose?.();
	});

	it('preserves a valid reported response size when optional body reading fails', async () => {
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const unreadableResponse = {
			status: 200,
			headers: new Headers({
				'content-length': '321',
				'content-type': 'text/plain',
			}),
			clone: () => ({
				body: {
					getReader: () => {
						throw new Error('unreadable stream');
					},
				},
			}),
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => unreadableResponse),
			{
				trustedResponse: true,
			},
		)('https://example.test/unreadable-response');
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '[Unreadable response body]',
				responseSizeBytes: 321,
			}),
		);
		dispose?.();
	});

	it('preserves a valid reported response size when body capture times out', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin({ captureBody: true });
			const dispose = diagnostics.plugin.install?.();
			const cancel = jest.fn(async () => {});
			const stalledResponse = {
				status: 200,
				headers: new Headers({
					'content-length': '321',
					'content-type': 'text/plain',
				}),
				clone: () => ({
					body: {
						getReader: () => ({
							cancel,
							read: () => new Promise<never>(() => {}),
						}),
					},
				}),
			} as unknown as Response;

			await diagnostics.instrumentFetch(
				jest.fn(async () => stalledResponse),
				{ trustedResponse: true },
			)('https://example.test/timed-out-response');
			expect(diagnostics.getEvents()[0]?.responseSizeBytes).toBe(321);

			await jest.advanceTimersByTimeAsync(10_000);
			await flushCapture();
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					responseBody: '[Body capture cancelled]',
					responseSizeBytes: 321,
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('drops a declared response size contradicted before body capture times out', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin({
				captureBody: true,
				maxBodyBytes: 96,
			});
			const dispose = diagnostics.plugin.install?.();
			const firstChunk = new Uint8Array(50);
			let readCount = 0;
			const stalledResponse = {
				status: 200,
				headers: new Headers({
					'content-length': '1',
					'content-type': 'text/plain',
				}),
				clone: () => ({
					body: {
						getReader: () => ({
							cancel: async () => {},
							read: () => {
								readCount += 1;
								return readCount === 1
									? Promise.resolve({ done: false, value: firstChunk })
									: new Promise<never>(() => {});
							},
						}),
					},
				}),
			} as unknown as Response;

			await diagnostics.instrumentFetch(
				jest.fn(async () => stalledResponse),
				{ trustedResponse: true },
			)('https://example.test/contradicted-timeout-size');
			await flushCapture();
			expect(readCount).toBe(2);

			await jest.advanceTimersByTimeAsync(10_000);
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					responseBody: '[Body capture cancelled]',
					responseSizeBytes: undefined,
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('bounds immediately resolving response-reader chunk counts', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const cancel = jest.fn(async () => {});
		const read = jest.fn(async () => ({
			done: false,
			value: new Uint8Array(0),
		}));
		const unboundedResponse = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain' }),
			clone: () => ({
				body: { getReader: () => ({ cancel, read }) },
			}),
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => unboundedResponse),
			{ trustedResponse: true },
		)('https://example.test/unbounded-zero-chunks');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(read.mock.calls.length).toBeGreaterThan(0);
		expect(read.mock.calls.length).toBeLessThan(10_000);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				responseBody: '[Body omitted: read count limit]',
				responseSizeBytes: undefined,
			}),
		);
		dispose?.();
	});

	it('stops bounded capture of unknown-length Request bodies', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			captureUnknownLengthBodies: true,
			maxBodyBytes: 96,
		});
		const dispose = diagnostics.plugin.install?.();
		const input = new Request('https://example.test/request-stream', {
			method: 'POST',
			body: 'x'.repeat(4 * 1024),
		});

		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)(input);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				requestBody: '[Body omitted: exceeds 96 bytes]',
				requestSizeBytes: undefined,
				requestProjectionComplete: false,
			}),
		);
		dispose?.();
	});

	it('settles request outcome before diagnostic body capture completes', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			eventStore: timeline,
		});
		const dispose = diagnostics.plugin.install?.();
		const cancel = jest.fn(async () => {});
		const stalledResponse = {
			status: 200,
			headers: new Headers({
				'content-length': '1',
				'content-type': 'text/plain',
			}),
			clone: () => ({
				body: {
					getReader: () => ({
						read: () => new Promise<never>(() => {}),
						cancel,
					}),
				},
			}),
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => stalledResponse),
			{
				trustedResponse: true,
			},
		)('https://example.test/stalled-clone');

		expect(diagnostics.getEvents()[0]?.state).toBe('success');
		expect(timeline.getEvents()[0]).toEqual(
			expect.objectContaining({
				attributes: expect.objectContaining({ state: 'success' }),
			}),
		);
		dispose?.();
		await flushCapture();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents()).toEqual([]);
	});

	it('cancels live body readers when capture authority changes', async () => {
		let capabilityListener = (): void => {};
		let capabilityId = NETWORK_SIMULATION_CAPABILITY_ID;
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			eventStore: timeline,
			enableSimulation: true,
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const cancel = jest.fn(async () => {});
		const stalledResponse = {
			status: 200,
			headers: new Headers({
				'content-length': '1',
				'content-type': 'text/plain',
			}),
			clone: () => ({
				body: {
					getReader: () => ({
						read: () => new Promise<never>(() => {}),
						cancel,
					}),
				},
			}),
		} as unknown as Response;

		await diagnostics.instrumentFetch(
			jest.fn(async () => stalledResponse),
			{
				trustedResponse: true,
			},
		)('https://example.test/authority-reader');
		await Promise.resolve();
		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(timeline.getEvents()).toHaveLength(1);

		capabilityId = 'network.set-profile.replacement';
		capabilityListener();
		await flushCapture();

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents()).toEqual([]);
		dispose?.();
	});

	it.each(['public clear', 'confirmed clear'] as const)(
		'cancels live body readers on %s',
		async (clearKind) => {
			const diagnostics = createNetworkPlugin({
				captureBody: true,
				...(clearKind === 'confirmed clear'
					? {
							actionCoordinator: createDevToolsActionCoordinator({
								confirm: async () => true,
							}),
						}
					: {}),
			});
			const dispose = diagnostics.plugin.install?.();
			const cancel = jest.fn(async () => {});
			const stalledResponse = {
				status: 200,
				headers: new Headers({
					'content-length': '1',
					'content-type': 'text/plain',
				}),
				clone: () => ({
					body: {
						getReader: () => ({
							read: () => new Promise<never>(() => {}),
							cancel,
						}),
					},
				}),
			} as unknown as Response;

			await diagnostics.instrumentFetch(
				jest.fn(async () => stalledResponse),
				{
					trustedResponse: true,
				},
			)('https://example.test/clear-reader');
			await Promise.resolve();
			expect(diagnostics.getEvents()).toHaveLength(1);

			if (clearKind === 'confirmed clear') {
				await diagnostics.requestClear('cancel-reader');
			} else {
				diagnostics.clear();
			}
			await flushCapture();

			expect(cancel).toHaveBeenCalledTimes(1);
			expect(diagnostics.getEvents()).toEqual([]);
			dispose?.();
		},
	);

	it('rejects invalid body bounds', () => {
		expect(() => createNetworkPlugin({ maxBodyBytes: 0 })).toThrow(
			'maxBodyBytes',
		);
		expect(() => createNetworkPlugin({ maxBodyBytes: 64 * 1024 + 1 })).toThrow(
			'maxBodyBytes cannot exceed 65536',
		);
		expect(() => createNetworkPlugin({ maxEvents: 10_001 })).toThrow(
			'maxEvents cannot exceed',
		);
	});

	it('does not resurrect a pending request after it has been evicted', async () => {
		const diagnostics = createNetworkPlugin({ maxEvents: 1 });
		const dispose = diagnostics.plugin.install?.();
		let resolveFirst: ((response: Response) => void) | undefined;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const response = (status: number) =>
			({
				status,
				headers: new Headers(),
				clone: () => ({ text: async () => '' }),
			}) as unknown as Response;
		const fetchImplementation = jest
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(response(201)) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		const first = instrumented('https://example.test/first');
		await instrumented('https://example.test/second');
		await flushCapture();
		resolveFirst?.(response(200));
		await first;
		await flushCapture();

		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ url: 'https://example.test/second' }),
		]);
		dispose?.();
	});

	it('cancels an evicted pending request-body reader before late settlement', async () => {
		const previousRequestDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'Request',
		);
		const cancel = jest.fn(async () => {});
		class StalledRequest {
			readonly body = {};
			readonly headers = new Headers({
				'content-length': '4',
				'content-type': 'text/plain',
			});
			readonly method = 'POST';
			readonly signal = new AbortController().signal;
			readonly url = 'https://example.test/evicted-body';

			clone() {
				return {
					body: {
						getReader: () => ({
							cancel,
							read: () => new Promise<never>(() => {}),
						}),
					},
				};
			}
		}
		Object.defineProperty(globalThis, 'Request', {
			configurable: true,
			value: StalledRequest,
			writable: true,
		});
		let dispose: (() => void) | undefined;
		try {
			const diagnostics = createNetworkPlugin({
				captureBody: true,
				captureUnknownLengthBodies: true,
				maxEvents: 1,
			});
			dispose = diagnostics.plugin.install?.();
			let resolveFirst = (_response: Response): void => {};
			const firstResponse = new Promise<Response>((resolve) => {
				resolveFirst = resolve;
			});
			const fetchImplementation = jest
				.fn()
				.mockReturnValueOnce(firstResponse)
				.mockResolvedValueOnce(response('{}')) as unknown as typeof fetch;
			const instrumented = diagnostics.instrumentFetch(fetchImplementation);

			const first = instrumented(new StalledRequest() as unknown as Request);
			await Promise.resolve();
			await instrumented('https://example.test/retained');
			await flushCapture();

			expect(cancel).toHaveBeenCalledTimes(1);
			expect(diagnostics.getEvents()).toEqual([
				expect.objectContaining({ url: 'https://example.test/retained' }),
			]);

			resolveFirst(response('{}'));
			await first;
			await flushCapture();
			expect(diagnostics.getEvents()).toEqual([
				expect.objectContaining({ url: 'https://example.test/retained' }),
			]);
		} finally {
			dispose?.();
			if (previousRequestDescriptor) {
				Object.defineProperty(globalThis, 'Request', previousRequestDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, 'Request');
			}
		}
	});

	it('binds captures and late settlements to the exact dynamic owner token', async () => {
		let owner = 'owner-a';
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => owner,
			eventStore: timeline,
		});
		const dispose = diagnostics.plugin.install?.();
		let settleOwnerA = (_response: Response): void => {};
		const ownerAResponse = new Promise<Response>((resolve) => {
			settleOwnerA = resolve;
		});
		const fetchImplementation = jest
			.fn()
			.mockReturnValueOnce(ownerAResponse)
			.mockResolvedValueOnce(response('{}')) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		const ownerARequest = instrumented('https://example.test/owner-a');
		await Promise.resolve();
		const ownerAEvent = diagnostics.getEvents()[0];
		expect(ownerAEvent?.url).toBe('https://example.test/owner-a');

		owner = 'owner-b';
		await instrumented('https://example.test/owner-b');
		await flushCapture();
		const ownerBEvent = diagnostics.getEvents()[0];
		expect(ownerBEvent).toEqual(
			expect.objectContaining({ url: 'https://example.test/owner-b' }),
		);
		expect(ownerBEvent?.sessionId).not.toBe(ownerAEvent?.sessionId);
		expect(ownerBEvent?.correlationId).not.toBe(ownerAEvent?.correlationId);

		settleOwnerA(response('{}'));
		await ownerARequest;
		await flushCapture();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ url: 'https://example.test/owner-b' }),
		]);
		expect(timeline.getEvents()).toEqual([
			expect.objectContaining({
				resourceRef: expect.objectContaining({
					resourceId: expect.stringContaining(`${ownerBEvent?.sessionId}:`),
				}),
			}),
		]);
		dispose?.();
	});

	it('does not append an old-owner request after a synchronous host callback changes authority', async () => {
		let owner = 'owner-a';
		let authorityListener = (): void => {};
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
			idFactory: (kind, sequence) => `${kind}-${sequence}`,
		});
		const correlationContext = jest.fn(() => {
			owner = 'owner-b';
			timeline.resetSession();
			authorityListener();
			return { correlationId: 'old-owner-correlation' };
		});
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => owner,
			correlationContext,
			eventStore: timeline,
			subscribeCaptureAuthority: (listener) => {
				authorityListener = listener;
				return () => {};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest.fn(async () => response('{}'));
		const instrumented = diagnostics.instrumentFetch(
			fetchImplementation as unknown as typeof fetch,
		);

		const result = await instrumented(
			'https://example.test/owner-a-reentrant-callback',
		);

		expect(result.status).toBe(200);
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
		expect(fetchImplementation).toHaveBeenCalledWith(
			'https://example.test/owner-a-reentrant-callback',
			undefined,
		);
		expect(correlationContext).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.createCorrelationId()).toMatch(
			/^correlation-1:correlation:\d+:[A-Za-z0-9-]+:1$/,
		);
		dispose?.();
	});

	it('polls dynamic capture ownership even while no panel is mounted', async () => {
		jest.useFakeTimers();
		try {
			let owner = 'owner-a';
			const diagnostics = createNetworkPlugin({
				captureAuthority: () => owner,
			});
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.instrumentFetch(
				jest.fn(async () => response('{}')) as unknown as typeof fetch,
			)('https://example.test/owner-a-private');
			expect(diagnostics.getEvents()).toHaveLength(1);

			owner = 'owner-b';
			await jest.advanceTimersByTimeAsync(250);

			expect(diagnostics.getEvents()).toEqual([]);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('keeps reentrant owner-reset requests out of the transitioning session', async () => {
		let owner = 'owner-a';
		const diagnostics = createNetworkPlugin({ captureAuthority: () => owner });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{}')) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);
		await instrumented('https://example.test/owner-a');
		const ownerASession = diagnostics.getEvents()[0]?.sessionId;
		let reentrantRequest: Promise<Response> | undefined;
		let triggered = false;
		const unsubscribe = diagnostics.subscribeSimulationState(() => {
			if (owner !== 'owner-b' || triggered) return;
			triggered = true;
			reentrantRequest = instrumented('https://example.test/reentrant-owner-b');
		});

		owner = 'owner-b';
		expect(diagnostics.getEvents()).toEqual([]);
		await reentrantRequest;
		await flushCapture();
		expect(diagnostics.getEvents()).toEqual([]);

		await instrumented('https://example.test/owner-b');
		const ownerBEvent = diagnostics.getEvents()[0];
		expect(ownerBEvent?.sessionId).not.toBe(ownerASession);
		expect(ownerBEvent?.url).toBe('https://example.test/owner-b');
		unsubscribe();
		dispose?.();
	});
});

describe('network presentation model', () => {
	it('labels Supabase rest, edge function, storage, and auth requests', () => {
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/rest/v1/items?select=id',
				}),
			),
		).toEqual({ label: 'items', sourceKind: 'rest' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/functions/v1/example-function',
				}),
			),
		).toEqual({ label: 'example-function', sourceKind: 'edge function' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/storage/v1/object/sign/item_media/clip.mp4',
				}),
			),
		).toEqual({ label: 'item_media', sourceKind: 'storage' });
		expect(
			networkEventLabel(
				networkEvent({
					url: 'https://abc.supabase.co/auth/v1/token?grant_type=refresh_token',
				}),
			),
		).toEqual({ label: 'token', sourceKind: 'auth' });
		expect(
			networkEventLabel(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
			),
		).toEqual({ label: 'batch' });
	});

	it('matches segment filters for supabase, errors, and slow requests', () => {
		expect(
			isSupabaseNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:54321/rest/v1/items' }),
			),
		).toBe(true);
		expect(
			isSupabaseNetworkEvent(
				networkEvent({ url: 'https://abc.supabase.co/anything' }),
			),
		).toBe(true);
		expect(
			matchesNetworkSegment(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
				'supabase',
			),
		).toBe(false);
		expect(matchesNetworkSegment(networkEvent({ status: 500 }), 'errors')).toBe(
			true,
		);
		expect(
			matchesNetworkSegment(
				networkEvent({ state: 'aborted', status: undefined }),
				'errors',
			),
		).toBe(true);
		expect(matchesNetworkSegment(networkEvent(), 'errors')).toBe(false);
		expect(
			matchesNetworkSegment(networkEvent({ durationMs: 1200 }), 'slow'),
		).toBe(true);
		expect(
			matchesNetworkSegment(networkEvent({ durationMs: 800 }), 'slow'),
		).toBe(false);
	});

	it('hides the Metro dev server on an IPv6 loopback authority', () => {
		// `URL.host` brackets IPv6, so splitting on the first colon used to yield
		// '[' as the hostname and drop the port, leaving dev-server traffic visible.
		expect(
			isSystemNetworkEvent(networkEvent({ url: 'http://[::1]:8081/status' })),
		).toBe(true);
		expect(
			isSystemNetworkEvent(networkEvent({ url: 'http://[::1]:443/v1/me' })),
		).toBe(false);
	});

	it('hides only connectivity checks, sentry ingest, and the Metro dev server', () => {
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://clients3.google.com/generate_204' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({
					url: 'https://connectivitycheck.gstatic.com/generate_204',
				}),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://captive.apple.com/hotspot-detect.html' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://o123.ingest.sentry.io/api/1/envelope/' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://localhost:8081/symbolicate' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:8090/status' }),
			),
		).toBe(true);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'http://127.0.0.1:54321/rest/v1/items' }),
			),
		).toBe(false);
		expect(
			isSystemNetworkEvent(
				networkEvent({ url: 'https://app.posthog.com/batch/' }),
			),
		).toBe(false);
	});

	it('collapses only consecutive duplicates of method, url, and status', () => {
		const batch = (id: number) =>
			networkEvent({
				id,
				method: 'POST',
				status: 204,
				url: 'https://app.posthog.com/batch/',
			});
		const collapsed = collapseNetworkEvents([
			batch(5),
			batch(4),
			batch(3),
			networkEvent({
				id: 2,
				method: 'POST',
				status: 500,
				url: 'https://app.posthog.com/batch/',
			}),
			batch(1),
		]);
		expect(collapsed.map((row) => [row.event.id, row.count])).toEqual([
			[5, 3],
			[2, 1],
			[1, 1],
		]);
	});

	it('summarizes visible traffic with window, counts, failures, and size', () => {
		const now = 10 * 60_000;
		const events = [
			networkEvent({
				requestSizeBytes: 1024,
				responseSizeBytes: 1024,
				startedAt: now - 4 * 60_000,
			}),
			networkEvent({
				error: 'Network request failed',
				id: 2,
				startedAt: now - 60_000,
				state: 'error',
				status: undefined,
			}),
		];
		expect(summarizeNetworkEvents(events, now)).toBe(
			'Last 4 min · 2 requests · 1 failed · 2.0 KB',
		);
		expect(summarizeNetworkEvents([], now)).toBe('No requests');
	});

	it('presents status text and tone by request outcome', () => {
		expect(
			networkStatusPresentation(
				networkEvent({ state: 'pending', status: undefined }),
			),
		).toEqual({ text: '…', tone: 'info' });
		expect(networkStatusPresentation(networkEvent())).toEqual({
			text: '200',
			tone: 'success',
		});
		expect(networkStatusPresentation(networkEvent({ status: 404 }))).toEqual({
			text: '404',
			tone: 'warning',
		});
		expect(networkStatusPresentation(networkEvent({ status: 500 }))).toEqual({
			text: '500',
			tone: 'danger',
		});
		expect(
			networkStatusPresentation(
				networkEvent({ state: 'error', status: undefined }),
			),
		).toEqual({ text: 'ERROR', tone: 'danger' });
	});

	it('builds row subtitles from source, timing, and payload', () => {
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 182,
					responseSizeBytes: 2150,
					url: 'https://abc.supabase.co/rest/v1/items',
				}),
			),
		).toBe('rest · 182 ms · 2.1 KB');
		expect(
			networkRowSubtitle(
				networkEvent({
					state: 'pending',
					status: undefined,
					url: 'https://abc.supabase.co/functions/v1/example-function',
				}),
			),
		).toBe('edge function · pending');
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 3400,
					error: 'STREAM_FAILED',
					state: 'error',
					status: undefined,
					url: 'https://abc.supabase.co/functions/v1/example-function',
				}),
			),
		).toBe('edge function · 3.4 s · STREAM_FAILED');
		expect(
			networkRowSubtitle(
				networkEvent({
					durationMs: 88,
					method: 'POST',
					responseSizeBytes: 6144,
					status: 204,
					url: 'https://app.posthog.com/batch/',
				}),
			),
		).toBe('posthog · 88 ms · 6.0 KB');
	});

	it('formats detail rows and bodies', () => {
		expect(formatNetworkDuration(182)).toBe('182 ms');
		expect(formatNetworkDuration(3400)).toBe('3.4 s');
		expect(
			formatNetworkClock(new Date(2026, 7, 19, 12, 41, 7, 412).getTime()),
		).toBe('12:41:07.412');
		expect(prettyNetworkBody('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyNetworkBody('plain')).toBe('plain');
		expect(
			networkRequestPath('https://abc.supabase.co/rest/v1/items?select=id'),
		).toBe('/rest/v1/items?select=id');
		expect(detailStatusText(networkEvent())).toBe('200 OK');
		expect(
			detailStatusText(networkEvent({ state: 'aborted', status: undefined })),
		).toBe('Aborted');
		expect(
			responseBodySummaryText(
				networkEvent({
					contentType: 'application/json',
					responseBody: '[]',
					responseSizeBytes: 2150,
				}),
			),
		).toBe('JSON · 2.1 KB');
		expect(responseBodySummaryText(networkEvent())).toBe('Empty');
	});

	it('builds a runnable cURL command with escaped quotes', () => {
		const command = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: '{"name":"Example"}',
				requestHeaders: { 'content-type': 'application/json' },
				url: "https://example.test/items?q=o'clock",
			}),
		);
		expect(command).toContain(
			"curl -X 'POST' 'https://example.test/items?q=o%27clock'",
		);
		expect(command).toContain("-H 'content-type: application/json'");
		expect(command).toContain(`--data-raw '{`);
		expect(command).toContain(`"name":"Example"`);
	});

	describe('replay safety', () => {
		it('allows replay only when nothing was redacted or dropped', () => {
			expect(
				networkReplayBlockReason(
					networkEvent({
						method: 'POST',
						requestBody: defaultRedactBody('{"items":[1,2,3]}'),
					}),
				),
			).toBeUndefined();
		});

		it('does not preserve raw JSON when duplicate keys hide sensitive text', () => {
			const raw = '{"note":"victim@example.com","note":"ok"}';
			const redacted = defaultRedactBody(raw);

			expect(redacted).not.toBe(raw);
			expect(redacted).not.toContain('victim@example.com');
			expect(redacted).toContain('"note": "ok"');
		});

		it('blocks replay when the projection dropped array entries', () => {
			// The per-level entry cap silently shortens the array, so the projected
			// body still parses as JSON and would otherwise look complete.
			const body = defaultRedactBody(
				JSON.stringify({ items: Array.from({ length: 150 }, (_, i) => i) }),
			);
			expect(
				JSON.parse(body.split('\n[Body truncated')[0] ?? '').items,
			).toHaveLength(100);
			expect(
				networkReplayBlockReason(
					networkEvent({ method: 'POST', requestBody: body }),
				),
			).toBeDefined();
		});

		it('blocks replay when the projection hit its depth limit', () => {
			let nested: Record<string, unknown> = { leaf: true };
			for (let depth = 0; depth < 12; depth += 1) nested = { nested };
			expect(
				networkReplayBlockReason(
					networkEvent({
						method: 'POST',
						requestBody: defaultRedactBody(JSON.stringify(nested)),
					}),
				),
			).toBeDefined();
		});

		it('blocks replay of a body cut at the capture size limit', () => {
			expect(
				networkReplayBlockReason(
					networkEvent({ method: 'POST', requestBody: '{"name":"Ben…' }),
				),
			).toBe(
				'The captured request body was truncated at the capture size limit.',
			);
		});

		it('blocks replay when a header or the URL was redacted', () => {
			expect(
				networkReplayBlockReason(
					networkEvent({ requestHeaders: { authorization: '[REDACTED]' } }),
				),
			).toBe('One or more request headers were redacted.');
			expect(
				networkReplayBlockReason(
					networkEvent({ url: 'https://example.test/items?token=[REDACTED]' }),
				),
			).toBe('The captured URL contains omitted or redacted data.');
		});

		it('distinguishes a known-bodyless write from an incomplete projection', () => {
			expect(
				networkReplayBlockReason(
					networkEvent({ method: 'POST', requestBody: undefined }),
				),
			).toBeUndefined();
			expect(
				networkReplayBlockReason(
					networkEvent({
						method: 'POST',
						requestBody: undefined,
						requestProjectionComplete: false,
					}),
				),
			).toContain('complete original request was not retained');
		});
	});

	it('applies and clears an app-scoped offline profile', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		const instrumentedFetch = diagnostics.instrumentFetch(fetchImplementation);

		await expect(diagnostics.setSimulationProfile('offline')).resolves.toEqual(
			expect.objectContaining({
				status: 'succeeded',
				risk: 'confirmation',
				capabilityId: NETWORK_SIMULATION_CAPABILITY_ID,
			}),
		);
		expect(diagnostics.getSimulationProfile()).toEqual(
			expect.objectContaining({ id: 'offline', offline: true }),
		);
		await expect(
			instrumentedFetch('https://example.test/offline'),
		).rejects.toThrow('Offline network profile');
		expect(fetchImplementation).not.toHaveBeenCalled();

		await expect(diagnostics.clearSimulationProfile()).resolves.toEqual(
			expect.objectContaining({ status: 'succeeded' }),
		);
		await expect(
			instrumentedFetch('https://example.test/online'),
		).resolves.toEqual(expect.objectContaining({ status: 200 }));
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
		dispose?.();
	});

	it('delays instrumented requests and honors cancellation', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
			const instrumentedFetch =
				diagnostics.instrumentFetch(fetchImplementation);
			await diagnostics.setSimulationProfile('wifi');

			const delayedRequest = instrumentedFetch('https://example.test/delayed');
			expect(fetchImplementation).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(100);
			await delayedRequest;
			expect(fetchImplementation).toHaveBeenCalledTimes(1);

			const controller = new AbortController();
			const cancelledRequest = instrumentedFetch(
				'https://example.test/cancelled',
				{ signal: controller.signal },
			);
			controller.abort(abortedErrorForTest());
			await expect(cancelledRequest).rejects.toMatchObject({
				name: 'AbortError',
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('treats an explicit null signal as overriding an aborted Request signal', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const controller = new AbortController();
			controller.abort(abortedErrorForTest());
			const input = new Request('https://example.test/detached-signal', {
				signal: controller.signal,
			});
			let receivedSignal: AbortSignal | null | undefined;
			const fetchImplementation = jest.fn(async (_input, init) => {
				receivedSignal = init?.signal;
				return response('{}');
			}) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');

			const request = diagnostics.instrumentFetch(fetchImplementation)(input, {
				signal: null,
			});
			await jest.advanceTimersByTimeAsync(100);
			await expect(request).resolves.toEqual(
				expect.objectContaining({ status: 200 }),
			);

			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			expect(receivedSignal?.aborted).toBe(false);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('inherits an aborted Request signal when init.signal is undefined', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();
		const controller = new AbortController();
		controller.abort(abortedErrorForTest());
		const input = new Request('https://example.test/inherited-signal', {
			signal: controller.signal,
		});
		const fetchImplementation = jest
			.fn()
			.mockResolvedValue(response('{}')) as unknown as typeof fetch;
		await diagnostics.setSimulationProfile('wifi');

		await expect(
			diagnostics.instrumentFetch(fetchImplementation)(input, {
				signal: undefined,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchImplementation).not.toHaveBeenCalled();
		dispose?.();
	});

	it('preserves caller cancellation for streaming bodies after fetch resolves', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			let receivedSignal: AbortSignal | undefined;
			const fetchImplementation = jest.fn(
				(_input: RequestInfo | URL, init?: RequestInit) => {
					receivedSignal = init?.signal ?? undefined;
					return Promise.resolve({
						...responseWithHeaders('', 200, new Headers()),
						body: {} as ReadableStream<Uint8Array>,
					} as Response);
				},
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');
			const controller = new AbortController();
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/streaming',
				{ signal: controller.signal },
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;
			expect(receivedSignal?.aborted).toBe(false);

			controller.abort(abortedErrorForTest());

			expect(receivedSignal?.aborted).toBe(true);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('classifies caller aborts with non-Error reasons as aborted', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');
			const controller = new AbortController();
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/raw-abort',
				{ signal: controller.signal },
			);
			controller.abort('navigation');

			await expect(request).rejects.toBe('navigation');
			await flushCapture();
			expect(diagnostics.getEvents()[0]?.state).toBe('aborted');
			expect(fetchImplementation).not.toHaveBeenCalled();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not relabel an earlier transport failure when the caller aborts later', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const transportError = new TypeError('transport failed');
		const fetchImplementation = jest.fn(() =>
			Promise.reject(transportError),
		) as unknown as typeof fetch;
		const controller = new AbortController();

		const request = diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/transport-failure',
			{ signal: controller.signal },
		);
		controller.abort('navigation');

		await expect(request).rejects.toBe(transportError);
		await flushCapture();
		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({ state: 'error', error: 'transport failed' }),
		);
		dispose?.();
	});

	it('keeps the fallback streaming abort bridge after the profile deadline', async () => {
		jest.useFakeTimers();
		const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
		try {
			Object.defineProperty(AbortSignal, 'any', {
				configurable: true,
				value: undefined,
			});
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const controller = new AbortController();
			let receivedSignal: AbortSignal | undefined;
			const fetchImplementation = jest.fn(
				(_input: RequestInfo | URL, init?: RequestInit) => {
					receivedSignal = init?.signal ?? undefined;
					return Promise.resolve({
						...responseWithHeaders('', 200, new Headers()),
						body: {} as ReadableStream<Uint8Array>,
					} as Response);
				},
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/stream-cleanup',
				{ signal: controller.signal },
			);
			await jest.advanceTimersByTimeAsync(100);
			const retainedBody = (await request).body;
			expect(retainedBody).toBeDefined();
			expect(receivedSignal?.aborted).toBe(false);

			await jest.advanceTimersByTimeAsync(10 * 60_000 + 1);

			expect(receivedSignal?.aborted).toBe(false);
			expect(retainedBody).toBeDefined();
			controller.abort(abortedErrorForTest());
			expect(receivedSignal?.aborted).toBe(true);
			dispose?.();
		} finally {
			if (anyDescriptor) {
				Object.defineProperty(AbortSignal, 'any', anyDescriptor);
			} else {
				Reflect.deleteProperty(AbortSignal, 'any');
			}
			jest.useRealTimers();
		}
	});

	it('releases fallback caller listeners for bodyless successful responses', async () => {
		jest.useFakeTimers();
		const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
		try {
			Object.defineProperty(AbortSignal, 'any', {
				configurable: true,
				value: undefined,
			});
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const controller = new AbortController();
			const add = jest.spyOn(controller.signal, 'addEventListener');
			const remove = jest.spyOn(controller.signal, 'removeEventListener');
			const fetchImplementation = jest.fn(async () =>
				responseWithHeaders('', 204, new Headers()),
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/no-content',
				{ signal: controller.signal },
			);

			await jest.advanceTimersByTimeAsync(100);
			await request;

			const abortAdds = add.mock.calls.filter(
				([type]) => type === 'abort',
			).length;
			const abortRemoves = remove.mock.calls.filter(
				([type]) => type === 'abort',
			).length;
			expect(abortAdds).toBeGreaterThan(0);
			expect(abortRemoves).toBe(abortAdds);
			expect(jest.getTimerCount()).toBe(0);
			dispose?.();
		} finally {
			if (anyDescriptor) {
				Object.defineProperty(AbortSignal, 'any', anyDescriptor);
			} else {
				Reflect.deleteProperty(AbortSignal, 'any');
			}
			jest.useRealTimers();
		}
	});

	it('bounds and clears the manual bridge when FinalizationRegistry is unavailable', async () => {
		jest.useFakeTimers();
		const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
		const finalizerDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			'FinalizationRegistry',
		);
		try {
			Object.defineProperty(AbortSignal, 'any', {
				configurable: true,
				value: undefined,
			});
			Object.defineProperty(globalThis, 'FinalizationRegistry', {
				configurable: true,
				value: undefined,
			});
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const controller = new AbortController();
			let receivedSignal: AbortSignal | undefined;
			const fetchImplementation = jest.fn(
				(_input: RequestInfo | URL, init?: RequestInit) => {
					receivedSignal = init?.signal ?? undefined;
					return Promise.resolve({
						...responseWithHeaders('', 200, new Headers()),
						body: {} as ReadableStream<Uint8Array>,
					} as Response);
				},
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/no-finalizer',
				{ signal: controller.signal },
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;

			expect(jest.getTimerCount()).toBe(1);
			controller.abort(abortedErrorForTest());
			expect(receivedSignal?.aborted).toBe(true);
			expect(jest.getTimerCount()).toBe(0);
			dispose?.();
		} finally {
			if (anyDescriptor) {
				Object.defineProperty(AbortSignal, 'any', anyDescriptor);
			} else {
				Reflect.deleteProperty(AbortSignal, 'any');
			}
			if (finalizerDescriptor) {
				Object.defineProperty(
					globalThis,
					'FinalizationRegistry',
					finalizerDescriptor,
				);
			} else {
				Reflect.deleteProperty(globalThis, 'FinalizationRegistry');
			}
			jest.useRealTimers();
		}
	});

	it('automatically clears a profile when the plugin is disposed', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('3g');
		dispose?.();

		expect(diagnostics.getSimulationProfile().id).toBe('none');
		await expect(diagnostics.setSimulationProfile('lte')).resolves.toEqual(
			expect.objectContaining({ status: 'rejected', errorCode: 'unsupported' }),
		);
	});

	it('does not carry a direct pause across collector sessions', () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		diagnostics.pause();
		expect(diagnostics.isPaused()).toBe(true);

		dispose?.();
		diagnostics.pause();
		expect(diagnostics.isPaused()).toBe(false);

		const disposeNextSession = diagnostics.plugin.install?.();
		expect(diagnostics.isPaused()).toBe(false);
		disposeNextSession?.();
	});

	it('requires hosts to explicitly opt in to request simulation', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();

		await expect(diagnostics.setSimulationProfile('offline')).resolves.toEqual(
			expect.objectContaining({
				status: 'rejected',
				error: expect.stringContaining('disabled by this host'),
			}),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		dispose?.();
	});

	it('requires a trusted confirmation authority for degrading profiles', async () => {
		const withoutAuthority = createNetworkPlugin({ enableSimulation: true });
		const disposeWithoutAuthority = withoutAuthority.plugin.install?.();
		await expect(
			withoutAuthority.setSimulationProfile('offline', 'no-authority'),
		).resolves.toEqual(
			expect.objectContaining({
				status: 'rejected',
				errorCode: 'confirmation-unavailable',
			}),
		);
		expect(withoutAuthority.getSimulationProfile().id).toBe('none');
		disposeWithoutAuthority?.();

		const confirm = jest.fn(async () => false);
		const cancelled = createNetworkPlugin({
			enableSimulation: true,
			actionCoordinator: createDevToolsActionCoordinator({ confirm }),
		});
		const disposeCancelled = cancelled.plugin.install?.();
		await expect(
			cancelled.setSimulationProfile('very-bad', 'cancel-profile'),
		).resolves.toEqual(expect.objectContaining({ status: 'cancelled' }));
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				required: true,
				title: 'Apply Very Bad Network profile?',
			}),
			expect.objectContaining({
				actionFingerprint: 'network.profile:very-bad',
			}),
			expect.anything(),
		);
		expect(cancelled.getSimulationProfile().id).toBe('none');
		disposeCancelled?.();
	});

	it('clears captures through a destructive confirmed receipt', async () => {
		const confirm = jest.fn(async () => true);
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({ confirm }),
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/clear-me');
		await flushCapture();
		expect(diagnostics.getEvents()).toHaveLength(1);
		const captured = diagnostics.getEvents()[0];

		await expect(diagnostics.requestClear('clear-once')).resolves.toEqual(
			expect.objectContaining({
				status: 'succeeded',
				risk: 'destructive',
				capabilityId: 'network.clear',
			}),
		);
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				destructive: true,
				message: expect.stringContaining('1 captured request'),
			}),
			expect.objectContaining({
				actionFingerprint: `network.capture:clear:1:${captured?.sessionId}:1:${captured?.sessionId}:1`,
			}),
			expect.anything(),
		);
		expect(diagnostics.getEvents()).toEqual([]);
		dispose?.();
	});

	it('bounds signal-ignoring confirmations across collector lifecycles', async () => {
		const confirm = jest.fn(
			(
				_confirmation: unknown,
				_plan: unknown,
				_signal?: AbortSignal,
			): Promise<boolean> => new Promise<boolean>(() => {}),
		);
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({ confirm }),
			enableSimulation: true,
		});
		const firstDispose = diagnostics.plugin.install?.();
		const firstEpoch: Array<Promise<unknown>> = [];
		for (let index = 0; index < 256; index += 1) {
			firstEpoch.push(
				diagnostics.setSimulationProfile('wifi', `first-${index}`),
			);
		}
		await flushCapture();
		expect(confirm).toHaveBeenCalledTimes(256);

		firstDispose?.();
		await Promise.all(firstEpoch);
		const secondDispose = diagnostics.plugin.install?.();
		const nextEpoch = await diagnostics.setSimulationProfile(
			'wifi',
			'second-0',
		);

		expect(confirm).toHaveBeenCalledTimes(256);
		expect(nextEpoch).toEqual(
			expect.objectContaining({
				errorCode: 'confirmation-unavailable',
				status: 'rejected',
			}),
		);
		secondDispose?.();
	});

	it('clears only the one confirmed retained resource from a shared timeline', async () => {
		const confirm = jest.fn(async () => true);
		const timeline = new DevtoolsEventStore({
			maxEvents: 100,
			maxBytes: 128 * 1024,
		});
		timeline.append({
			source: 'custom',
			kind: 'test.unrelated',
			level: 'info',
			title: 'Unrelated event',
		});
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({ confirm }),
			eventStore: timeline,
			maxEvents: 1,
		});
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);
		await instrumented('https://example.test/evicted');
		await instrumented('https://example.test/retained');
		await flushCapture();

		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'Unrelated event',
			'GET retained',
		]);
		await diagnostics.requestClear('bounded-shared-clear');

		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('1 captured request'),
			}),
			expect.any(Object),
			expect.anything(),
		);
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'Unrelated event',
		]);
		dispose?.();
	});

	it('prunes an evicted settled summary as soon as a pending request replaces it', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 100,
			maxBytes: 128 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			eventStore: timeline,
			maxEvents: 1,
		});
		const dispose = diagnostics.plugin.install?.();
		let settlePending = (_response: Response): void => {};
		const pendingResponse = new Promise<Response>((resolve) => {
			settlePending = resolve;
		});
		const fetchImplementation = jest
			.fn()
			.mockResolvedValueOnce(response('{}'))
			.mockReturnValueOnce(pendingResponse) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		await instrumented('https://example.test/settled');
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'GET settled',
		]);
		const pending = instrumented('https://example.test/pending');
		await Promise.resolve();

		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				state: 'pending',
				url: 'https://example.test/pending',
			}),
		]);
		expect(timeline.getEvents()).toEqual([]);

		settlePending(response('{}'));
		await pending;
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'GET pending',
		]);
		dispose?.();
	});

	it('does not clear requests that arrived after confirmation started', async () => {
		let resolveConfirmation = (_confirmed: boolean): void => {};
		const confirmation = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () => confirmation,
			}),
		});
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);
		await instrumented('https://example.test/confirmed-target');
		await flushCapture();
		const pendingClear = diagnostics.requestClear('same-session-clear');

		await instrumented('https://example.test/arrived-during-confirmation');
		await flushCapture();
		resolveConfirmation(true);

		await expect(pendingClear).resolves.toEqual(
			expect.objectContaining({
				status: 'failed',
				error: expect.stringContaining('requests changed'),
			}),
		);
		expect(diagnostics.getEvents()).toHaveLength(2);
		dispose?.();
	});

	it('does not let a stale clear confirmation erase a replacement session', async () => {
		let resolveConfirmation = (_confirmed: boolean): void => {};
		const confirmation = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () => confirmation,
			}),
		});
		const firstDispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);
		await instrumented('https://example.test/first-session');
		await flushCapture();
		const pendingClear = diagnostics.requestClear('stale-clear');

		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		await instrumented('https://example.test/second-session');
		await flushCapture();
		resolveConfirmation(true);

		await expect(pendingClear).resolves.toEqual(
			expect.objectContaining({
				status: 'cancelled',
			}),
		);
		expect(diagnostics.getEvents()).toHaveLength(1);
		secondDispose?.();
	});

	it('defines every named bounded profile and round-trips versioned preferences', () => {
		expect(Object.isFrozen(NETWORK_SIMULATION_PROFILE_IDS)).toBe(true);
		expect(
			NETWORK_SIMULATION_PROFILE_IDS.map(
				(profileId) => getNetworkSimulationProfile(profileId).name,
			),
		).toEqual([
			'No profile',
			'Offline',
			'Edge',
			'3G',
			'LTE',
			'Wi-Fi',
			'DSL',
			'Very Bad Network',
		]);
		for (const profileId of NETWORK_SIMULATION_PROFILE_IDS) {
			const profile = getNetworkSimulationProfile(profileId);
			expect(profile.packetLossPercent).toBeGreaterThanOrEqual(0);
			expect(profile.packetLossPercent).toBeLessThanOrEqual(100);
			expect(profile.failurePercent).toBeGreaterThanOrEqual(0);
			expect(profile.failurePercent).toBeLessThanOrEqual(100);
		}
		const serialized = exportNetworkSimulationPreference('very-bad');
		expect(importNetworkSimulationPreference(serialized)).toEqual({
			version: 1,
			profileId: 'very-bad',
		});
		expect(() =>
			importNetworkSimulationPreference(
				JSON.stringify({ version: 2, profileId: 'wifi' }),
			),
		).toThrow('unsupported');
		expect(() =>
			importNetworkSimulationPreference(
				'x'.repeat(MAX_NETWORK_SIMULATION_PREFERENCE_BYTES + 1),
			),
		).toThrow('import limit');
		expect(() =>
			getNetworkSimulationProfile(
				'custom' as unknown as Parameters<
					typeof getNetworkSimulationProfile
				>[0],
			),
		).toThrow('unsupported');
		expect(() =>
			exportNetworkSimulationPreference(
				'custom' as unknown as Parameters<
					typeof exportNetworkSimulationPreference
				>[0],
			),
		).toThrow('unsupported');
	});

	it('imports a bounded preference through the profile action coordinator', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();

		await expect(
			diagnostics.importSimulationPreference(
				exportNetworkSimulationPreference('dsl'),
				'import-profile-once',
			),
		).resolves.toEqual(expect.objectContaining({ status: 'succeeded' }));
		expect(diagnostics.getSimulationProfile().id).toBe('dsl');
		expect(
			importNetworkSimulationPreference(
				diagnostics.exportSimulationPreference(),
			).profileId,
		).toBe('dsl');
		dispose?.();
		expect(diagnostics.getSimulationProfile().id).toBe('none');
	});

	it('rejects malformed imports through the audited one-use action path', async () => {
		const onActionReceipt = jest.fn();
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			onActionReceipt,
		});
		const dispose = diagnostics.plugin.install?.();

		const rejected = await diagnostics.importSimulationPreference(
			'{not-json',
			'import-bound-id',
		);
		const conflict = await diagnostics.importSimulationPreference(
			exportNetworkSimulationPreference('dsl'),
			'import-bound-id',
		);

		expect(rejected).toEqual(
			expect.objectContaining({
				requestId: 'import-bound-id',
				status: 'rejected',
				errorCode: 'unsupported',
			}),
		);
		expect(conflict).toEqual(
			expect.objectContaining({
				requestId: 'import-bound-id',
				status: 'rejected',
				errorCode: 'request-id-conflict',
			}),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		expect(onActionReceipt).toHaveBeenNthCalledWith(1, rejected);
		expect(onActionReceipt).toHaveBeenNthCalledWith(2, conflict);
		dispose?.();
	});

	it('reports subscribed active state and enforces one-use action IDs', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const listener = jest.fn();
		const unsubscribe = diagnostics.subscribeSimulationState(listener);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getSimulationState()).toEqual(
			expect.objectContaining({
				active: false,
				scope: 'instrumented-fetch',
				capability: expect.objectContaining({ availability: 'available' }),
			}),
		);

		const first = await diagnostics.setSimulationProfile('lte', 'profile-once');
		const replay = await diagnostics.setSimulationProfile(
			'lte',
			'profile-once',
		);
		const conflict = await diagnostics.setSimulationProfile(
			'offline',
			'profile-once',
		);
		expect(first.status).toBe('succeeded');
		expect(replay).toEqual(first);
		expect(conflict).toEqual(
			expect.objectContaining({
				status: 'rejected',
				errorCode: 'request-id-conflict',
			}),
		);
		expect(diagnostics.getSimulationState()).toEqual(
			expect.objectContaining({
				active: true,
				profile: expect.objectContaining({ id: 'lte' }),
				limitations: expect.arrayContaining(['No WebSocket interception']),
			}),
		);
		expect(listener).toHaveBeenCalled();

		dispose?.();
		const unavailableState = diagnostics.getSimulationState();
		expect(unavailableState).toEqual(
			expect.objectContaining({
				active: false,
				profile: expect.objectContaining({ id: 'none' }),
				capability: expect.objectContaining({ availability: 'unavailable' }),
			}),
		);
		expect(Object.isFrozen(unavailableState)).toBe(true);
		expect(Object.isFrozen(unavailableState.profile)).toBe(true);
		expect(Object.isFrozen(unavailableState.capability)).toBe(true);
		expect(Object.isFrozen(unavailableState.capability.reason)).toBe(true);
		try {
			Reflect.set(unavailableState.capability, 'availability', 'available');
		} catch {
			// Strict runtimes throw instead of returning false for frozen objects.
		}
		expect(diagnostics.getSimulationState().capability.availability).toBe(
			'unavailable',
		);
		unsubscribe();
	});

	it('scopes one-use action receipts to the collector session', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const disposeFirst = diagnostics.plugin.install?.();
		const firstAutoReceipt = await diagnostics.clearSimulationProfile();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/first-authority');
		const firstEvent = diagnostics.getEvents()[0];

		await expect(
			diagnostics.clearSimulationProfile('reusable-cleanup-id'),
		).resolves.toEqual(expect.objectContaining({ status: 'succeeded' }));
		disposeFirst?.();

		const disposeSecond = diagnostics.plugin.install?.();
		const secondAutoReceipt = await diagnostics.clearSimulationProfile();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/second-authority');
		const secondEvent = diagnostics.getEvents()[0];
		expect(secondEvent?.id).toBe(1);
		expect(secondEvent?.sessionId).not.toBe(firstEvent?.sessionId);
		expect(secondEvent?.correlationId).not.toBe(firstEvent?.correlationId);
		expect(secondAutoReceipt.requestId).not.toBe(firstAutoReceipt.requestId);
		await diagnostics.setSimulationProfile('wifi', 'second-session-profile');
		expect(diagnostics.getSimulationProfile().id).toBe('wifi');
		await expect(
			diagnostics.clearSimulationProfile('reusable-cleanup-id'),
		).resolves.toEqual(expect.objectContaining({ status: 'succeeded' }));
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		disposeSecond?.();
	});

	it('does not publish a late receipt from an expired session under a reused ID', async () => {
		let resolveFirstConfirmation = (_confirmed: boolean): void => {};
		const firstConfirmation = new Promise<boolean>((resolve) => {
			resolveFirstConfirmation = resolve;
		});
		let confirmationCount = 0;
		const onActionReceipt = jest.fn();
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () => {
					confirmationCount += 1;
					return confirmationCount === 1
						? firstConfirmation
						: Promise.resolve(true);
				},
			}),
			enableSimulation: true,
			onActionReceipt,
		});
		const disposeFirst = diagnostics.plugin.install?.();
		const lateFirst = diagnostics.setSimulationProfile('wifi', 'reused-id');
		await Promise.resolve();
		disposeFirst?.();

		const disposeSecond = diagnostics.plugin.install?.();
		const second = await diagnostics.clearSimulationProfile('reused-id');
		expect(second).toEqual(expect.objectContaining({ status: 'succeeded' }));
		expect(onActionReceipt).toHaveBeenCalledTimes(1);
		expect(onActionReceipt).toHaveBeenLastCalledWith(second);

		resolveFirstConfirmation(true);
		await expect(lateFirst).resolves.toEqual(
			expect.objectContaining({
				requestId: 'reused-id',
				status: 'cancelled',
			}),
		);
		expect(onActionReceipt).toHaveBeenCalledTimes(1);
		disposeSecond?.();
	});

	it('rejects unsafe action IDs without aliasing or leaking them and audits conflicts', async () => {
		const onActionReceipt = jest.fn();
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			onActionReceipt,
		});
		const dispose = diagnostics.plugin.install?.();

		const empty = await diagnostics.clearSimulationProfile('');
		const secret = await diagnostics.clearSimulationProfile(
			'password=supersecret',
		);
		const encodedSecret =
			await diagnostics.clearSimulationProfile('token%253Dhunter2');
		const longPrefix = 'a'.repeat(256);
		const longFirst = await diagnostics.clearSimulationProfile(
			`${longPrefix}x`,
		);
		const longSecond = await diagnostics.clearSimulationProfile(
			`${longPrefix}y`,
		);
		await diagnostics.setSimulationProfile('wifi', 'same-action-id');
		const conflict = await diagnostics.setSimulationProfile(
			'offline',
			'same-action-id',
		);

		for (const receipt of [
			empty,
			secret,
			encodedSecret,
			longFirst,
			longSecond,
		]) {
			expect(receipt).toEqual(
				expect.objectContaining({
					requestId: 'unknown',
					status: 'rejected',
					errorCode: 'invalid-request',
				}),
			);
		}
		expect(conflict).toEqual(
			expect.objectContaining({
				requestId: 'same-action-id',
				status: 'rejected',
				errorCode: 'request-id-conflict',
			}),
		);
		expect(
			JSON.stringify([secret, encodedSecret, ...onActionReceipt.mock.calls]),
		).not.toMatch(/supersecret|hunter2|token%/);
		expect(onActionReceipt).toHaveBeenCalledWith(
			expect.objectContaining({ errorCode: 'invalid-request' }),
		);
		expect(onActionReceipt).toHaveBeenCalledWith(
			expect.objectContaining({ errorCode: 'request-id-conflict' }),
		);
		dispose?.();
	});

	it('retains one-use receipts until the bounded session action limit', async () => {
		const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
		const dispose = diagnostics.plugin.install?.();

		let firstReceipt: Awaited<
			ReturnType<typeof diagnostics.clearSimulationProfile>
		> | null = null;
		for (let index = 0; index < 256; index += 1) {
			const receipt = await diagnostics.clearSimulationProfile(
				`long-session-${index}`,
			);
			await expect(Promise.resolve(receipt)).resolves.toEqual(
				expect.objectContaining({ status: 'succeeded' }),
			);
			if (index === 0) firstReceipt = receipt;
		}
		await expect(
			diagnostics.clearSimulationProfile('long-session-over-limit'),
		).resolves.toEqual(
			expect.objectContaining({
				status: 'rejected',
				errorCode: 'invalid-request',
			}),
		);
		await expect(
			diagnostics.clearSimulationProfile('long-session-0'),
		).resolves.toEqual(firstReceipt);

		dispose?.();
	});

	it('generates collision-free action IDs across a shared coordinator', async () => {
		const actionCoordinator = createDevToolsActionCoordinator({
			confirm: async () => true,
		});
		const first = createNetworkPlugin({
			actionCoordinator,
			enableSimulation: true,
		});
		const second = createNetworkPlugin({
			actionCoordinator,
			enableSimulation: true,
		});
		const disposeFirst = first.plugin.install?.();
		const disposeSecond = second.plugin.install?.();

		const [firstReceipt, secondReceipt] = await Promise.all([
			first.setSimulationProfile('offline'),
			second.setSimulationProfile('wifi'),
		]);

		expect(firstReceipt.status).toBe('succeeded');
		expect(secondReceipt.status).toBe('succeeded');
		expect(firstReceipt.requestId).not.toBe(secondReceipt.requestId);
		disposeFirst?.();
		disposeSecond?.();
	});

	it('cannot reactivate a profile when a delayed policy action loses its session', async () => {
		const coordinator = createDevToolsActionCoordinator({
			confirm: async () => true,
		});
		let releaseAction = (): void => {};
		const gate = new Promise<void>((resolve) => {
			releaseAction = resolve;
		});
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			actionCoordinator: {
				clearReceipts: coordinator.clearReceipts,
				execute: (execution) =>
					coordinator.execute({
						...execution,
						action: async () => {
							if (execution.plan.actionFingerprint === 'network.profile:wifi') {
								await gate;
							}
							return execution.action();
						},
					}),
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const pending = diagnostics.setSimulationProfile('wifi', 'stale-profile');
		dispose?.();
		const disposeNextSession = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('lte', 'fresh-profile');
		releaseAction();

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('lte');
		disposeNextSession?.();
	});

	it('clears active conditions when the runtime capability is revoked', async () => {
		let available = true;
		let capabilityListener = (): void => {};
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			simulationCapability: () =>
				available
					? {
							schemaVersion: 1,
							id: 'network.set-profile',
							availability: 'available',
						}
					: {
							schemaVersion: 1,
							id: 'network.set-profile',
							availability: 'unavailable',
							reason: { code: 'disabled', message: 'Revoked by host.' },
						},
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi');
		expect(diagnostics.getSimulationState().active).toBe(true);

		available = false;
		capabilityListener();
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		expect(diagnostics.getSimulationState()).toEqual(
			expect.objectContaining({
				active: false,
				capability: expect.objectContaining({ availability: 'unavailable' }),
			}),
		);
		dispose?.();
	});

	it('cancels synthetic latency before a revoked profile can start transport', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			let capabilityListener = (): void => {};
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
				subscribeSimulationCapability: (listener) => {
					capabilityListener = listener;
					return () => {
						capabilityListener = (): void => {};
					};
				},
			});
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('dsl');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/revoked-during-latency',
			);
			expect(fetchImplementation).not.toHaveBeenCalled();

			available = false;
			capabilityListener();
			await expect(request).rejects.toThrow('simulation authority changed');
			await jest.advanceTimersByTimeAsync(60_000);

			expect(fetchImplementation).not.toHaveBeenCalled();
			expect(diagnostics.getEvents()).toEqual([]);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('revalidates unannounced dynamic authorities before starting transport', async () => {
		jest.useFakeTimers();
		try {
			for (const authorityKind of ['capture', 'simulation'] as const) {
				let owner = 'owner-a';
				let available = true;
				const diagnostics = createNetworkPlugin({
					...confirmedSimulationOptions(),
					...(authorityKind === 'capture'
						? { captureAuthority: () => owner }
						: {
								simulationCapability: () =>
									available
										? {
												schemaVersion: 1 as const,
												id: NETWORK_SIMULATION_CAPABILITY_ID,
												availability: 'available' as const,
											}
										: {
												schemaVersion: 1 as const,
												id: NETWORK_SIMULATION_CAPABILITY_ID,
												availability: 'unavailable' as const,
												reason: {
													code: 'disabled' as const,
													message: 'Revoked by host.',
												},
											},
							}),
				});
				const dispose = diagnostics.plugin.install?.();
				const fetchImplementation = jest
					.fn()
					.mockResolvedValue(response('{}')) as unknown as typeof fetch;
				await diagnostics.setSimulationProfile('dsl');
				const request = diagnostics.instrumentFetch(fetchImplementation)(
					`https://example.test/unannounced-${authorityKind}`,
				);
				const rejected = expect(request).rejects.toThrow(
					'simulation authority changed',
				);

				if (authorityKind === 'capture') owner = 'owner-b';
				else available = false;
				await jest.advanceTimersByTimeAsync(60_000);
				await rejected;

				expect(fetchImplementation).not.toHaveBeenCalled();
				expect(diagnostics.getEvents()).toEqual([]);
				dispose?.();
			}
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not abort a streaming body when policy changes after headers resolve', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			let bodyAborted = false;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
			});
			const dispose = diagnostics.plugin.install?.();
			const streamingResponse = {
				status: 200,
				headers: new Headers(),
				text: async () => {
					if (bodyAborted) throw abortedErrorForTest();
					return 'still readable';
				},
			} as unknown as Response;
			const fetchImplementation = jest.fn(async (_input, init) => {
				init?.signal?.addEventListener(
					'abort',
					() => {
						bodyAborted = true;
					},
					{ once: true },
				);
				available = false;
				return streamingResponse;
			}) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');

			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/stream-after-policy-change',
			);
			await jest.advanceTimersByTimeAsync(100);
			const result = await request;

			await expect(result.text()).resolves.toBe('still readable');
			expect(bodyAborted).toBe(false);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it.each(['subscription', 'timer recheck'] as const)(
		'disarms a stale profile timeout during pending transport via %s',
		async (revocationPath) => {
			jest.useFakeTimers();
			try {
				let available = true;
				let capabilityListener = (): void => {};
				const diagnostics = createNetworkPlugin({
					...confirmedSimulationOptions(),
					simulationCapability: () =>
						available
							? {
									schemaVersion: 1,
									id: NETWORK_SIMULATION_CAPABILITY_ID,
									availability: 'available',
								}
							: {
									schemaVersion: 1,
									id: NETWORK_SIMULATION_CAPABILITY_ID,
									availability: 'unavailable',
									reason: {
										code: 'disabled',
										message: 'Revoked by host.',
									},
								},
					...(revocationPath === 'subscription'
						? {
								subscribeSimulationCapability: (listener: () => void) => {
									capabilityListener = listener;
									return () => {
										capabilityListener = (): void => {};
									};
								},
							}
						: {}),
				});
				const dispose = diagnostics.plugin.install?.();
				let resolveTransport = (_response: Response): void => {};
				const transport = new Promise<Response>((resolve) => {
					resolveTransport = resolve;
				});
				const transportAborted = jest.fn();
				const fetchImplementation = jest.fn((_input, init) => {
					init?.signal?.addEventListener('abort', transportAborted, {
						once: true,
					});
					return transport;
				}) as unknown as typeof fetch;
				await diagnostics.setSimulationProfile('wifi');

				const pending = diagnostics.instrumentFetch(fetchImplementation)(
					'https://example.test/pending-transport',
				);
				await jest.advanceTimersByTimeAsync(100);
				expect(fetchImplementation).toHaveBeenCalledTimes(1);
				available = false;
				if (revocationPath === 'subscription') capabilityListener();
				await jest.advanceTimersByTimeAsync(31_000);
				expect(transportAborted).not.toHaveBeenCalled();

				const expected = response('{}');
				resolveTransport(expected);
				await expect(pending).resolves.toBe(expected);
				expect(diagnostics.getSimulationProfile().id).toBe('none');
				dispose?.();
			} finally {
				jest.useRealTimers();
			}
		},
	);

	it('allows explicit cleanup after an unannounced capability revocation', async () => {
		let available = true;
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			simulationCapability: () =>
				available
					? {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'available',
						}
					: {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'unavailable',
							reason: { code: 'disabled', message: 'Revoked by host.' },
						},
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi');
		available = false;

		await expect(
			diagnostics.clearSimulationProfile('cleanup-after-revoke'),
		).resolves.toEqual(
			expect.objectContaining({
				status: 'succeeded',
				capabilityId: 'network.clear-profile',
			}),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		dispose?.();
	});

	it('does not transfer an active profile to a replacement capability identity', async () => {
		let capabilityId = NETWORK_SIMULATION_CAPABILITY_ID;
		let capabilityListener = (): void => {};
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi');
		expect(diagnostics.getSimulationState().active).toBe(true);

		capabilityId = 'network.set-profile.replacement';
		capabilityListener();

		expect(diagnostics.getSimulationProfile().id).toBe('none');
		expect(diagnostics.getSimulationState()).toEqual(
			expect.objectContaining({
				active: false,
				capability: expect.objectContaining({ id: capabilityId }),
			}),
		);
		dispose?.();
	});

	it('treats capability notifications as capture authority boundaries', async () => {
		let capabilityId = 'network.set-profile.authority-a';
		let capabilityListener = (): void => {};
		let resolveConfirmation = (_confirmed: boolean): void => {};
		const confirmation = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		timeline.append({
			source: 'custom',
			kind: 'test.unrelated',
			level: 'info',
			title: 'Unrelated event',
		});
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () => confirmation,
			}),
			enableSimulation: true,
			eventStore: timeline,
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		let settleInFlight = (_response: Response): void => {};
		const inFlightResponse = new Promise<Response>((resolve) => {
			settleInFlight = resolve;
		});
		const fetchImplementation = jest
			.fn()
			.mockResolvedValueOnce(response('{}'))
			.mockImplementationOnce(
				() => inFlightResponse,
			) as unknown as typeof fetch;
		const instrumented = diagnostics.instrumentFetch(fetchImplementation);

		await instrumented('https://example.test/authority-a');
		await flushCapture();
		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(timeline.getEvents()).toHaveLength(2);
		const pendingClear = diagnostics.requestClear('authority-a-clear');
		await Promise.resolve();
		const staleInFlight = instrumented(
			'https://example.test/authority-a-in-flight',
		);
		await Promise.resolve();

		capabilityId = 'network.set-profile.authority-b';
		capabilityListener();

		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'Unrelated event',
		]);
		resolveConfirmation(true);
		settleInFlight(response('{}'));
		await staleInFlight;
		await expect(pendingClear).resolves.toEqual(
			expect.objectContaining({
				status: 'cancelled',
			}),
		);
		await flushCapture();
		expect(diagnostics.getEvents()).toEqual([]);
		expect(timeline.getEvents().map((event) => event.title)).toEqual([
			'Unrelated event',
		]);
		dispose?.();
	});

	it('does not transfer or revive an active profile when capability changes are polled', async () => {
		jest.useFakeTimers();
		try {
			let capabilityId = 'network.set-profile.authority-a';
			let available = true;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: capabilityId,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: capabilityId,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
			});
			const unsubscribe = diagnostics.subscribeSimulationState(() => {});
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi');
			expect(diagnostics.getSimulationProfile().id).toBe('wifi');

			capabilityId = 'network.set-profile.authority-b';
			await jest.advanceTimersByTimeAsync(250);
			expect(diagnostics.getSimulationProfile().id).toBe('none');

			capabilityId = 'network.set-profile.authority-a';
			await jest.advanceTimersByTimeAsync(250);
			expect(diagnostics.getSimulationProfile().id).toBe('none');

			await diagnostics.setSimulationProfile('lte');
			available = false;
			await jest.advanceTimersByTimeAsync(250);
			expect(diagnostics.getSimulationProfile().id).toBe('none');
			available = true;
			await jest.advanceTimersByTimeAsync(250);
			expect(diagnostics.getSimulationProfile().id).toBe('none');
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('keeps the public simulation snapshot getter pure across owner changes', () => {
		let owner = 'owner-a';
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => owner,
			enableSimulation: true,
		});
		const listener = jest.fn();
		const unsubscribe = diagnostics.subscribeSimulationState(listener);
		const dispose = diagnostics.plugin.install?.();
		listener.mockClear();
		const before = diagnostics.getSimulationState();

		owner = 'owner-b';
		const after = diagnostics.getSimulationState();

		expect(after).toBe(before);
		expect(listener).not.toHaveBeenCalled();
		unsubscribe();
		dispose?.();
	});

	it('invalidates delayed mutations when a dynamic capture owner changes', async () => {
		let owner = 'owner-a';
		const confirmations: Array<(confirmed: boolean) => void> = [];
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () =>
					new Promise<boolean>((resolve) => {
						confirmations.push(resolve);
					}),
			}),
			captureAuthority: () => owner,
			enableSimulation: true,
		});
		const dispose = diagnostics.plugin.install?.();

		const pendingProfile = diagnostics.setSimulationProfile(
			'wifi',
			'owner-bound-profile',
		);
		await Promise.resolve();
		owner = 'owner-b';
		confirmations[0]?.(true);
		await expect(pendingProfile).resolves.toEqual(
			expect.objectContaining({ status: 'rolled-back' }),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');

		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/owner-b');
		expect(diagnostics.getEvents()).toHaveLength(1);
		const pendingClear = diagnostics.requestClear('owner-bound-clear');
		await Promise.resolve();
		owner = 'owner-c';
		confirmations[1]?.(true);
		await expect(pendingClear).resolves.toEqual(
			expect.objectContaining({ status: 'failed' }),
		);
		expect(diagnostics.getEvents()).toEqual([]);
		dispose?.();
	});

	it('publishes polled dynamic capability changes to state subscribers', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
			});
			const listener = jest.fn();
			const unsubscribe = diagnostics.subscribeSimulationState(listener);
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi');
			listener.mockClear();

			available = false;
			await jest.advanceTimersByTimeAsync(250);

			expect(listener).toHaveBeenCalled();
			expect(diagnostics.getSimulationState()).toEqual(
				expect.objectContaining({
					active: false,
					capability: expect.objectContaining({ availability: 'unavailable' }),
				}),
			);
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('reconciles an authority change before the first poll subscriber baseline', async () => {
		jest.useFakeTimers();
		try {
			let capabilityId = 'network-capability-a';
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () => ({
					schemaVersion: 1,
					id: capabilityId,
					availability: 'available',
				}),
			});
			const dispose = diagnostics.plugin.install?.();
			await diagnostics.setSimulationProfile('wifi', 'profile-for-a');
			expect(diagnostics.getSimulationProfile().id).toBe('wifi');

			capabilityId = 'network-capability-b';
			const unsubscribe = diagnostics.subscribeSimulationState(() => {});
			expect(diagnostics.getSimulationProfile().id).toBe('none');

			capabilityId = 'network-capability-a';
			await jest.advanceTimersByTimeAsync(250);
			expect(diagnostics.getSimulationProfile().id).toBe('none');
			expect(diagnostics.getSimulationState().active).toBe(false);
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('publishes same-authority capability metadata changes without resetting', async () => {
		jest.useFakeTimers();
		try {
			let reasonMessage = 'Policy A';
			const diagnostics = createNetworkPlugin({
				enableSimulation: true,
				simulationCapability: () => ({
					schemaVersion: 1,
					id: NETWORK_SIMULATION_CAPABILITY_ID,
					availability: 'unavailable',
					reason: { code: 'restricted', message: reasonMessage },
				}),
			});
			const listener = jest.fn();
			const unsubscribe = diagnostics.subscribeSimulationState(listener);
			const dispose = diagnostics.plugin.install?.();
			listener.mockClear();

			reasonMessage = 'Policy B';
			await jest.advanceTimersByTimeAsync(250);

			expect(listener).toHaveBeenCalledTimes(1);
			expect(diagnostics.getSimulationState().capability.reason?.message).toBe(
				'Policy B',
			);
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('invalidates delayed approval across a polled revoke and same-ID regrant', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			let resolveConfirmation = (_confirmed: boolean): void => {};
			const confirmation = new Promise<boolean>((resolve) => {
				resolveConfirmation = resolve;
			});
			const diagnostics = createNetworkPlugin({
				actionCoordinator: createDevToolsActionCoordinator({
					confirm: () => confirmation,
				}),
				enableSimulation: true,
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
			});
			const unsubscribe = diagnostics.subscribeSimulationState(() => {});
			const dispose = diagnostics.plugin.install?.();
			const pending = diagnostics.setSimulationProfile(
				'wifi',
				'polled-epoch-profile',
			);
			await Promise.resolve();

			available = false;
			await jest.advanceTimersByTimeAsync(250);
			available = true;
			await jest.advanceTimersByTimeAsync(250);
			resolveConfirmation(true);

			await expect(pending).resolves.toEqual(
				expect.objectContaining({ status: 'cancelled' }),
			);
			expect(diagnostics.getSimulationProfile().id).toBe('none');
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('falls back to polling when host capability subscription setup fails', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked by host.' },
							},
				subscribeSimulationCapability: () => {
					throw new Error('subscription unavailable');
				},
			});
			const listener = jest.fn();
			const unsubscribe = diagnostics.subscribeSimulationState(listener);
			const dispose = diagnostics.plugin.install?.();
			listener.mockClear();

			available = false;
			await jest.advanceTimersByTimeAsync(250);

			expect(listener).toHaveBeenCalled();
			expect(diagnostics.getSimulationState().capability.availability).toBe(
				'unavailable',
			);
			unsubscribe();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('keeps polling until every duplicate-callback state subscription ends', async () => {
		jest.useFakeTimers();
		try {
			let available = true;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () =>
					available
						? {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'available',
							}
						: {
								schemaVersion: 1,
								id: NETWORK_SIMULATION_CAPABILITY_ID,
								availability: 'unavailable',
								reason: { code: 'disabled', message: 'Revoked.' },
							},
			});
			const listener = jest.fn();
			const unsubscribeFirst = diagnostics.subscribeSimulationState(listener);
			const unsubscribeSecond = diagnostics.subscribeSimulationState(listener);
			const dispose = diagnostics.plugin.install?.();
			listener.mockClear();
			unsubscribeFirst();

			available = false;
			await jest.advanceTimersByTimeAsync(250);

			expect(listener).toHaveBeenCalled();
			expect(diagnostics.getSimulationState().capability.availability).toBe(
				'unavailable',
			);
			unsubscribeSecond();
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('ignores rejected capture-subscription callbacks after reinstall', async () => {
		let owner = 'owner-a';
		const callbacks: Array<() => void> = [];
		let subscriptions = 0;
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => owner,
			subscribeCaptureAuthority: (listener) => {
				callbacks.push(listener);
				subscriptions += 1;
				return subscriptions === 1
					? (undefined as unknown as () => void)
					: () => {};
			},
		});
		const firstDispose = diagnostics.plugin.install?.();
		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/current-owner');
		expect(diagnostics.getEvents()).toHaveLength(1);

		callbacks[0]?.();
		expect(diagnostics.getEvents()).toHaveLength(1);
		owner = 'owner-b';
		callbacks[1]?.();
		expect(diagnostics.getEvents()).toEqual([]);
		secondDispose?.();
	});

	it('ignores rejected capability-subscription callbacks after reinstall', async () => {
		const callbacks: Array<() => void> = [];
		let subscriptions = 0;
		let capabilityId = NETWORK_SIMULATION_CAPABILITY_ID;
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
			subscribeSimulationCapability: (listener) => {
				callbacks.push(listener);
				subscriptions += 1;
				return subscriptions === 1
					? (undefined as unknown as () => void)
					: () => {};
			},
		});
		const firstDispose = diagnostics.plugin.install?.();
		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi', 'fresh-profile');
		expect(diagnostics.getSimulationProfile().id).toBe('wifi');

		callbacks[0]?.();
		expect(diagnostics.getSimulationProfile().id).toBe('wifi');
		capabilityId = 'network.set-profile.replacement';
		callbacks[1]?.();
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		secondDispose?.();
	});

	it('does not expose encoded secrets from capability reasons or receipts', async () => {
		const onActionReceipt = jest.fn();
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			onActionReceipt,
			simulationCapability: () => ({
				schemaVersion: 1,
				id: NETWORK_SIMULATION_CAPABILITY_ID,
				availability: 'unavailable',
				reason: {
					code: 'restricted',
					message: 'token%253Dhunter2',
				},
			}),
		});
		const dispose = diagnostics.plugin.install?.();

		const state = diagnostics.getSimulationState();
		const receipt = await diagnostics.setSimulationProfile(
			'wifi',
			'encoded-reason',
		);
		const exposed = JSON.stringify({
			state,
			receipt,
			calls: onActionReceipt.mock.calls,
		});

		expect(exposed).not.toMatch(/hunter2|token%/);
		expect(state.capability.reason?.message).toContain('current host policy');
		expect(receipt).toEqual(
			expect.objectContaining({ status: 'rejected', errorCode: 'unsupported' }),
		);
		dispose?.();
	});

	it('reads only fixed capability and reason fields', () => {
		const reasonTarget = {
			code: 'restricted' as const,
			message: 'Bounded host policy.',
		};
		Object.defineProperty(reasonTarget, 'irrelevant', { value: 'ignored' });
		const reasonOwnKeys = jest.fn(() => {
			throw new Error('reason keys must not be enumerated');
		});
		const reason = new Proxy(reasonTarget, { ownKeys: reasonOwnKeys });
		const capabilityTarget = {
			schemaVersion: 1 as const,
			id: NETWORK_SIMULATION_CAPABILITY_ID,
			availability: 'unavailable' as const,
			reason,
		};
		Object.defineProperty(capabilityTarget, 'irrelevant', { value: 'ignored' });
		const capabilityOwnKeys = jest.fn(() => {
			throw new Error('capability keys must not be enumerated');
		});
		const capability = new Proxy(capabilityTarget, {
			ownKeys: capabilityOwnKeys,
		});
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			simulationCapability: () => capability,
		});
		const dispose = diagnostics.plugin.install?.();

		expect(diagnostics.getSimulationState().capability).toEqual({
			schemaVersion: 1,
			id: NETWORK_SIMULATION_CAPABILITY_ID,
			availability: 'unavailable',
			reason: { code: 'restricted', message: 'Bounded host policy.' },
		});
		expect(capabilityOwnKeys).not.toHaveBeenCalled();
		expect(reasonOwnKeys).not.toHaveBeenCalled();
		dispose?.();
	});

	it('invalidates pending profile approval when a request observes revocation', async () => {
		let available = true;
		let confirmationCount = 0;
		let resolveSecondConfirmation = (_confirmed: boolean): void => {};
		const secondConfirmation = new Promise<boolean>((resolve) => {
			resolveSecondConfirmation = resolve;
		});
		const diagnostics = createNetworkPlugin({
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: () => {
					confirmationCount += 1;
					return confirmationCount === 1
						? Promise.resolve(true)
						: secondConfirmation;
				},
			}),
			enableSimulation: true,
			simulationCapability: () =>
				available
					? {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'available',
						}
					: {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'unavailable',
							reason: { code: 'disabled', message: 'Revoked by host.' },
						},
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.setSimulationProfile('wifi', 'initial-profile');
		const pending = diagnostics.setSimulationProfile('dsl', 'pending-profile');
		await Promise.resolve();

		available = false;
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/observe-revoke');
		available = true;
		resolveSecondConfirmation(true);

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		dispose?.();
	});

	it('rejects capability identities that could collide after redaction', async () => {
		let capabilityId = 'network:user-a@example.com';
		const diagnostics = createNetworkPlugin({
			...confirmedSimulationOptions(),
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
		});
		const dispose = diagnostics.plugin.install?.();

		await expect(diagnostics.setSimulationProfile('wifi')).resolves.toEqual(
			expect.objectContaining({ status: 'rejected', errorCode: 'unsupported' }),
		);
		capabilityId = 'network:user-b@example.com';
		expect(diagnostics.getSimulationState()).toEqual(
			expect.objectContaining({
				active: false,
				capability: expect.objectContaining({ availability: 'unavailable' }),
			}),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		dispose?.();
	});

	it('invalidates delayed approval across revoke and re-grant epochs', async () => {
		let available = true;
		let capabilityListener = (): void => {};
		let releaseAction = (): void => {};
		const gate = new Promise<void>((resolve) => {
			releaseAction = resolve;
		});
		const baseCoordinator = createDevToolsActionCoordinator({
			confirm: async () => true,
		});
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			actionCoordinator: {
				clearReceipts: baseCoordinator.clearReceipts,
				execute: (execution) =>
					baseCoordinator.execute({
						...execution,
						action: async () => {
							await gate;
							return execution.action();
						},
					}),
			},
			simulationCapability: () =>
				available
					? {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'available',
						}
					: {
							schemaVersion: 1,
							id: NETWORK_SIMULATION_CAPABILITY_ID,
							availability: 'unavailable',
							reason: { code: 'disabled', message: 'Revoked by host.' },
						},
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const pending = diagnostics.setSimulationProfile('wifi', 'epoch-profile');
		await Promise.resolve();
		available = false;
		capabilityListener();
		available = true;
		capabilityListener();
		releaseAction();

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		dispose?.();
	});

	it('reads correlation ids from host-supplied vendor headers only', async () => {
		const diagnostics = createNetworkPlugin({
			correlationIdHeaders: ['x-acme-request-id'],
			parentEventIdHeaders: ['x-acme-parent-id'],
		});
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest.fn(async () =>
			responseWithHeaders('{}', 200, new Headers({ 'content-length': '2' })),
		) as unknown as typeof fetch;
		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/items',
			{
				headers: {
					'x-acme-request-id': 'vendor-request-1',
					'x-acme-parent-id': 'vendor-parent-1',
					// The standard headers must be ignored once a host declares its own.
					'x-request-id': 'standard-request-1',
					'x-parent-event-id': 'standard-parent-1',
				},
			},
		);
		await flushCapture();

		expect(diagnostics.getEvents()[0]).toEqual(
			expect.objectContaining({
				correlationId: 'vendor-request-1',
				parentEventId: 'vendor-parent-1',
			}),
		);
		dispose?.();
	});

	it('publishes correlated summary references with measured timing and cache evidence', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({ eventStore: timeline });
		const dispose = diagnostics.plugin.install?.();
		const headers = new Headers({
			'content-length': '2',
			'content-type': 'application/json',
			'x-cache': 'HIT',
		});
		const fetchImplementation = jest.fn(async () =>
			responseWithHeaders('{}', 200, headers),
		) as unknown as typeof fetch;
		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/items?token=query-secret',
			{
				headers: {
					'x-request-id': 'request-7',
					'x-parent-event-id': 'parent-3',
				},
			},
		);
		await flushCapture();

		const detail = diagnostics.getEvents()[0];
		expect(detail).toEqual(
			expect.objectContaining({
				correlationId: 'request-7',
				parentEventId: 'parent-3',
				cacheStatus: 'hit',
				timing: expect.objectContaining({
					totalMs: expect.any(Number),
					transportMs: expect.any(Number),
				}),
			}),
		);
		const event = timeline.getEvents()[0];
		expect(event).toEqual(
			expect.objectContaining({
				kind: 'network.request',
				correlationId: 'request-7',
				parentEventId: 'parent-3',
				resourceRef: {
					toolId: 'network',
					resourceId: `${detail?.sessionId}:${detail?.id}`,
				},
				attributes: expect.objectContaining({ cache: 'hit', method: 'GET' }),
			}),
		);
		expect(JSON.stringify(event)).not.toContain('query-secret');
		dispose?.();
	});

	it('uses evidence-based HTTP summaries and omits nonexistent status fields', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({ eventStore: timeline });
		const dispose = diagnostics.plugin.install?.();
		const fetchImplementation = jest
			.fn()
			.mockResolvedValueOnce(response('{"error":true}', 500))
			.mockRejectedValueOnce(
				new Error('transport unavailable'),
			) as unknown as typeof fetch;

		await diagnostics.instrumentFetch(fetchImplementation)(
			'https://example.test/http-error',
		);
		await expect(
			diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/transport-error',
			),
		).rejects.toThrow('transport unavailable');
		await flushCapture();

		const [httpEvent, transportEvent] = timeline.getEvents();
		expect(httpEvent).toEqual(
			expect.objectContaining({
				level: 'error',
				summary: expect.stringContaining('HTTP 500'),
				attributes: expect.objectContaining({ status: 500, state: 'success' }),
			}),
		);
		expect(transportEvent).toEqual(
			expect.objectContaining({
				level: 'error',
				summary: expect.stringContaining('error'),
			}),
		);
		expect(transportEvent?.attributes).not.toHaveProperty('status');
		dispose?.();
	});

	it('keeps a valid resource reference when body enrichment exceeds the detail bound', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			eventStore: timeline,
			maxBodyBytes: 4 * 1024,
			maxStoreBytes: 1_000,
		});
		const dispose = diagnostics.plugin.install?.();

		await diagnostics.instrumentFetch(
			jest
				.fn()
				.mockResolvedValue(
					response('x'.repeat(4 * 1024)),
				) as unknown as typeof fetch,
		)('https://example.test/oversized-detail');
		await flushCapture();

		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({
				state: 'success',
			}),
		]);
		expect(diagnostics.getEvents()[0]).not.toHaveProperty('responseBody');
		const detail = diagnostics.getEvents()[0];
		expect(timeline.getEvents()).toEqual([
			expect.objectContaining({
				resourceRef: {
					toolId: 'network',
					resourceId: `${detail?.sessionId}:${detail?.id}`,
				},
			}),
		]);
		dispose?.();
	});

	it('rejects redaction markers and overlong values as correlation identities', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
		});
		const diagnostics = createNetworkPlugin({
			eventStore: timeline,
			correlationContext: (input) => ({
				correlationId: String(input).includes('overlong')
					? 'same-prefix'.repeat(100)
					: undefined,
			}),
			redactHeader: (name, value) => {
				if (name.toLowerCase() === 'x-request-id') {
					throw new Error('redaction failed');
				}
				return value;
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);

		await instrumented('https://example.test/marker', {
			headers: { 'x-request-id': 'secret-correlation' },
		});
		await instrumented('https://example.test/overlong-one');
		await instrumented('https://example.test/overlong-two');
		await flushCapture();

		const correlationIds = diagnostics
			.getEvents()
			.map((event) => event.correlationId);
		expect(correlationIds[0]).not.toBe('[REDACTION FAILED]');
		expect(new Set(correlationIds).size).toBe(3);
		expect(timeline.getEvents().map((event) => event.correlationId)).toEqual(
			correlationIds,
		);
		dispose?.();
	});

	it('rejects encoded-sensitive correlation IDs from every public source', async () => {
		const timeline = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
			idFactory: (kind, sequence) =>
				kind === 'correlation' ? 'victim%2540example.com' : `event-${sequence}`,
		});
		const diagnostics = createNetworkPlugin({
			eventStore: timeline,
			correlationContext: (input) =>
				String(input).includes('host')
					? {
							correlationId: 'victim%2540example.com',
							parentEventId: 'token%253Dhunter2',
						}
					: undefined,
		});
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		);

		await instrumented('https://example.test/host');
		await instrumented('https://example.test/header', {
			headers: {
				'x-parent-event-id': 'token%253Dhunter2',
				'x-request-id': 'victim%2540example.com',
			},
		});
		await instrumented('https://example.test/store');
		await flushCapture();

		const exposed = JSON.stringify({
			details: diagnostics.getEvents(),
			timeline: timeline.getEvents(),
		});
		expect(exposed).not.toMatch(/victim|hunter2|%25/);
		expect(diagnostics.getEvents().map((event) => event.correlationId)).toEqual(
			[
				expect.stringMatching(/^network-request-/),
				expect.stringMatching(/^network-request-/),
				expect.stringMatching(/^network-request-/),
			],
		);
		dispose?.();
	});

	it('shapes only known-size upload and download paths and records phases', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const responseBody = 'x'.repeat(30_000);
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response(responseBody)) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/shape',
				{ method: 'POST', body: 'x'.repeat(25_000) },
			);

			await jest.advanceTimersByTimeAsync(1_200);
			expect(fetchImplementation).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(300);
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			let settled = false;
			void request.then(() => {
				settled = true;
			});
			await jest.advanceTimersByTimeAsync(500);
			expect(settled).toBe(false);
			await jest.advanceTimersByTimeAsync(600);
			await request;
			await flushCapture();
			expect(diagnostics.getEvents()[0]?.timing).toEqual(
				expect.objectContaining({
					latencyDelayMs: expect.any(Number),
					uploadDelayMs: 1_000,
					downloadDelayMs: 1_000,
					transportMs: expect.any(Number),
				}),
			);
			expect(
				diagnostics.getEvents()[0]?.timing?.latencyDelayMs,
			).toBeGreaterThanOrEqual(300);
			expect(
				diagnostics.getEvents()[0]?.timing?.latencyDelayMs,
			).toBeLessThanOrEqual(500);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('releases stale download shaping without aborting a returned body', async () => {
		jest.useFakeTimers();
		try {
			let capabilityId = NETWORK_SIMULATION_CAPABILITY_ID;
			let capabilityListener = (): void => {};
			let bodyAborted = false;
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				simulationCapability: () => ({
					schemaVersion: 1,
					id: capabilityId,
					availability: 'available',
				}),
				subscribeSimulationCapability: (listener) => {
					capabilityListener = listener;
					return () => {
						capabilityListener = (): void => {};
					};
				},
			});
			const dispose = diagnostics.plugin.install?.();
			const streamedResponse = {
				status: 200,
				headers: new Headers({
					'content-length': '5000000',
					'content-type': 'text/plain',
				}),
				body: {},
				text: async () => {
					if (bodyAborted) throw new Error('body was aborted');
					return 'still readable';
				},
			} as unknown as Response;
			const fetchImplementation = jest.fn(async (_input, init) => {
				init?.signal?.addEventListener(
					'abort',
					() => {
						bodyAborted = true;
					},
					{ once: true },
				);
				return streamedResponse;
			}) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/stale-download-shaping',
			);
			await jest.advanceTimersByTimeAsync(700);
			expect(fetchImplementation).toHaveBeenCalledTimes(1);

			capabilityId = 'network.set-profile.replacement';
			capabilityListener();
			const result = await request;

			await expect(result.text()).resolves.toBe('still readable');
			expect(bodyAborted).toBe(false);
			expect(diagnostics.getEvents()).toEqual([]);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not shape malformed Content-Length values as known downloads', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest.fn(async () =>
				responseWithHeaders('', 200, new Headers({ 'content-length': '1e6' })),
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('wifi');

			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/malformed-length',
			);
			await jest.advanceTimersByTimeAsync(100);
			await request;
			await flushCapture();

			expect(diagnostics.getEvents()[0]?.timing?.downloadDelayMs).toBe(0);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('shapes a known-size Blob upload without reading its payload', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/shape',
				{ method: 'POST', body: new Blob(['x'.repeat(25_000)]) },
			);

			await jest.advanceTimersByTimeAsync(1_200);
			expect(fetchImplementation).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(400);
			await request;
			await flushCapture();
			expect(diagnostics.getEvents()[0]?.timing?.uploadDelayMs).toBe(1_000);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('shapes and reports intrinsic-sized ArrayBufferView uploads', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin({
				...confirmedSimulationOptions(),
				captureBody: true,
			});
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const body = new Uint8Array(25_000);
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/view-upload',
				{ method: 'POST', body: body as unknown as BodyInit },
			);

			await jest.advanceTimersByTimeAsync(1_600);
			await request;
			await flushCapture();

			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					requestBody: '[Binary body omitted: ArrayBufferView]',
					requestSizeBytes: 25_000,
					timing: expect.objectContaining({ uploadDelayMs: 1_000 }),
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('shapes bounded URLSearchParams by their serialized UTF-8 size', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			const body = new URLSearchParams({ payload: 'x'.repeat(24_992) });
			const serializedBytes = utf8ByteLength(body.toString());
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/params-upload',
				{ method: 'POST', body },
			);

			await jest.advanceTimersByTimeAsync(1_700);
			await request;
			await flushCapture();

			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					requestSizeBytes: serializedBytes,
					timing: expect.objectContaining({
						uploadDelayMs: (serializedBytes * 8 * 1_000) / (200 * 1_000),
					}),
				}),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not invent download shaping for an unknown-length response', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest.fn(async () =>
				responseWithHeaders('', 200, new Headers()),
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/unknown-0',
			);
			await jest.advanceTimersByTimeAsync(600);
			await request;
			await flushCapture();
			expect(diagnostics.getEvents()[0]?.timing?.downloadDelayMs).toBe(0);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('times out and aborts the instrumented request operation', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			let receivedSignal: AbortSignal | undefined;
			const fetchImplementation = jest.fn(
				(_input: RequestInfo | URL, init?: RequestInit) => {
					receivedSignal = init?.signal ?? undefined;
					return new Promise<Response>(() => {});
				},
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('very-bad');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/timeout-0',
			);
			const rejection = expect(request).rejects.toThrow(
				'timed out after 8000 ms',
			);
			await jest.advanceTimersByTimeAsync(10_000);
			await rejection;
			expect(receivedSignal?.aborted).toBe(true);
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({ state: 'error' }),
			);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('applies the profile timeout to synthetic download shaping', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest.fn(async () =>
				responseWithHeaders(
					'',
					200,
					new Headers({ 'content-length': '1000000' }),
				),
			) as unknown as typeof fetch;
			await diagnostics.setSimulationProfile('edge');
			const request = diagnostics.instrumentFetch(fetchImplementation)(
				'https://example.test/download-timeout-0',
			);
			const rejection = expect(request).rejects.toThrow(
				'timed out after 15000 ms',
			);
			await jest.advanceTimersByTimeAsync(16_000);
			await rejection;
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('applies deterministic request-loss without claiming packet interception', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			const instrumented = diagnostics.instrumentFetch(fetchImplementation);
			for (let sequence = 1; sequence < 30; sequence += 1) {
				await instrumented(`https://example.test/warmup-${sequence}`);
			}
			await diagnostics.setSimulationProfile('very-bad');
			const dropped = instrumented('https://example.test/loss-30');
			const rejection = expect(dropped).rejects.toThrow('request-loss model');
			await jest.advanceTimersByTimeAsync(2_000);
			await rejection;
			expect(fetchImplementation).toHaveBeenCalledTimes(29);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('applies deterministic simulated failures for identical request ordering', async () => {
		jest.useFakeTimers();
		try {
			const diagnostics = createNetworkPlugin(confirmedSimulationOptions());
			const dispose = diagnostics.plugin.install?.();
			const fetchImplementation = jest
				.fn()
				.mockResolvedValue(response('{}')) as unknown as typeof fetch;
			const instrumented = diagnostics.instrumentFetch(fetchImplementation);
			await instrumented('https://example.test/warmup-1');
			await instrumented('https://example.test/warmup-2');
			await diagnostics.setSimulationProfile('very-bad');
			const failed = instrumented('https://example.test/failure-3');
			const rejection = expect(failed).rejects.toThrow(
				'failed by the Very Bad Network',
			);
			await jest.advanceTimersByTimeAsync(2_000);
			await rejection;
			expect(fetchImplementation).toHaveBeenCalledTimes(2);
			dispose?.();
		} finally {
			jest.useRealTimers();
		}
	});

	it('derives duplicate, failed, slow, and cache insights from evidence', () => {
		const events = [
			networkEvent({ id: 1, cacheStatus: 'hit' }),
			networkEvent({ id: 2, cacheStatus: 'miss' }),
			networkEvent({
				id: 3,
				state: 'error',
				status: undefined,
				durationMs: 1_500,
				url: 'https://example.test/failure',
			}),
			networkEvent({ id: 4, state: 'pending', durationMs: 9_000 }),
		];
		expect(
			summarizeNetworkInsights(events).map((insight) => insight.id),
		).toEqual(['duplicates', 'failed', 'slow', 'cache']);
		expect(inferNetworkCacheStatus(304, {})).toBe('revalidated');
		expect(inferNetworkCacheStatus(200, { 'cache-control': 'private' })).toBe(
			'unknown',
		);
		expect(inferNetworkCacheStatus(200, { 'cache-control': 'no-store' })).toBe(
			'bypassed',
		);
		expect(inferNetworkCacheStatus(200, {})).toBe('unknown');
	});

	it('re-redacts and bounds cURL export from an unsanitized event', () => {
		const command = buildCurlCommand(
			networkEvent({
				method: 'POST',
				url: 'https://example.test/items?token=query-secret',
				requestHeaders: {
					authorization: 'Bearer header-secret',
					'content-length': '999999',
					host: 'attacker.test',
					'transfer-encoding': 'chunked',
					'x-safe': 'ok',
				},
				requestBody: JSON.stringify({ password: 'body-secret' }),
			}),
		);
		expect(command).not.toContain('query-secret');
		expect(command).not.toContain('header-secret');
		expect(command).not.toContain('body-secret');
		expect(command).not.toContain('content-length');
		expect(command).not.toContain('attacker.test');
		expect(command).not.toContain('transfer-encoding');
		expect(command).toContain('[REDACTED]');
		expect(utf8ByteLength(command)).toBeLessThanOrEqual(64 * 1024);
	});

	it('keeps cURL methods and bodies inert while re-sanitizing form content', () => {
		const injectedMethod = buildCurlCommand(
			networkEvent({ method: 'GET|whoami', requestBody: undefined }),
		);
		const injectedBackticks = buildCurlCommand(
			networkEvent({ method: 'GET`id`', requestBody: undefined }),
		);
		const localFile = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: '@/etc/passwd',
				requestHeaders: { 'content-type': 'text/plain' },
			}),
		);
		const stdinFile = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: '@-',
				requestHeaders: { 'content-type': 'text/plain' },
			}),
		);
		const encodedForm = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'pass%77ord=hunter2',
				requestHeaders: {
					'content-type': 'application/x-www-form-urlencoded, text/plain',
				},
			}),
		);
		const multipart = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'password=hunter2',
				requestHeaders: {
					'content-type': 'text/plain, multipart/form-data; boundary=x',
				},
			}),
		);

		expect(injectedMethod).toContain("curl -X 'GET|WHOAMI'");
		expect(injectedBackticks).toContain("curl -X 'GET`ID`'");
		expect(localFile).toContain("--data-raw '@/etc/passwd'");
		expect(stdinFile).toContain("--data-raw '@-'");
		expect(localFile).not.toContain(' --data ');
		expect(encodedForm).not.toMatch(/hunter2|pass%77ord/);
		expect(encodedForm).toContain('omitted by export limit');
		expect(multipart).not.toMatch(/hunter2|--data/);
		expect(multipart).toContain('omitted by export limit');
	});

	it('omits unsafe header names, XML, binary MIME, and overflowed MIME exports', () => {
		const encodedHeader = buildCurlCommand(
			networkEvent({
				requestHeaders: {
					'pass%77ord': 'hunter2',
					'to%256ben%253dhunter2': 'still-secret',
				},
			}),
		);
		const xml = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: '<?target x?><entry key="password">hunter2</entry>',
				requestHeaders: { 'content-type': 'text/plain' },
			}),
		);
		const binary = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'opaque-hunter2-secret',
				requestHeaders: { 'content-type': 'application/cbor' },
			}),
		);
		const ambiguous = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'opaque-hunter2-secret',
				requestHeaders: { 'content-type': 'text/plain, image/png' },
			}),
		);
		const cappedHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		for (let index = 0; index < 99; index += 1) {
			cappedHeaders[`x-padding-${index}`] = String(index);
		}
		cappedHeaders['content-type'] = 'multipart/form-data; boundary=x';
		const overflowedMime = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'opaque-hunter2-secret',
				requestHeaders: cappedHeaders,
			}),
		);

		expect(encodedHeader).not.toMatch(/hunter2|still-secret|pass%77ord|to%/i);
		for (const command of [xml, binary, ambiguous, overflowedMime]) {
			expect(command).not.toContain('hunter2');
			expect(command).not.toContain('--data-raw');
			expect(command).toContain('omitted by export limit');
		}
	});

	it('omits multibyte cURL fields instead of exporting truncated requests', () => {
		const command = buildCurlCommand(
			networkEvent({
				method: 'POST',
				url: `https://example.test/${'🏋️'.repeat(2_000)}`,
				requestHeaders: { 'x-multibyte': '🏋️'.repeat(2_000) },
				requestBody: '🏋️'.repeat(5_000),
			}),
		);

		expect(command).toContain('[URL omitted: export limit]');
		expect(command).not.toContain('🏋️');
		expect(command).not.toContain('…');
		expect(command).toContain('omitted by export limit');
	});

	it('bounds direct cURL inputs before redaction without leaking cut secrets', () => {
		const requestHeaders: Record<string, string> = {
			'x-oversized': `${'x'.repeat(8 * 1024)}person@example.com`,
		};
		for (let index = 0; index < 150; index += 1) {
			requestHeaders[`x-header-${index}`] = `value-${index}`;
		}
		const command = buildCurlCommand(
			networkEvent({
				method: 'M-SEARCH',
				url: `https://example.test/${'a'.repeat(16 * 1024)}person@example.com`,
				requestHeaders,
				requestBody: `${'b'.repeat(32 * 1024)}body@example.com`,
			}),
		);

		expect(command).toContain("curl -X 'M-SEARCH'");
		expect(command).toContain('[URL omitted: export limit]');
		expect(command).not.toContain('person@example.com');
		expect(command).not.toContain('body@example.com');
		expect(command.match(/-H /g)?.length ?? 0).toBeLessThanOrEqual(100);
		expect(command).toContain('omitted by export limit');
		expect(utf8ByteLength(command)).toBeLessThanOrEqual(64 * 1024);
	});

	it('uses one guarded bounded header projection for cURL export', () => {
		const headerTarget = Object.assign(Object.create(null), {
			'content-type': 'text/plain',
			'x-safe': 'ok',
		});
		const ownKeys = jest.fn((target: Record<string, string>) => {
			if (ownKeys.mock.calls.length > 1) {
				throw new Error('headers must be traversed only once');
			}
			return Reflect.ownKeys(target);
		});
		const requestHeaders = new Proxy(headerTarget, { ownKeys });

		const command = buildCurlCommand(
			networkEvent({ method: 'POST', requestBody: 'safe', requestHeaders }),
		);

		expect(ownKeys).toHaveBeenCalledTimes(1);
		expect(command).toContain("--data-raw 'safe'");
		expect(command).toContain("-H 'x-safe: ok'");

		const throwingHeaders = new Proxy(Object.create(null), {
			ownKeys: () => {
				throw new Error('hostile header projection');
			},
		}) as Readonly<Record<string, string>>;
		const failClosed = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'must-not-export',
				requestHeaders: throwingHeaders,
			}),
		);
		expect(failClosed).not.toContain('must-not-export');
		expect(failClosed).not.toContain('--data-raw');
		expect(failClosed).toContain('omitted by export limit');
	});

	it('never exports diagnostic, truncated, or incomplete request bodies', () => {
		for (const requestBody of [
			'[Unreadable request body]',
			'[Body redacted: encoded sensitive data]',
			'{"safe":true}\n[Truncated: entry limit reached]',
			'[Body capture cancelled]',
			'partial-value…',
		]) {
			const command = buildCurlCommand(
				networkEvent({
					method: 'POST',
					requestBody,
					requestHeaders: { 'content-type': 'text/plain' },
				}),
			);
			expect(command).not.toContain('--data-raw');
			expect(command).toContain('omitted by export limit');
		}

		const incomplete = buildCurlCommand(
			networkEvent({
				method: 'POST',
				requestBody: 'otherwise-safe',
				requestHeaders: { 'content-type': 'text/plain' },
				requestProjectionComplete: false,
			}),
		);
		expect(incomplete).not.toContain('otherwise-safe');
		expect(incomplete).not.toContain('--data-raw');
	});
});

function abortedErrorForTest(): Error {
	const error = new Error('cancelled');
	error.name = 'AbortError';
	return error;
}

function responseWithHeaders(
	body: string,
	status: number,
	headers: Headers,
): Response {
	return new Response(
		status === 204 || status === 205 || status === 304 ? null : body,
		{ status, headers },
	);
}
