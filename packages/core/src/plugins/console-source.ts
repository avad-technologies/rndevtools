import { serializeValue } from '../core/serialize';
import type {
	ConsoleLogInput,
	ConsoleLogLevel,
	ConsoleLogSource,
} from './console';

const CONSOLE_METHOD_LEVELS = {
	debug: 'debug',
	error: 'error',
	info: 'info',
	log: 'info',
	warn: 'warn',
} as const satisfies Readonly<Record<string, ConsoleLogLevel>>;

type ConsoleMethodName = keyof typeof CONSOLE_METHOD_LEVELS;
type ConsoleMethod = (...args: readonly unknown[]) => unknown;

export type ConsoleMethodTarget = Partial<
	Record<ConsoleMethodName, ConsoleMethod>
>;

export type ConsoleMethodSourceOptions = Readonly<{
	/** Both flags must be true. The adapter never patches by default. */
	enabled?: boolean;
	development?: boolean;
	target: ConsoleMethodTarget;
	now?: () => number;
}>;

/**
 * Explicit third-party compatibility bridge. A host's logger-backed source is
 * preferred. This adapter patches only while subscribed and restores a method
 * only when its own wrapper still owns that property.
 */
export function createConsoleMethodSource(
	options: ConsoleMethodSourceOptions,
): ConsoleLogSource {
	const listeners = new Set<(event: ConsoleLogInput) => void>();
	const originals = new Map<ConsoleMethodName, ConsoleMethod>();
	const wrappers = new Map<ConsoleMethodName, ConsoleMethod>();
	const active = options.enabled === true && options.development === true;
	const now = options.now ?? Date.now;
	let emitting = false;

	const emit = (level: ConsoleLogLevel, args: readonly unknown[]): void => {
		// A listener that logs, or React warning about an update the listener
		// caused, calls back into a wrapper. Capturing that call would recurse
		// until the stack overflows, so it still prints but is not captured.
		if (emitting) return;
		emitting = true;
		try {
			const first = args[0];
			const message =
				typeof first === 'string'
					? first
					: serializeValue(first, 4 * 1024).text;
			const serializedArguments =
				args.length > 1 ? serializeValue(args.slice(1), 8 * 1024) : undefined;
			const event: ConsoleLogInput = {
				at: now(),
				level,
				message,
				scope: 'console',
				...(serializedArguments
					? {
							attributes: {
								argumentsText: serializedArguments.text,
								argumentsTruncated: serializedArguments.truncated,
							},
						}
					: {}),
			};
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					// A diagnostics listener must never alter console behavior.
				}
			}
		} finally {
			emitting = false;
		}
	};

	const restore = (): void => {
		for (const [name, wrapper] of wrappers) {
			try {
				if (options.target[name] === wrapper) {
					options.target[name] = originals.get(name);
				}
			} catch {
				// A host may freeze or replace its console while diagnostics are active.
			}
		}
		wrappers.clear();
		originals.clear();
	};

	const install = (): void => {
		if (!active || wrappers.size > 0) return;
		try {
			for (const name of Object.keys(
				CONSOLE_METHOD_LEVELS,
			) as ConsoleMethodName[]) {
				const original = options.target[name];
				if (typeof original !== 'function') continue;
				const wrapper: ConsoleMethod = function (
					this: unknown,
					...args: readonly unknown[]
				): unknown {
					const result = Reflect.apply(original, this, args);
					emit(CONSOLE_METHOD_LEVELS[name], args);
					return result;
				};
				originals.set(name, original);
				wrappers.set(name, wrapper);
				options.target[name] = wrapper;
			}
		} catch {
			restore();
		}
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);
			if (listeners.size === 1) install();
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				listeners.delete(listener);
				if (listeners.size === 0) restore();
			};
		},
	};
}
