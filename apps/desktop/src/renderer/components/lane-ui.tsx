import { Asterisk, ChevronRight, Cpu } from 'lucide-react';
import { Badge } from '@/components/ui';
import { agentLabel, shortPath } from '@/simulator/fleet-model';
import type { Lane, LaneAgent } from '../../shared/lane-protocol';
import { laneHealth, laneSlimSummary } from '../../shared/lane-protocol';

/**
 * Chips shared by the fleet wall and the Lanes panel. They only read the
 * shared protocol shapes, so the two panels cannot drift in how a lane or an
 * agent is described.
 */

export function LaneChip({
	lane,
	compact = false,
}: {
	lane: Lane;
	compact?: boolean;
}) {
	const health = laneHealth(lane);
	return (
		<span className="lane-chip" title={lane.worktreePath}>
			<Badge tone={health.tone} className="lane-chip-port">
				:{lane.port} {health.label}
			</Badge>
			{!compact ? (
				<code className="lane-chip-branch">{lane.branch}</code>
			) : null}
			{!compact ? <Badge>{lane.environment}</Badge> : null}
		</span>
	);
}

/** The lane's own slimming request (not the device's measured slim level). */
export function LaneSlimBadge({ lane }: { lane: Pick<Lane, 'slim'> }) {
	const summary = laneSlimSummary(lane.slim);
	if (!summary) return null;
	return (
		<Badge
			className="lane-slim-badge"
			tone={summary.tone === 'muted' ? 'default' : summary.tone}
		>
			{summary.label}
		</Badge>
	);
}

export function AgentGlyph({ kind }: { kind: LaneAgent['kind'] }) {
	const Icon =
		kind === 'claude' ? Asterisk : kind === 'codex' ? ChevronRight : Cpu;
	return (
		<span className={`agent-glyph is-${kind}`} aria-hidden="true">
			<Icon className="h-3 w-3" strokeWidth={2.5} />
		</span>
	);
}

/**
 * Which coding agent holds this lane. This is the headline signal on a busy
 * wall, so it gets the only saturated colour on a row. Any holder with a kind
 * and a session fits, so Supabase stack holders render the same badge.
 */
export function AgentBadge({
	agent,
	showSession = false,
}: {
	agent: Pick<LaneAgent, 'kind' | 'sessionId'> & { lastSeenAt?: number };
	showSession?: boolean;
}) {
	return (
		<span
			className={`agent-badge is-${agent.kind}`}
			title={`${agentLabel(agent.kind)} session ${agent.sessionId}`}
		>
			<AgentGlyph kind={agent.kind} />
			<span>{agentLabel(agent.kind)}</span>
			{showSession ? (
				<code className="agent-badge-session">{agent.sessionId}</code>
			) : null}
		</span>
	);
}

export function WorktreeLabel({
	path,
	branch,
}: {
	path: string;
	branch: string;
}) {
	return (
		<span className="worktree-label" title={path}>
			<code className="worktree-label-branch">{branch}</code>
			<span className="worktree-label-path">{shortPath(path)}</span>
		</span>
	);
}
