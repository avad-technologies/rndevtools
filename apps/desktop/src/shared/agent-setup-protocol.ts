import { z } from 'zod';

const text = z.string().max(4096);
const client = z.enum(['claude', 'codex']);
const repairId = z.string().regex(/^check-[a-f0-9]{32}$/);

const agentSetupFindingSchema = z.strictObject({
	id: z.string().regex(/^finding-[a-f0-9]{32}$/),
	client,
	rule: z.string().max(160),
	severity: z.enum(['warning', 'review', 'info']),
	title: text,
	detail: text,
	source: text,
	scope: text,
	fixLabel: text.optional(),
});

export const agentSetupReportSchema = z.strictObject({
	version: z.literal(1),
	rulesVersion: z.string().max(80),
	checkedAt: z.number().int().nonnegative(),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	project: text,
	clients: z
		.array(
			z.strictObject({
				id: client,
				name: text,
				configuration: z.enum(['checked', 'attention', 'not-checked']),
				connection: z.enum(['configured', 'needs-setup']),
				hooks: z.enum([
					'not-verified',
					'installed-unverified',
					'command-rules',
				]),
			})
		)
		.max(2),
	findings: z.array(agentSetupFindingSchema).max(200),
	repairs: z
		.array(
			z.strictObject({
				id: repairId,
				client,
				title: text,
				scope: text,
				appliedAt: z.number().int().nonnegative(),
				status: z.enum(['prepared', 'applied', 'undone']),
			})
		)
		.max(32),
	coverage: z.array(text).max(32),
	limitations: z.array(text).max(32),
});

export const agentSetupPlanSchema = z.strictObject({
	id: repairId,
	client,
	title: text,
	scope: text,
	source: text,
	/** The file the repair writes, when a link at `source` points elsewhere. */
	target: text.optional(),
	summary: text,
	expiresAt: z.number().int().nonnegative(),
});

export const agentSetupProbeSchema = z.strictObject({
	ok: z.boolean(),
	checkedAt: z.number().int().nonnegative(),
	toolCount: z.number().int().nonnegative(),
	message: text,
});

export const agentSetupRequestSchema = z
	.strictObject({
		operation: z.enum(['scan', 'plan', 'apply', 'undo', 'probe']),
		/** A registered repository/worktree reference, validated again in main. */
		project: text.optional(),
		findingId: z
			.string()
			.regex(/^finding-[a-f0-9]{32}$/)
			.optional(),
		planId: repairId.optional(),
	})
	.superRefine((value, context) => {
		if (value.operation === 'plan' && !value.findingId) {
			context.addIssue({ code: 'custom', message: 'A finding is required.' });
		}
		if (['apply', 'undo'].includes(value.operation) && !value.planId) {
			context.addIssue({
				code: 'custom',
				message: 'A repair identifier is required.',
			});
		}
	});

export const agentSetupResultSchema = z.strictObject({
	report: agentSetupReportSchema.optional(),
	plan: agentSetupPlanSchema.optional(),
	probe: agentSetupProbeSchema.optional(),
	cancelled: z.boolean().optional(),
});

export type AgentSetupReport = z.infer<typeof agentSetupReportSchema>;
export type AgentSetupRequest = z.infer<typeof agentSetupRequestSchema>;
export type AgentSetupResult = z.infer<typeof agentSetupResultSchema>;
export type AgentSetupPlan = z.infer<typeof agentSetupPlanSchema>;
