import { describe, expect, it } from 'vitest';
import { ActionConfirmationStore } from './action-confirmation-store';

describe('action confirmation store', () => {
	it('binds one-use tokens to sender, scope, and exact normalized action', () => {
		let now = 100;
		const store = new ActionConfirmationStore({ now: () => now, ttlMs: 50 });
		const action = {
			actionId: 'erase',
			kind: 'device.erase',
			udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
		};
		const confirmation = store.issue('simulator', 7, action);
		expect(
			store.consume(
				'simulator',
				7,
				{ ...action, confirmationToken: confirmation.token },
				confirmation.token
			)
		).toBe(true);
		expect(store.consume('simulator', 7, action, confirmation.token)).toBe(
			false
		);

		const wrongAction = store.issue('simulator', 7, action);
		expect(
			store.consume(
				'simulator',
				7,
				{ ...action, kind: 'device.delete' },
				wrongAction.token
			)
		).toBe(false);

		const wrongSender = store.issue('simulator', 7, action);
		expect(store.consume('simulator', 8, action, wrongSender.token)).toBe(
			false
		);
		now = 200;
		const expired = store.issue('simulator', 7, action);
		now = 251;
		expect(store.consume('simulator', 7, action, expired.token)).toBe(false);
	});
});
