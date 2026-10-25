import { z } from 'zod';

const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const buildInsightIdSchema = z
	.string()
	.regex(/^build-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const buildInsightSourceIdSchema = z
	.string()
	.regex(/^build-source-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

export const buildInsightSchema = z.strictObject({
	id: buildInsightIdSchema,
	sourceId: buildInsightSourceIdSchema,
	sourceLabel: z.string().trim().min(1).max(128),
	name: z.string().trim().min(1).max(128),
	configuration: z.string().trim().min(1).max(64).optional(),
	scheme: z.string().trim().min(1).max(128).optional(),
	destination: z.string().trim().min(1).max(256),
	createdAt: z.number().finite().nonnegative(),
	startedAt: z.number().finite().nonnegative(),
	endedAt: z.number().finite().nonnegative(),
	durationMs: z
		.number()
		.finite()
		.nonnegative()
		.max(7 * 24 * 60 * 60 * 1_000),
	status: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
	classification: z.enum(['clean', 'incremental', 'unknown']),
	classificationConfidence: z.enum(['confirmed', 'inferred', 'unknown']),
	warnings: z.number().int().nonnegative().max(1_000_000),
	errors: z.number().int().nonnegative().max(1_000_000),
	analyzerWarnings: z.number().int().nonnegative().max(1_000_000),
	xcodeVersion: z.string().trim().min(1).max(128).optional(),
});
export type BuildInsight = z.infer<typeof buildInsightSchema>;

export const buildInsightSourceSchema = z.strictObject({
	id: buildInsightSourceIdSchema,
	label: z.string().trim().min(1).max(128),
	kind: z.enum(['xcresult', 'derived-data-root']),
	addedAt: z.number().finite().nonnegative(),
	lastScannedAt: z.number().finite().nonnegative().optional(),
	status: z.enum(['ready', 'scanning', 'error']),
	error: z
		.string()
		.max(4 * 1024)
		.optional(),
});
export type BuildInsightSource = z.infer<typeof buildInsightSourceSchema>;

const activityMonthSchema = z.strictObject({
	month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
	count: z.number().int().nonnegative(),
	totalDurationMs: z.number().finite().nonnegative(),
});

const buildInsightsStatsSchema = z.strictObject({
	totalBuilds: z.number().int().nonnegative(),
	succeededBuilds: z.number().int().nonnegative(),
	medianDurationMs: z.number().finite().nonnegative().optional(),
	p75DurationMs: z.number().finite().nonnegative().optional(),
	p95DurationMs: z.number().finite().nonnegative().optional(),
	sevenDayAverageMs: z.number().finite().nonnegative().optional(),
	activity: z.array(activityMonthSchema).max(12),
});
export type BuildInsightsStats = z.infer<typeof buildInsightsStatsSchema>;

export const buildInsightsStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number().finite().nonnegative(),
	retentionMonths: z.literal(12),
	sources: z.array(buildInsightSourceSchema).max(100),
	builds: z.array(buildInsightSchema).max(2_000),
	stats: buildInsightsStatsSchema,
});
export type BuildInsightsState = z.infer<typeof buildInsightsStateSchema>;

export const buildInsightsOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('build.import-xcresult'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('build.add-watch-root'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('build.refresh'),
		sourceId: buildInsightSourceIdSchema.optional(),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('build.export'),
		format: z.enum(['json', 'csv']),
	}),
]);
export type BuildInsightsOperation = z.infer<
	typeof buildInsightsOperationSchema
>;

export const buildInsightsOperationReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'build.import-xcresult',
		'build.add-watch-root',
		'build.refresh',
		'build.export',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	error: z
		.string()
		.max(8 * 1024)
		.optional(),
	state: buildInsightsStateSchema.optional(),
});
export type BuildInsightsOperationReceipt = z.infer<
	typeof buildInsightsOperationReceiptSchema
>;

export type BuildInsightsBridge = {
	getBuildInsightsState: () => Promise<BuildInsightsState>;
	subscribeBuildInsightsState: (
		listener: (state: BuildInsightsState) => void
	) => () => void;
	runBuildInsightsOperation: (
		operation: BuildInsightsOperation
	) => Promise<BuildInsightsOperationReceipt>;
};
