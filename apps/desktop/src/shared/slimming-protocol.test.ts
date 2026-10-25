import { describe, expect, it } from 'vitest';
import {
	SLIMMING_CONFIRMATIONS,
	slimmingAcknowledgementRequestSchema,
	slimmingActionSchema,
	slimmingSettingRequestSchema,
	slimmingStateSchema,
} from './slimming-protocol';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('slimming protocol', () => {
	it('requires exact mutation confirmation and rejects inline acknowledgement authority', () => {
		expect(() =>
			slimmingActionSchema.parse({
				actionId: 'apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: 'ui-automation',
				confirmation: SLIMMING_CONFIRMATIONS.apply,
				acknowledgement: 'yes',
			})
		).toThrow();
		expect(() =>
			slimmingActionSchema.parse({
				actionId: 'apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: 'ui-automation',
				confirmation: SLIMMING_CONFIRMATIONS.apply,
				acknowledgement: 'EXPERIMENTAL',
			})
		).toThrow();
		expect(
			slimmingActionSchema.parse({
				actionId: 'verified-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: 'rndevtools-ui-automation',
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		).not.toHaveProperty('acknowledgement');
	});

	it('requires an explicit disable disposition and exact targets for restore-all', () => {
		expect(() =>
			slimmingSettingRequestSchema.parse({
				actionId: 'disable',
				enabled: false,
			})
		).toThrow();
		expect(
			slimmingSettingRequestSchema.parse({
				actionId: 'leave',
				enabled: false,
				disposition: 'leave-overrides-in-place',
			})
		).toMatchObject({ disposition: 'leave-overrides-in-place' });
		expect(() =>
			slimmingSettingRequestSchema.parse({
				actionId: 'restore',
				enabled: false,
				disposition: 'restore-and-verify',
				simulatorUdids: [],
				confirmation: SLIMMING_CONFIRMATIONS.restore,
			})
		).toThrow();
	});

	it('lets only the operator forget an emergency restore point, with its own exact confirmation', () => {
		const forget = {
			actionId: 'forget',
			kind: 'pending.forget',
			simulatorUdids: [UDID],
			confirmation: SLIMMING_CONFIRMATIONS.forget,
		};
		expect(slimmingActionSchema.parse(forget)).toEqual(forget);
		expect(() =>
			slimmingActionSchema.parse({
				...forget,
				confirmation: SLIMMING_CONFIRMATIONS.undo,
			})
		).toThrow();
		// No agent request can express it.
		expect(() =>
			slimmingActionSchema.parse({
				...forget,
				requester: { kind: 'codex', sessionId: 'thread-1' },
			})
		).toThrow();
	});

	it('bounds sequential batches and rejects duplicate simulator identifiers', () => {
		expect(() =>
			slimmingActionSchema.parse({
				actionId: 'verify',
				kind: 'profile.verify',
				profileId: 'ui-automation',
				simulatorUdids: [UDID, UDID.toLowerCase()],
			})
		).toThrow('unique');
	});

	it('keeps tuple acknowledgement separate from mutation and recipe payloads', () => {
		expect(
			slimmingAcknowledgementRequestSchema.parse({
				actionId: 'ack-current-tuples',
				simulatorUdids: [UDID],
				acknowledgement: 'EXPERIMENTAL',
			})
		).toEqual({
			actionId: 'ack-current-tuples',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		expect(() =>
			slimmingAcknowledgementRequestSchema.parse({
				actionId: 'ack-current-tuples',
				simulatorUdids: [UDID],
				acknowledgement: 'experimental',
			})
		).toThrow();
	});

	it('does not admit checkpoint tokens into renderer state', () => {
		expect(() =>
			slimmingStateSchema.parse({
				revision: 0,
				updatedAt: 0,
				setting: { experimentalMutationsEnabled: false },
				helper: { status: 'checking', readOnlyAvailable: false },
				categories: [],
				profiles: [],
				simulators: [],
				statusBySimulator: {},
				previewBySimulator: {},
				doctorBySimulator: {},
				jobs: [],
				checkpointBySimulator: {
					[UDID]: {
						id: 'checkpoint',
						createdAt: 1,
						sourceOperationId: 'operation',
						helperVersion: '1',
						catalogVersion: 'catalog',
						compatibilityMatrixVersion: 'matrix',
						checkpointToken: 'must-not-cross-ipc',
					},
				},
				operationsBySimulator: {},
			})
		).toThrow();
	});
});
