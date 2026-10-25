import { describe, expect, it, vi } from 'vitest';
import { createNetworkFilterIntents } from './app-traffic';

const target = { key: 'stack:abc', label: 'origin 127.0.0.1:24410' };

describe('the Network filter intent', () => {
	it('holds the latest request until the panel settles it', () => {
		const intents = createNetworkFilterIntents();
		const listener = vi.fn();
		const unsubscribe = intents.subscribe(listener);
		expect(intents.current()).toBeNull();
		intents.request({ deviceId: 'device-1', target });
		expect(intents.current()).toEqual({
			deviceId: 'device-1',
			target,
			nonce: 1,
		});
		intents.request({ deviceId: 'device-1', target });
		expect(intents.current()?.nonce).toBe(2);
		// An older nonce no longer settles anything.
		intents.settle(1);
		expect(intents.current()?.nonce).toBe(2);
		intents.settle(2);
		expect(intents.current()).toBeNull();
		expect(listener).toHaveBeenCalledTimes(3);
		unsubscribe();
		intents.request({ deviceId: 'device-2', target });
		expect(listener).toHaveBeenCalledTimes(3);
	});
});
