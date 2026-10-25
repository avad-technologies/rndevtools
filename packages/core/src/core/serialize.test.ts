import { serializeValue, truncateText, utf8ByteLength } from './serialize';

describe('serializeValue', () => {
	it('serializes circular and bigint values safely', () => {
		const value: { count: bigint; self?: unknown } = { count: 2n };
		value.self = value;

		expect(serializeValue(value).text).toContain('[Circular]');
		expect(serializeValue(value).text).toContain('2n');
	});

	it('truncates to the requested approximate byte budget', () => {
		const result = serializeValue('abcdefghij', 10);

		expect(result.truncated).toBe(true);
		expect(result.estimatedBytes).toBe(10);
	});

	it('redacts and serializes without invoking accessors or toJSON hooks', () => {
		const getter = jest.fn(() => 'private-getter');
		const toJSON = jest.fn(() => ({ token: 'private-to-json' }));
		const value = { email: 'person@example.com', toJSON } as Record<
			string,
			unknown
		>;
		Object.defineProperty(value, 'unsafe', { enumerable: true, get: getter });

		const serialized = serializeValue(value).text;

		expect(serialized).toContain('[REDACTED]');
		expect(serialized).toContain('[Accessor omitted]');
		expect(serialized).not.toContain('person@example.com');
		expect(getter).not.toHaveBeenCalled();
		expect(toJSON).not.toHaveBeenCalled();
	});
});

describe('truncateText', () => {
	it('preserves raw strings without JSON quoting', () => {
		expect(truncateText('{"ok":true}').text).toBe('{"ok":true}');
	});

	it('enforces UTF-8 byte budgets for CJK and emoji without splitting surrogates', () => {
		const result = truncateText('训练🏋️abcdef', 12);

		expect(result.truncated).toBe(true);
		expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(12);
		expect(result.text).not.toContain('\uFFFD');
	});

	it('preserves text that exactly fills very small byte budgets', () => {
		expect(truncateText('ab', 2)).toEqual({
			text: 'ab',
			truncated: false,
			estimatedBytes: 2,
		});
		expect(truncateText('abc', 2)).toEqual({
			text: '',
			truncated: true,
			estimatedBytes: 0,
		});
	});

	it('counts UTF-8 bytes at each encoding boundary and for lone surrogates', () => {
		const widths: readonly (readonly [string, number])[] = [
			['\u007f', 1],
			['\u0080', 2],
			['\u07ff', 2],
			['\u0800', 3],
			['\uffff', 3],
			['😀', 4],
			['\ud83d', 3],
			['\ude00', 3],
			['a\ud83d', 4],
			['\ude00\ud83d', 6],
		];
		for (const [text, bytes] of widths) {
			expect(utf8ByteLength(text)).toBe(bytes);
		}
		// A surrogate pair is kept or dropped whole.
		expect(truncateText('a😀b', 7)).toEqual({
			text: 'a😀b',
			truncated: false,
			estimatedBytes: 6,
		});
		expect(truncateText('a😀b', 5)).toEqual({
			text: 'a…',
			truncated: true,
			estimatedBytes: 4,
		});
		expect(truncateText('ab😀', 9)).toEqual({
			text: 'ab😀',
			truncated: false,
			estimatedBytes: 6,
		});
		expect(truncateText('ab😀c', 6)).toEqual({
			text: 'ab…',
			truncated: true,
			estimatedBytes: 5,
		});
	});

	it('treats positive infinity as an unbounded byte budget', () => {
		expect(truncateText('unbounded', Number.POSITIVE_INFINITY)).toEqual({
			text: 'unbounded',
			truncated: false,
			estimatedBytes: 9,
		});
	});
});
