import type { SlimmingConfirmationTarget } from '../shared/slimming-protocol';

export type SlimmingConfirmationCopy = { detail: string; title: string };

function targetList(simulatorUdids: readonly string[]): string {
	return `Targets (${simulatorUdids.length}):\n${simulatorUdids.join('\n')}`;
}

/**
 * Which slimming operations still ask the operator before running.
 *
 * Applying, undoing, and restoring a profile no longer do: they are reversible
 * (`undo_last` and `restore_managed` exist, and SimSlim keeps checkpoints), the
 * slimming service now refuses to touch a Simulator another session holds, and
 * the first use of an untested runtime/profile combination is gated by its own
 * one-time acknowledgement. A person who clicks Apply has said what they want,
 * and an agent that asks over the socket is checked for ownership instead.
 * What remains here is the one slimming change that is a mode switch, not a
 * mutation: turning slimming off while restoring every managed service. And
 * the one that cannot be taken back: forgetting an interrupted mutation's
 * emergency restore point, after which nothing can undo that mutation.
 */
export function slimmingConfirmationCopy(
	target: SlimmingConfirmationTarget
): SlimmingConfirmationCopy | undefined {
	if (
		'enabled' in target &&
		!target.enabled &&
		target.disposition === 'restore-and-verify'
	) {
		return {
			title: 'Restore managed services and disable slimming?',
			detail: `Operation: Restore all rndevtools-managed services, verify, then disable experimental slimming\n${targetList(target.simulatorUdids)}\n\nRN Devtools will process every exact target sequentially before disabling mutation controls.`,
		};
	}
	if ('kind' in target && target.kind === 'pending.forget') {
		return {
			title: 'Forget the emergency restore point?',
			detail: `Operation: Forget the emergency restore point an interrupted SimSlim mutation left behind\n${targetList(target.simulatorUdids)}\n\nAfterwards nothing can undo that mutation, and RN Devtools stops trying to reconcile it. Each Simulator keeps whatever managed overrides it has now; restore its services to return it to a known state. Do this only when Undo can no longer succeed, for example after an Xcode, runtime, or helper update.`,
		};
	}
	return undefined;
}
