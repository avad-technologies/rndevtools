export type DevtoolsAuthorization = Readonly<{
	enabled: boolean;
	ownerId: string | null;
}>;

type OwnerSource = Readonly<{
	getOwnerId: () => string | null;
	subscribe: (listener: () => void) => () => void;
}>;

type OwnerBoundary = {
	readonly source: OwnerSource;
	/** False when the source could not be subscribed to. */
	observable: boolean;
	cleanup: (() => void) | undefined;
};

/**
 * Names this module in its errors. A release bundle keeps string literals but
 * drops comments and import paths, so `rndevtools-verify-bundle` looks for
 * this one, and it stays in use so a minifier cannot drop it.
 */
const AUTHORIZATION_MODULE = '@rndevtools/react-native/authorization';

const DISABLED_AUTHORIZATION: DevtoolsAuthorization = Object.freeze({
	enabled: false,
	ownerId: null,
});

let snapshot = DISABLED_AUTHORIZATION;
const listeners = new Set<() => void>();
let ownerBoundary: OwnerBoundary | undefined;

function publish(next: DevtoolsAuthorization): void {
	if (snapshot.enabled === next.enabled && snapshot.ownerId === next.ownerId) {
		return;
	}
	snapshot = next;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// Authorization observers are diagnostics and cannot affect the app.
		}
	}
}

/** Whether a grant to `ownerId` belongs to the boundary's live owner. */
function isLiveOwner(boundary: OwnerBoundary, ownerId: string | null): boolean {
	// A source that cannot report owner changes could never revoke this grant.
	if (!boundary.observable) return false;
	try {
		const candidate = boundary.source.getOwnerId();
		return (typeof candidate === 'string' ? candidate : null) === ownerId;
	} catch {
		// A failed owner read is a revocation boundary.
		return false;
	}
}

function reconcileOwnerBoundary(boundary: OwnerBoundary): void {
	// A re-bind retires the previous source, so its late notifications are inert.
	if (ownerBoundary !== boundary || !snapshot.enabled) return;
	if (!isLiveOwner(boundary, snapshot.ownerId)) {
		publish(DISABLED_AUTHORIZATION);
	}
}

/**
 * Grants or revokes privileged tools. While an owner source is bound, a grant
 * only applies when `ownerId` is that source's live owner, so a grant computed
 * for a user who has since signed out is ignored rather than re-enabling tools
 * for whoever signed in next. A missing authorization revokes, then throws.
 */
export function setDevtoolsAuthorization(next: DevtoolsAuthorization): void {
	if (next == null) {
		// A grant that failed to compute must not leave an earlier one in force.
		publish(DISABLED_AUTHORIZATION);
		throw new TypeError(
			`${AUTHORIZATION_MODULE}: setDevtoolsAuthorization needs { enabled, ownerId }.`,
		);
	}
	const normalized: DevtoolsAuthorization = Object.freeze({
		enabled: Boolean(next.enabled),
		ownerId: typeof next.ownerId === 'string' ? next.ownerId : null,
	});
	const boundary = ownerBoundary;
	if (
		normalized.enabled &&
		boundary &&
		!isLiveOwner(boundary, normalized.ownerId)
	) {
		// Refusing a stale grant may only revoke, never keep a grant stale too.
		reconcileOwnerBoundary(boundary);
		return;
	}
	publish(normalized);
}

export function disableDevtoolsAuthorization(): void {
	publish(DISABLED_AUTHORIZATION);
}

export function getDevtoolsAuthorization(): DevtoolsAuthorization {
	return snapshot;
}

export function subscribeToDevtoolsAuthorization(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Binds the authorization mirror to its live authentication owner. A source
 * change can only revoke synchronously; React may explicitly re-grant the new
 * owner after recomputing all visibility policy. A source whose `subscribe`
 * throws revokes the mirror and keeps refusing grants until a working source
 * is bound, because nothing could revoke them when its owner changes.
 */
export function bindDevtoolsAuthorizationOwnerSource(
	source: OwnerSource,
): void {
	const previous = ownerBoundary;
	const boundary: OwnerBoundary = {
		source,
		observable: true,
		cleanup: undefined,
	};
	ownerBoundary = boundary;
	try {
		previous?.cleanup?.();
	} catch {
		// The retired source's listener is already inert.
	}
	try {
		const cleanup = source.subscribe(() => reconcileOwnerBoundary(boundary));
		boundary.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
	} catch {
		boundary.observable = false;
	}
	reconcileOwnerBoundary(boundary);
}
