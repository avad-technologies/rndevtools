import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 60_000;
const MAX_CONFIRMATIONS = 256;

type ConfirmationRecord = {
	scope: string;
	senderId: number;
	fingerprint: string;
	expiresAt: number;
};

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== 'object') return value;
	const record = value as Record<string, unknown>;
	const output: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(record).sort()) {
		if (key !== 'confirmationToken') output[key] = canonicalValue(record[key]);
	}
	return output;
}

function actionFingerprint(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonicalValue(value)))
		.digest('hex');
}

export class ActionConfirmationStore {
	readonly #records = new Map<string, ConfirmationRecord>();
	readonly #now: () => number;
	readonly #ttlMs: number;

	constructor({
		now = Date.now,
		ttlMs = DEFAULT_TTL_MS,
	}: { now?: () => number; ttlMs?: number } = {}) {
		this.#now = now;
		this.#ttlMs =
			Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
	}

	issue(
		scope: string,
		senderId: number,
		action: unknown
	): { token: string; expiresAt: number } {
		this.#prune();
		while (this.#records.size >= MAX_CONFIRMATIONS) {
			const oldest = this.#records.keys().next().value as string | undefined;
			if (!oldest) break;
			this.#records.delete(oldest);
		}
		const token = `confirmation-${randomBytes(32).toString('hex')}`;
		const expiresAt = this.#now() + this.#ttlMs;
		this.#records.set(token, {
			scope,
			senderId,
			fingerprint: actionFingerprint(action),
			expiresAt,
		});
		return { token, expiresAt };
	}

	consume(
		scope: string,
		senderId: number,
		action: unknown,
		token: string | undefined
	): boolean {
		this.#prune();
		if (!token) return false;
		const record = this.#records.get(token);
		this.#records.delete(token);
		return Boolean(
			record &&
				record.scope === scope &&
				record.senderId === senderId &&
				record.expiresAt >= this.#now() &&
				record.fingerprint === actionFingerprint(action)
		);
	}

	revokeSender(senderId: number): void {
		for (const [token, record] of this.#records) {
			if (record.senderId === senderId) this.#records.delete(token);
		}
	}

	#prune(): void {
		const now = this.#now();
		for (const [token, record] of this.#records) {
			if (record.expiresAt < now) this.#records.delete(token);
		}
	}
}
