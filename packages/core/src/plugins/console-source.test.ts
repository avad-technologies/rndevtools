import type { ConsoleLogInput } from './console';
import {
	type ConsoleMethodTarget,
	createConsoleMethodSource,
} from './console-source';

describe('optional console method source', () => {
	it('does not patch unless explicitly enabled for development', () => {
		const log = jest.fn();
		const target = { log };
		const source = createConsoleMethodSource({ target });
		const listener = jest.fn();
		const dispose = source.subscribe(listener);
		target.log('unchanged');
		expect(target.log).toBe(log);
		expect(listener).not.toHaveBeenCalled();
		dispose();
	});

	it('preserves console behavior and emits explicit structured events', () => {
		const receiver = { calls: 0 };
		const log = jest.fn(function (this: typeof receiver, _message: unknown) {
			this.calls += 1;
			return 'result';
		});
		const target: ConsoleMethodTarget = { log };
		const source = createConsoleMethodSource({
			target,
			enabled: true,
			development: true,
			now: () => 123,
		});
		const events: ConsoleLogInput[] = [];
		const dispose = source.subscribe((event) => events.push(event));
		const result = target.log?.call(receiver, 'hello', { status: 200 });

		expect(result).toBe('result');
		expect(receiver.calls).toBe(1);
		expect(events).toEqual([
			{
				at: 123,
				level: 'info',
				message: 'hello',
				scope: 'console',
				attributes: {
					argumentsText: '[\n  {\n    "status": 200\n  }\n]',
					argumentsTruncated: false,
				},
			},
		]);
		dispose();
		expect(target.log).toBe(log);
	});

	it('shares one wrapper across subscribers and restores on the last disposal', () => {
		const warn = jest.fn();
		const target: ConsoleMethodTarget = { warn };
		const source = createConsoleMethodSource({
			target,
			enabled: true,
			development: true,
		});
		const first = jest.fn();
		const second = jest.fn();
		const disposeFirst = source.subscribe(first);
		const wrapper = target.warn;
		const disposeSecond = source.subscribe(second);
		expect(target.warn).toBe(wrapper);
		disposeFirst();
		expect(target.warn).toBe(wrapper);
		target.warn?.('warning');
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		disposeSecond();
		expect(target.warn).toBe(warn);
	});

	it('prints but does not capture a log made while a listener handles one', () => {
		const log = jest.fn();
		const target: ConsoleMethodTarget = { log };
		const source = createConsoleMethodSource({
			target,
			enabled: true,
			development: true,
		});
		const messages: string[] = [];
		const dispose = source.subscribe((event) => {
			messages.push(event.message);
			// A forwarder that logs would otherwise recurse until the stack overflows.
			target.log?.(`forwarded ${event.message}`);
		});

		target.log?.('first');
		target.log?.('second');

		expect(messages).toEqual(['first', 'second']);
		expect(log.mock.calls).toEqual([
			['first'],
			['forwarded first'],
			['second'],
			['forwarded second'],
		]);
		dispose();
	});

	it('does not overwrite a method another owner installed later', () => {
		const error = jest.fn();
		const replacement = jest.fn();
		const target: ConsoleMethodTarget = { error };
		const source = createConsoleMethodSource({
			target,
			enabled: true,
			development: true,
		});
		const dispose = source.subscribe(jest.fn());
		target.error = replacement;
		dispose();
		expect(target.error).toBe(replacement);
	});
});
