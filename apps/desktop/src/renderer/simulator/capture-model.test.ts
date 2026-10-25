import { describe, expect, it } from 'vitest';
import type { SimulatorJob } from '../../shared/simulator-protocol';
import {
	captureRetentionFieldsFromPolicy,
	captureRetentionPolicyFromFields,
	refillCaptureRetentionForm,
	runningRecordingJobForDevice,
} from './capture-model';

describe('capture retention model', () => {
	it('converts valid day and GiB fields into the strict shared policy', () => {
		expect(
			captureRetentionPolicyFromFields({ maxAgeDays: '30', maxTotalGiB: '10' })
		).toEqual({ maxAgeDays: 30, maxTotalBytes: 10 * 1024 ** 3 });
		expect(
			captureRetentionPolicyFromFields({ maxAgeDays: '30', maxTotalGiB: '2.5' })
		).toEqual({ maxAgeDays: 30, maxTotalBytes: 2.5 * 1024 ** 3 });
	});

	it.each([
		{ maxAgeDays: '0', maxTotalGiB: '10' },
		{ maxAgeDays: '30.5', maxTotalGiB: '10' },
		{ maxAgeDays: '30', maxTotalGiB: '1' },
		{ maxAgeDays: '30', maxTotalGiB: '101' },
		{ maxAgeDays: 'forever', maxTotalGiB: '10' },
	])('rejects a policy outside the shared protocol bounds: %o', (fields) => {
		expect(captureRetentionPolicyFromFields(fields)).toBeNull();
	});

	it('converts a stored policy back to editable fields without byte rounding', () => {
		expect(
			captureRetentionFieldsFromPolicy({
				maxAgeDays: 90,
				maxTotalBytes: 25 * 1024 ** 3,
			})
		).toEqual({ maxAgeDays: '90', maxTotalGiB: '25' });
	});
});

describe('capture retention form', () => {
	const stored = { maxAgeDays: 30, maxTotalBytes: 10 * 1024 ** 3 };
	const loaded = refillCaptureRetentionForm(
		{ fields: { maxAgeDays: '30', maxTotalGiB: '10' } },
		stored
	);

	it('fills the form from the first policy main reports', () => {
		expect(
			refillCaptureRetentionForm(
				{ fields: { maxAgeDays: '30', maxTotalGiB: '10' } },
				{ maxAgeDays: 90, maxTotalBytes: 25 * 1024 ** 3 }
			).fields
		).toEqual({ maxAgeDays: '90', maxTotalGiB: '25' });
	});

	it('keeps an unapplied edit when a new capture reloads the policy', () => {
		const edited = {
			...loaded,
			fields: { ...loaded.fields, maxTotalGiB: '20' },
		};
		expect(refillCaptureRetentionForm(edited, stored)).toBe(edited);
		// Typing the same value differently still counts as the operator's.
		const retyped = {
			...loaded,
			fields: { ...loaded.fields, maxTotalGiB: '10.0' },
		};
		expect(refillCaptureRetentionForm(retyped, stored)).toBe(retyped);
	});

	it('follows the stored policy while the form is untouched', () => {
		const changed = { maxAgeDays: 14, maxTotalBytes: 2.5 * 1024 ** 3 };
		expect(refillCaptureRetentionForm(loaded, changed)).toEqual({
			fields: { maxAgeDays: '14', maxTotalGiB: '2.5' },
			filledFrom: changed,
		});
	});
});

describe('capture recording target model', () => {
	const firstUdid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
	const secondUdid = '11111111-2222-4333-8444-555555555555';
	const job = (
		id: string,
		deviceUdid: string,
		status: SimulatorJob['status'] = 'running'
	): SimulatorJob => ({
		id,
		actionId: `action-${id}`,
		kind: 'capture.video',
		deviceUdid,
		status,
		progressSequence: 1,
		phase: 'recording',
		createdAt: 1,
		message: 'Recording.',
	});

	it('returns only the selected Simulator recording when several run concurrently', () => {
		const jobs = [job('first', firstUdid), job('second', secondUdid)];
		expect(runningRecordingJobForDevice(jobs, secondUdid)?.id).toBe('second');
		expect(runningRecordingJobForDevice(jobs, firstUdid)?.id).toBe('first');
	});

	it('does not expose another target recording or a finished selected-target job', () => {
		expect(
			runningRecordingJobForDevice([job('first', firstUdid)], secondUdid)
		).toBe(undefined);
		expect(
			runningRecordingJobForDevice(
				[job('complete', secondUdid, 'complete')],
				secondUdid
			)
		).toBe(undefined);
		expect(
			runningRecordingJobForDevice([job('first', firstUdid)], undefined)
		).toBe(undefined);
	});
});
