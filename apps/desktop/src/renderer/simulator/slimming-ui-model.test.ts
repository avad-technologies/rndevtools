import { describe, expect, it } from 'vitest';
import type { SlimmingSimulatorStatus } from '../../shared/slimming-protocol';
import {
	allSelectedCheckpointsAvailable,
	allSelectedNeedAttention,
	isExactExperimentalAcknowledgement,
	managedOverrideUdids,
	restoreAndDisableInput,
	unknownCompatibilityBinding,
} from './slimming-ui-model';

const FIRST_UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const SECOND_UDID = '11111111-2222-4333-8444-555555555555';

function status(
	udid: string,
	overrides: Partial<SlimmingSimulatorStatus> = {}
): SlimmingSimulatorStatus {
	return {
		simulatorUdid: udid,
		condition: 'managed-clean',
		managedDisabledServiceIds: [],
		managedDisabledCount: 0,
		managedServiceCount: 12,
		matchingProfileIds: [],
		checkedAt: 1,
		checkpointAvailable: false,
		...overrides,
	};
}

function unknownStatus(udid: string, key: string): SlimmingSimulatorStatus {
	return status(udid, {
		compatibility: {
			key,
			status: 'unknown',
			matrixVersion: 'matrix-1',
			tuple: {
				macOSBuild: '24A',
				xcodeBuild: '16A',
				coreSimulatorBuild: '1010.1',
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
				runtimeBuild: '22A3354',
				hostArchitecture: 'arm64',
				helperVersion: '0.1.0',
				helperBuildCommit: '0123456789abcdef0123456789abcdef01234567',
				catalogVersion: 'catalog-1',
			},
			verifiedOperations: [],
			acknowledgementRequired: true,
			acknowledged: false,
		},
	});
}

describe('Slimming renderer safety model', () => {
	it('finds every known or potentially active managed override target', () => {
		expect(
			managedOverrideUdids({
				[FIRST_UDID]: status(FIRST_UDID, { managedDisabledCount: 2 }),
				[SECOND_UDID]: status(SECOND_UDID, {
					condition: 'needs-attention',
					checkpointAvailable: true,
				}),
				'99999999-2222-4333-8444-555555555555': status(
					'99999999-2222-4333-8444-555555555555'
				),
			})
		).toEqual([SECOND_UDID, FIRST_UDID]);
	});

	it('enables batch undo only when every selected target has a recovery checkpoint', () => {
		const available = status(FIRST_UDID, { checkpointAvailable: true });
		const missing = status(SECOND_UDID, { checkpointAvailable: false });
		expect(
			allSelectedCheckpointsAvailable([FIRST_UDID], {
				[FIRST_UDID]: available,
			})
		).toBe(true);
		expect(
			allSelectedCheckpointsAvailable([FIRST_UDID, SECOND_UDID], {
				[FIRST_UDID]: available,
				[SECOND_UDID]: missing,
			})
		).toBe(false);
		expect(allSelectedCheckpointsAvailable([], {})).toBe(false);
	});

	it('offers forgetting a restore point only when every selected target needs attention', () => {
		const stuck = status(FIRST_UDID, {
			condition: 'needs-attention',
			checkpointAvailable: true,
		});
		expect(
			allSelectedNeedAttention([FIRST_UDID], { [FIRST_UDID]: stuck })
		).toBe(true);
		expect(
			allSelectedNeedAttention([FIRST_UDID, SECOND_UDID], {
				[FIRST_UDID]: stuck,
				[SECOND_UDID]: status(SECOND_UDID, { checkpointAvailable: true }),
			})
		).toBe(false);
		expect(
			allSelectedNeedAttention([FIRST_UDID], {
				[FIRST_UDID]: status(FIRST_UDID, { condition: 'needs-attention' }),
			})
		).toBe(false);
		expect(allSelectedNeedAttention([], {})).toBe(false);
	});

	it('binds acknowledgement to the exact sorted set of current unknown tuples', () => {
		const first = unknownStatus(FIRST_UDID, 'tuple-a');
		const second = unknownStatus(SECOND_UDID, 'tuple-b');
		const binding = unknownCompatibilityBinding([second, first, first]);
		expect(binding).toBe('["tuple-a","tuple-b"]');
		expect(unknownCompatibilityBinding([first, second])).toBe(binding);
		expect(unknownCompatibilityBinding([])).toBeNull();
	});

	it('accepts only the exact, case-sensitive acknowledgement text', () => {
		expect(isExactExperimentalAcknowledgement('EXPERIMENTAL')).toBe(true);
		expect(isExactExperimentalAcknowledgement('experimental')).toBe(false);
		expect(isExactExperimentalAcknowledgement('EXPERIMENTAL ')).toBe(false);
	});

	it('validates exact text but never treats renderer input as mutation authority', () => {
		const binding = '["tuple-a"]';
		expect(
			restoreAndDisableInput([FIRST_UDID], binding, 'experimental')
		).toBeNull();
		expect(
			restoreAndDisableInput([FIRST_UDID], binding, 'EXPERIMENTAL')
		).toEqual({
			enabled: false,
			disposition: 'restore-and-verify',
			simulatorUdids: [FIRST_UDID],
			confirmation: 'RESTORE_ALL_MANAGED_SERVICES',
		});
		expect(restoreAndDisableInput([], null, '')).toBeNull();
		expect(
			restoreAndDisableInput(
				Array.from({ length: 21 }, () => FIRST_UDID),
				null,
				''
			)
		).toBeNull();
	});
});
