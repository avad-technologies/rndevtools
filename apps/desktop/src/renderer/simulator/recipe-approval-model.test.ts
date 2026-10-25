import { describe, expect, it, vi } from 'vitest';
import type { RecipeRun } from '../../shared/recipe-protocol';
import type { SlimmingSimulatorStatus } from '../../shared/slimming-protocol';
import {
	acknowledgeThenApproveRecipe,
	recipeSlimmingAcknowledgementBinding,
	unknownSlimmingStatusesForRun,
} from './recipe-approval-model';

const FIRST = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const SECOND = '11111111-2222-4333-8444-555555555555';

function unknownStatus(
	udid: string,
	key: string,
	acknowledged = false
): SlimmingSimulatorStatus {
	return {
		simulatorUdid: udid,
		condition: 'unknown',
		managedDisabledServiceIds: [],
		managedDisabledCount: 0,
		managedServiceCount: 10,
		matchingProfileIds: [],
		checkedAt: 1,
		checkpointAvailable: false,
		compatibility: {
			key,
			status: 'unknown',
			matrixVersion: 'matrix-1',
			tuple: {
				macOSBuild: '24A',
				xcodeBuild: '16A',
				coreSimulatorBuild: '1010.1',
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
				runtimeBuild: '22F76',
				hostArchitecture: 'arm64',
				helperVersion: '0.1.0',
				helperBuildCommit: '0123456789abcdef0123456789abcdef01234567',
				catalogVersion: 'catalog-1',
			},
			verifiedOperations: [],
			acknowledgementRequired: true,
			acknowledged,
		},
	};
}

describe('recipe first-use Slimming approval', () => {
	it('finds only exact selected unknown and unacknowledged targets', () => {
		const first = unknownStatus(FIRST, 'tuple-a');
		const second = unknownStatus(SECOND, 'tuple-b', true);
		expect(
			unknownSlimmingStatusesForRun(
				{ targetUdids: [FIRST, SECOND] },
				{ [FIRST]: first, [SECOND]: second }
			)
		).toEqual([first]);
	});

	it('binds typed UI state to the exact target and tuple set', () => {
		const first = unknownStatus(FIRST, 'tuple-a');
		const second = unknownStatus(SECOND, 'tuple-b');
		expect(recipeSlimmingAcknowledgementBinding([second, first])).toBe(
			recipeSlimmingAcknowledgementBinding([first, second])
		);
		expect(
			recipeSlimmingAcknowledgementBinding([
				unknownStatus(FIRST, 'tuple-a-updated'),
				second,
			])
		).not.toBe(recipeSlimmingAcknowledgementBinding([first, second]));
	});

	it('acknowledges current unknown targets once before approving the same run', async () => {
		const run = pendingRun();
		const order: string[] = [];
		const acknowledgeCompatibility = vi.fn(async () => {
			order.push('acknowledge');
			return { accepted: true };
		});
		const approveRun = vi.fn(async (received: RecipeRun) => {
			order.push('approve');
			expect(received).toBe(run);
			return { actionId: run.actionId, accepted: true, runId: run.id };
		});
		const receipt = await acknowledgeThenApproveRecipe({
			run,
			statusBySimulator: { [FIRST]: unknownStatus(FIRST, 'tuple-a') },
			typedAcknowledgement: 'EXPERIMENTAL',
			acknowledgeCompatibility,
			approveRun,
		});
		expect(receipt.accepted).toBe(true);
		expect(order).toEqual(['acknowledge', 'approve']);
		expect(acknowledgeCompatibility).toHaveBeenCalledOnce();
		expect(acknowledgeCompatibility).toHaveBeenCalledWith({
			simulatorUdids: [FIRST],
			acknowledgement: 'EXPERIMENTAL',
		});
	});

	it('blocks both calls when typing is not exact', async () => {
		const run = pendingRun();
		const acknowledgeCompatibility = vi.fn();
		const approveRun = vi.fn();
		const receipt = await acknowledgeThenApproveRecipe({
			run,
			statusBySimulator: { [FIRST]: unknownStatus(FIRST, 'tuple-a') },
			typedAcknowledgement: 'experimental',
			acknowledgeCompatibility,
			approveRun,
		});
		expect(receipt).toMatchObject({ accepted: false, actionId: run.actionId });
		expect(acknowledgeCompatibility).not.toHaveBeenCalled();
		expect(approveRun).not.toHaveBeenCalled();
	});
});

function pendingRun(): RecipeRun {
	return {
		id: 'recipe-run-12345678-1234-4123-8123-123456789abc',
		actionId: 'agent-action',
		recipeId: 'recipe-one',
		recipeRevision: 1,
		evidenceId: 'evidence-12345678-1234-4123-8123-123456789abc',
		status: 'needs-approval',
		createdAt: 100,
		progressSequence: 1,
		message: 'Approval required.',
		concurrency: 1,
		targetUdids: [FIRST],
		pendingRequest: {
			actionId: 'agent-action',
			recipeId: 'recipe-one',
			targetUdids: [FIRST],
			concurrency: 1,
		},
		targets: [
			{
				udid: FIRST,
				status: 'queued',
				completedSteps: 0,
				totalSteps: 1,
				message: 'Approval required.',
				cleanup: {
					status: 'not-started',
					completedSteps: 0,
					totalSteps: 0,
					failures: [],
				},
			},
		],
	};
}
