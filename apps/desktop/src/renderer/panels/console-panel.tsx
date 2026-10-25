import { Button } from '@heroui/react/button';
import {
	DataGrid,
	type DataGridColumn,
	type DataGridSelection,
} from '@heroui-pro/react/data-grid';
import {
	Bookmark,
	Braces,
	Copy,
	ShieldCheck,
	TerminalSquare,
	Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	CodePreview,
	ConfirmAction,
	DetailPlaceholder,
	EmptyPanel,
	KeyValue,
	PanelHeader,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { boundedTextExport, copyText, formatClock } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { ConsoleEntry } from '../../shared/protocol';

type ConsoleLevel = ConsoleEntry['level'] | 'all';

export function levelTone(
	level: ConsoleEntry['level']
): 'default' | 'info' | 'warning' | 'danger' {
	if (level === 'error') return 'danger';
	if (level === 'warn') return 'warning';
	if (level === 'info') return 'info';
	return 'default';
}

export function exportLine(entry: ConsoleEntry): string {
	const repeatCount = entry.repeatCount ?? 1;
	return `[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()}${entry.scope ? ` [${entry.scope}]` : entry.source ? ` [${entry.source}]` : ''} ${entry.message}${repeatCount > 1 ? ` (repeated ${repeatCount}x)` : ''}${entry.errorStack ? `\n${entry.errorStack}` : ''}${entry.attributesText ? `\n${entry.attributesText}` : ''}`;
}

/** Copy-button label from the last copy result. Pure so it is unit-tested. */
export function copyFeedbackLabel(
	lastCopy: { ok: boolean; truncated: boolean } | null
): string {
	if (lastCopy?.ok === true)
		return lastCopy.truncated ? 'Copied (bounded)' : 'Copied';
	if (lastCopy?.ok === false) return 'Copy failed';
	return 'Copy visible';
}

/**
 * Drops bookmarks whose entries left the buffer. Returns `previous` itself
 * when none did, so a push that only adds entries renders the grid once, not
 * twice with rebuilt columns.
 */
export function retainedBookmarks(
	previous: ReadonlySet<string>,
	entries: readonly Pick<ConsoleEntry, 'id'>[]
): ReadonlySet<string> {
	if (previous.size === 0) return previous;
	const retained = new Set(entries.map((entry) => entry.id));
	const kept = [...previous].filter((id) => retained.has(id));
	return kept.length === previous.size ? previous : new Set(kept);
}

export function ConsolePanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const entries = selectedDevice?.tools.console ?? [];
	const [query, setQuery] = useState('');
	const [level, setLevel] = useState<ConsoleLevel>('all');
	const [bookmarksOnly, setBookmarksOnly] = useState(false);
	const [bookmarkedIds, setBookmarkedIds] = useState<ReadonlySet<string>>(
		new Set()
	);
	const [selectedId, setSelectedId] = useState<string | null>(
		entries[0]?.id ?? null
	);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter(
				(entry) =>
					(!bookmarksOnly || bookmarkedIds.has(entry.id)) &&
					(level === 'all' || entry.level === level) &&
					(!needle ||
						[
							entry.message,
							entry.attributesText,
							entry.source,
							entry.scope,
							entry.correlationId,
							entry.errorName,
							entry.errorStack,
							entry.level,
						]
							.join(' ')
							.toLowerCase()
							.includes(needle))
			)
			.sort((left, right) => right.at - left.at);
	}, [bookmarkedIds, bookmarksOnly, entries, level, query]);
	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const [lastCopy, setLastCopy] = useState<{
		ok: boolean;
		truncated: boolean;
	} | null>(null);
	const copyLabel = copyFeedbackLabel(lastCopy);
	useEffect(() => {
		if (!lastCopy) return;
		const timer = window.setTimeout(() => setLastCopy(null), 1_800);
		return () => window.clearTimeout(timer);
	}, [lastCopy]);
	useEffect(() => {
		setBookmarkedIds(new Set());
		setBookmarksOnly(false);
		// Bookmarks are intentionally session-local to the selected device.
		if (selectedDevice?.info.id === undefined) setSelectedId(null);
	}, [selectedDevice?.info.id]);
	useEffect(() => {
		setBookmarkedIds((previous) => retainedBookmarks(previous, entries));
	}, [entries]);
	const toggleBookmark = (id: string): void => {
		setBookmarkedIds((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const levelCounts = useMemo(() => {
		const counts = { debug: 0, info: 0, warn: 0, error: 0 };
		for (const entry of entries) counts[entry.level] += 1;
		return counts;
	}, [entries]);
	const columns = useMemo<DataGridColumn<ConsoleEntry>[]>(
		() => [
			{
				id: 'time',
				header: 'Time',
				width: 92,
				isRowHeader: true,
				cell: (entry) => (
					<span className="font-mono text-xs text-(--text-3)">
						{formatClock(entry.at)}
					</span>
				),
			},
			{
				id: 'level',
				header: 'Level',
				width: 88,
				cell: (entry) => (
					<StatusPill tone={levelTone(entry.level)}>{entry.level}</StatusPill>
				),
			},
			{
				id: 'message',
				header: 'Message',
				minWidth: 420,
				cell: (entry) => (
					<div className="min-w-0 py-0.5">
						<div className="truncate font-mono text-xs text-(--foreground)">
							{bookmarkedIds.has(entry.id) ? '★ ' : ''}
							{entry.message}
							{(entry.repeatCount ?? 1) > 1 ? ` ×${entry.repeatCount}` : ''}
						</div>
						{entry.attributesText ? (
							<div className="mt-0.5 truncate font-mono text-xs text-(--text-3)">
								{entry.attributesText.replace(/\s+/g, ' ')}
							</div>
						) : null}
					</div>
				),
			},
			{
				id: 'source',
				header: 'Source',
				width: 140,
				cell: (entry) => (
					<span className="truncate text-xs text-(--muted)">
						{entry.scope ?? entry.source ?? 'application'}
					</span>
				),
			},
		],
		[bookmarkedIds]
	);

	function onSelectionChange(selection: DataGridSelection): void {
		const key = selection === 'all' ? filtered[0]?.id : [...selection][0];
		setSelectedId(key === undefined ? null : String(key));
	}

	return (
		<section className="panel-root">
			<PanelHeader
				title="Console"
				description="Events from the app's structured logger after telemetry sanitization—without monkey-patching the global console."
				meta={
					<span className="flex items-center gap-1.5 text-(--brand-text)">
						<ShieldCheck className="h-3 w-3" /> Logger-backed · redacted
					</span>
				}
				actions={
					<>
						<Button
							isDisabled={filtered.length === 0}
							size="sm"
							variant="secondary"
							onPress={() => {
								const visibleExport = boundedTextExport(filtered, exportLine);
								void copyText(visibleExport.text).then((ok) => {
									setLastCopy({
										ok,
										truncated: visibleExport.truncated,
									});
								});
							}}
						>
							<Copy className="h-3.5 w-3.5" /> {copyLabel}
						</Button>
						<ConfirmAction
							triggerLabel="Clear"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							title="Clear logger events?"
							description="This clears the desktop-visible ring buffer only. Application logging continues."
							confirmLabel="Clear events"
							isDisabled={!canRunAction('console', 'clear')}
							onConfirm={() =>
								void runAction(
									'console',
									'clear',
									{},
									'Console buffer cleared.'
								)
							}
						/>
					</>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search console events"
					placeholder="Message, source, attributes…"
					value={query}
					onChange={setQuery}
				/>
				<div className="flex items-center gap-1">
					{(['all', 'debug', 'info', 'warn', 'error'] as const).map((value) => (
						<Button
							aria-pressed={level === value}
							className="h-7 rounded-md px-2.5 text-xs capitalize"
							key={value}
							size="sm"
							variant={level === value ? 'secondary' : 'ghost'}
							onPress={() => setLevel(value)}
						>
							{value}
							{value !== 'all' && levelCounts[value] > 0 ? (
								<span className="font-mono text-xs text-(--text-3)">
									{levelCounts[value]}
								</span>
							) : null}
						</Button>
					))}
				</div>
				<Button
					aria-pressed={bookmarksOnly}
					className="h-7 rounded-md px-2.5 text-xs"
					size="sm"
					variant={bookmarksOnly ? 'secondary' : 'ghost'}
					onPress={() => setBookmarksOnly((value) => !value)}
				>
					<Bookmark className="h-3.5 w-3.5" /> Bookmarks {bookmarkedIds.size}
				</Button>
				<span className="ml-auto font-mono text-xs text-(--text-3)">
					{filtered.length} events
				</span>
			</Toolbar>
			<div className="split-panel">
				<div className="min-w-0 overflow-hidden">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<TerminalSquare className="h-5 w-5" />}
							title="No matching logger events"
							description="Structured application logs will appear here as the selected device emits them."
						/>
					) : (
						<DataGrid
							aria-label="Structured logger events"
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
						<div className="h-full overflow-auto p-4">
							<div className="mb-4 flex items-center gap-2">
								<StatusPill tone={levelTone(selected.level)}>
									{selected.level}
								</StatusPill>
								<span className="font-mono text-xs text-(--text-3)">
									{formatClock(selected.at)}
								</span>
							</div>
							<Button
								className="mb-3"
								size="sm"
								variant={bookmarkedIds.has(selected.id) ? 'secondary' : 'ghost'}
								onPress={() => toggleBookmark(selected.id)}
							>
								<Bookmark className="h-3.5 w-3.5" />
								{bookmarkedIds.has(selected.id)
									? 'Remove bookmark'
									: 'Bookmark'}
							</Button>
							<h2 className="m-0 font-mono text-[13px] font-medium leading-6 text-(--foreground)">
								{selected.message}
							</h2>
							<dl className="mb-4 mt-4">
								<KeyValue
									label="Source"
									value={selected.source ?? 'application'}
								/>
								<KeyValue label="Scope" value={selected.scope ?? '—'} />
								<KeyValue
									label="Repeats"
									value={String(selected.repeatCount ?? 1)}
									mono
								/>
								<KeyValue
									label="Correlation"
									value={selected.correlationId ?? '—'}
									mono
								/>
								<KeyValue
									label="Timestamp"
									value={new Date(selected.at).toISOString()}
									mono
								/>
								{selected.sourceLocation ? (
									<KeyValue
										label="Location"
										value={`${selected.sourceLocation.file}${selected.sourceLocation.line ? `:${selected.sourceLocation.line}` : ''}${selected.sourceLocation.column ? `:${selected.sourceLocation.column}` : ''}`}
										mono
									/>
								) : null}
							</dl>
							{selected.errorStack ? (
								<CodePreview
									label={selected.errorName ?? 'Sanitized error stack'}
									value={selected.errorStack}
									maxHeight={260}
								/>
							) : null}
							{selected.attributesText ? (
								<CodePreview
									label="Sanitized attributes"
									value={selected.attributesText}
									maxHeight={520}
								/>
							) : (
								<div className="rounded-md border border-foreground/8 bg-foreground/[0.025] p-4 text-xs text-(--text-3)">
									No structured attributes were attached to this event.
								</div>
							)}
							<div className="mt-4 flex items-center gap-2 rounded-md border border-(--brand-border) bg-(--brand-soft) p-3 text-xs leading-5 text-(--brand-text)">
								<Braces className="h-4 w-4 shrink-0" /> Sensitive keys, tokens,
								emails, and identifiers are redacted before this event reaches
								desktop.
							</div>
						</div>
					) : (
						<DetailPlaceholder label="Select a logger event to inspect its structured attributes" />
					)}
				</aside>
			</div>
		</section>
	);
}
