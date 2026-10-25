type Listener = () => void;

export type BoundedEventStoreOptions<T> = {
	maxEvents: number;
	maxBytes: number;
	estimateBytes: (event: T) => number;
};

export class BoundedEventStore<T> {
	readonly #listeners = new Set<Listener>();
	readonly #maxEvents: number;
	readonly #maxBytes: number;
	readonly #estimateBytes: (event: T) => number;
	#events: readonly T[] = [];
	#sizes: readonly number[] = [];
	#bytes = 0;

	constructor(options: BoundedEventStoreOptions<T>) {
		if (!Number.isInteger(options.maxEvents) || options.maxEvents <= 0) {
			throw new Error('maxEvents must be a positive integer');
		}
		if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
			throw new Error('maxBytes must be a positive finite number');
		}
		this.#maxEvents = options.maxEvents;
		this.#maxBytes = options.maxBytes;
		this.#estimateBytes = options.estimateBytes;
	}

	append(event: T): void {
		const eventBytes = this.#eventBytes(event);
		if (eventBytes > this.#maxBytes) {
			return;
		}

		const events = [...this.#events, event];
		const sizes = [...this.#sizes, eventBytes];
		let bytes = this.#bytes + eventBytes;

		while (
			events.length > this.#maxEvents ||
			(bytes > this.#maxBytes && events.length > 0)
		) {
			events.shift();
			bytes -= sizes.shift() ?? 0;
		}

		this.#events = events;
		this.#sizes = sizes;
		this.#bytes = bytes;
		this.#emit();
	}

	replace(predicate: (event: T) => boolean, event: T): boolean {
		const index = this.#events.findIndex(predicate);
		if (index < 0) return false;
		const eventBytes = this.#eventBytes(event);
		const events = [...this.#events];
		const sizes = [...this.#sizes];
		if (eventBytes > this.#maxBytes) {
			events.splice(index, 1);
			sizes.splice(index, 1);
		} else {
			events[index] = event;
			sizes[index] = eventBytes;
		}
		let bytes = sizes.reduce((sum, size) => sum + size, 0);
		while (bytes > this.#maxBytes && events.length > 0) {
			events.shift();
			bytes -= sizes.shift() ?? 0;
		}
		this.#events = events;
		this.#sizes = sizes;
		this.#bytes = bytes;
		this.#emit();
		return true;
	}

	upsert(predicate: (event: T) => boolean, event: T): void {
		if (!this.replace(predicate, event)) this.append(event);
	}

	clear = (): void => {
		if (this.#events.length === 0) return;
		this.#events = [];
		this.#sizes = [];
		this.#bytes = 0;
		this.#emit();
	};

	getSnapshot = (): readonly T[] => this.#events;

	getServerSnapshot = (): readonly T[] => this.#events;

	getEstimatedBytes = (): number => this.#bytes;

	subscribe = (listener: Listener): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#emit(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A diagnostics observer must never interrupt the instrumented app.
			}
		}
	}

	#eventBytes(event: T): number {
		try {
			const estimate = this.#estimateBytes(event);
			if (!Number.isFinite(estimate)) return this.#maxBytes + 1;
			return Math.max(0, Math.ceil(estimate));
		} catch {
			return this.#maxBytes + 1;
		}
	}
}

export class ExternalStore<T> {
	readonly #listeners = new Set<Listener>();
	#snapshot: T;

	constructor(initialSnapshot: T) {
		this.#snapshot = initialSnapshot;
	}

	set(snapshot: T): void {
		this.#snapshot = snapshot;
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A diagnostics observer must never interrupt the instrumented app.
			}
		}
	}

	getSnapshot = (): T => this.#snapshot;

	getServerSnapshot = (): T => this.#snapshot;

	subscribe = (listener: Listener): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
}
