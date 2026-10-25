import { Button } from '@heroui/react/button';
import {
	Bot,
	CircleAlert,
	DatabaseZap,
	Link2,
	Link2Off,
	RefreshCw,
	Unlink,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AgentGlyph } from '@/components/lane-ui';
import { HolderBadge } from '@/components/supabase-ui';
import {
	Badge,
	ConfirmAction,
	DisabledReason,
	Disclosure,
	KeyValue,
	PanelNotice,
} from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import {
	type ReleaseBackendPrompt,
	releaseBackendPrompt,
	type SessionBackendView,
	sessionAttachmentLabel,
	sessionRequestLines,
	sessionSupabaseBackends,
	supabaseChipsVisible,
} from '@/simulator/supabase-cross-panel';
import {
	supabaseStackDeadlines,
	supabaseStateClock,
} from '@/simulator/supabase-model';
import { useAgentRuntime } from '@/state/agent-runtime';
import {
	useSupabaseActions,
	useSupabaseNavigation,
	useSupabaseNow,
	useSupabaseState,
} from '@/state/supabase-runtime';
import type {
	AgentSession,
	AgentState,
	DeviceAgent,
} from '../../../shared/agent-protocol';
import { agentSessionKey } from '../../../shared/agent-protocol';
import type { SimulatorDevice } from '../../../shared/simulator-protocol';
import { supabaseStackTitle } from '../../../shared/supabase-protocol';

/**
 * Groups the per-device attachments by session, so the view answers "what is
 * this agent driving?" as well as "who is on this Simulator?". Sessions with
 * no device still appear: an idle agent is information too.
 */
export function sessionsWithDevices(
	state: Pick<AgentState, 'sessions' | 'byDevice'>
): Array<{
	session: AgentSession;
	devices: Array<{ udid: string; attachment: DeviceAgent }>;
}> {
	const byKey = new Map(
		state.sessions.map((session) => [
			agentSessionKey(session),
			{
				session,
				devices: [] as Array<{ udid: string; attachment: DeviceAgent }>,
			},
		])
	);
	for (const [udid, attachments] of Object.entries(state.byDevice)) {
		for (const attachment of attachments) {
			const key = agentSessionKey(attachment);
			const entry = byKey.get(key) ?? {
				session: attachment,
				devices: [],
			};
			entry.devices.push({ udid, attachment });
			byKey.set(key, entry);
		}
	}
	return [...byKey.values()].sort((left, right) => {
		if (left.devices.length !== right.devices.length) {
			return right.devices.length - left.devices.length;
		}
		return (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0);
	});
}

function viaLabel(via: DeviceAgent['via']): string {
	switch (via) {
		case 'claim':
			return 'claimed';
		case 'touch':
			return 'driving';
		default:
			return 'lane cwd';
	}
}

export function AgentsView({
	devices,
	onSelectSimulator,
	focusSessionKey = null,
	onFocusHandled,
}: {
	devices: readonly SimulatorDevice[];
	onSelectSimulator: (udid: string) => void;
	/** A session card another panel asked for (`kind:sessionId`). */
	focusSessionKey?: string | null;
	onFocusHandled?: () => void;
}) {
	const agents = useAgentRuntime();
	const { state: supabase } = useSupabaseState();
	const backendsShown = supabaseChipsVisible(supabase);
	const deviceByUdid = useMemo(
		() => new Map(devices.map((device) => [device.udid.toUpperCase(), device])),
		[devices]
	);
	const rows = useMemo(() => sessionsWithDevices(agents.state), [agents.state]);
	const { discovery } = agents.state;
	const now = supabaseStateClock(
		supabase,
		useSupabaseNow(
			{ deadlines: supabase.stacks.flatMap(supabaseStackDeadlines) },
			backendsShown
		)
	);
	const listRef = useRef<HTMLUListElement>(null);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const { isLoading: agentsLoading } = agents;
	// A deep link from Supabase lands on its session's card, once the first
	// agent state has rendered; an unknown session just opens the view.
	useEffect(() => {
		if (focusSessionKey === null) return;
		const card = [
			...(listRef.current?.querySelectorAll<HTMLElement>(
				'[data-session-key]'
			) ?? []),
		].find((element) => element.dataset.sessionKey === focusSessionKey);
		if (!card && agentsLoading) return;
		if (card) {
			card.scrollIntoView({ block: 'nearest' });
			card.focus();
			setHighlighted(focusSessionKey);
		}
		onFocusHandled?.();
	}, [agentsLoading, focusSessionKey, onFocusHandled]);

	return (
		<div className="agents-view panel-scroll">
			<div className="agents-toolbar">
				<p className="sim-inline-note">
					{backendsShown
						? 'Live Claude Code and Codex sessions on this Mac and the Simulators and local Supabase stacks each one is attached to.'
						: 'Live Claude Code and Codex sessions on this Mac and the Simulators each one is attached to.'}{' '}
					Attribution comes from explicit claims, recent CLI commands, and lanes
					whose worktree holds the session’s working directory. A claim is a
					hold: until it is released, other agents can’t run lanes on, send
					input to, install on, slim, or run recipes on the claimed Simulator.
				</p>
				<Button
					aria-label="Refresh agents"
					className="sim-icon-button"
					isDisabled={!agents.isBridgeAvailable}
					isIconOnly
					size="sm"
					variant="secondary"
					onPress={() => void agents.refresh()}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</Button>
			</div>
			{agents.error ? (
				<PanelNotice title="Agent state could not be read." tone="danger">
					{agents.error}
				</PanelNotice>
			) : null}
			{discovery.claude === 'unavailable' &&
			discovery.codex === 'unavailable' ? (
				<PanelNotice title="No agent registries found." tone="info">
					Claude Code sessions are read from <code>~/.claude/sessions</code> and
					Codex threads from <code>~/.codex</code>. Neither exists on this Mac,
					so only CLI touches and claims can attribute devices.
				</PanelNotice>
			) : null}
			{discovery.error ? (
				<PanelNotice
					title="Session discovery reported a problem."
					tone="warning"
				>
					{discovery.error}
				</PanelNotice>
			) : null}
			{rows.length === 0 ? (
				<div className="lane-empty">
					<Bot className="h-5 w-5" />
					<strong>No live agent sessions</strong>
					<span>
						Start Claude Code or Codex in a worktree, or run any{' '}
						<code>rndevtools</code> command from inside one, and it appears here
						with the Simulators it touches.
					</span>
				</div>
			) : (
				<ul className="agent-list" ref={listRef}>
					{rows.map(({ session, devices: attached }) => {
						const key = agentSessionKey(session);
						const backends = sessionSupabaseBackends(session, supabase);
						const requests = sessionRequestLines(session, supabase, now);
						return (
							<li
								className={`agent-card ${highlighted === key ? 'is-focused' : ''}`}
								data-session-key={key}
								key={key}
								tabIndex={-1}
							>
								<div className="agent-card-head">
									<AgentGlyph kind={session.kind} />
									<div className="agent-card-title">
										<strong className="agent-card-name">{session.title}</strong>
										<span className="agent-card-meta">
											{session.kind}
											{session.status ? ` · ${session.status}` : ''}
											{session.pid ? ` · pid ${session.pid}` : ''}
											{session.updatedAt
												? ` · ${new Date(session.updatedAt).toLocaleTimeString()}`
												: ''}
										</span>
									</div>
									<Badge
										tone={
											attached.length + backends.length > 0 ? 'info' : 'default'
										}
									>
										{sessionAttachmentLabel(attached.length, backends.length)}
									</Badge>
								</div>
								{session.cwd ? (
									<code className="agent-card-cwd" title={session.cwd}>
										{shortPath(session.cwd)}
									</code>
								) : null}
								{attached.length > 0 ? (
									<ul className="agent-devices">
										{attached.map(({ udid, attachment }) => {
											const device = deviceByUdid.get(udid.toUpperCase());
											return (
												<li key={udid} className="agent-device">
													<button
														type="button"
														className="agent-device-name"
														onClick={() => onSelectSimulator(udid)}
													>
														{device?.name ?? udid}
														{device ? (
															<span className="agent-device-state">
																{' '}
																· {device.state}
															</span>
														) : null}
													</button>
													<Badge
														tone={
															attachment.via === 'claim'
																? 'brand'
																: attachment.via === 'touch'
																	? 'success'
																	: 'default'
														}
													>
														{viaLabel(attachment.via)}
														{!attachment.live ? ' · session gone' : ''}
													</Badge>
													{attachment.note ? (
														<span className="agent-device-note">
															{attachment.note}
														</span>
													) : null}
													{attachment.via === 'claim' ? (
														<Button
															aria-label={`Release ${device?.name ?? udid}`}
															className="sim-icon-button"
															isIconOnly
															size="sm"
															variant="ghost"
															onPress={() =>
																void agents.runOperation({
																	kind: 'agent.release',
																	simulatorUdid: udid,
																	agent: {
																		kind: attachment.kind,
																		sessionId: attachment.sessionId,
																	},
																})
															}
														>
															<Link2Off className="h-3.5 w-3.5" />
														</Button>
													) : (
														<Button
															aria-label={`Claim ${device?.name ?? udid} for ${session.title}`}
															className="sim-icon-button"
															isIconOnly
															size="sm"
															variant="ghost"
															onPress={() =>
																void agents.runOperation({
																	kind: 'agent.claim',
																	simulatorUdid: udid,
																	agent: {
																		kind: session.kind,
																		sessionId: session.sessionId,
																	},
																	note: 'Claimed from the desktop.',
																})
															}
														>
															<Link2 className="h-3.5 w-3.5" />
														</Button>
													)}
												</li>
											);
										})}
									</ul>
								) : null}
								{backends.length > 0 ? (
									<SessionBackends backends={backends} now={now} />
								) : null}
								{requests.length > 0 ? (
									<SessionRequests requests={requests} />
								) : null}
								<Disclosure title="Session details">
									<dl>
										<KeyValue
											label="Session id"
											mono
											value={session.sessionId}
										/>
										{session.cwd ? (
											<KeyValue
												label="Working directory"
												mono
												value={session.cwd}
											/>
										) : null}
										{session.startedAt ? (
											<KeyValue
												label="Started"
												value={new Date(session.startedAt).toLocaleString()}
											/>
										) : null}
									</dl>
								</Disclosure>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/**
 * The local Supabase stacks a session holds: the lane chip, how it holds
 * each one and whether it is still around, Open in Supabase, and Release
 * for its session and worktree holds.
 */
function SessionBackends({
	backends,
	now,
}: {
	backends: readonly SessionBackendView[];
	now: number;
}) {
	const { state, isBridgeAvailable } = useSupabaseState();
	const { run, isStackPending } = useSupabaseActions();
	const { openInSupabase } = useSupabaseNavigation();
	const clocksPaused = state.discovery.sessions === 'unavailable';
	return (
		<div className="agent-backends">
			<p className="agent-backends-label">Backends</p>
			<ul className="agent-devices">
				{backends.map((backend) => {
					const title = supabaseStackTitle(backend.stack);
					const prompt = releaseBackendPrompt(backend, state, {
						bridgeAvailable: isBridgeAvailable,
						pending: isStackPending(backend.stack.id),
					});
					return (
						<li className="agent-device agent-backend" key={backend.key}>
							<Badge className="supabase-chip" tone={backend.chip.tone}>
								{backend.chip.label}
							</Badge>
							<span className="agent-backend-name">{backend.text}</span>
							{backend.hold ? (
								<HolderBadge
									clocksPaused={clocksPaused}
									hold={backend.hold}
									lanes={backend.stack.lanes}
									now={now}
									pinned={backend.stack.pinned}
								/>
							) : null}
							<span className="agent-backend-actions">
								<Button
									aria-label={`Open ${title} in Supabase`}
									size="sm"
									variant="ghost"
									onPress={() => openInSupabase({ stackId: backend.stack.id })}
								>
									<DatabaseZap className="h-3.5 w-3.5" /> Open in Supabase
								</Button>
								{prompt ? (
									<ReleaseBackend
										prompt={prompt}
										onRelease={() => void run(prompt.operation)}
									/>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** Release: a ConfirmAction while the holder is live, at once once it is gone. */
function ReleaseBackend({
	prompt,
	onRelease,
}: {
	prompt: ReleaseBackendPrompt;
	onRelease: () => void;
}) {
	const reasonId = useId();
	const { availability } = prompt;
	if (prompt.confirm) {
		return (
			<ConfirmAction
				ariaLabel={prompt.label}
				confirmLabel="Release"
				description={prompt.description}
				{...(availability.allowed
					? {}
					: { disabledReason: availability.reason })}
				title={prompt.title}
				tone="warning"
				triggerIcon={<Unlink className="h-3.5 w-3.5" />}
				triggerLabel="Release…"
				onConfirm={onRelease}
			/>
		);
	}
	return (
		<>
			<Button
				{...(availability.allowed ? {} : { 'aria-describedby': reasonId })}
				aria-label={prompt.label}
				isDisabled={!availability.allowed}
				size="sm"
				variant="ghost"
				onPress={onRelease}
			>
				<Unlink className="h-3.5 w-3.5" /> Release
			</Button>
			{availability.allowed ? null : (
				<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
			)}
		</>
	);
}

/** What the session asked the user to approve, with a way to review it. */
function SessionRequests({
	requests,
}: {
	requests: readonly Readonly<{ id: string; text: string }>[];
}) {
	const { openInSupabase } = useSupabaseNavigation();
	return (
		<ul className="agent-devices agent-requests">
			{requests.map((request) => (
				<li className="agent-device agent-request" key={request.id}>
					<CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
					<span className="agent-request-text">{request.text}</span>
					<Button
						size="sm"
						variant="ghost"
						onPress={() => openInSupabase({ view: 'requests' })}
					>
						Review in Supabase
					</Button>
				</li>
			))}
		</ul>
	);
}
