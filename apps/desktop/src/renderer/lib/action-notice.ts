import type { SimulatorToolId } from '@/simulator/simulator-config';

/** The latest action of a renderer runtime, in the shape every runtime uses. */
export type ActionStatus =
	| { kind: 'idle'; message: '' }
	| { kind: 'pending'; message: string }
	| { kind: 'success'; message: string }
	| { kind: 'error'; message: string };

export type ActionNoticeSource = {
	status: ActionStatus;
	clear: () => void;
};

/** A runtime's notice that is on screen: never an idle one. */
type ActiveActionNotice = {
	status: Exclude<ActionStatus, { kind: 'idle' }>;
	clear: () => void;
};

/** Renderer runtimes whose action status reaches the global ActionNotice. */
export type ActionNoticeRuntime =
	| 'desktop'
	| 'simulator'
	| 'recipe'
	| 'slimming'
	| 'lanes'
	| 'supabase';

/** A success notice clears itself this long after it appears. */
export const ACTION_SUCCESS_CLEAR_MS = 3_500;

const CONNECTED_NOTICES: readonly ActionNoticeRuntime[] = ['desktop'];
const SIMULATOR_NOTICES: readonly ActionNoticeRuntime[] = ['simulator'];

/**
 * Simulator tools whose panels act through runtimes other than the Simulator
 * runtime; any other tool shows the Simulator runtime's notices. A new runtime
 * joins ActionNoticeRuntime (app.tsx must then supply its source) and is
 * listed here for the tools that use it.
 */
const SIMULATOR_TOOL_NOTICES: Partial<
	Record<SimulatorToolId, readonly ActionNoticeRuntime[]>
> = {
	automation: ['recipe'],
	slimming: ['slimming'],
	// Track repository… runs through the lane runtime.
	supabase: ['supabase', 'lanes'],
	// A lane can start, stop or restart its Supabase stack.
	lanes: ['lanes', 'supabase'],
	// The fleet detail pane launches and stops lanes and their stacks, too.
	fleet: ['simulator', 'lanes', 'supabase'],
};

/** The runtimes whose notices the active workspace and tool show. */
export function actionNoticeRuntimes(
	workspace: 'simulator' | 'connected',
	simulatorTool: SimulatorToolId
): readonly ActionNoticeRuntime[] {
	if (workspace === 'connected') return CONNECTED_NOTICES;
	return SIMULATOR_TOOL_NOTICES[simulatorTool] ?? SIMULATOR_NOTICES;
}

/**
 * Numbers status objects in the order they are first seen. Runtimes replace
 * their status object on every change, so a higher number is a newer status.
 */
export function createActionStatusOrder(): (status: ActionStatus) => number {
	const seen = new WeakMap<ActionStatus, number>();
	let next = 0;
	return (status) => {
		const known = seen.get(status);
		if (known !== undefined) return known;
		const order = next;
		next += 1;
		seen.set(status, order);
		return order;
	};
}

/**
 * Picks the notice to show: the newest non-idle status among `runtimes`, so an
 * action is never hidden behind an older notice from another runtime. Every
 * source is numbered first, so 'newest' still holds after a tool switch.
 */
export function selectActionNotice(
	sources: Readonly<Record<ActionNoticeRuntime, ActionNoticeSource>>,
	runtimes: readonly ActionNoticeRuntime[],
	order: (status: ActionStatus) => number
): ActiveActionNotice | undefined {
	for (const source of Object.values(sources)) order(source.status);
	let newest: ActiveActionNotice | undefined;
	for (const runtime of runtimes) {
		const { status, clear } = sources[runtime];
		if (status.kind === 'idle') continue;
		if (!newest || order(status) > order(newest.status)) {
			newest = { status, clear };
		}
	}
	return newest;
}

/**
 * Clears each runtime's success notice ACTION_SUCCESS_CLEAR_MS after it
 * appears, whether or not it is on screen. A timer belongs to one status
 * object, so neither re-renders nor a runtime that hands out a new clear
 * function on every render restart it; a newer status cancels it.
 */
export function createSuccessNoticeTimers(): {
	sync: (
		sources: Readonly<Record<ActionNoticeRuntime, ActionNoticeSource>>
	) => void;
	dispose: () => void;
} {
	const timers = new Map<
		ActionNoticeRuntime,
		{ status: ActionStatus; handle: ReturnType<typeof setTimeout> }
	>();
	const clears = new Map<ActionNoticeRuntime, () => void>();
	return {
		sync(sources) {
			for (const [runtime, source] of Object.entries(sources) as Array<
				[ActionNoticeRuntime, ActionNoticeSource]
			>) {
				clears.set(runtime, source.clear);
				const timer = timers.get(runtime);
				// A fired timer stays recorded, so a status is cleared at most once.
				if (timer?.status === source.status) continue;
				if (timer) clearTimeout(timer.handle);
				timers.delete(runtime);
				if (source.status.kind !== 'success') continue;
				timers.set(runtime, {
					status: source.status,
					handle: setTimeout(
						() => clears.get(runtime)?.(),
						ACTION_SUCCESS_CLEAR_MS
					),
				});
			}
		},
		dispose() {
			for (const timer of timers.values()) clearTimeout(timer.handle);
			timers.clear();
		},
	};
}
