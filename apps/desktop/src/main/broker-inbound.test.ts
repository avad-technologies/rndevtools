import { describe, expect, it } from 'vitest';
import { DESKTOP_PROTOCOL_VERSION } from '../shared/protocol';
import {
	brokerRawDataByteLength,
	parseBrokerDeviceMessage,
	safeBrokerErrorText,
} from './broker-inbound';

function helloMessage(): Record<string, unknown> {
	return {
		type: 'hello',
		protocolVersion: DESKTOP_PROTOCOL_VERSION,
		device: {
			id: 'inbound-device',
			name: 'Inbound device',
			platform: 'ios',
			capabilities: [],
		},
	};
}

describe('broker inbound boundary', () => {
	it('normalizes complete and fragmented ws frames through the wire schema', () => {
		const encoded = Buffer.from(JSON.stringify(helloMessage()));
		const splitAt = Math.floor(encoded.byteLength / 2);
		const fragmented = [
			encoded.subarray(0, splitAt),
			encoded.subarray(splitAt),
		];

		expect(parseBrokerDeviceMessage(encoded)).toMatchObject({
			type: 'hello',
			device: { id: 'inbound-device' },
		});
		expect(parseBrokerDeviceMessage(fragmented)).toEqual(
			parseBrokerDeviceMessage(encoded)
		);
		expect(brokerRawDataByteLength(fragmented)).toBe(encoded.byteLength);
	});

	it('rejects malformed or schema-incompatible frames', () => {
		expect(() => parseBrokerDeviceMessage(Buffer.from('{'))).toThrow();
		expect(() =>
			parseBrokerDeviceMessage(
				Buffer.from(JSON.stringify({ ...helloMessage(), unexpected: true }))
			)
		).toThrow();
	});

	it('redacts and bounds boundary errors', () => {
		const secret = 'private-broker-token';
		const message = safeBrokerErrorText(
			new Error(`token=${secret} ${'failure '.repeat(4_000)}`)
		);

		expect(message).not.toContain(secret);
		expect(message).toContain('[REDACTED]');
		expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(8 * 1024);
	});

	it('says where a schema-incompatible message failed', () => {
		let rejected: unknown;
		try {
			parseBrokerDeviceMessage(
				Buffer.from(JSON.stringify({ ...helloMessage(), unexpected: true }))
			);
		} catch (error) {
			rejected = error;
		}
		const message = safeBrokerErrorText(rejected);
		expect(message).toMatch(/^The device message does not match the protocol/);
		expect(message).not.toBe('ZodError');
		expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(8 * 1024);
	});
});
