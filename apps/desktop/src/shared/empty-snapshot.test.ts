import { createEmptyDesktopToolsSnapshot } from '@rndevtools/core/desktop-protocol';
import { describe, expect, it } from 'vitest';
import { deviceSnapshotMessageSchema } from './protocol';

// The core package hands hosts a baseline snapshot to spread over. It is only
// useful if the desktop actually accepts it, and the two live in different
// packages, so this asserts the contract across that seam.
describe('empty tools snapshot', () => {
	it('satisfies the desktop snapshot schema', () => {
		const result = deviceSnapshotMessageSchema.safeParse({
			type: 'snapshot',
			sequence: 0,
			sentAt: Date.now(),
			tools: createEmptyDesktopToolsSnapshot(),
		});

		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});
});
