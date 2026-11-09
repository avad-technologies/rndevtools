import { describe, expect, it, vi } from 'vitest';
import { agentSetupRequestSchema } from '../shared/agent-setup-protocol';
import { AgentSetupCheckService } from './agent-setup-check';

const planId = `check-${'a'.repeat(32)}`;
const findingId = `finding-${'b'.repeat(32)}`;
const report = {
	version: 1,
	rulesVersion: 'test',
	checkedAt: 1,
	fingerprint: 'c'.repeat(64),
	project: '',
	clients: [],
	findings: [],
	repairs: [],
	coverage: [],
	limitations: [],
};
const plan = {
	id: planId,
	client: 'codex',
	title: 'Disable overlapping controller',
	scope: 'All Codex projects',
	source: '~/.codex/config.toml',
	summary: 'Keep installation and settings. Reload Codex afterward.',
	expiresAt: Date.now() + 300_000,
};

function fixture() {
	const run = vi.fn(async (_exe: string, args: string[]) =>
		JSON.stringify(args[2] === 'plan' ? plan : report)
	);
	const confirm = vi.fn(async () => true);
	const executable = vi.fn(
		async () => '/Applications/RN Devtools.app/rndevtools'
	);
	const service = new AgentSetupCheckService({
		executable,
		home: '/fixture',
		projects: () => ['/project'],
		confirm,
		run,
	});
	return { service, run, confirm, executable };
}

describe('agent setup checks', () => {
	it('requires a preview and main confirmation; rejects replay and arbitrary scope', async () => {
		const { service, run, confirm } = fixture();
		await expect(service.run({ operation: 'apply', planId })).rejects.toThrow(
			'Preview'
		);
		await expect(service.scan('/unregistered')).rejects.toThrow(
			'already added'
		);
		expect(run).not.toHaveBeenCalled();
		await service.run({ operation: 'plan', findingId });
		await expect(
			service.run({ operation: 'apply', project: '/project', planId })
		).rejects.toThrow('Preview');
		await service.run({ operation: 'apply', planId });
		expect(confirm).toHaveBeenCalledWith({
			title: plan.title,
			detail: `${plan.scope}\n${plan.source}\n\n${plan.summary}`,
		});
		await expect(service.run({ operation: 'apply', planId })).rejects.toThrow(
			'Preview'
		);
		expect(run.mock.calls.map((call) => call[1][2])).toEqual(['plan', 'apply']);
	});
	it('names the file a repair writes when a link resolves elsewhere', async () => {
		const { service, run, confirm } = fixture();
		const linked = { ...plan, target: '~/dotfiles/codex.toml' };
		run.mockImplementation(async (_exe: string, args: string[]) =>
			JSON.stringify(args[2] === 'plan' ? linked : report)
		);
		await service.run({ operation: 'plan', findingId });
		await service.run({ operation: 'apply', planId });
		expect(confirm).toHaveBeenCalledWith({
			title: plan.title,
			detail: `${plan.scope}\n${plan.source}\nWrites ~/dotfiles/codex.toml, the file it links to.\n\n${plan.summary}`,
		});
	});
	it('cancel changes nothing; undo checks history and confirms separately', async () => {
		const { service, run, confirm } = fixture();
		await service.run({ operation: 'plan', findingId });
		confirm.mockResolvedValue(false);
		await expect(service.run({ operation: 'apply', planId })).resolves.toEqual({
			cancelled: true,
		});
		expect(run).toHaveBeenCalledTimes(1);
		await expect(service.run({ operation: 'undo', planId })).rejects.toThrow(
			'no longer available'
		);
		run.mockResolvedValue(
			JSON.stringify({
				...report,
				repairs: [
					{
						id: planId,
						client: 'codex',
						title: plan.title,
						scope: plan.scope,
						appliedAt: 1,
						status: 'applied',
					},
				],
			})
		);
		confirm.mockResolvedValue(true);
		await service.run({ operation: 'undo', planId });
		expect(confirm).toHaveBeenLastCalledWith(
			expect.objectContaining({ title: `Undo: ${plan.title}` })
		);
		expect(run.mock.lastCall?.[1][2]).toBe('undo');
	});
	it('bounds output, validates IDs and never echoes raw child failures', async () => {
		const { service, run } = fixture();
		expect(
			agentSetupRequestSchema.safeParse({
				operation: 'apply',
				planId: '../secret',
			}).success
		).toBe(false);
		expect(
			agentSetupRequestSchema.safeParse({ operation: 'plan' }).success
		).toBe(false);
		expect(
			agentSetupRequestSchema.safeParse({ operation: 'scan', file: '/secret' })
				.success
		).toBe(false);
		run.mockRejectedValue({
			stderr: 'SECRET raw config',
			stdout: 'SECRET env',
			message: 'SECRET args',
		});
		await expect(service.scan()).rejects.toThrow('Agent setup check failed');
		try {
			await service.scan();
		} catch (error) {
			expect(String(error)).not.toContain('SECRET');
		}
		run.mockResolvedValue(
			JSON.stringify({ ...report, limitations: ['x'.repeat(4097)] })
		);
		await expect(service.scan()).rejects.toThrow();
	});
	it('caches read-only doctor checks, invalidates on repairs, verifies the executable each time', async () => {
		const { service, run, executable } = fixture();
		await service.scan('', true);
		await service.scan('', true);
		expect(run).toHaveBeenCalledTimes(1);
		await service.run({ operation: 'plan', findingId });
		await service.run({ operation: 'apply', planId });
		await service.scan('', true);
		expect(run).toHaveBeenCalledTimes(4);
		expect(executable).toHaveBeenCalledTimes(4);
		expect(run.mock.calls[0]?.[1]).toContain('/fixture');
	});
	it('rejects expired previews and validates probe responses', async () => {
		const { service, run, confirm } = fixture();
		run.mockResolvedValueOnce(JSON.stringify({ ...plan, expiresAt: 1 }));
		await service.run({ operation: 'plan', findingId });
		await expect(service.run({ operation: 'apply', planId })).rejects.toThrow(
			'Preview'
		);
		expect(confirm).not.toHaveBeenCalled();
		run.mockResolvedValueOnce(
			JSON.stringify({
				ok: true,
				checkedAt: 1,
				toolCount: 21,
				message: 'MCP responds; loaded client trust is not verified.',
			})
		);
		await expect(service.run({ operation: 'probe' })).resolves.toMatchObject({
			probe: { ok: true },
		});
	});
});
