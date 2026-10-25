import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';

/**
 * Native Simulator input: taps, swipes, typed text, keys, and hardware buttons
 * delivered through the signed native host over SimulatorKit's HID transport,
 * the same path Simulator.app uses for the mouse and keyboard. Nothing here
 * needs the development app to be connected, so an agent can drive the login
 * screen, a system alert, or Springboard itself.
 *
 * Coordinates are ratios of the device screen (0…1 from the top-left), so a
 * click on any size of screenshot or live frame converts without knowing the
 * device's point or pixel geometry.
 */

const udidSchema = z.string().regex(UDID_PATTERN);
const ratioSchema = z.number().finite().min(0).max(1);

const SIMULATOR_INPUT_MAX_TEXT = 2_048;

const simulatorHardwareButtonSchema = z.enum([
	'home',
	'lock',
	'siri',
	'volume-up',
	'volume-down',
	'apple-pay',
]);
export type SimulatorHardwareButton = z.infer<
	typeof simulatorHardwareButtonSchema
>;

export const simulatorKeyModifierSchema = z.enum([
	'shift',
	'control',
	'option',
	'command',
]);

/**
 * Printable ASCII plus newline and tab. The Simulator keyboard has a key for
 * each of these; anything else would need the pasteboard, which iOS 16+ gates
 * behind an "Allow Paste" prompt that blocks unattended use.
 */
const typeableTextSchema = z
	.string()
	.min(1)
	.max(SIMULATOR_INPUT_MAX_TEXT)
	.regex(
		/^[\x20-\x7E\n\t]+$/,
		'Only printable ASCII, newline, and tab can be typed.'
	);

export const simulatorInputSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('tap'),
		udid: udidSchema,
		x: ratioSchema,
		y: ratioSchema,
		/** Contact time; a long press is a tap held for 500+ ms. */
		holdMilliseconds: z.number().int().min(0).max(10_000).default(40),
	}),
	z.strictObject({
		kind: z.literal('swipe'),
		udid: udidSchema,
		fromX: ratioSchema,
		fromY: ratioSchema,
		toX: ratioSchema,
		toY: ratioSchema,
		durationMilliseconds: z.number().int().min(1).max(10_000).default(250),
		steps: z.number().int().min(2).max(120).default(16),
	}),
	z.strictObject({
		kind: z.literal('text'),
		udid: udidSchema,
		text: typeableTextSchema,
	}),
	z.strictObject({
		kind: z.literal('key'),
		udid: udidSchema,
		/** USB HID keyboard usage (page 0x07): 0x28 Return, 0x2A Delete, 0x29 Escape. */
		usage: z.number().int().min(0x04).max(0xe7),
		modifiers: z.array(simulatorKeyModifierSchema).max(4).default([]),
	}),
	z.strictObject({
		kind: z.literal('button'),
		udid: udidSchema,
		button: simulatorHardwareButtonSchema,
	}),
]);
export type SimulatorInput = z.infer<typeof simulatorInputSchema>;

export const simulatorInputResultSchema = z.strictObject({
	udid: udidSchema,
	kind: z.enum(['tap', 'swipe', 'text', 'key', 'button']),
	/** HID messages delivered and acknowledged by the Simulator. */
	messages: z.number().int().nonnegative(),
	elapsedMilliseconds: z.number().int().nonnegative(),
	/**
	 * Which HID path carried the events. `indigo` is SimulatorKit's legacy client (through
	 * CoreSimulator 1051 / Xcode 26); `dtuhid` is the XPC daemon Xcode 27 introduced. Optional
	 * so a host built before this field still validates.
	 */
	transport: z.enum(['indigo', 'dtuhid']).optional(),
});
export type SimulatorInputResult = z.infer<typeof simulatorInputResultSchema>;

export type SimulatorInputBridge = {
	sendSimulatorInput: (input: SimulatorInput) => Promise<SimulatorInputResult>;
};

/** Named keys an operator or agent can press without knowing HID usages. */
const SIMULATOR_NAMED_KEYS: Readonly<Record<string, number>> = {
	Enter: 0x28,
	Return: 0x28,
	Escape: 0x29,
	Backspace: 0x2a,
	Delete: 0x2a,
	Tab: 0x2b,
	Space: 0x2c,
	ArrowRight: 0x4f,
	ArrowLeft: 0x50,
	ArrowDown: 0x51,
	ArrowUp: 0x52,
	Home: 0x4a,
	End: 0x4d,
	PageUp: 0x4b,
	PageDown: 0x4e,
};

/**
 * Translates a browser `KeyboardEvent` (code + modifier flags) into the HID
 * usage and modifiers the host needs. Letters, digits, and the US punctuation
 * keys map by `code`; a named key maps through `SIMULATOR_NAMED_KEYS`. Returns
 * undefined for keys the Simulator keyboard cannot represent.
 */
export function simulatorKeyFromEvent(event: {
	code: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
}):
	| { usage: number; modifiers: z.infer<typeof simulatorKeyModifierSchema>[] }
	| undefined {
	const modifiers: z.infer<typeof simulatorKeyModifierSchema>[] = [];
	if (event.shiftKey) modifiers.push('shift');
	if (event.ctrlKey) modifiers.push('control');
	if (event.altKey) modifiers.push('option');
	if (event.metaKey) modifiers.push('command');
	const named = SIMULATOR_NAMED_KEYS[event.code];
	if (named !== undefined) return { usage: named, modifiers };
	const letter = /^Key([A-Z])$/.exec(event.code);
	if (letter?.[1]) {
		return {
			usage: 0x04 + (letter[1].charCodeAt(0) - 'A'.charCodeAt(0)),
			modifiers,
		};
	}
	const digit = /^Digit([0-9])$/.exec(event.code);
	if (digit?.[1]) {
		const value = Number(digit[1]);
		return { usage: value === 0 ? 0x27 : 0x1d + value, modifiers };
	}
	const punctuation: Readonly<Record<string, number>> = {
		Minus: 0x2d,
		Equal: 0x2e,
		BracketLeft: 0x2f,
		BracketRight: 0x30,
		Backslash: 0x31,
		Semicolon: 0x33,
		Quote: 0x34,
		Backquote: 0x35,
		Comma: 0x36,
		Period: 0x37,
		Slash: 0x38,
	};
	const usage = punctuation[event.code];
	return usage === undefined ? undefined : { usage, modifiers };
}
