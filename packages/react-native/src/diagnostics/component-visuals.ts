import type {
	ComponentInspectorVisualController,
	ComponentInspectorVisualState,
	ComponentTargetSnapshot,
} from '@rndevtools/core/plugins';

export type ComponentVisualState = ComponentInspectorVisualState &
	Readonly<{
		candidates: readonly ComponentTargetSnapshot[];
		selectedInstanceId?: string;
	}>;

class ComponentVisualController implements ComponentInspectorVisualController {
	#snapshot: ComponentVisualState = {
		debugBorders: false,
		inspectMode: false,
		updateHighlights: false,
		candidates: [],
	};
	readonly #listeners = new Set<() => void>();

	readonly getSnapshot = (): ComponentVisualState => this.#snapshot;
	readonly getServerSnapshot = (): ComponentVisualState => this.#snapshot;
	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	setDebugBorders(enabled: boolean): void {
		this.#set({ ...this.#snapshot, debugBorders: enabled });
	}

	setInspectMode(enabled: boolean): void {
		this.#set({
			...this.#snapshot,
			inspectMode: enabled,
			candidates: [],
			selectedInstanceId: undefined,
		});
	}

	setUpdateHighlights(enabled: boolean): void {
		this.#set({ ...this.#snapshot, updateHighlights: enabled });
	}

	setCandidates(candidates: readonly ComponentTargetSnapshot[]): void {
		this.#set({
			...this.#snapshot,
			candidates: candidates.slice(0, 20),
			selectedInstanceId: undefined,
		});
	}

	select(instanceId: string): void {
		if (!this.#snapshot.candidates.some((target) => target.id === instanceId)) {
			return;
		}
		this.#set({
			...this.#snapshot,
			inspectMode: false,
			candidates: [],
			selectedInstanceId: instanceId,
			debugBorders: true,
		});
	}

	clearSelection(): void {
		this.#set({
			...this.#snapshot,
			candidates: [],
			selectedInstanceId: undefined,
		});
	}

	reset(): void {
		this.#set({
			debugBorders: false,
			inspectMode: false,
			updateHighlights: false,
			candidates: [],
		});
	}

	#set(snapshot: ComponentVisualState): void {
		this.#snapshot = snapshot;
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// Diagnostic overlays must not interrupt application rendering.
			}
		}
	}
}

export const componentVisuals = new ComponentVisualController();
