import { describe, expect, it } from 'vitest';
import {
	simulatorInputResultSchema,
	simulatorInputSchema,
	simulatorKeyFromEvent,
} from './simulator-input-protocol';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

describe('simulatorInputSchema', () => {
	it('accepts each kind with defaults and rejects out-of-range or mixed payloads', () => {
		expect(
			simulatorInputSchema.parse({ kind: 'tap', udid: UDID, x: 0.5, y: 1 })
		).toMatchObject({
			holdMilliseconds: 40,
		});
		expect(
			simulatorInputSchema.parse({
				kind: 'swipe',
				udid: UDID,
				fromX: 0,
				fromY: 1,
				toX: 1,
				toY: 0,
			})
		).toMatchObject({ durationMilliseconds: 250, steps: 16 });
		expect(
			simulatorInputSchema.parse({ kind: 'key', udid: UDID, usage: 0x28 })
		).toMatchObject({
			modifiers: [],
		});
		expect(
			simulatorInputSchema.parse({
				kind: 'text',
				udid: UDID,
				text: 'Hello 42!\n',
			}).kind
		).toBe('text');
		for (const bad of [
			{ kind: 'tap', udid: UDID, x: 1.01, y: 0 },
			{ kind: 'tap', udid: 'booted', x: 0.5, y: 0.5 },
			{ kind: 'tap', udid: UDID, x: 0.5, y: 0.5, button: 'home' },
			{ kind: 'text', udid: UDID, text: '' },
			{ kind: 'text', udid: UDID, text: 'héllo' },
			{ kind: 'text', udid: UDID, text: 'a'.repeat(2_049) },
			{ kind: 'key', udid: UDID, usage: 3 },
			{ kind: 'key', udid: UDID, usage: 0x04, modifiers: ['hyper'] },
			{ kind: 'button', udid: UDID, button: 'power' },
			{ kind: 'shake', udid: UDID },
		]) {
			expect(
				() => simulatorInputSchema.parse(bad),
				JSON.stringify(bad)
			).toThrow();
		}
	});
});

describe('simulatorKeyFromEvent', () => {
	it('maps browser key codes to HID usages with modifiers', () => {
		expect(simulatorKeyFromEvent({ code: 'KeyA' })).toEqual({
			usage: 0x04,
			modifiers: [],
		});
		expect(simulatorKeyFromEvent({ code: 'KeyZ', shiftKey: true })).toEqual({
			usage: 0x1d,
			modifiers: ['shift'],
		});
		expect(simulatorKeyFromEvent({ code: 'Digit1' })).toEqual({
			usage: 0x1e,
			modifiers: [],
		});
		expect(simulatorKeyFromEvent({ code: 'Digit0' })).toEqual({
			usage: 0x27,
			modifiers: [],
		});
		expect(simulatorKeyFromEvent({ code: 'Enter' })).toEqual({
			usage: 0x28,
			modifiers: [],
		});
		expect(simulatorKeyFromEvent({ code: 'Backspace', metaKey: true })).toEqual(
			{
				usage: 0x2a,
				modifiers: ['command'],
			}
		);
		expect(
			simulatorKeyFromEvent({ code: 'Period', ctrlKey: true, altKey: true })
		).toEqual({
			usage: 0x37,
			modifiers: ['control', 'option'],
		});
		expect(simulatorKeyFromEvent({ code: 'F5' })).toBeUndefined();
		expect(simulatorKeyFromEvent({ code: 'IntlBackslash' })).toBeUndefined();
	});
});

describe('simulatorInputResultSchema', () => {
	it('reports the transport when the host names one and tolerates older hosts', () => {
		const base = {
			udid: UDID,
			kind: 'tap',
			messages: 2,
			elapsedMilliseconds: 7,
		};
		expect(simulatorInputResultSchema.parse(base).transport).toBeUndefined();
		expect(
			simulatorInputResultSchema.parse({ ...base, transport: 'dtuhid' })
				.transport
		).toBe('dtuhid');
		expect(() =>
			simulatorInputResultSchema.parse({ ...base, transport: 'usb' })
		).toThrow();
	});
});
