import { z } from 'zod';

export const failureRecordSchema = z.strictObject({
	id: z.string().regex(/^failure-[a-f0-9]{32}$/),
	at: z.number().finite().nonnegative(),
	kind: z.enum([
		'metro-exit',
		'lane-lifecycle',
		'app-crash',
		'simulator-crash',
		'simulator-diagnostic',
		'operation-failed',
	]),
	severity: z.enum(['error', 'warning', 'info']),
	title: z.string().max(240),
	detail: z.string().max(16_384),
	source: z.string().max(256),
	laneId: z.string().max(128).optional(),
	simulatorUdid: z.string().max(64).optional(),
	project: z.string().max(1_024).optional(),
	process: z.string().max(256).optional(),
	metroPid: z.number().int().positive().optional(),
	port: z.number().int().positive().optional(),
	resolvedAt: z.number().finite().nonnegative().optional(),
});
export type FailureRecord = z.infer<typeof failureRecordSchema>;

export const failureStateSchema = z.strictObject({
	records: z.array(failureRecordSchema).max(200),
	checkedAt: z.number().finite().nonnegative(),
	monitoring: z.boolean(),
	issues: z.array(z.string().max(512)).max(12),
});
export type FailureState = z.infer<typeof failureStateSchema>;

export const failureRequestSchema = z.discriminatedUnion('operation', [
	z.strictObject({ operation: z.literal('scan') }),
	z.strictObject({
		operation: z.literal('resolve'),
		id: failureRecordSchema.shape.id,
		resolved: z.boolean(),
	}),
	z.strictObject({
		operation: z.literal('handoff'),
		id: failureRecordSchema.shape.id,
		client: z.enum(['claude', 'codex']),
		mode: z.enum(['investigate', 'fix']),
		project: z.string().min(1).max(1_024),
	}),
]);
export type FailureRequest = z.infer<typeof failureRequestSchema>;

export const failureResultSchema = z.strictObject({
	state: failureStateSchema,
	message: z.string().max(1_024).optional(),
	cancelled: z.boolean().optional(),
});
export type FailureResult = z.infer<typeof failureResultSchema>;
export type FailureBridge = {
	getFailureState: () => Promise<FailureState>;
	runFailureOperation: (request: FailureRequest) => Promise<FailureResult>;
};
