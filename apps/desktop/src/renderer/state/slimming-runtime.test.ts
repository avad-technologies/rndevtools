import { describe, expect, it, vi } from 'vitest';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingBridge,
	type SlimmingSettingRequest,
} from '../../shared/slimming-protocol';
import {
	confirmSlimmingSettingRequest,
	createSlimmingAcknowledgementRequest,
} from './slimming-runtime';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function restoreRequest(
	overrides: Partial<SlimmingSettingRequest> = {}
): SlimmingSettingRequest {
	return {
		actionId: 'disable-and-restore',
		enabled: false,
		disposition: 'restore-and-verify',
		simulatorUdids: [UDID],
		confirmation: SLIMMING_CONFIRMATIONS.restore,
		...overrides,
	} as SlimmingSettingRequest;
}

describe('Slimming setting confirmation runtime', () => {
	it('builds acknowledgement only after exact typing for unique bounded targets', () => {
		expect(
			createSlimmingAcknowledgementRequest('ack-1', {
				simulatorUdids: [UDID],
				acknowledgement: 'EXPERIMENTAL',
			})
		).toEqual({
			actionId: 'ack-1',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		expect(
			createSlimmingAcknowledgementRequest('ack-2', {
				simulatorUdids: [UDID],
				acknowledgement: 'experimental',
			})
		).toBeNull();
		expect(
			createSlimmingAcknowledgementRequest('ack-3', {
				simulatorUdids: [UDID, UDID],
				acknowledgement: 'EXPERIMENTAL',
			})
		).toBeNull();
	});

	it('does not invoke native confirmation for enable or explicit leave-overrides', async () => {
		const requestSlimmingConfirmation = vi.fn();
		const bridge = { requestSlimmingConfirmation } as Pick<
			SlimmingBridge,
			'requestSlimmingConfirmation'
		>;
		const enable = { actionId: 'enable', enabled: true } as const;
		const leave = {
			actionId: 'leave',
			enabled: false,
			disposition: 'leave-overrides-in-place',
		} as const;
		expect(await confirmSlimmingSettingRequest(bridge, enable)).toEqual({
			confirmed: true,
			request: enable,
		});
		expect(await confirmSlimmingSettingRequest(bridge, leave)).toEqual({
			confirmed: true,
			request: leave,
		});
		expect(requestSlimmingConfirmation).not.toHaveBeenCalled();
	});

	it('passes only the fresh native token on the exact restore request', async () => {
		const token = `confirmation-${'a'.repeat(64)}`;
		const request = restoreRequest();
		const bridge = {
			requestSlimmingConfirmation: vi.fn(async () => ({
				actionId: request.actionId,
				required: true,
				confirmed: true,
				token,
			})),
		};
		expect(await confirmSlimmingSettingRequest(bridge, request)).toEqual({
			confirmed: true,
			request: { ...request, confirmationToken: token },
		});
		expect(bridge.requestSlimmingConfirmation).toHaveBeenCalledWith(request);
	});

	it('rejects cancellation, a missing token, and a mismatched action identifier', async () => {
		const request = restoreRequest();
		for (const confirmation of [
			{ actionId: request.actionId, required: true, confirmed: false },
			{ actionId: request.actionId, required: true, confirmed: true },
			{ actionId: 'other-action', required: false, confirmed: true },
		]) {
			const result = await confirmSlimmingSettingRequest(
				{ requestSlimmingConfirmation: vi.fn(async () => confirmation) },
				request
			);
			expect(result.confirmed).toBe(false);
		}
	});
});
