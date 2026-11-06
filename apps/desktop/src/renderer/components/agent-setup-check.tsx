import { Button } from '@heroui/react/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Disclosure, PanelNotice } from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import type {
	AgentSetupReport,
	AgentSetupRequest,
	AgentSetupResult,
} from '../../shared/agent-setup-protocol';

/** Shared by first-run setup and the persistent Agents view. */
export function AgentSetupCheck({ refreshKey = 0 }: { refreshKey?: number }) {
	const { isBridgeAvailable, runOnboardingOperation } = useSimulatorRuntime();
	const { state: lanes } = useLaneRuntime();
	const [project, setProject] = useState('');
	const [report, setReport] = useState<AgentSetupReport | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [message, setMessage] = useState('');
	const pending = useRef(false);
	const rescan = useRef(false);
	const mounted = useRef(true);
	const scope = useRef(project);
	scope.current = project;
	const projects = [
		...new Set([
			...lanes.repositories,
			...lanes.worktrees.map((worktree) => worktree.path),
		]),
	].sort();

	const request = useCallback(
		async (operation: AgentSetupRequest): Promise<AgentSetupResult> => {
			const receipt = await runOnboardingOperation({
				kind: 'agentCli.check',
				request: operation,
			});
			if (receipt.cancelled) return { cancelled: true };
			if (!receipt.completed || !receipt.agentCheck)
				throw new Error(receipt.error ?? 'Agent setup check failed.');
			return receipt.agentCheck;
		},
		[runOnboardingOperation]
	);

	const run = useCallback(
		async (operation: AgentSetupRequest['operation'], id?: string) => {
			if (!isBridgeAvailable) return;
			if (pending.current) {
				if (operation === 'scan') rescan.current = true;
				return;
			}
			pending.current = true;
			setBusy(true);
			setError('');
			const selectedProject = scope.current;
			try {
				let result: AgentSetupResult;
				if (operation === 'plan') {
					const preview = await request({
						operation: 'plan',
						project: selectedProject,
						findingId: id,
					});
					if (!preview.plan)
						throw new Error('The repair preview was unavailable. Recheck.');
					// Main shows the exact scope and effect in its own confirmation dialog.
					result = await request({
						operation: 'apply',
						project: selectedProject,
						planId: preview.plan.id,
					});
				} else {
					result = await request({
						operation,
						project: selectedProject,
						...(id ? { planId: id } : {}),
					});
				}
				if (!mounted.current || scope.current !== selectedProject) return;
				if (result.report) setReport(result.report);
				if (result.probe) setMessage(result.probe.message);
				else if (result.cancelled) setMessage('No settings changed.');
				else if (operation === 'plan' || operation === 'undo')
					setMessage(
						'Settings updated. Reload the affected client, then verify its RN Devtools connection.'
					);
			} catch (failure) {
				if (mounted.current)
					setError(
						failure instanceof Error
							? failure.message
							: 'Agent setup check failed.'
					);
			} finally {
				if (rescan.current && mounted.current) {
					rescan.current = false;
					const refreshedScope = scope.current;
					try {
						const refreshed = await request({
							operation: 'scan',
							project: refreshedScope,
						});
						if (
							mounted.current &&
							scope.current === refreshedScope &&
							refreshed.report
						)
							setReport(refreshed.report);
					} catch (failure) {
						if (mounted.current)
							setError(
								failure instanceof Error ? failure.message : 'Recheck failed.'
							);
					}
				}
				pending.current = false;
				if (mounted.current) setBusy(false);
			}
		},
		[isBridgeAvailable, request]
	);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		void refreshKey;
		setReport(null);
		setMessage('');
		void run('scan');
		const refresh = () => {
			if (document.visibilityState === 'visible') void run('scan');
		};
		const timer = window.setInterval(refresh, 60_000);
		window.addEventListener('focus', refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener('focus', refresh);
		};
	}, [project, refreshKey, run]);

	return (
		<section
			className="agent-setup-check"
			aria-label="Agent setup check"
			aria-busy={busy}
		>
			<div className="agent-check-heading">
				<div>
					<h3>Agent setup check</h3>
					<p>
						Check Claude Code and Codex for overlapping tools and missing RN
						Devtools setup.
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					isDisabled={busy || !isBridgeAvailable}
					onPress={() => void run('scan')}
				>
					{busy ? 'Checking…' : 'Recheck'}
				</Button>
			</div>
			<label className="agent-check-scope">
				Configuration scope
				<select
					value={project}
					disabled={busy}
					onChange={(event) => setProject(event.target.value)}
				>
					<option value="">User settings — all projects</option>
					{projects.map((path) => (
						<option key={path} value={path}>
							{shortPath(path)}
						</option>
					))}
				</select>
			</label>
			{!isBridgeAvailable ? (
				<p className="sim-inline-note">
					Open the desktop app to check this Mac.
				</p>
			) : null}
			{error ? (
				<PanelNotice title="Setup check needs attention" tone="danger">
					{error}
				</PanelNotice>
			) : null}
			{message ? (
				<p className="agent-check-message" role="status">
					{message}
				</p>
			) : null}
			{report ? (
				<>
					<div className="agent-check-clients">
						{report.clients.map((client) => (
							<div key={client.id}>
								<strong>{client.name}</strong>
								<span>
									{client.configuration === 'checked'
										? 'Configuration checked'
										: client.configuration === 'not-checked'
											? 'Not fully checked'
											: 'Needs attention'}
								</span>
								<small>
									{client.connection === 'configured'
										? 'MCP registered'
										: 'MCP needs setup'}{' '}
									·{' '}
									{client.hooks === 'installed-unverified'
										? 'Hooks installed; trust unverified'
										: 'Hooks need setup'}
								</small>
							</div>
						))}
					</div>
					<p className="sim-inline-note">
						Checked {new Date(report.checkedAt).toLocaleTimeString()}. Rechecks
						on focus and every minute while this view is open.
					</p>
					<ul className="agent-check-findings">
						{report.findings.map((finding) => (
							<li key={finding.id} data-agent-check-rule={finding.rule}>
								<div>
									<strong>{finding.title}</strong>
									<span>
										{finding.client === 'claude' ? 'Claude Code' : 'Codex'} ·{' '}
										{finding.scope}
									</span>
									<p>{finding.detail}</p>
									<small>{finding.source}</small>
								</div>
								{finding.fixLabel ? (
									<Button
										size="sm"
										variant="secondary"
										isDisabled={busy}
										onPress={() => void run('plan', finding.id)}
									>
										{finding.fixLabel}
									</Button>
								) : null}
							</li>
						))}
					</ul>
					{report.findings.length === 0 ? (
						<p className="agent-check-message">
							No conflicts found in the checked configuration.
						</p>
					) : null}
					{report.repairs.some((repair) => repair.status !== 'undone') ? (
						<Disclosure
							title="Recent repairs — reload clients after changes"
							defaultOpen
						>
							<ul className="agent-check-findings">
								{report.repairs
									.filter((repair) => repair.status !== 'undone')
									.map((repair) => (
										<li key={repair.id}>
											<div>
												<strong>{repair.title}</strong>
												<span>
													{repair.scope}
													{repair.status === 'prepared'
														? ' · Check interrupted repair'
														: ' · Reload needed'}
												</span>
											</div>
											<Button
												size="sm"
												variant="secondary"
												isDisabled={busy}
												onPress={() => void run('undo', repair.id)}
											>
												Undo
											</Button>
										</li>
									))}
							</ul>
						</Disclosure>
					) : null}
					<div className="agent-check-actions">
						<Button
							size="sm"
							variant="secondary"
							isDisabled={busy}
							onPress={() => void run('probe')}
						>
							Test RN Devtools connection
						</Button>
					</div>
					<Disclosure title="What this check verifies">
						<ul>
							{[...report.coverage, ...report.limitations].map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
						<p>
							After a repair, reload the affected client. In Codex, review new
							hooks with <code>/hooks</code>. In an existing agent chat, ask it
							to call RN Devtools doctor. Device and database tests remain
							separate.
						</p>
					</Disclosure>
				</>
			) : null}
		</section>
	);
}
