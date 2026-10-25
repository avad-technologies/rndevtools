import type { RecipeRun, RecipeRunReceipt } from '../../shared/recipe-protocol';
import {
	SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	type SlimmingSimulatorStatus,
} from '../../shared/slimming-protocol';

export function unknownSlimmingStatusesForRun(
	run: Pick<RecipeRun, 'targetUdids'>,
	statusBySimulator: Readonly<
		Record<string, SlimmingSimulatorStatus | undefined>
	>
): SlimmingSimulatorStatus[] {
	const seen = new Set<string>();
	return run.targetUdids.flatMap((udid) => {
		if (seen.has(udid)) return [];
		seen.add(udid);
		const status = statusBySimulator[udid];
		const compatibility = status?.compatibility;
		return status?.simulatorUdid === udid &&
			compatibility?.status === 'unknown' &&
			compatibility.acknowledgementRequired &&
			!compatibility.acknowledged
			? [status]
			: [];
	});
}

export function recipeSlimmingAcknowledgementBinding(
	statuses: readonly SlimmingSimulatorStatus[]
): string {
	return JSON.stringify(
		statuses
			.map((status): [string, string] => [
				status.simulatorUdid,
				status.compatibility?.key ?? '',
			])
			.sort(([left], [right]) => left.localeCompare(right))
	);
}

export async function acknowledgeThenApproveRecipe(input: {
	run: RecipeRun;
	statusBySimulator: Readonly<
		Record<string, SlimmingSimulatorStatus | undefined>
	>;
	typedAcknowledgement?: string;
	acknowledgeCompatibility: (input: {
		simulatorUdids: string[];
		acknowledgement: string;
	}) => Promise<{ accepted: boolean; error?: string }>;
	approveRun: (run: RecipeRun) => Promise<RecipeRunReceipt>;
}): Promise<RecipeRunReceipt> {
	const unknownStatuses = unknownSlimmingStatusesForRun(
		input.run,
		input.statusBySimulator
	);
	if (unknownStatuses.length > 0) {
		if (input.typedAcknowledgement !== SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT) {
			return {
				actionId: input.run.actionId,
				accepted: false,
				error:
					'Type EXPERIMENTAL exactly before approving a recipe against an unknown compatibility tuple.',
			};
		}
		const acknowledgement = await input.acknowledgeCompatibility({
			simulatorUdids: unknownStatuses.map((status) => status.simulatorUdid),
			acknowledgement: SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
		});
		if (!acknowledgement.accepted) {
			return {
				actionId: input.run.actionId,
				accepted: false,
				error:
					acknowledgement.error ??
					'Compatibility acknowledgement was rejected.',
			};
		}
	}
	return input.approveRun(input.run);
}
