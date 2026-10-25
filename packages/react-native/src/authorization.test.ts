/**
 * The mirror is module state, so every test loads a fresh module through
 * Jest's registry; this package deliberately has no @types/node for `require`.
 */
declare const require: (id: string) => unknown;

type AuthorizationModule = typeof import('./authorization');
type DevtoolsAuthorization = ReturnType<
	AuthorizationModule['getDevtoolsAuthorization']
>;

let authorization: AuthorizationModule;

beforeEach(() => {
	jest.resetModules();
	authorization = require('./authorization') as AuthorizationModule;
});

function ownerSource(initialOwnerId: string | null) {
	let ownerId = initialOwnerId;
	const listeners = new Set<() => void>();
	return {
		source: {
			getOwnerId: () => ownerId,
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		changeOwner(next: string | null) {
			ownerId = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

describe('devtools authorization', () => {
	it('grants and revokes while no owner source is bound', () => {
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});
		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: true,
			ownerId: 'staff-1',
		});

		authorization.disableDevtoolsAuthorization();
		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: false,
			ownerId: null,
		});
	});

	it('revokes synchronously when the bound owner changes', () => {
		const owner = ownerSource('staff-1');
		const listener = jest.fn();
		authorization.subscribeToDevtoolsAuthorization(listener);
		authorization.bindDevtoolsAuthorizationOwnerSource(owner.source);
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		owner.changeOwner('customer-2');

		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: false,
			ownerId: null,
		});
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('ignores a late grant for an owner who has signed out', () => {
		const owner = ownerSource('staff-1');
		authorization.bindDevtoolsAuthorizationOwnerSource(owner.source);
		owner.changeOwner(null);
		owner.changeOwner('customer-2');

		// The host's asynchronous staff check for staff-1 resolves only now.
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: false,
			ownerId: null,
		});
	});

	it('keeps the live owner granted when a stale grant arrives', () => {
		const owner = ownerSource('staff-2');
		authorization.bindDevtoolsAuthorizationOwnerSource(owner.source);
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-2',
		});

		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: true,
			ownerId: 'staff-2',
		});
	});

	it('revokes before it rejects a missing authorization', () => {
		const listener = jest.fn();
		authorization.subscribeToDevtoolsAuthorization(listener);
		for (const missing of [undefined, null]) {
			authorization.setDevtoolsAuthorization({
				enabled: true,
				ownerId: 'staff-1',
			});

			expect(() =>
				authorization.setDevtoolsAuthorization(
					missing as unknown as DevtoolsAuthorization,
				),
			).toThrow(
				new TypeError(
					'@rndevtools/react-native/authorization: setDevtoolsAuthorization needs { enabled, ownerId }.',
				),
			);
			expect(authorization.getDevtoolsAuthorization()).toEqual({
				enabled: false,
				ownerId: null,
			});
		}
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it('revokes and refuses grants while the source cannot be subscribed to', () => {
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		authorization.bindDevtoolsAuthorizationOwnerSource({
			getOwnerId: () => 'staff-1',
			subscribe: () => {
				throw new Error('Auth events are unavailable.');
			},
		});
		expect(authorization.getDevtoolsAuthorization().enabled).toBe(false);
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});
		expect(authorization.getDevtoolsAuthorization().enabled).toBe(false);

		// Binding a source that works lets the host grant again.
		authorization.bindDevtoolsAuthorizationOwnerSource(
			ownerSource('staff-1').source,
		);
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});
		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: true,
			ownerId: 'staff-1',
		});
	});

	it('treats a failed owner read as a revocation, even for an anonymous grant', () => {
		let readFails = false;
		const listeners = new Set<() => void>();
		authorization.bindDevtoolsAuthorizationOwnerSource({
			getOwnerId: () => {
				if (readFails) throw new Error('Session store is locked.');
				return null;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		});
		authorization.setDevtoolsAuthorization({ enabled: true, ownerId: null });
		expect(authorization.getDevtoolsAuthorization().enabled).toBe(true);

		readFails = true;
		for (const listener of listeners) listener();
		expect(authorization.getDevtoolsAuthorization().enabled).toBe(false);

		authorization.setDevtoolsAuthorization({ enabled: true, ownerId: null });
		expect(authorization.getDevtoolsAuthorization().enabled).toBe(false);
	});

	it('keeps a grant when the source reports its owner while subscribing', () => {
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		authorization.bindDevtoolsAuthorizationOwnerSource({
			getOwnerId: () => 'staff-1',
			subscribe: (listener) => {
				listener();
				return () => undefined;
			},
		});

		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: true,
			ownerId: 'staff-1',
		});
	});

	it('ignores a retired source even when it cannot unsubscribe', () => {
		let retiredOwnerId = 'staff-1';
		const retiredListeners = new Set<() => void>();
		authorization.bindDevtoolsAuthorizationOwnerSource({
			getOwnerId: () => retiredOwnerId,
			subscribe: (listener) => {
				retiredListeners.add(listener);
				return () => {
					throw new Error('Cannot unsubscribe.');
				};
			},
		});
		authorization.bindDevtoolsAuthorizationOwnerSource(
			ownerSource('staff-1').source,
		);
		authorization.setDevtoolsAuthorization({
			enabled: true,
			ownerId: 'staff-1',
		});

		retiredOwnerId = 'customer-2';
		for (const listener of retiredListeners) listener();

		expect(authorization.getDevtoolsAuthorization()).toEqual({
			enabled: true,
			ownerId: 'staff-1',
		});
	});
});
