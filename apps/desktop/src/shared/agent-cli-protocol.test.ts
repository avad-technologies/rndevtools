import { describe, expect, it } from 'vitest';
import {
	agentCliRequestSchema,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from './agent-cli-protocol';

const UDID = '11111111-2222-3333-4444-555555555555';

function request(command: unknown) {
	return {
		protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
		id: 'cli-0123456789abcdef0123456789abcdef',
		command,
	};
}

describe('agent CLI protocol', () => {
	it('applies bounded defaults to inspection commands', () => {
		expect(
			agentCliRequestSchema.parse(request({ kind: 'simulators' })).command
		).toEqual({ kind: 'simulators', includeUnavailable: false });
		expect(
			agentCliRequestSchema.parse({
				...request({ kind: 'elements', target: { udid: UDID } }),
			}).command
		).toMatchObject({ limit: 100 });
	});

	it('rejects arbitrary shell-shaped commands and unknown fields', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'shell',
					executable: '/bin/zsh',
					args: ['-c', 'whoami'],
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'doctor', environment: { TOKEN: 'secret' } })
			).success
		).toBe(false);
	});

	it('permits semantic actions but rejects destructive connected-app actions', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: {
						tool: 'components',
						command: 'activate',
						payload: { id: 'button-1', screenHash: 'screen-1' },
					},
				})
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: {
						tool: 'restore',
						command: 'restore',
						payload: { id: 'restore-1' },
					},
				})
			).success
		).toBe(false);
	});

	it('allows app-scoped network profiles but not clearing captured traffic', () => {
		for (const [command, payload] of [
			['setProfile', { profileId: 'lte' }],
			['clearProfile', {}],
		] as const) {
			expect(
				agentCliRequestSchema.safeParse(
					request({
						kind: 'act',
						target: { deviceId: 'device-1' },
						action: { tool: 'network', command, payload },
					})
				).success
			).toBe(true);
		}
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'act',
					target: { deviceId: 'device-1' },
					action: { tool: 'network', command: 'clear', payload: {} },
				})
			).success
		).toBe(false);
	});

	it('keeps Simulator Slimming commands read-only', () => {
		for (const command of [
			{ kind: 'slimming', operation: 'status' },
			{ kind: 'slimming', operation: 'doctor', udids: [UDID] },
			{
				kind: 'slimming',
				operation: 'preview',
				udids: [UDID],
				profileId: 'rndevtools-development',
			},
			{
				kind: 'slimming',
				operation: 'verify',
				udids: [UDID],
				profileId: 'rndevtools-development',
			},
		]) {
			expect(agentCliRequestSchema.safeParse(request(command)).success).toBe(
				true
			);
		}
		for (const command of [
			{ kind: 'slimming', operation: 'status', udids: [UDID] },
			{
				kind: 'slimming',
				operation: 'doctor',
				udids: [UDID],
				profileId: 'ignored-profile',
			},
			{ kind: 'slimming', operation: 'preview', udids: [UDID] },
		]) {
			expect(agentCliRequestSchema.safeParse(request(command)).success).toBe(
				false
			);
		}
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'slimming',
					operation: 'apply',
					udids: [UDID],
					confirmation: 'APPLY_EXPERIMENTAL_PROFILE',
				})
			).success
		).toBe(false);
	});

	it('requires exact UDID syntax and bounded target batches', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'capture', udid: 'booted; rm -rf /' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'recipe',
					operation: 'run',
					recipeId: 'smoke',
					udids: Array.from({ length: 21 }, () => UDID),
				})
			).success
		).toBe(false);
	});

	it('shapes lane commands per operation and refuses ambiguous targets', () => {
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app',
					udid: UDID,
					agent: { kind: 'codex', sessionId: 'thread-1' },
				})
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'up', udid: UDID })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: 'relative/app',
					udid: UDID,
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'ls' })
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'ls', laneId })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'launch', laneId, url: 'checkout' })
			).success
		).toBe(true);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'launch',
					laneId,
					worktreePath: '/Users/dev/app',
				})
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'down' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({ kind: 'lane', operation: 'log', laneId, url: 'nope' })
			).success
		).toBe(false);
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: '/a',
					udid: UDID,
					shell: 'x',
				})
			).success
		).toBe(false);
	});

	it('lets lane up omit the udid and says so when a lane command is malformed', () => {
		expect(
			agentCliRequestSchema.safeParse(
				request({
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app',
				})
			).success
		).toBe(true);
		const malformed = agentCliRequestSchema.safeParse(
			request({ kind: 'lane', operation: 'up', udid: UDID })
		);
		expect(malformed.success).toBe(false);
		const message = malformed.error?.issues.map((issue) => issue.message);
		expect(message?.join(' ')).toMatch(/up requires worktreePath/);
		expect(message?.join(' ')).not.toMatch(/worktreePath and udid/);
	});

	it('accepts a release sessionCwd only with all, absolute and bounded', () => {
		const release = (fields: Record<string, unknown>) =>
			agentCliRequestSchema.safeParse(request({ kind: 'release', ...fields }))
				.success;
		expect(release({ all: true, sessionCwd: '/Users/dev/app' })).toBe(true);
		expect(release({ all: true, sessionCwd: '/' })).toBe(true);
		expect(release({ all: true })).toBe(true);
		expect(release({ udid: UDID })).toBe(true);
		expect(release({ udid: UDID, sessionCwd: '/Users/dev/app' })).toBe(false);
		expect(release({ all: true, sessionCwd: 'Users/dev/app' })).toBe(false);
		expect(release({ all: true, sessionCwd: '' })).toBe(false);
		expect(release({ all: true, sessionCwd: '/a\0b' })).toBe(false);
		expect(release({ all: true, sessionCwd: `/${'a'.repeat(1_023)}` })).toBe(
			true
		);
		expect(release({ all: true, sessionCwd: `/${'a'.repeat(1_024)}` })).toBe(
			false
		);
	});

	describe('supabase', () => {
		const WORKTREE = '/Users/dev/example-app-wt/feat-checkout';
		const STACK_ID =
			'64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f';
		const supabase = (fields: Record<string, unknown>) =>
			agentCliRequestSchema.safeParse(request({ kind: 'supabase', ...fields }));

		// The Go CLI's validateSupabase mirrors this matrix row for row.
		it.each([
			{ operation: 'ls' },
			{ operation: 'up', worktreePath: WORKTREE },
			{ operation: 'up', worktreePath: WORKTREE, waitMs: 0 },
			{ operation: 'up', worktreePath: WORKTREE, waitMs: 45_000 },
			{ operation: 'up', stackId: STACK_ID.slice(0, 8) },
			{ operation: 'down', worktreePath: WORKTREE },
			{ operation: 'down', stackId: STACK_ID },
			{ operation: 'status', stackId: STACK_ID.slice(0, 12) },
			{ operation: 'env', worktreePath: '/a' },
			{ operation: 'reset', worktreePath: WORKTREE },
			{
				operation: 'reset',
				stackId: STACK_ID,
				seed: false,
				note: 'Start over with the seed fixtures.',
			},
			{ operation: 'log', worktreePath: WORKTREE },
			{
				operation: 'log',
				stackId: STACK_ID,
				services: ['database', 'auth', 'gateway'],
				tail: 1,
				since: '10m',
			},
			{ operation: 'log', worktreePath: WORKTREE, tail: 1_000, since: '1h30m' },
			{ operation: 'log', worktreePath: WORKTREE, since: '1.5s' },
			{
				operation: 'log',
				worktreePath: WORKTREE,
				since: '2026-10-17T05:00:00Z',
			},
			{
				operation: 'log',
				worktreePath: WORKTREE,
				since: '2026-10-17T05:00:00.250+02:00',
			},
			// The contract's filters, which the Go CLI also sends: each service's
			// latest launch, and one instance by id.
			{ operation: 'log', worktreePath: WORKTREE, since: 'start' },
			{
				operation: 'log',
				worktreePath: WORKTREE,
				services: ['3f2c9e1a-0b7d-4c55-9a8e-1d2f3a4b5c6d'],
			},
			{ operation: 'destroy', worktreePath: WORKTREE },
			{ operation: 'destroy', stackId: STACK_ID, note: 'n'.repeat(240) },
		])('accepts %o', (fields) => {
			expect(supabase(fields).success).toBe(true);
		});

		it.each([
			// Targets: ls takes none, everything else exactly one.
			{ operation: 'ls', worktreePath: WORKTREE },
			{ operation: 'ls', stackId: STACK_ID },
			{ operation: 'up' },
			{ operation: 'status' },
			{ operation: 'down', worktreePath: WORKTREE, stackId: STACK_ID },
			{ operation: 'up', worktreePath: 'example-app-wt/feat-checkout' },
			{ operation: 'up', worktreePath: '/' },
			{ operation: 'up', worktreePath: '/Users/dev/app\nrm' },
			{ operation: 'up', worktreePath: '/Users/dev/app\0' },
			{ operation: 'up', worktreePath: `/${'a'.repeat(1_024)}` },
			{ operation: 'env', stackId: STACK_ID.slice(0, 7) },
			{ operation: 'env', stackId: `${STACK_ID}0` },
			{ operation: 'env', stackId: STACK_ID.toUpperCase() },
			{ operation: 'env', stackId: 'feat-checkout' },
			// Fields belong to one operation each.
			{ operation: 'up', worktreePath: WORKTREE, waitMs: -1 },
			{ operation: 'up', worktreePath: WORKTREE, waitMs: 45_001 },
			{ operation: 'up', worktreePath: WORKTREE, waitMs: 1.5 },
			{ operation: 'down', worktreePath: WORKTREE, waitMs: 1_000 },
			{ operation: 'ls', waitMs: 1_000 },
			{ operation: 'up', worktreePath: WORKTREE, seed: true },
			{ operation: 'reset', worktreePath: WORKTREE, seed: 'yes' },
			{ operation: 'status', worktreePath: WORKTREE, services: ['database'] },
			{ operation: 'log', worktreePath: WORKTREE, services: [] },
			{ operation: 'log', worktreePath: WORKTREE, services: ['postgres'] },
			{ operation: 'log', worktreePath: WORKTREE, services: ['unknown'] },
			{
				operation: 'log',
				worktreePath: WORKTREE,
				services: ['database', 'database'],
			},
			{ operation: 'log', worktreePath: WORKTREE, tail: 0 },
			{ operation: 'log', worktreePath: WORKTREE, tail: 1_001 },
			{ operation: 'env', worktreePath: WORKTREE, tail: 10 },
			{ operation: 'log', worktreePath: WORKTREE, since: 'yesterday' },
			{ operation: 'log', worktreePath: WORKTREE, since: '10' },
			{ operation: 'log', worktreePath: WORKTREE, since: '-10m' },
			{
				operation: 'log',
				worktreePath: WORKTREE,
				since: '2026-13-45T00:00:00Z',
			},
			{ operation: 'status', worktreePath: WORKTREE, since: '10m' },
			{ operation: 'up', worktreePath: WORKTREE, note: 'please' },
			{ operation: 'down', worktreePath: WORKTREE, note: 'please' },
			{ operation: 'destroy', worktreePath: WORKTREE, note: 'n'.repeat(241) },
			// Nothing else gets through: no runtimes, flags, or other verbs.
			{ operation: 'up', worktreePath: WORKTREE, runtime: 'docker' },
			{ operation: 'up', worktreePath: WORKTREE, agent: { kind: 'codex' } },
			{ operation: 'up', worktreePath: WORKTREE, waitMs: null },
			{ operation: 'start', worktreePath: WORKTREE },
			{ operation: 'stop', worktreePath: WORKTREE },
			{ operation: 'prune' },
		])('rejects %o', (fields) => {
			expect(supabase(fields).success).toBe(false);
		});

		it('names the target rule and the field rule when a command breaks them', () => {
			const issues = (fields: Record<string, unknown>) =>
				supabase(fields)
					.error?.issues.map((issue) => issue.message)
					.join(' ');
			expect(issues({ operation: 'ls', stackId: STACK_ID })).toMatch(
				/ls takes no target/
			);
			expect(issues({ operation: 'env' })).toMatch(
				/exactly one of worktreePath or stackId/
			);
			expect(
				issues({ operation: 'status', worktreePath: WORKTREE, seed: true })
			).toMatch(/seed for reset/);
		});

		it('keeps the parsed command flat, with no defaults applied', () => {
			expect(
				agentCliRequestSchema.parse(
					request({ kind: 'supabase', operation: 'up', worktreePath: WORKTREE })
				).command
			).toEqual({ kind: 'supabase', operation: 'up', worktreePath: WORKTREE });
		});
	});

	it('takes a lane backend policy on lane up only', () => {
		const lane = (fields: Record<string, unknown>) =>
			agentCliRequestSchema.safeParse(request({ kind: 'lane', ...fields }))
				.success;
		for (const backend of ['auto', 'off', 'required']) {
			expect(
				lane({ operation: 'up', worktreePath: '/Users/dev/app', backend })
			).toBe(true);
		}
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		expect(
			lane({ operation: 'up', worktreePath: '/Users/dev/app', backend: 'on' })
		).toBe(false);
		expect(lane({ operation: 'down', laneId, backend: 'off' })).toBe(false);
		expect(lane({ operation: 'launch', laneId, backend: 'auto' })).toBe(false);
		expect(lane({ operation: 'ls', backend: 'auto' })).toBe(false);
	});
});
