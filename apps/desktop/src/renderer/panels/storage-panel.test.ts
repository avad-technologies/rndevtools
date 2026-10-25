import { describe, expect, it } from 'vitest';
import { storageWriteBlockReason } from './storage-panel';

describe('storageWriteBlockReason', () => {
	it('surfaces the capability reason first when one exists', () => {
		expect(
			storageWriteBlockReason(true, 'The selected device is offline.')
		).toBe('The selected device is offline.');
		// A capability block wins even when the draft is unchanged.
		expect(
			storageWriteBlockReason(false, 'The selected device is offline.')
		).toBe('The selected device is offline.');
	});

	it('explains that an unchanged value cannot be saved', () => {
		expect(storageWriteBlockReason(false, null)).toBe(
			'Edit the value to enable saving.'
		);
	});

	it('allows saving a dirty, capability-permitted value', () => {
		expect(storageWriteBlockReason(true, null)).toBeNull();
	});
});
