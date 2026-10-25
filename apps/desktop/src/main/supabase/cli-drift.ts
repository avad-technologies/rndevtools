import type { SupabaseCliResolution } from './cli-resolver';

/**
 * Owner binary drift (DESIGN: CLI upgrade and owner binary drift). A stack's
 * owner keeps running the binary that started it, while `pnpm install` may
 * replace or remove that binary under it; lazy wakes then spawn launchers
 * from a missing or different binary. Each cheap tick compares the owner's
 * argv[0] (trusted only after the resolver validates it) with the
 * worktree's own resolved CLI:
 * - a verified worktree CLI of another version, or an owner binary that no
 *   longer validates, restarts the stack with the worktree's binary after a
 *   30 s debounce (stop works across releases, data is kept);
 * - an unverified worktree CLI leaves the worktree observed, so nothing is
 *   restarted and the stack is only flagged;
 * - a release mismatch the owner reports is shown as CLI mismatch, where
 *   stop, destroy and log history still work.
 * Pure: the service runs the restart.
 */

/** A version change must hold this long before the stack is restarted. */
export const SUPABASE_DRIFT_DEBOUNCE_MS = 30_000;

/** What the service knows about one running managed stack's binaries. */
export type SupabaseDriftStack = Readonly<{
	stackId: string;
	/** The validated binary the desktop last started it with. */
	recordedBinary?: string | undefined;
	recordedVersion?: string | undefined;
	/** argv[0] of the owner process, unvalidated. */
	ownerExecutable?: string | undefined;
	/** The resolver's verdict on ownerExecutable, when it was checked. */
	ownerValidation?: SupabaseCliResolution | undefined;
	/** The worktree's own CLI. */
	worktreeCli?: SupabaseCliResolution | undefined;
	/** A desktop job is running on it. */
	inFlight: boolean;
}>;

export type SupabaseDriftPlan = Readonly<{
	/** Restart these now, with the worktree's binary. */
	restart: readonly Readonly<{ stackId: string; signature: string }>[];
	/** The owner's binary changed or vanished since it started. */
	changed: ReadonlySet<string>;
	/** Drift seen but still inside its debounce, with when it was first seen. */
	pending: ReadonlyMap<string, Readonly<{ signature: string; since: number }>>;
	nextDueAt?: number;
}>;

export function planSupabaseDrift(
	input: Readonly<{
		stacks: readonly SupabaseDriftStack[];
		previous: ReadonlyMap<
			string,
			Readonly<{ signature: string; since: number }>
		>;
		/** Drift already restarted once, by signature: never retried. */
		attempted?: ReadonlyMap<string, string>;
		now: number;
	}>
): SupabaseDriftPlan {
	const restart: { stackId: string; signature: string }[] = [];
	const changed = new Set<string>();
	const pending = new Map<string, { signature: string; since: number }>();
	let nextDueAt: number | undefined;
	for (const stack of input.stacks) {
		const owner = stack.ownerExecutable;
		const ownerValid = stack.ownerValidation?.ok === true;
		const ownerVersion = stack.ownerValidation?.ok
			? stack.ownerValidation.cli.version
			: undefined;
		const binaryChanged =
			owner !== undefined &&
			((stack.recordedBinary !== undefined && owner !== stack.recordedBinary) ||
				(stack.ownerValidation !== undefined && !ownerValid));
		if (binaryChanged) changed.add(stack.stackId);
		const worktree = stack.worktreeCli;
		if (!worktree?.ok || !worktree.cli.dialect.manageable) continue;
		const target = worktree.cli.version;
		const running = ownerVersion ?? stack.recordedVersion;
		const drifted =
			(stack.ownerValidation !== undefined && !ownerValid) ||
			(running !== undefined && running !== target);
		if (!drifted) continue;
		const signature = `${running ?? 'missing'}->${target}`;
		// A restart that did not take is not repeated for the same drift.
		if (input.attempted?.get(stack.stackId) === signature) continue;
		const known = input.previous.get(stack.stackId);
		const since = known?.signature === signature ? known.since : input.now;
		pending.set(stack.stackId, { signature, since });
		const dueAt = since + SUPABASE_DRIFT_DEBOUNCE_MS;
		if (dueAt <= input.now && !stack.inFlight) {
			restart.push({ stackId: stack.stackId, signature });
			pending.delete(stack.stackId);
		} else {
			nextDueAt = Math.min(nextDueAt ?? dueAt, dueAt);
		}
	}
	return {
		restart,
		changed,
		pending,
		...(nextDueAt === undefined ? {} : { nextDueAt }),
	};
}
