import { Card } from '@heroui/react/card';
import {
	Activity,
	CircleAlert,
	Cpu,
	DatabaseZap,
	Laptop2,
	Radio,
	ShieldCheck,
	TerminalSquare,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { SupabaseChip } from '@/components/supabase-ui';
import {
	CopyButton,
	EmptyPanel,
	InlineCode,
	PanelHeader,
	PanelNotice,
	SearchControl,
	SectionCard,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { type AppTraffic, useAppTraffic } from '@/lib/app-traffic';
import {
	boundedTextExport,
	formatClock,
	formatRelativeTime,
} from '@/lib/format';
import { appTrafficHealth } from '@/simulator/app-traffic-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { DiagnosticEntry } from '../../shared/protocol';

const MAX_RENDERED_DIAGNOSTICS = 500;

export function levelTone(level: DiagnosticEntry['level']) {
	if (level === 'error') return 'danger' as const;
	if (level === 'warn') return 'warning' as const;
	if (level === 'info') return 'info' as const;
	return 'default' as const;
}

type HealthTone = 'brand' | 'warning' | 'danger' | 'default';

/**
 * Health-card tone. Blue is reserved for neutral information elsewhere, so the
 * cards use the brand green for a healthy/positive reading, amber for a pending
 * or attention state, red for a hard failure, and the default grey for a
 * reading with no verdict. Pure for unit testing.
 */
export function brokerTone(status: string | undefined): HealthTone {
	if (status === 'listening') return 'brand';
	if (status === 'error') return 'danger';
	return 'warning';
}

/** An app-traffic verdict as a card tone: only "uses this stack" is green. */
export function trafficHealthTone(
	tone: 'success' | 'warning' | 'danger' | 'default'
): HealthTone {
	return tone === 'success' ? 'brand' : tone;
}

export function DiagnosticsPanel() {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	const [query, setQuery] = useState('');
	const entries = useMemo(
		() => [
			...(state?.diagnostics ?? []),
			...(selectedDevice?.tools.diagnostics ?? []),
		],
		[state?.diagnostics, selectedDevice?.tools.diagnostics]
	);
	const matching = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter(
				(entry) =>
					!needle ||
					[entry.level, entry.scope, entry.message]
						.join(' ')
						.toLowerCase()
						.includes(needle)
			)
			.sort((left, right) => right.at - left.at);
	}, [entries, query]);
	const filtered = matching.slice(0, MAX_RENDERED_DIAGNOSTICS);
	const broker = state?.broker;
	const latestSample = selectedDevice?.tools.performance.samples.at(-1);
	const traffic = useAppTraffic();
	const exportText = useMemo(
		() =>
			boundedTextExport(
				filtered,
				(entry) =>
					`${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`
			),
		[filtered]
	);

	return (
		<section className="panel-root">
			<PanelHeader
				title="Diagnostics"
				description="Desktop broker health, device transport, runtime versions, privacy guarantees, and internal diagnostic events in one place."
				meta={
					<StatusPill
						dot
						tone={
							broker?.status === 'listening'
								? 'success'
								: broker?.status === 'error'
									? 'danger'
									: 'warning'
						}
					>
						{broker?.status ?? 'starting'}
					</StatusPill>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search diagnostics"
					placeholder="Scope, level, message…"
					value={query}
					onChange={setQuery}
				/>
				<span className="ml-auto font-mono text-xs text-(--text-3)">
					{filtered.length} of {matching.length} events
				</span>
			</Toolbar>
			{matching.length > filtered.length || exportText.truncated ? (
				<PanelNotice title="Diagnostic rendering is bounded." tone="info">
					Search covers all {matching.length} matching events. The stream and
					copy action use the newest {MAX_RENDERED_DIAGNOSTICS}, and copied text
					is capped at 2 MB.
				</PanelNotice>
			) : null}
			<div className="panel-scroll p-5">
				<div
					className={`mb-4 grid gap-3 ${traffic.enabled ? 'grid-cols-5 max-[1180px]:grid-cols-3' : 'grid-cols-4 max-[1180px]:grid-cols-2'}`}
				>
					<HealthCard
						icon={<Radio className="h-4 w-4" />}
						label="Broker"
						value={broker?.status ?? 'Starting'}
						detail={
							broker
								? `${broker.host}:${broker.port}`
								: 'Creating local listener'
						}
						tone={brokerTone(broker?.status)}
					/>
					<HealthCard
						icon={<Laptop2 className="h-4 w-4" />}
						label="Selected device"
						value={selectedDevice?.status ?? 'None'}
						detail={
							selectedDevice
								? `${selectedDevice.info.name} · ${formatRelativeTime(selectedDevice.lastSeenAt)}`
								: 'Waiting for a session'
						}
						tone={
							!selectedDevice || selectedDevice.status === 'offline'
								? 'warning'
								: 'brand'
						}
					/>
					<HealthCard
						icon={<Activity className="h-4 w-4" />}
						label="JS responsiveness"
						value={
							latestSample
								? `${latestSample.jsFps.toFixed(0)} fps`
								: 'Unavailable'
						}
						detail={
							latestSample
								? `${latestSample.eventLoopLagMs.toFixed(1)} ms loop lag`
								: 'Start a performance review'
						}
						tone={
							!latestSample
								? 'warning'
								: latestSample.eventLoopLagMs > 32
									? 'warning'
									: 'brand'
						}
					/>
					<HealthCard
						icon={<ShieldCheck className="h-4 w-4" />}
						label="Transport"
						value={
							broker?.access === 'token' ? 'Token protected' : 'Loopback only'
						}
						detail={
							broker?.access === 'token'
								? `Authenticated access on ${broker.host}; traffic is not encrypted by ws://`
								: 'Only this computer can connect'
						}
						tone={brokerTone(broker?.status)}
					/>
					{traffic.enabled ? <LocalSupabaseCard traffic={traffic} /> : null}
				</div>

				<div className="mb-4 grid grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)] gap-4 max-[1080px]:grid-cols-1">
					<SectionCard
						bodyClassName="p-0"
						icon={<Radio className="h-4 w-4" />}
						title="Connection endpoints"
					>
						<p className="m-0 border-b border-foreground/8 px-4 py-3 text-xs text-(--text-3)">
							Use the first reachable WebSocket URL from a development device.
						</p>
						{broker?.urls.map((url) => (
							<div
								className="flex items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
								key={url}
							>
								<span
									className={`h-1.5 w-1.5 shrink-0 rounded-full ${broker.status === 'listening' ? 'bg-(--brand)' : 'bg-(--danger)'}`}
								/>
								<InlineCode className="min-w-0 flex-1 truncate">
									{url}
								</InlineCode>
								<CopyButton label="Copy endpoint" value={url} />
							</div>
						))}
						{broker?.urls.length === 0 ? (
							<p className="m-0 px-4 py-3 text-xs text-(--text-3)">
								No connection endpoint is available.
							</p>
						) : null}
						{broker?.error ? (
							<div className="flex items-start gap-2 border-t border-danger/15 bg-danger/[0.05] px-4 py-3 text-xs leading-5 text-danger-text">
								<CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{' '}
								{broker.error}
							</div>
						) : null}
					</SectionCard>
					<SectionCard
						bodyClassName="p-4"
						icon={<Cpu className="h-4 w-4" />}
						title="Runtime"
					>
						<VersionRow label="App" value={bootstrap?.versions.app ?? '—'} />
						<VersionRow
							label="Electron"
							value={bootstrap?.versions.electron ?? '—'}
						/>
						<VersionRow
							label="Chromium"
							value={bootstrap?.versions.chrome ?? '—'}
						/>
						<VersionRow label="Node" value={bootstrap?.versions.node ?? '—'} />
						<VersionRow
							label="Protocol"
							value={state ? `v${state.protocolVersion}` : '—'}
						/>
					</SectionCard>
				</div>

				<SectionCard
					actions={
						exportText.text ? (
							<CopyButton
								label={
									exportText.truncated
										? 'Copy bounded diagnostic events'
										: 'Copy diagnostic events'
								}
								value={exportText.text}
							/>
						) : undefined
					}
					bodyClassName="p-0"
					icon={<TerminalSquare className="h-4 w-4" />}
					title="Internal event stream"
				>
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<TerminalSquare className="h-5 w-5" />}
							title="No diagnostic events"
							description="Broker and device lifecycle events will appear here."
						/>
					) : (
						filtered.map((entry) => (
							<div
								className="grid grid-cols-[78px_72px_110px_minmax(0,1fr)] items-start gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
								key={`${entry.scope}-${entry.id}`}
							>
								<span className="font-mono text-xs text-(--text-3)">
									{formatClock(entry.at)}
								</span>
								<StatusPill tone={levelTone(entry.level)}>
									{entry.level}
								</StatusPill>
								<InlineCode className="truncate">{entry.scope}</InlineCode>
								<span className="text-xs leading-4 text-(--foreground)">
									{entry.message}
								</span>
							</div>
						))
					)}
				</SectionCard>
			</div>
		</section>
	);
}

/**
 * The connected app's backend: the verdict over its captured traffic, its
 * lane's stack, and the lane's chip. Never green without evidence.
 */
function LocalSupabaseCard({ traffic }: { traffic: AppTraffic }) {
	const health = appTrafficHealth(traffic);
	return (
		<HealthCard
			capitalize={false}
			detail={health.detail}
			footer={
				traffic.lane?.backend ? (
					<SupabaseChip summary={traffic.lane.backend} />
				) : undefined
			}
			icon={<DatabaseZap className="h-4 w-4" />}
			label="Local Supabase"
			tone={trafficHealthTone(health.tone)}
			value={health.value}
		/>
	);
}

function HealthCard({
	icon,
	label,
	value,
	detail,
	tone,
	capitalize = true,
	footer,
}: {
	icon: ReactNode;
	label: string;
	value: string;
	detail: string;
	tone: HealthTone;
	/** Readings that are sentences, such as a traffic verdict, keep their case. */
	capitalize?: boolean;
	footer?: ReactNode;
}) {
	const color = {
		brand: 'border-(--brand-border) bg-(--brand-soft) text-(--brand-text)',
		warning: 'border-warning/15 bg-warning/[0.055] text-warning-text',
		danger: 'border-danger/15 bg-danger/[0.055] text-danger-text',
		default: 'border-foreground/10 bg-foreground/[0.04] text-(--muted)',
	}[tone];
	return (
		<Card
			className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-4 shadow-none"
			variant="secondary"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
						{label}
					</p>
					<p
						className={`mb-0 mt-2 truncate text-sm font-semibold text-(--foreground) ${capitalize ? 'capitalize' : ''}`}
						title={value}
					>
						{value}
					</p>
				</div>
				<span
					className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${color}`}
				>
					{icon}
				</span>
			</div>
			<p className="mb-0 mt-3 truncate text-xs text-(--text-3)" title={detail}>
				{detail}
			</p>
			{footer ? <div className="mt-2 flex">{footer}</div> : null}
		</Card>
	);
}

function VersionRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] py-2 first:border-0">
			<span className="text-xs text-(--text-3)">{label}</span>
			<InlineCode className="max-w-[170px] truncate">{value}</InlineCode>
		</div>
	);
}
