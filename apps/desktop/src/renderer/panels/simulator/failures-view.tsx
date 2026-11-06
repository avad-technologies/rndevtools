import { Button } from '@heroui/react/button';
import {
	AlertTriangle,
	CheckCircle2,
	ClipboardCopy,
	RefreshCw,
	Search,
	Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelNotice } from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import { useLaneRuntime } from '@/state/lane-runtime';
import type {
	FailureRequest,
	FailureState,
} from '../../../shared/failure-protocol';

const emptyState: FailureState = {
	records: [],
	checkedAt: 0,
	monitoring: false,
	issues: [],
};

export function FailuresView() {
	const bridge = window.rnDevtools;
	const { state: lanes } = useLaneRuntime();
	const projects = [
		...new Set([
			...lanes.repositories,
			...lanes.worktrees.map((worktree) => worktree.path),
		]),
	].sort();
	const [state, setState] = useState(emptyState);
	const [filter, setFilter] = useState('open');
	const [selectedId, setSelectedId] = useState('');
	const [project, setProject] = useState('');
	const [client, setClient] = useState<'codex' | 'claude'>('codex');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [message, setMessage] = useState('');
	const pending = useRef(false);
	const generation = useRef(0);
	const mounted = useRef(true);
	const available = typeof bridge?.getFailureState === 'function';
	const records = state.records.filter(
		(record) =>
			filter === 'all' ||
			(filter === 'resolved'
				? record.resolvedAt !== undefined
				: record.resolvedAt === undefined && record.severity !== 'info')
	);
	const selected =
		records.find((record) => record.id === selectedId) ?? records[0];
	const openCount = state.records.filter(
		(record) => record.resolvedAt === undefined && record.severity !== 'info'
	).length;

	const refresh = useCallback(async () => {
		if (!bridge?.getFailureState || pending.current) return;
		const requestGeneration = ++generation.current;
		const current = () =>
			mounted.current &&
			!pending.current &&
			requestGeneration === generation.current;
		try {
			const next = await bridge.getFailureState();
			if (current()) setState(next);
		} catch {
			if (current()) setError('Failure history could not be read.');
		}
	}, [bridge]);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		const timer = window.setInterval(() => void refresh(), 5_000);
		return () => {
			mounted.current = false;
			generation.current++;
			window.clearInterval(timer);
		};
	}, [refresh]);
	useEffect(() => {
		setProject(selected?.project ?? '');
	}, [selected?.project, selected?.id]);

	const run = async (request: FailureRequest) => {
		if (!bridge?.runFailureOperation || pending.current) return;
		pending.current = true;
		generation.current++;
		setBusy(true);
		setError('');
		setMessage('');
		try {
			const result = await bridge.runFailureOperation(request);
			if (mounted.current) {
				setState(result.state);
				setMessage(
					result.cancelled ? 'Task cancelled.' : (result.message ?? '')
				);
			}
		} catch (failure) {
			if (mounted.current)
				setError(
					failure instanceof Error ? failure.message : 'The action failed.'
				);
		} finally {
			pending.current = false;
			if (mounted.current) setBusy(false);
		}
	};

	return (
		<section className="failure-view" aria-label="Failure history">
			<div className="failure-toolbar">
				<div>
					<h2>
						Failures &amp; events{' '}
						<span className="failure-count">{openCount} open</span>
					</h2>
					<p>Local crash reports and lane history, retained across restarts.</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					isDisabled={!available || busy}
					onPress={() => void run({ operation: 'scan' })}
				>
					<RefreshCw className="h-3.5 w-3.5" /> Scan now
				</Button>
			</div>
			<div className="failure-controls">
				<label>
					Show
					<select
						aria-label="Failure filter"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					>
						<option value="open">Open failures</option>
						<option value="all">All events</option>
						<option value="resolved">Resolved</option>
					</select>
				</label>
				<span className="failure-muted">
					{state.monitoring ? 'Monitoring' : 'Not monitoring'}
					{state.checkedAt
						? ` · Checked ${new Date(state.checkedAt).toLocaleTimeString()}`
						: ''}{' '}
					· Latest 200 events
				</span>
			</div>
			{!available ? (
				<PanelNotice tone="warning" title="Failure history unavailable">
					Open the desktop app to view failure history.
				</PanelNotice>
			) : null}
			{error ? (
				<PanelNotice tone="danger" title="Action needs attention">
					{error}
				</PanelNotice>
			) : null}
			{message ? (
				<div className="failure-feedback" role="status">
					<CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
					<span>{message}</span>
				</div>
			) : null}
			{state.issues.map((issue) => (
				<PanelNotice
					key={issue}
					tone="warning"
					title="Monitoring is incomplete"
				>
					{issue}
				</PanelNotice>
			))}
			<div className="failure-layout">
				<div className="failure-list">
					{records.length === 0 ? (
						<div className="failure-empty">
							<CheckCircle2 className="h-6 w-6" />
							<strong>No matching failures</strong>
							<p>
								New lane exits and simulator crash reports appear here.
								Diagnostic reports cover the last 30 days.
							</p>
						</div>
					) : (
						records.map((record) => (
							<button
								key={record.id}
								type="button"
								className="failure-row"
								aria-pressed={selected?.id === record.id}
								onClick={() => {
									setSelectedId(record.id);
									setMessage('');
								}}
							>
								<AlertTriangle
									className={`h-4 w-4 failure-${record.severity}`}
								/>
								<span>
									<strong>{record.title}</strong>
									<small>
										{new Date(record.at).toLocaleString()}
										{record.resolvedAt !== undefined ? ' · Resolved' : ''}
									</small>
									<small>
										{record.project
											? shortPath(record.project)
											: (record.simulatorUdid?.slice(0, 8) ??
												'Host diagnostic')}
									</small>
								</span>
							</button>
						))
					)}
				</div>
				{selected ? (
					<article className="failure-detail">
						<div className="failure-detail-heading">
							<span className={`failure-kind failure-${selected.severity}`}>
								{selected.kind.replaceAll('-', ' ')}
							</span>
							<span className="failure-muted">{selected.source}</span>
						</div>
						<h3>{selected.title}</h3>
						<dl className="failure-metadata">
							<dt>Observed</dt>
							<dd>{new Date(selected.at).toLocaleString()}</dd>
							{selected.simulatorUdid ? (
								<>
									<dt>Simulator</dt>
									<dd>{selected.simulatorUdid}</dd>
								</>
							) : null}
							{selected.port ? (
								<>
									<dt>Metro</dt>
									<dd>
										Port {selected.port} · PID {selected.metroPid ?? 'unknown'}
									</dd>
								</>
							) : null}
						</dl>
						<pre className="failure-evidence">{selected.detail}</pre>
						<div className="failure-agent">
							<h4>Investigate on this Mac</h4>
							<p>
								Opens your installed CLI in Terminal with its subscription
								login. Review the diagnosis and any edits there.
							</p>
							<label>
								Project
								<select
									aria-label="Failure project"
									value={projects.includes(project) ? project : ''}
									onChange={(event) => setProject(event.target.value)}
								>
									<option value="">Choose a registered project…</option>
									{projects.map((value) => (
										<option key={value} value={value}>
											{shortPath(value)}
										</option>
									))}
								</select>
							</label>
							<label>
								Agent
								<select
									aria-label="Failure agent"
									value={client}
									onChange={(event) =>
										setClient(
											event.target.value === 'claude' ? 'claude' : 'codex'
										)
									}
								>
									<option value="codex">Codex · ChatGPT subscription</option>
									<option value="claude">
										Claude Code · Claude subscription
									</option>
								</select>
							</label>
							<div className="failure-actions">
								<Button
									size="sm"
									variant="secondary"
									isDisabled={busy || !projects.includes(project)}
									onPress={() =>
										void run({
											operation: 'handoff',
											id: selected.id,
											client,
											mode: 'investigate',
											project,
										})
									}
								>
									<Search className="h-3.5 w-3.5" /> Investigate
								</Button>
								<Button
									size="sm"
									variant="primary"
									isDisabled={busy || !projects.includes(project)}
									onPress={() =>
										void run({
											operation: 'handoff',
											id: selected.id,
											client,
											mode: 'fix',
											project,
										})
									}
								>
									<Wrench className="h-3.5 w-3.5" /> Fix with{' '}
									{client === 'claude' ? 'Claude' : 'Codex'}
								</Button>
							</div>
						</div>
						<div className="failure-actions">
							<Button
								size="sm"
								variant="ghost"
								onPress={() => {
									void navigator.clipboard
										.writeText(JSON.stringify(selected, null, 2))
										.then(
											() => setMessage('Diagnostic copied.'),
											() => setError('Could not copy the diagnostic.')
										);
								}}
							>
								<ClipboardCopy className="h-3.5 w-3.5" /> Copy diagnostic
							</Button>
							<Button
								size="sm"
								variant="ghost"
								isDisabled={busy}
								onPress={() =>
									void run({
										operation: 'resolve',
										id: selected.id,
										resolved: selected.resolvedAt === undefined,
									})
								}
							>
								{selected.resolvedAt !== undefined ? 'Reopen' : 'Mark resolved'}
							</Button>
						</div>
					</article>
				) : null}
			</div>
		</section>
	);
}
