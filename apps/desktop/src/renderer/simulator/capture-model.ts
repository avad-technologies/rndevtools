import {
	type SimulatorCaptureRetentionPolicy,
	type SimulatorJob,
	simulatorCaptureRetentionPolicySchema,
} from '../../shared/simulator-protocol';

const BYTES_PER_GIBIBYTE = 1024 ** 3;

export type CaptureRetentionFields = {
	maxAgeDays: string;
	maxTotalGiB: string;
};

export function captureRetentionPolicyFromFields(
	fields: CaptureRetentionFields
): SimulatorCaptureRetentionPolicy | null {
	const maxAgeDays = Number(fields.maxAgeDays);
	const maxTotalGiB = Number(fields.maxTotalGiB);
	if (!Number.isInteger(maxAgeDays) || !Number.isFinite(maxTotalGiB))
		return null;
	const result = simulatorCaptureRetentionPolicySchema.safeParse({
		maxAgeDays,
		maxTotalBytes: Math.round(maxTotalGiB * BYTES_PER_GIBIBYTE),
	});
	return result.success ? result.data : null;
}

export function captureRetentionFieldsFromPolicy(
	policy: SimulatorCaptureRetentionPolicy
): CaptureRetentionFields {
	return {
		maxAgeDays: String(policy.maxAgeDays),
		maxTotalGiB: String(
			Number((policy.maxTotalBytes / BYTES_PER_GIBIBYTE).toFixed(2))
		),
	};
}

/** The retention form, and the stored policy it was last filled from. */
export type CaptureRetentionForm = Readonly<{
	fields: CaptureRetentionFields;
	filledFrom?: SimulatorCaptureRetentionPolicy;
}>;

/**
 * The retention form once main reports the stored policy. It follows the
 * policy unless the operator has typed over the values it was last filled
 * with, so a capture landing in the background never wipes an edit that has
 * not been applied yet.
 */
export function refillCaptureRetentionForm(
	form: CaptureRetentionForm,
	policy: SimulatorCaptureRetentionPolicy
): CaptureRetentionForm {
	if (form.filledFrom) {
		const filled = captureRetentionFieldsFromPolicy(form.filledFrom);
		if (
			form.fields.maxAgeDays !== filled.maxAgeDays ||
			form.fields.maxTotalGiB !== filled.maxTotalGiB
		) {
			return form;
		}
	}
	return {
		fields: captureRetentionFieldsFromPolicy(policy),
		filledFrom: policy,
	};
}

export function runningRecordingJobForDevice(
	jobs: readonly SimulatorJob[],
	deviceUdid: string | undefined
): SimulatorJob | undefined {
	if (!deviceUdid) return undefined;
	const normalizedUdid = deviceUdid.toUpperCase();
	return jobs.find(
		(job) =>
			job.kind === 'capture.video' &&
			job.status === 'running' &&
			job.deviceUdid?.toUpperCase() === normalizedUdid
	);
}
