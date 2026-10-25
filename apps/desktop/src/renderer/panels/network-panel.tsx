import { Button } from '@heroui/react/button';
import {
	DataGrid,
	type DataGridColumn,
	type DataGridSelection,
} from '@heroui-pro/react/data-grid';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	matchesNetworkSegment,
	type NetworkSegment,
	SLOW_REQUEST_MS,
} from '@rndevtools/core/plugins/network-presentation';
import {
	ChevronDown,
	CirclePause,
	CirclePlay,
	DatabaseZap,
	Filter,
	Radio,
	Trash2,
	Wifi,
	WifiOff,
	X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	ConfirmAction,
	DetailPlaceholder,
	EmptyPanel,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	Toolbar,
} from '@/components/ui';
import {
	settleNetworkFilter,
	useAppTraffic,
	useNetworkFilterIntent,
} from '@/lib/app-traffic';
import {
	formatBytes,
	formatClock,
	formatDuration,
	truncateMiddle,
} from '@/lib/format';
import {
	type NetworkTargetBadge,
	type NetworkTargetFilter,
	networkTargetFilter,
	networkTargetKey,
} from '@/simulator/app-traffic-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useSupabaseNavigation } from '@/state/supabase-runtime';
import type { NetworkEntry } from '../../shared/protocol';
import type { SupabaseTrafficTarget } from '../../shared/supabase-traffic';

// Classification is shared with the on-device panel. The local copy disagreed
// with it: aborted requests were missing from `errors`, and `supabase` matched
// on a hard-coded host substring rather than the REST/functions/storage/auth
// path prefixes, so custom-domain traffic was classified differently on each
// surface.
type NetworkFilter = NetworkSegment;
type DetailTab = 'overview' | 'headers' | 'request' | 'response';

const DETAIL_TABS: readonly { id: DetailTab; label: string }[] = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'headers', label: 'Headers' },
	{ id: 'request', label: 'Request' },
	{ id: 'response', label: 'Response' },
];

const NETWORK_PROFILES = [
	{ id: 'offline', name: 'Offline' },
	{ id: 'edge', name: 'Edge' },
	{ id: '3g', name: '3G' },
	{ id: 'lte', name: 'LTE' },
	{ id: 'wifi', name: 'Wi-Fi' },
	{ id: 'dsl', name: 'DSL' },
	{ id: 'very-bad', name: 'Very Bad Network' },
] as const;
type NetworkProfileId = (typeof NETWORK_PROFILES)[number]['id'];

const NETWORK_FILTERS: {
	id: NetworkFilter;
	label: string;
}[] = [
	{ id: 'all', label: 'All' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'slow', label: 'Slow' },
	{ id: 'supabase', label: 'Backend' },
];

/** Durations share one 0 to 2 s scale, so bars compare across requests. */
const DURATION_SCALE_MS = 2_000;

export function durationBarPercent(durationMs: number | undefined): number {
	if (durationMs === undefined) return 0;
	return Math.max(
		3,
		Math.min(100, Math.round((durationMs / DURATION_SCALE_MS) * 100))
	);
}

const STATUS_REASONS: Readonly<Record<number, string>> = {
	200: 'OK',
	201: 'Created',
	202: 'Accepted',
	204: 'No Content',
	301: 'Moved Permanently',
	302: 'Found',
	304: 'Not Modified',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	409: 'Conflict',
	422: 'Unprocessable Content',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
};

/** `200 OK`, or the code alone when its reason phrase is not a common one. */
export function statusLabel(
	entry: Pick<NetworkEntry, 'state' | 'status'>
): string {
	if (entry.state === 'pending') return 'Pending';
	if (entry.status === undefined) return entry.state;
	const reason = STATUS_REASONS[entry.status];
	return reason ? `${entry.status} ${reason}` : String(entry.status);
}

/** A failure is red at any speed; otherwise slow requests are amber. */
export function durationTone(
	entry: Pick<NetworkEntry, 'state' | 'status' | 'durationMs'>
): 'success' | 'warning' | 'danger' | 'info' {
	if (entry.state === 'pending') return 'info';
	if (statusTone(entry) === 'danger') return 'danger';
	return (entry.durationMs ?? 0) >= SLOW_REQUEST_MS ? 'warning' : 'success';
}

/** JSON bodies indented two spaces; anything else, or cut short, as captured. */
export function prettyBody(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

/** How many values the device redacted before the body reached the desktop. */
export function redactedCount(value: string | undefined): number {
	return value?.match(/\[REDACTED(?:_[A-Z]+)?\]/g)?.length ?? 0;
}

/** Each view filter's count, before search and the backend filter. */
export function networkSegmentCounts(
	entries: readonly NetworkEntry[]
): Record<NetworkFilter, number> {
	return {
		all: entries.length,
		errors: entries.filter((entry) => matchesNetworkSegment(entry, 'errors'))
			.length,
		slow: entries.filter((entry) => matchesNetworkSegment(entry, 'slow'))
			.length,
		supabase: entries.filter((entry) =>
			matchesNetworkSegment(entry, 'supabase')
		).length,
	};
}

export function statusTone(
	entry: Pick<NetworkEntry, 'state' | 'status'>
): 'success' | 'warning' | 'danger' | 'info' {
	if (entry.state === 'pending') return 'info';
	if (
		entry.state === 'error' ||
		entry.state === 'aborted' ||
		(entry.status ?? 0) >= 400
	)
		return 'danger';
	if ((entry.status ?? 0) >= 300) return 'warning';
	return 'success';
}

export function headersText(
	headers: Record<string, string> | undefined
): string {
	if (!headers || Object.keys(headers).length === 0)
		return 'No captured headers.';
	return Object.entries(headers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
}

/**
 * Requests to one backend: the filter the connected banner's Show this
 * traffic asks for, kept per device so another app's list is never
 * narrowed by it.
 */
export function matchesNetworkTarget(
	target: SupabaseTrafficTarget | undefined,
	filter: NetworkTargetFilter | null
): boolean {
	return (
		filter === null ||
		(target !== undefined && networkTargetKey(target) === filter.key)
	);
}

/** Methods are neutral: colour is kept for outcomes, not verbs. */
function MethodChip({ method }: { method: string }) {
	return <span className="network-method">{method}</span>;
}

function StatusCode({
	entry,
	label,
}: {
	entry: Pick<NetworkEntry, 'state' | 'status'>;
	label: string;
}) {
	return (
		<span className={`network-status is-${statusTone(entry)}`}>{label}</span>
	);
}

export function NetworkPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const liveEntries = selectedDevice?.tools.network ?? [];
	const deviceId = selectedDevice?.info.id;
	const [pausedSnapshot, setPausedSnapshot] = useState<{
		deviceId: string | undefined;
		entries: NetworkEntry[];
	} | null>(null);
	const pausedEntries =
		pausedSnapshot && pausedSnapshot.deviceId === deviceId
			? pausedSnapshot.entries
			: null;
	const entries = pausedEntries ?? liveEntries;
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<NetworkFilter>('all');
	const [selectedId, setSelectedId] = useState<string | null>(
		entries[0]?.id ?? null
	);
	const [detailTab, setDetailTab] = useState<DetailTab>('overview');
	const currentProfile = selectedDevice?.tools.networkProfile;
	const [profileId, setProfileId] = useState<NetworkProfileId>(
		currentProfile?.id === 'none' || !currentProfile?.id
			? 'lte'
			: (currentProfile.id as NetworkProfileId)
	);
	const paused = pausedEntries !== null;
	const setProfileReason = actionUnavailableReason('network', 'setProfile');
	const traffic = useAppTraffic();
	const { targetFor, badgeFor } = traffic;
	const { openInSupabase } = useSupabaseNavigation();
	const [targetChip, setTargetChip] = useState<{
		deviceId: string | undefined;
		filter: NetworkTargetFilter;
	} | null>(null);
	const targetFilter =
		targetChip && targetChip.deviceId === deviceId ? targetChip.filter : null;
	const intent = useNetworkFilterIntent();
	useEffect(() => {
		if (!intent) return;
		// The banner's Show this traffic: the backend segment, one backend.
		setFilter('supabase');
		setTargetChip({ deviceId: intent.deviceId, filter: intent.target });
		settleNetworkFilter(intent.nonce);
	}, [intent]);
	useEffect(() => {
		if (pausedSnapshot && pausedSnapshot.deviceId !== deviceId) {
			setPausedSnapshot(null);
		}
	}, [deviceId, pausedSnapshot]);
	useEffect(() => {
		if (currentProfile?.id && currentProfile.id !== 'none') {
			setProfileId(currentProfile.id);
		}
	}, [currentProfile?.id]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter((entry) => {
				if (!matchesNetworkSegment(entry, filter)) return false;
				if (!matchesNetworkTarget(targetFor(entry), targetFilter)) return false;
				return (
					!needle ||
					[
						entry.method,
						entry.url,
						entry.host,
						entry.path,
						entry.status,
						entry.source,
					]
						.join(' ')
						.toLowerCase()
						.includes(needle)
				);
			})
			.sort((left, right) => right.at - left.at);
	}, [entries, filter, query, targetFilter, targetFor]);

	const segmentCounts = useMemo(() => networkSegmentCounts(entries), [entries]);
	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const columns = useMemo<DataGridColumn<NetworkEntry>[]>(
		() => [
			{
				id: 'method',
				header: 'Method',
				width: 76,
				isRowHeader: true,
				cell: (entry) => <MethodChip method={entry.method} />,
			},
			{
				id: 'request',
				header: 'Request',
				minWidth: 340,
				cell: (entry) => {
					const target = targetFor(entry);
					return (
						<div className="min-w-0 py-0.5">
							<div className="truncate font-mono text-xs text-(--foreground)">
								{entry.path}
							</div>
							<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-(--text-3)">
								{target ? <TargetBadge badge={badgeFor(target)} /> : null}
								<span className="truncate">
									{entry.host} {entry.source ? `· ${entry.source}` : ''}
								</span>
							</div>
						</div>
					);
				},
			},
			{
				id: 'status',
				header: 'Status',
				width: 76,
				cell: (entry) => (
					<StatusCode
						entry={entry}
						label={
							entry.state === 'pending'
								? 'Pending'
								: String(entry.status ?? entry.state)
						}
					/>
				),
			},
			{
				id: 'duration',
				header: 'Duration',
				width: 150,
				cell: (entry) => {
					const tone = durationTone(entry);
					return (
						<span className="network-duration">
							<span className={`network-duration-value is-${tone}`}>
								{formatDuration(entry.durationMs)}
							</span>
							<span aria-hidden="true" className="network-duration-track">
								<span
									className={`network-duration-bar is-${tone}`}
									style={{ width: `${durationBarPercent(entry.durationMs)}%` }}
								/>
							</span>
						</span>
					);
				},
			},
			{
				id: 'size',
				header: 'Size',
				width: 92,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--muted)">
						{formatBytes(entry.responseBytes)}
					</span>
				),
			},
			{
				id: 'at',
				header: 'Started',
				width: 88,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--text-3)">
						{formatClock(entry.at)}
					</span>
				),
			},
		],
		[badgeFor, targetFor]
	);

	const selectedTarget = selected ? targetFor(selected) : undefined;
	const selectedBackend = selectedTarget
		? {
				badge: badgeFor(selectedTarget),
				target: selectedTarget,
				onOpen: () =>
					openInSupabase(
						selectedTarget.kind === 'this-stack' ||
							selectedTarget.kind === 'other-stack'
							? { stackId: selectedTarget.stackId }
							: {}
					),
				onOnly: () => {
					setFilter('supabase');
					setTargetChip({
						deviceId,
						filter: networkTargetFilter(selectedTarget),
					});
				},
			}
		: undefined;

	function onSelectionChange(selection: DataGridSelection): void {
		if (selection === 'all') {
			setSelectedId(filtered[0]?.id ?? null);
			return;
		}
		const key = [...selection][0];
		setSelectedId(key === undefined ? null : String(key));
	}

	return (
		<section className="panel-root">
			<PanelHeader
				title="Network"
				description="Every instrumented request, with privacy-safe headers, bodies, timing, and failure context. Duration bars share one 0 to 2 s scale."
				meta={
					<span className={`network-live ${paused ? 'is-paused' : ''}`}>
						<span aria-hidden="true" className="network-live-dot" />
						{paused ? 'View paused' : 'Live view'} ·{' '}
						{filtered.length === entries.length
							? `${entries.length} requests`
							: `${filtered.length} of ${entries.length} requests`}
					</span>
				}
				actions={
					<>
						<Button
							aria-pressed={paused}
							size="sm"
							variant="secondary"
							onPress={() =>
								setPausedSnapshot(
									paused ? null : { deviceId, entries: [...liveEntries] }
								)
							}
						>
							{paused ? (
								<CirclePlay className="h-3.5 w-3.5" />
							) : (
								<CirclePause className="h-3.5 w-3.5" />
							)}
							{paused ? 'Resume view' : 'Pause view'}
						</Button>
						<ConfirmAction
							triggerLabel="Clear"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							title="Clear captured requests?"
							description="This only clears the diagnostics buffer. It does not cancel requests or change app data."
							confirmLabel="Clear requests"
							isDisabled={!canRunAction('network', 'clear')}
							onConfirm={() => {
								void runAction(
									'network',
									'clear',
									{},
									'Network buffer cleared.'
								).then((result) => {
									if (result.ok && paused) {
										setPausedSnapshot((current) =>
											current?.deviceId === deviceId
												? { deviceId, entries: [] }
												: current
										);
									}
								});
							}}
						/>
					</>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search network requests"
					placeholder="URL, method, status…"
					value={query}
					widthClassName="w-[260px] max-[1080px]:w-[200px]"
					onChange={setQuery}
				/>
				<fieldset className="sim-layout-toggle network-segments">
					<legend className="sr-only">Show requests</legend>
					{NETWORK_FILTERS.map(({ id, label }) => (
						<Button
							aria-pressed={filter === id}
							key={id}
							size="sm"
							variant={filter === id ? 'secondary' : 'ghost'}
							onPress={() => setFilter(id)}
						>
							{label}
							<span aria-hidden="true" className="network-segment-count">
								{segmentCounts[id]}
							</span>
						</Button>
					))}
				</fieldset>
				{targetFilter ? (
					<span className="network-target-filter">
						<Badge className="network-target-filter-label">
							{targetFilter.label}
						</Badge>
						<Button
							aria-label={`Show every backend, not only ${targetFilter.label}`}
							className="sim-icon-button"
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={() => setTargetChip(null)}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</span>
				) : null}
				<div className="network-profile">
					<div className="sim-toolbar-field">
						<span>Fetch profile</span>
						<NativeSelect className="sim-filter-select" fullWidth={false}>
							<NativeSelect.Trigger
								aria-label="Instrumented fetch network profile"
								value={profileId}
								onChange={(event) =>
									setProfileId(event.currentTarget.value as NetworkProfileId)
								}
							>
								{NETWORK_PROFILES.map((profile) => (
									<NativeSelect.Option key={profile.id} value={profile.id}>
										{profile.name}
									</NativeSelect.Option>
								))}
								<NativeSelect.Indicator>
									<ChevronDown className="h-3 w-3" />
								</NativeSelect.Indicator>
							</NativeSelect.Trigger>
						</NativeSelect>
					</div>
					<Button
						{...(setProfileReason
							? { 'aria-describedby': 'network-set-reason' }
							: {})}
						isDisabled={!canRunAction('network', 'setProfile')}
						size="sm"
						variant="secondary"
						onPress={() =>
							void runAction(
								'network',
								'setProfile',
								{ profileId },
								`${NETWORK_PROFILES.find((profile) => profile.id === profileId)?.name ?? profileId} fetch profile applied.`
							)
						}
					>
						<Wifi className="h-3.5 w-3.5" /> Set
					</Button>
					<Button
						{...(currentProfile?.active
							? {}
							: { 'aria-describedby': 'network-clear-reason' })}
						isDisabled={
							!canRunAction('network', 'clearProfile') ||
							!currentProfile?.active
						}
						size="sm"
						variant="ghost"
						onPress={() =>
							void runAction(
								'network',
								'clearProfile',
								{},
								'Instrumented fetch profile cleared.'
							)
						}
					>
						<WifiOff className="h-3.5 w-3.5" /> Clear
					</Button>
					{setProfileReason ? (
						<span className="sr-only" id="network-set-reason">
							{setProfileReason}
						</span>
					) : !currentProfile?.active ? (
						<span className="sr-only" id="network-clear-reason">
							No profile active
						</span>
					) : null}
				</div>
			</Toolbar>
			<PanelNotice
				title={
					setProfileReason
						? 'Fetch profiles are not available for this app'
						: currentProfile?.active
							? `${currentProfile.name} is active · instrumented requests only`
							: 'Network simulation is off'
				}
				tone="info"
			>
				{setProfileReason ? `${setProfileReason} ` : null}
				{currentProfile?.active
					? `${currentProfile.name} is active for instrumented fetch only. `
					: 'No network profile is currently active. '}
				Profiles do not change Simulator-wide networking, native SDK traffic,
				WebSockets, or requests from other apps.
			</PanelNotice>

			<div className="split-panel">
				<div className="min-w-0 overflow-hidden">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<Radio className="h-5 w-5" />}
							title="No matching requests"
							description="Adjust the filters or use the app to generate fresh network traffic."
						/>
					) : (
						<DataGrid
							aria-label="Captured network requests"
							className="desktop-grid"
							columns={columns}
							data={filtered}
							getRowId={(entry) => entry.id}
							headingHeight={36}
							rowHeight={42}
							selectedKeys={selected ? new Set([selected.id]) : new Set()}
							selectionMode="single"
							virtualized
							onSelectionChange={onSelectionChange}
						/>
					)}
				</div>
				<aside className="detail-pane">
					{selected ? (
						<NetworkDetail
							backend={selectedBackend}
							entry={selected}
							tab={detailTab}
							onTabChange={setDetailTab}
						/>
					) : (
						<DetailPlaceholder />
					)}
				</aside>
			</div>
		</section>
	);
}

/** The backend a Supabase-shaped request went to, beside its host. */
function TargetBadge({ badge }: { badge: NetworkTargetBadge }) {
	return (
		<Badge className="network-target-badge" tone={badge.tone}>
			{badge.label}
		</Badge>
	);
}

function NetworkDetail({
	entry,
	tab,
	onTabChange,
	backend,
}: {
	entry: NetworkEntry;
	tab: DetailTab;
	onTabChange: (tab: DetailTab) => void;
	/** Set for Supabase-shaped requests: which backend, and what to do about it. */
	backend?:
		| Readonly<{
				badge: NetworkTargetBadge;
				target: SupabaseTrafficTarget;
				onOpen: () => void;
				onOnly: () => void;
		  }>
		| undefined;
}) {
	return (
		<div className="flex h-full flex-col">
			<div className="network-detail-head">
				<div className="network-detail-badges">
					<MethodChip method={entry.method} />
					<StatusCode entry={entry} label={statusLabel(entry)} />
					<span className="network-detail-time">{formatClock(entry.at)}</span>
				</div>
				<h2 className="network-detail-url">{truncateMiddle(entry.url, 160)}</h2>
				<p className="network-detail-meta">
					{formatDuration(entry.durationMs)} ·{' '}
					{formatBytes(entry.responseBytes)}
					{entry.source ? ` · ${entry.source}` : ''}
				</p>
			</div>
			<div
				aria-label="Request detail"
				className="network-tabs"
				role="tablist"
				onKeyDown={(event) => {
					const index = DETAIL_TABS.findIndex(({ id }) => id === tab);
					const next =
						event.key === 'ArrowRight'
							? DETAIL_TABS[(index + 1) % DETAIL_TABS.length]
							: event.key === 'ArrowLeft'
								? DETAIL_TABS[
										(index + DETAIL_TABS.length - 1) % DETAIL_TABS.length
									]
								: event.key === 'Home'
									? DETAIL_TABS[0]
									: event.key === 'End'
										? DETAIL_TABS.at(-1)
										: undefined;
					if (!next) return;
					event.preventDefault();
					onTabChange(next.id);
					document.getElementById(`network-tab-${next.id}`)?.focus();
				}}
			>
				{DETAIL_TABS.map(({ id, label }) => (
					<button
						aria-controls="network-tab-panel"
						aria-selected={tab === id}
						className="network-tab"
						id={`network-tab-${id}`}
						key={id}
						role="tab"
						tabIndex={tab === id ? 0 : -1}
						type="button"
						onClick={() => onTabChange(id)}
					>
						{label}
					</button>
				))}
			</div>
			<div
				aria-labelledby={`network-tab-${tab}`}
				className="min-h-0 flex-1 overflow-auto p-4"
				id="network-tab-panel"
				role="tabpanel"
			>
				{tab === 'overview' ? (
					<dl className="m-0">
						<KeyValue label="Host" value={entry.host} mono />
						<KeyValue label="Path" value={entry.path} mono />
						<KeyValue label="Source" value={entry.source ?? 'fetch'} />
						{backend ? (
							<KeyValue
								label="Backend"
								value={
									<span className="network-target-detail">
										<TargetBadge badge={backend.badge} />
										<span>{backend.badge.detail}</span>
										<span className="network-target-detail-actions">
											{backend.target.kind === 'this-stack' ||
											backend.target.kind === 'other-stack' ? (
												<Button
													size="sm"
													variant="ghost"
													onPress={backend.onOpen}
												>
													<DatabaseZap className="h-3.5 w-3.5" /> Open in
													Supabase
												</Button>
											) : null}
											<Button
												size="sm"
												variant="ghost"
												onPress={backend.onOnly}
											>
												<Filter className="h-3.5 w-3.5" /> Only this backend
											</Button>
										</span>
									</span>
								}
							/>
						) : null}
						<KeyValue
							label="Content type"
							value={entry.contentType ?? 'Unknown'}
							mono
						/>
						<KeyValue
							label="Request size"
							value={formatBytes(entry.requestBytes)}
							mono
						/>
						<KeyValue
							label="Response size"
							value={formatBytes(entry.responseBytes)}
							mono
						/>
						<KeyValue
							label="Duration"
							value={formatDuration(entry.durationMs)}
							mono
						/>
						{entry.error ? (
							<div className="mt-4">
								<PanelNotice title="Request failed" tone="danger">
									{entry.error}
								</PanelNotice>
							</div>
						) : null}
					</dl>
				) : null}
				{tab === 'headers' ? (
					<div className="space-y-4">
						<CodePreview
							label="Request headers"
							value={headersText(entry.requestHeaders)}
						/>
						<CodePreview
							label="Response headers"
							value={headersText(entry.responseHeaders)}
						/>
					</div>
				) : null}
				{tab === 'request' ? (
					<BodyPreview label="Request body" value={entry.requestBody} />
				) : null}
				{tab === 'response' ? (
					<BodyPreview label="Response body" value={entry.responseBody} />
				) : null}
			</div>
		</div>
	);
}

/**
 * A captured body, indented when it is JSON. Raw shows it as captured, and a
 * note counts the values the device redacted before they reached the desktop.
 */
function BodyPreview({
	label,
	value,
}: {
	label: string;
	value: string | undefined;
}) {
	const [format, setFormat] = useState<'pretty' | 'raw'>('pretty');
	const pretty = value === undefined ? undefined : prettyBody(value);
	const canFormat = pretty !== undefined && pretty !== value;
	const redacted = redactedCount(value);
	return (
		<div className="space-y-2">
			<CodePreview
				actions={
					canFormat ? (
						<fieldset className="sim-layout-toggle network-body-format">
							<legend className="sr-only">{label} format</legend>
							{(['pretty', 'raw'] as const).map((option) => (
								<Button
									aria-pressed={format === option}
									key={option}
									size="sm"
									variant={format === option ? 'secondary' : 'ghost'}
									onPress={() => setFormat(option)}
								>
									{option === 'pretty' ? 'Pretty' : 'Raw'}
								</Button>
							))}
						</fieldset>
					) : null
				}
				label={label}
				maxHeight={520}
				value={canFormat && format === 'pretty' ? pretty : value}
			/>
			{redacted > 0 ? (
				<p className="network-redaction-note">
					{redacted === 1 ? '1 value was' : `${redacted} values were`} redacted
					on the device before reaching RN Devtools.
				</p>
			) : null}
		</div>
	);
}
