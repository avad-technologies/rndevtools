import { redactDiagnosticText } from '../core/redact';
import { truncateText } from '../core/serialize';
import {
	type ConsoleLogInput,
	createConsolePlugin,
	redactConsoleText,
} from './console';

describe('console attribute redaction', () => {
	it('redacts credential keys in either casing but keeps ordinary keys', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		listener?.({
			level: 'info',
			message: 'render',
			attributes: {
				width: 390,
				isValid: true,
				provider: 'google',
				gridSize: 12,
				accessToken: 'super-secret',
				user_id: 'abc',
			},
		});
		const captured = JSON.stringify(diagnostics.getEvents());
		// Ordinary diagnostic keys must survive: an unanchored match would redact
		// every one of these, because each contains the substring `id`.
		expect(captured).toContain('390');
		expect(captured).toContain('google');
		expect(captured).toContain('12');
		expect(captured).toContain('isValid');
		// Credential keys stay redacted in both separator and camelCase spellings.
		expect(captured).not.toContain('super-secret');
		expect(captured).not.toContain('abc');
		dispose?.();
	});
});

describe('createConsolePlugin', () => {
	it('captures logger events only while installed and redacts before storage', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});

		expect(listener).toBeUndefined();
		const dispose = diagnostics.plugin.install?.();
		listener?.({
			level: 'error',
			message: 'Request for person@example.com used Bearer super-secret',
			attributes: {
				email: 'person@example.com',
				status: 500,
				request_id: '6b03a565-1d70-40a5-9340-6ff8d752fb50',
			},
		});

		const captured = JSON.stringify(diagnostics.getEvents());
		expect(captured).toContain('[REDACTED_EMAIL]');
		expect(captured).toContain('[REDACTED]');
		expect(captured).toContain('500');
		expect(captured).not.toContain('person@example.com');
		expect(captured).not.toContain('super-secret');
		expect(captured).not.toContain('6b03a565');

		dispose?.();
		expect(listener).toBeUndefined();
	});

	it('bounds captured logger events', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxEvents: 1,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({ level: 'info', message: 'first' });
		listener?.({ level: 'warn', message: 'second' });

		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.message).toBe('second');
	});

	it('groups identical structured logs inside the grouping window', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			groupingWindowMs: 500,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const repeated: ConsoleLogInput = {
			at: 1_000,
			level: 'warn',
			message: 'Retrying request',
			scope: 'network.retry',
			correlationId: 'request-42',
			attributes: { attempt: 1 },
		};
		listener?.(repeated);
		listener?.({ ...repeated, at: 1_250 });
		listener?.({ ...repeated, at: 2_000 });

		expect(diagnostics.getEvents()).toHaveLength(2);
		expect(diagnostics.getEvents()[0]).toMatchObject({
			firstAt: 1_000,
			lastAt: 1_250,
			at: 1_250,
			repeatCount: 2,
			scope: 'network.retry',
			correlationId: 'request-42',
		});
		expect(diagnostics.getEvents()[1]).toMatchObject({
			firstAt: 2_000,
			lastAt: 2_000,
			repeatCount: 1,
		});
	});

	it('captures supplied error and source metadata after bounding and redaction', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxStackBytes: 256,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({
			level: 'error',
			message: 'Request failed',
			error: {
				name: 'NetworkError',
				stack:
					'NetworkError: Bearer top-secret\n at fetch (person@example.com:1:2)',
			},
			sourceLocation: {
				file: '/src/network/client.ts?token=source-secret',
				line: 42,
				column: 7,
			},
		});

		const captured = diagnostics.getEvents()[0];
		expect(captured).toMatchObject({
			errorName: 'NetworkError',
			sourceLocation: { line: 42, column: 7 },
			repeatCount: 1,
		});
		expect(JSON.stringify(captured)).not.toContain('top-secret');
		expect(JSON.stringify(captured)).not.toContain('person@example.com');
		expect(JSON.stringify(captured)).not.toContain('source-secret');
	});

	it('bookmarks retained events and removes stale bookmarks on eviction or clear', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxEvents: 1,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({ level: 'info', message: 'first' });
		expect(diagnostics.toggleBookmark(1)).toBe(true);
		expect(diagnostics.getBookmarkedEventIds()).toEqual([1]);
		expect(diagnostics.toggleBookmark(1)).toBe(false);
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
		diagnostics.toggleBookmark(1);

		listener?.({ level: 'warn', message: 'second' });
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
		expect(diagnostics.toggleBookmark(1)).toBe(false);
		expect(diagnostics.toggleBookmark(2)).toBe(true);
		diagnostics.clear();
		expect(diagnostics.getBookmarkedEventIds()).toEqual([]);
	});

	it('ignores source callbacks retained after disposal', () => {
		const listeners: Array<(event: ConsoleLogInput) => void> = [];
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (listener) => {
					listeners.push(listener);
					return () => {};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const staleListener = listeners[0];
		dispose?.();

		staleListener?.({ level: 'error', message: 'late event' });

		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('redacts camelCase sensitive attribute keys without invoking accessors', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const attributes = {
			accessToken: 'opaque-access-value',
			refreshToken: 'opaque-refresh-value',
			userId: 'opaque-user-value',
			phoneNumber: '555-0100',
			get dangerous() {
				throw new Error('getter must not run');
			},
		};

		expect(() =>
			listener?.({ level: 'info', message: 'safe', attributes }),
		).not.toThrow();
		const captured = JSON.stringify(diagnostics.getEvents());
		expect(captured).not.toContain('opaque-access-value');
		expect(captured).not.toContain('opaque-refresh-value');
		expect(captured).not.toContain('opaque-user-value');
		expect(captured).not.toContain('555-0100');
		expect(captured).toContain('[Accessor omitted]');
	});

	it('contains faulty sources, sanitizers, and disposers', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			sanitize: () => {
				throw new Error('sanitize failed');
			},
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						throw new Error('dispose failed');
					};
				},
			},
		});

		const dispose = diagnostics.plugin.install?.();
		expect(() =>
			listener?.({ level: 'info', message: 'ignored' }),
		).not.toThrow();
		expect(diagnostics.getEvents()).toEqual([]);
		expect(() => dispose?.()).not.toThrow();
	});

	it('does not invoke array accessors and replaces invalid timestamps', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const values: unknown[] = [];
		Object.defineProperty(values, '0', {
			enumerable: true,
			get() {
				throw new Error('getter must not run');
			},
		});
		values.length = 1;

		expect(() =>
			listener?.({
				at: Number.MAX_VALUE,
				level: 'info',
				message: 'safe',
				attributes: { values },
			}),
		).not.toThrow();
		expect(diagnostics.getEvents()[0]?.attributesText).toContain(
			'[Accessor omitted]',
		);
		expect(diagnostics.getEvents()[0]?.at).toBeLessThanOrEqual(Date.now());
	});

	it('does not invoke accessors on sanitizer output', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const getter = jest.fn(() => 'unsafe');
		const output = { level: 'info' } as Record<string, unknown>;
		Object.defineProperty(output, 'message', {
			enumerable: true,
			get: getter,
		});
		const diagnostics = createConsolePlugin({
			sanitize: () => output as unknown as ConsoleLogInput,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();

		expect(() =>
			listener?.({ level: 'info', message: 'original' }),
		).not.toThrow();
		expect(getter).not.toHaveBeenCalled();
		expect(diagnostics.getEvents()).toEqual([]);
	});

	it('summarizes binary attributes and reads only the entries it keeps', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const read = jest.fn();
		const samples = new Proxy(new Array<number>(1_000_000).fill(7), {
			getOwnPropertyDescriptor(target, key) {
				read(key);
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});

		listener?.({
			level: 'info',
			message: 'frame',
			attributes: { frame: new Uint8Array(1_000_000), samples },
		});

		const attributes = JSON.parse(
			diagnostics.getEvents()[0]?.attributesText ?? '{}',
		);
		expect(attributes.frame).toEqual({
			type: 'Uint8Array',
			byteLength: 1_000_000,
		});
		expect(attributes.samples).toHaveLength(50);
		// The length, then one descriptor per kept index.
		expect(read).toHaveBeenCalledTimes(51);
	});

	it('redacts a secret that starts in the kept part of an oversized message', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// Large enough that a window of a few message budgets would cut it.
		const token = `eyJ${'a'.repeat(9_000)}.eyJ${'b'.repeat(9_000)}.signature`;

		listener?.({
			level: 'info',
			message: `refresh ${token} ${'x'.repeat(500_000)}`,
		});
		listener?.({
			level: 'info',
			message: `password="${'p'.repeat(300_000)}" tail after the value`,
		});

		const [jwtEvent, passwordEvent] = diagnostics.getEvents();
		expect(jwtEvent?.message.startsWith('refresh [REDACTED_TOKEN] x')).toBe(
			true,
		);
		expect(jwtEvent?.messageTruncated).toBe(true);
		expect(jwtEvent?.message).not.toContain('aaaa');
		// A redacted value longer than the first redaction window does not hide
		// the text after it: the windows widen, up to their limit, until the
		// value ends.
		expect(passwordEvent).toMatchObject({
			message: 'password="[REDACTED]" tail after the value',
			messageTruncated: false,
		});
	});

	it('redacts a secret that a long redacted value pulls to the window edge', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const secrets = [
			'postgresql://postgres:hunter2-super-secret@db.example.com:5432/app',
			'alice.smith@example.com',
			`eyJ${'h'.repeat(32)}.eyJ${'c'.repeat(64)}.${'s'.repeat(43)}`,
		];
		const head = 'upload failed {"token":"';
		const between = '","next":"';
		const messages: string[] = [];
		// Each message holds a large redacted value, then a secret that the edge
		// of a redaction window cuts in half, then more text. The edges are those
		// of the first pair of windows: the 2 KiB message budget plus 64 Ki
		// units, and plus 128 Ki units.
		for (const edge of [2 * 1024 + 64 * 1024, 2 * 1024 + 128 * 1024]) {
			for (const secret of secrets) {
				const value = 't'.repeat(
					edge - head.length - between.length - Math.floor(secret.length / 2),
				);
				messages.push(
					`${head}${value}${between}${secret}"} ${'x'.repeat(200_000)}`,
				);
			}
		}
		// Far apart, so that identical stored text is not grouped.
		messages.forEach((message, index) => {
			listener?.({ at: (index + 1) * 60_000, level: 'warn', message });
		});

		const stored = diagnostics.getEvents().map((event) => event.message);
		// The same text as redacting the whole message before truncating it.
		expect(stored).toEqual(
			messages.map(
				(message) => truncateText(redactConsoleText(message), 2 * 1024).text,
			),
		);
		for (const message of stored) {
			expect(message).toContain('"token":"[REDACTED]","next":"');
			expect(message).not.toMatch(/hunter2|alice\.smith|eyJ/);
		}
	});

	it('redacts only a bounded prefix of an oversized message', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const message = `user person@example.com ${'x'.repeat(8 * 1024 * 1024)}`;
		const replace = jest.spyOn(String.prototype, 'replace');
		try {
			listener?.({ level: 'info', message });
			const scanned = Math.max(
				...replace.mock.contexts.map((text) => String(text).length),
			);
			// More than the 2 KiB that is kept, far less than the message.
			expect(scanned).toBeGreaterThan(2 * 1024);
			expect(scanned).toBeLessThan(1024 * 1024);
		} finally {
			replace.mockRestore();
		}
		expect(diagnostics.getEvents()[0]).toMatchObject({
			messageTruncated: true,
		});
		expect(diagnostics.getEvents()[0]?.message).toMatch(
			/^user \[REDACTED_EMAIL\] x+…$/,
		);
	});

	it('redacts a URL password whose cut tail other rules lengthen', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// `,jwt=x` redacts to 2.5 times its length. The windows used to measure
		// the text after the kept part once redacted, so the cut part of a
		// password of about 26 Ki units counted as 64 Ki of context, and the
		// password's start was stored. Each message is longer than the pair of
		// windows whose edge cuts its password, which would redact a shorter one
		// whole.
		const head = '{"token":"';
		const next = '","next":"postgresql://postgres:hunter2';
		const item = ',jwt=x';
		const cuts: [edge: number, itemsBeforeEdge: number][] = [
			// The first window of the first pair, which the second holds whole.
			[2 * 1024 + 64 * 1024, 1_000],
			// What was the first window: 633,170 units, a 27,062-unit password.
			[2 * 1024 + 128 * 1024, 4_505],
			// The largest window: 1,024,338 units, a 26,264-unit password.
			[512 * 1024, 4_372],
		];
		const messages = cuts.map(([edge, itemsBeforeEdge]) => {
			const value = 't'.repeat(
				edge - head.length - next.length - itemsBeforeEdge * item.length - 2,
			);
			return `${head}${value}${next}${item.repeat(itemsBeforeEdge + 4)},@db.example.com:5432/app"} ${'x'.repeat(500_000)}`;
		});
		messages.forEach((message, index) => {
			listener?.({ at: (index + 1) * 60_000, level: 'warn', message });
		});

		const [first, second, longer] = diagnostics.getEvents();
		expect([first?.message, second?.message]).toEqual(
			messages
				.slice(0, 2)
				.map(
					(message) => truncateText(redactConsoleText(message), 2 * 1024).text,
				),
		);
		// Past the largest windows, only the text both redactions start with is
		// kept, and the password's start is not part of it.
		expect(longer).toMatchObject({
			message: '{"token":"[REDACTED]"…',
			messageTruncated: true,
		});
		expect(JSON.stringify(diagnostics.getEvents())).not.toContain('hunter2');
	});

	it('redacts a quoted secret that a window edge cuts right after a backslash', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// A 30,009-unit value with `jwt=x` inside, cut between the two halves of
		// an escape by what was the first window.
		const edge = 2 * 1024 + 128 * 1024;
		const head = '{"token":"';
		const password = '","password":"hunter2';
		const item = ' jwt=x';
		const value = `${item.repeat(4_600)}\\n${item.repeat(400)}`;
		const message = `${head}${'t'.repeat(edge - head.length - password.length - 4_600 * item.length - 1)}${password}${value}"} ${'x'.repeat(200_000)}`;
		expect(message[edge - 1]).toBe('\\');

		listener?.({ level: 'warn', message });

		expect(diagnostics.getEvents()[0]?.message).toBe(
			truncateText(redactConsoleText(message), 2 * 1024).text,
		);
		expect(diagnostics.getEvents()[0]?.message).not.toContain('hunter2');
	});

	it('keeps what the largest windows agree on before a secret that the first one cuts', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// The first window of the largest pair, in code units. A redacted value
		// runs almost to it, so every pair redacts to a few dozen units and the
		// windows grow to their limit. Its edge then cuts each secret in half,
		// and only the second window holds the secret whole. Each message is
		// longer than that pair, which would redact a shorter one whole.
		const edge = 448 * 1024;
		const head = 'upload failed {"token":"';
		const between = '","next":"';
		const secrets = [
			[
				'postgresql://postgres:hunter2-super-secret@db.example.com:5432/app',
				'postgresql://postgres:',
			],
			['alice.smith@example.com', ''],
			[`eyJ${'h'.repeat(32)}.eyJ${'c'.repeat(64)}.${'s'.repeat(43)}`, ''],
			// The redactions also agree on any characters that the secret shares
			// with the start of a redaction marker.
			[
				'postgresql://postgres:[REDACTEhunter2@db.example.com:5432/app',
				'postgresql://postgres:',
			],
		];
		const messages = secrets.map(([secret = '']) => {
			const value = 't'.repeat(
				edge - head.length - between.length - Math.floor(secret.length / 2),
			);
			return `${head}${value}${between}${secret}"} ${'x'.repeat(600_000)}`;
		});
		messages.forEach((message, index) => {
			listener?.({ at: (index + 1) * 60_000, level: 'warn', message });
		});

		const events = diagnostics.getEvents();
		expect(events).toHaveLength(messages.length);
		events.forEach((event, index) => {
			const [, sharedStart = ''] = secrets[index] ?? [];
			expect(event).toMatchObject({
				message: `${head}[REDACTED]${between}${sharedStart}…`,
				messageTruncated: true,
			});
			expect(
				redactConsoleText(messages[index] ?? '').startsWith(
					event.message.slice(0, -1),
				),
			).toBe(true);
		});
	});

	it('never keeps half of a surrogate pair that a window edge cuts', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// The first window of the largest pair ends inside a run of emoji, two
		// code units each. Moving the edge by one unit cuts a pair or does not.
		// Each message is longer than that pair, which would redact a shorter
		// one whole.
		const edge = 448 * 1024;
		const head = 'upload failed {"token":"';
		const between = '","next":"';
		const messages = [400, 401].map((emojiUnitsBeforeEdge) => {
			const value = 't'.repeat(
				edge - head.length - between.length - emojiUnitsBeforeEdge,
			);
			return `${head}${value}${between}${'😀'.repeat(1_000)}"} ${'x'.repeat(600_000)}`;
		});
		messages.forEach((message, index) => {
			listener?.({ at: (index + 1) * 60_000, level: 'warn', message });
		});

		const events = diagnostics.getEvents();
		expect(events).toHaveLength(messages.length);
		for (const event of events) {
			// The whole emoji before the edge, but no high surrogate without its
			// pair.
			expect(event).toMatchObject({
				message: `${head}[REDACTED]${between}${'😀'.repeat(200)}…`,
				messageTruncated: true,
			});
		}
	});

	it('bounds the work on a multi-megabyte message that redaction keeps shortening', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const size = 12 * 1024 * 1024;
		const jwt = `eyJ${'h'.repeat(40)}.eyJ${'c'.repeat(900)}.${'s'.repeat(43)}`;
		// Each one shrinks every window, which used to keep doubling, up to the
		// whole message. V8's regexp backtracking overflows on the quoted value,
		// and that event was dropped.
		const messages = [
			`password="${'p'.repeat(size)}" tail`,
			`token=${'u'.repeat(size)} tail`,
			`[${Array.from({ length: Math.ceil(size / (jwt.length + 3)) }, () => `"${jwt}"`).join(',')}]`,
		];
		const replace = jest.spyOn(String.prototype, 'replace');
		try {
			messages.forEach((message, index) => {
				listener?.({ at: (index + 1) * 60_000, level: 'warn', message });
			});
			const scanned = Math.max(
				...replace.mock.contexts.map((text) => String(text).length),
			);
			expect(scanned).toBeLessThanOrEqual(512 * 1024);
		} finally {
			replace.mockRestore();
		}

		// The two values are cut at the largest windows, and the array of tokens
		// fills the message budget.
		expect(diagnostics.getEvents()).toMatchObject([
			{ message: 'password="[REDACTED]"…', messageTruncated: true },
			{ message: 'token=[REDACTED]…', messageTruncated: true },
			{
				message: truncateText(`[${'"[REDACTED_TOKEN]",'.repeat(200)}`, 2 * 1024)
					.text,
				messageTruncated: true,
			},
		]);
	});

	it('redacts a quoted credential that a host cut right after a backslash', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		listener?.({
			at: 60_000,
			level: 'warn',
			message: 'login failed {"password":"hunter2\\',
		});
		listener?.({
			at: 120_000,
			level: 'warn',
			message: "login failed {'password': 'hunter2\\\nrest'} tail",
		});
		listener?.({
			at: 180_000,
			level: 'warn',
			message: 'login failed',
			attributes: { note: 'password="hunter2\\' },
		});

		expect(diagnostics.getEvents()).toMatchObject([
			{ message: 'login failed {"password":"[REDACTED]"' },
			{ message: "login failed {'password': '[REDACTED]'} tail" },
			{ attributesText: '{\n  "note": "password=\\"[REDACTED]\\""\n}' },
		]);
		expect(JSON.stringify(diagnostics.getEvents())).not.toContain('hunter2');
	});

	it('cuts a short message of wide characters to its byte limit', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// 2,000 code units, under the 2 KiB limit, but 4,000 UTF-8 bytes.
		listener?.({ level: 'info', message: '😀'.repeat(1_000) });

		expect(diagnostics.getEvents()[0]).toMatchObject({
			message: `${'😀'.repeat(511)}…`,
			messageTruncated: true,
		});
	});

	it('redacts a bounded window of a multi-megabyte attribute string', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const size = 12 * 1024 * 1024;
		const replace = jest.spyOn(String.prototype, 'replace');
		try {
			listener?.({
				at: 60_000,
				level: 'info',
				message: 'plain',
				attributes: { note: `user person@example.com ${'x'.repeat(size)}` },
			});
			// V8's regexp stack overflowed on this, and the attributes became
			// `[Unreadable object]`.
			listener?.({
				at: 120_000,
				level: 'info',
				message: 'quoted',
				attributes: {
					note: `password="${'p'.repeat(size)}" tail`,
					status: 500,
				},
			});
			const scanned = Math.max(
				...replace.mock.contexts.map((text) => String(text).length),
			);
			expect(scanned).toBeLessThanOrEqual(512 * 1024);
		} finally {
			replace.mockRestore();
		}

		const [plain, quoted] = diagnostics.getEvents();
		expect(plain?.attributesText).toMatch(
			/^\{\n {2}"note": "user \[REDACTED_EMAIL\] x+…$/,
		);
		expect(plain?.attributesTruncated).toBe(true);
		expect(quoted).toMatchObject({
			attributesText:
				'{\n  "note": "password=\\"[REDACTED]\\"…",\n  "status": 500\n}',
			attributesTruncated: true,
		});
	});

	it('redacts attributes that are themselves a string', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const asAttributes = (text: string) =>
			text as unknown as ConsoleLogInput['attributes'];
		listener?.({
			at: 60_000,
			level: 'info',
			message: 'short',
			attributes: asAttributes('token=abc person@example.com'),
		});
		// The regexp stack overflow escaped ingest here, and the event was
		// dropped.
		listener?.({
			at: 120_000,
			level: 'info',
			message: 'long',
			attributes: asAttributes(
				`password="${'p'.repeat(12 * 1024 * 1024)}" tail`,
			),
		});

		expect(diagnostics.getEvents()).toMatchObject([
			{
				attributesText: '"token=[REDACTED] [REDACTED_EMAIL]"',
				attributesTruncated: false,
			},
			{
				attributesText: '"password=\\"[REDACTED]\\"…"',
				attributesTruncated: true,
			},
		]);
	});

	it('keeps the serialized shape of attributes that the serializer redacts or cuts', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			maxAttributesBytes: 64,
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// The serializer redacts `userId5`, so cutting its long value must not
		// mark the attributes as truncated.
		listener?.({
			at: 60_000,
			level: 'info',
			message: 'key',
			attributes: { userId5: 'x'.repeat(100_000), status: 1 },
		});
		// A cut that stops before an emoji leaves room for the closing quote,
		// unless the string is kept a little longer than the attributes.
		listener?.({
			at: 120_000,
			level: 'info',
			message: 'cut',
			attributes:
				`${'a'.repeat(58)}${'😀'.repeat(10)}` as unknown as ConsoleLogInput['attributes'],
		});

		expect(diagnostics.getEvents()).toMatchObject([
			{
				attributesText: '{\n  "userId5": "[REDACTED]",\n  "status": 1\n}',
				attributesTruncated: false,
			},
			{ attributesText: `"${'a'.repeat(58)}…`, attributesTruncated: true },
		]);
	});

	it('shares one redaction budget between the attribute values of an event', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const quoted = `password="${'p'.repeat(12 * 1024 * 1024)}" tail`;
		// Each copy redacts about 1.5 Mi units, so the second one spends the
		// 2 Mi budget. A number after them costs nothing to keep.
		listener?.({
			at: 60_000,
			level: 'info',
			message: 'repeated',
			attributes: {
				...Object.fromEntries(
					Array.from({ length: 98 }, (_unused, index) => [`k${index}`, quoted]),
				),
				status: 500,
			},
		});
		// Levels that share their child: a walk without a budget visits every
		// path, a million values here.
		const read = jest.fn();
		let tree: object = { leaf: 'x' };
		for (let depth = 0; depth < 3; depth += 1) {
			const child = tree;
			tree = new Proxy(
				Object.fromEntries(
					Array.from({ length: 100 }, (_unused, index) => [`k${index}`, child]),
				),
				{
					getOwnPropertyDescriptor(target, key) {
						read(key);
						return Reflect.getOwnPropertyDescriptor(target, key);
					},
				},
			);
		}
		listener?.({
			at: 120_000,
			level: 'info',
			message: 'tree',
			attributes: { tree },
		});

		const [repeated, wide] = diagnostics.getEvents();
		const values = Object.values(JSON.parse(repeated?.attributesText ?? '{}'));
		expect(values).toEqual([
			...Array(2).fill('password="[REDACTED]"…'),
			...Array(96).fill('[Value omitted: input limit]'),
			500,
		]);
		expect(repeated?.attributesTruncated).toBe(true);
		// `Object.keys` and the walk each read a descriptor per key: 2,020,200
		// reads for the whole tree. Each value costs at least 16 of the 2 Mi
		// units, and the three open levels omit the rest of their keys.
		expect(read.mock.calls.length).toBeLessThan(
			2 * ((2 * 1024 * 1024) / 16 + 3 * 100),
		);
		expect(wide?.attributesTruncated).toBe(true);
	});

	it('keeps the event when an engine cannot redact an attribute string', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const replace = String.prototype.replace;
		const failing = jest
			.spyOn(String.prototype, 'replace')
			.mockImplementation(function (this: string, ...args: unknown[]) {
				// An engine whose regexp stack is smaller than one redaction window.
				if (this.length > 100_000) {
					throw new RangeError('Maximum call stack size exceeded');
				}
				return Reflect.apply(replace, this, args) as string;
			});
		try {
			listener?.({
				at: 60_000,
				level: 'warn',
				message: 'nested',
				attributes: { note: 'x'.repeat(200_000), status: 500 },
			});
			listener?.({
				at: 120_000,
				level: 'warn',
				message: 'string',
				attributes: 'y'.repeat(
					200_000,
				) as unknown as ConsoleLogInput['attributes'],
			});
		} finally {
			failing.mockRestore();
		}

		expect(diagnostics.getEvents()).toMatchObject([
			{
				message: 'nested',
				attributesText:
					'{\n  "note": "[Value omitted: redaction failed]",\n  "status": 500\n}',
				attributesTruncated: true,
			},
			{
				message: 'string',
				attributesText: '"[Value omitted: redaction failed]"',
				attributesTruncated: true,
			},
		]);
	});

	it('redacts and bounds attribute keys', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const jwt = `eyJ${'h'.repeat(32)}.eyJ${'c'.repeat(64)}.${'s'.repeat(43)}`;
		listener?.({
			level: 'info',
			message: 'keys',
			attributes: {
				'postgresql://postgres:hunter2@db.example.com/app': true,
				'alice.smith@example.com': 1,
				'bob@example.com': 2,
				[jwt]: 3,
				'6b03a565-1d70-40a5-9340-6ff8d752fb50': 4,
				['k'.repeat(2_000)]: 5,
				accessToken: 'opaque',
			},
		});

		const [event] = diagnostics.getEvents();
		// Two addresses stay two keys, and their values stay readable: the
		// serializer's key test skips the marker that names an email field.
		expect(JSON.parse(event?.attributesText ?? '{}')).toEqual({
			'postgresql://postgres:[REDACTED]@db.example.com/app': true,
			'[REDACTED_EMAIL]': 1,
			'(2) [REDACTED_EMAIL]': 2,
			'[REDACTED_TOKEN]': 3,
			'[REDACTED_ID]': 4,
			[`${'k'.repeat(1_021)}…`]: 5,
			accessToken: '[REDACTED]',
		});
		expect(event?.attributesTruncated).toBe(true);
	});

	it('bounds the work on attributes that list or share large objects', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const table = Object.fromEntries(
			Array.from({ length: 100_000 }, (_unused, index) => [
				`id${index}`,
				{ n: index },
			]),
		);
		const many = Object.fromEntries(
			Array.from({ length: 200_000 }, (_unused, index) => [`m${index}`, 1]),
		);
		const references = Object.fromEntries(
			Array.from({ length: 100 }, (_unused, index) => [`r${index}`, many]),
		);
		const shapes = [
			{
				rows: Array.from({ length: 50 }, (_unused, index) => ({
					index,
					table,
				})),
			},
			references,
			Object.fromEntries(
				Array.from({ length: 100 }, (_unused, index) => [
					`s${index}`,
					references,
				]),
			),
		];
		const listed = jest.spyOn(Object, 'keys');
		try {
			shapes.forEach((attributes, index) => {
				listed.mockClear();
				listener?.({
					at: (index + 1) * 60_000,
					level: 'info',
					message: 'state',
					attributes,
				});
				const keysListed = listed.mock.results.reduce(
					(sum, result) => sum + (result.value as unknown[]).length,
					0,
				);
				// Listing went uncharged, so every reference listed the shared object
				// again: 25 s for the last shape on this Mac.
				expect(keysListed).toBeLessThan(3 * 200_000);
			});
		} finally {
			listed.mockRestore();
		}

		expect(diagnostics.getEvents()).toHaveLength(3);
		for (const event of diagnostics.getEvents()) {
			expect(event.attributesTruncated).toBe(true);
		}
	});

	it('bounds the work on long attribute keys', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// Levels of 100 keys of 4 Ki units that share their child. Every path
		// tested its keys in full, uncharged: 3.7 s on this Mac.
		const keys = Array.from(
			{ length: 100 },
			(_unused, index) => `${'k'.repeat(4_096)}${index}`,
		);
		let tree: Record<string, unknown> = { leaf: 1 };
		for (let depth = 0; depth < 5; depth += 1) {
			const child = tree;
			tree = Object.fromEntries(keys.map((key) => [key, child]));
		}
		const replace = jest.spyOn(String.prototype, 'replace');
		const listed = jest.spyOn(Object, 'keys');
		let keysListed = 0;
		try {
			listener?.({
				at: 60_000,
				level: 'info',
				message: 'tree',
				attributes: tree,
			});
			listener?.({
				at: 120_000,
				level: 'info',
				message: 'key',
				attributes: { [`token=${'k'.repeat(12 * 1024 * 1024)}`]: 1 },
			});
			keysListed = listed.mock.results.reduce(
				(sum, result) => sum + (result.value as unknown[]).length,
				0,
			);
			const scanned = replace.mock.contexts.reduce<number>(
				(longest, text) => Math.max(longest, String(text).length),
				0,
			);
			expect(scanned).toBeLessThanOrEqual(512 * 1024);
		} finally {
			replace.mockRestore();
			listed.mockRestore();
		}
		// Each key that the walks test or copy is charged twice its 4 Ki units,
		// to redact it and to test its name, so they open a few of these objects
		// of 100 keys and list 1,916 keys here. Uncharged, they listed 73,731.
		expect(keysListed).toBeLessThan(50 * 100);

		const [treeEvent, keyEvent] = diagnostics.getEvents();
		expect(treeEvent?.attributesTruncated).toBe(true);
		// Too long to test whole, so its value is redacted too.
		expect(keyEvent).toMatchObject({
			attributesText: '{\n  "token=[REDACTED]…": "[REDACTED]"\n}',
			attributesTruncated: true,
		});
	});

	it('reads a String object as its text, and only the fields it uses', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// A String object lists every index as a key: 0.7 s as an attribute, and
		// 2 s as an error, whose every descriptor was read, on this Mac.
		const text: unknown = Object('x'.repeat(4 * 1024 * 1024));
		const startedAt = Date.now();
		listener?.({
			at: 60_000,
			level: 'info',
			message: 'attribute',
			attributes: { note: text },
		});
		listener?.({ at: 120_000, level: 'error', message: 'error', error: text });
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		const read = jest.fn();
		const counted = <T extends object>(target: T): T =>
			new Proxy(target, {
				getOwnPropertyDescriptor(object, key) {
					read(key);
					return Reflect.getOwnPropertyDescriptor(object, key);
				},
			});
		const extra = Object.fromEntries(
			Array.from({ length: 100_000 }, (_unused, index) => [
				`extra${index}`,
				index,
			]),
		);
		listener?.(
			counted({
				...extra,
				at: 180_000,
				level: 'error',
				message: 'proxied',
				error: counted({
					...extra,
					name: 'TypeError',
					stack: 'TypeError: failed',
				}),
			}) as unknown as ConsoleLogInput,
		);

		expect(read.mock.calls.map(([key]) => key)).toEqual([
			'level',
			'message',
			'attributes',
			'at',
			'scope',
			'correlationId',
			'groupId',
			'error',
			'name',
			'stack',
			'sourceLocation',
		]);
		const [attribute, error, proxied] = diagnostics.getEvents();
		expect(attribute?.attributesText).toMatch(/^\{\n {2}"note": "x+…$/);
		expect(error?.errorStack).toBeUndefined();
		expect(proxied).toMatchObject({
			errorName: 'TypeError',
			errorStack: 'TypeError: failed',
		});
	});

	it('walks an attribute that refuses its prototype as the object it is', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// A stale Immer draft is a revoked proxy. The test for a String object
		// threw on these out of ingest, which dropped the event, or turned the
		// whole attributes into `[Unreadable object]`.
		const revoked = () => {
			const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
			revoke();
			return proxy;
		};
		const refusing = () =>
			new Proxy(
				{ a: 1 },
				{
					getPrototypeOf() {
						throw new Error('prototype refused');
					},
				},
			);
		const shapes: unknown[] = [
			revoked(),
			{ user: 'x', draft: revoked() },
			refusing(),
			{ user: 'x', draft: refusing() },
		];
		shapes.forEach((attributes, index) => {
			listener?.({
				at: (index + 1) * 60_000,
				level: 'info',
				message: 'state',
				attributes: attributes as ConsoleLogInput['attributes'],
			});
		});

		expect(
			diagnostics.getEvents().map((event) => event.attributesText),
		).toEqual([
			'"[Unreadable object]"',
			'{\n  "user": "x",\n  "draft": "[Unreadable object]"\n}',
			'{\n  "a": 1\n}',
			'{\n  "user": "x",\n  "draft": {\n    "a": 1\n  }\n}',
		]);
	});

	it('bounds the work on attributes that share arrays of values without text', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// One array shared through four levels of 50, so 6.25 M paths reach it.
		// Its values cost nothing, nor did holes: 4 s for one event on this Mac.
		let reads = 0;
		const shared = (leaf: unknown[]): unknown => {
			let node: unknown = new Proxy(leaf, {
				getOwnPropertyDescriptor(target, key) {
					reads += 1;
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			});
			for (let level = 0; level < 4; level += 1) {
				const child = node;
				node = Array.from({ length: 50 }, () => child);
			}
			return node;
		};
		const leaves = [
			Array(50).fill(undefined),
			Array(50).fill(() => 1),
			Array(50).fill(Symbol('s')),
			Array(50).fill(1n),
			new Array(50),
		];
		leaves.forEach((leaf, index) => {
			reads = 0;
			listener?.({
				at: (index + 1) * 60_000,
				level: 'info',
				message: 'state',
				attributes: { v: shared(leaf) },
			});
			// Each read of the shared array costs 16 of the 2 Mi units, and an
			// array open when they run out reads its remaining 50 entries.
			expect(reads).toBeLessThanOrEqual((2 * 1024 * 1024) / 16 + 50);
		});

		expect(diagnostics.getEvents()).toHaveLength(leaves.length);
		for (const event of diagnostics.getEvents()) {
			expect(event.attributesTruncated).toBe(true);
		}
	});

	it('charges the attributes for the values it hides', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		// One object of 100 hidden values shared through three levels of 50, so
		// 125,000 paths reach it. If a hidden value cost nothing, each listing
		// would cost only its keys.
		let listings = 0;
		let node: unknown = new Proxy(
			Object.fromEntries(
				Array.from({ length: 100 }, (_unused, index) => [
					`token${index}`,
					'opaque',
				]),
			),
			{
				ownKeys(target) {
					listings += 1;
					return Reflect.ownKeys(target);
				},
			},
		);
		for (let level = 0; level < 3; level += 1) {
			const child = node;
			node = Array.from({ length: 50 }, () => child);
		}
		listener?.({ level: 'info', message: 'state', attributes: { v: node } });

		// Each key costs 16 of the 2 Mi units to list and 16 to hide its value.
		expect(listings).toBeLessThanOrEqual((2 * 1024 * 1024) / (100 * 32) + 1);
		expect(diagnostics.getEvents()[0]?.attributesTruncated).toBe(true);
		expect(diagnostics.getEvents()[0]?.attributesText).not.toContain('opaque');
	});

	it('marks the attributes truncated when an entry cap cuts them', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const numbered = (count: number) =>
			Array.from({ length: count }, (_unused, index) => index);
		const shapes = [
			Object.fromEntries(numbered(100).map((index) => [`k${index}`, index])),
			Object.fromEntries(numbered(101).map((index) => [`k${index}`, index])),
			{ list: numbered(50) },
			{ list: numbered(51) },
		];
		shapes.forEach((attributes, index) => {
			listener?.({
				at: (index + 1) * 60_000,
				level: 'info',
				message: 'caps',
				attributes,
			});
		});

		// The last key and entry were left out silently.
		expect(
			diagnostics.getEvents().map((event) => event.attributesTruncated),
		).toEqual([false, true, false, true]);
	});

	it('keeps the ellipsis of an attribute that the largest windows cut', () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {};
				},
			},
		});
		diagnostics.plugin.install?.();
		const size = 12 * 1024 * 1024;
		listener?.({
			at: 60_000,
			level: 'info',
			message: 'token',
			attributes: { note: `token=${'u'.repeat(size)} tail` },
		});
		listener?.({
			at: 120_000,
			level: 'info',
			message: 'code',
			attributes: {
				note: `https://example.com/callback?code=${'c'.repeat(size)}&state=s`,
			},
		});

		// The serializer redacts the text again, and took the ellipsis for the
		// value, which left nothing to show that the text was cut.
		expect(
			diagnostics.getEvents().map((event) => event.attributesText),
		).toEqual([
			'{\n  "note": "token=[REDACTED]…"\n}',
			'{\n  "note": "https://example.com/callback?code=[REDACTED]…"\n}',
		]);
	});

	it('rejects unsafe retention limits', () => {
		const source = { subscribe: () => () => {} };
		expect(() => createConsolePlugin({ source, maxEvents: 10_001 })).toThrow(
			'maxEvents cannot exceed',
		);
		expect(() =>
			createConsolePlugin({ source, maxMessageBytes: 64 * 1024 + 1 }),
		).toThrow('maxMessageBytes cannot exceed');
	});
});

describe('redactConsoleText', () => {
	it('redacts common credentials and identifiers', () => {
		const value = redactConsoleText(
			'https://example.test?a=1&token=abc person@example.com Bearer xyz {"secret":"hidden"}',
		);
		expect(value).toContain('token=[REDACTED]');
		expect(value).not.toContain('person@example.com');
		expect(value).not.toContain('Bearer xyz');
		expect(value).not.toContain('hidden');
	});

	it('changes nothing when it redacts text it already redacted', () => {
		const pieces = [
			'password',
			'token',
			'session_id',
			'email',
			'authorization',
			'=',
			': ',
			'"',
			"'",
			'\\',
			' ',
			',',
			'&',
			'}',
			'?',
			'(',
			'//',
			'//u:',
			':',
			'@',
			'.',
			'-',
			'[REDACTED]',
			'[REDACTED',
			'[REDACTED EMAIL]',
			'[REDACTED JWT]',
			'[REDACTED_EMAIL]',
			'[REDACTED_TOKEN]',
			'[REDACTED_ID]',
			'…',
			'alice@example.com',
			'b@x.io',
			`eyJ${'h'.repeat(8)}.eyJ${'c'.repeat(8)}.sig`,
			'6b03a565-1d70-40a5-9340-6ff8d752fb50',
			'Bearer abc',
			'sb_secret_x',
			'?code=abc',
			'postgresql://u:pw@example.invalid',
			'abc',
		];
		let seed = 1;
		const nextPiece = () => {
			// A fixed-seed Lehmer generator, so a failure reproduces.
			seed = (seed * 48_271) % 2_147_483_647;
			return pieces[seed % pieces.length] ?? '';
		};
		const changed: string[] = [];
		for (let run = 0; run < 20_000; run += 1) {
			const text = Array.from({ length: 1 + (run % 13) }, nextPiece).join('');
			const once = redactConsoleText(text);
			// The serializer redacts attributes again, without the Console rules.
			if (
				redactConsoleText(once) !== once ||
				redactDiagnosticText(once) !== once
			) {
				changed.push(text);
			}
		}
		expect(changed).toEqual([]);
	});
});
