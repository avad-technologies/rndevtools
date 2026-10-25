import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import {
	CheckCircle2,
	CircleAlert,
	DatabaseZap,
	Settings2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	EmptyPanel,
	InlineCode,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { type AppTraffic, useAppTraffic } from '@/lib/app-traffic';
import {
	type AppTrafficView,
	environmentSupabaseChecks,
} from '@/simulator/app-traffic-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import {
	useSupabaseNavigation,
	useSupabaseState,
} from '@/state/supabase-runtime';
import type { EnvironmentEntry } from '../../shared/protocol';
import { supabaseStackTitle } from '../../shared/supabase-protocol';

const MAX_RENDERED_ENVIRONMENT_VALUES = 500;

export function validationTone(
	status: EnvironmentEntry['status']
): 'success' | 'warning' | 'danger' | 'default' {
	if (status === 'valid') return 'success';
	if (status === 'unchecked') return 'default';
	if (status === 'missing') return 'warning';
	return 'danger';
}

export function statusLabel(status: EnvironmentEntry['status']): string {
	if (status === 'typeMismatch') return 'type';
	if (status === 'valueMismatch') return 'value';
	return status;
}

/**
 * Reduces the validated entries to a health summary. Pure so it can be unit
 * tested independently of the rendered panel.
 */
export function environmentHealth(entries: readonly EnvironmentEntry[]): {
	hasChecks: boolean;
	valid: number;
	failures: number;
	score: number;
} {
	const checked = entries.filter((entry) => entry.status !== 'unchecked');
	const valid = checked.filter((entry) => entry.status === 'valid').length;
	const hasChecks = checked.length > 0;
	return {
		hasChecks,
		valid,
		failures: checked.length - valid,
		score: hasChecks ? Math.round((valid / checked.length) * 100) : 0,
	};
}

/**
 * What the desktop compares the app's declared Supabase URL with: its lane's
 * stack, as `the stack for feat-checkout (:21734)`.
 */
export function laneStackPhrase(
	view: Pick<AppTrafficView, 'expectedStack' | 'labels'>
): string {
	const port =
		view.labels.expectedPort === undefined
			? ''
			: ` (:${view.labels.expectedPort})`;
	return view.expectedStack
		? `the stack for ${supabaseStackTitle(view.expectedStack)}${port}`
		: `this lane's stack${port}`;
}

export function EnvironmentPanel() {
	const entries = useDesktopRuntime().selectedDevice?.tools.environment ?? [];
	const [query, setQuery] = useState('');
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries.filter(
			(entry) =>
				!needle ||
				[
					entry.section,
					entry.key,
					entry.valueText,
					entry.status,
					entry.description,
				]
					.join(' ')
					.toLowerCase()
					.includes(needle)
		);
	}, [entries, query]);
	const visibleEntries = filtered.slice(0, MAX_RENDERED_ENVIRONMENT_VALUES);
	const sections = useMemo(
		() =>
			[...new Set(visibleEntries.map((entry) => entry.section))].map(
				(title) => ({
					title,
					entries: visibleEntries.filter((entry) => entry.section === title),
				})
			),
		[visibleEntries]
	);
	const { hasChecks, valid, failures, score } = environmentHealth(entries);
	const traffic = useAppTraffic();

	return (
		<section className="panel-root">
			<PanelHeader
				title="Environment"
				description="Declared build, update, device, backend, and observability values with explicit validation results."
				meta={
					<span
						className={
							!hasChecks
								? 'text-(--text-3)'
								: failures === 0
									? 'text-(--brand-text)'
									: 'text-(--warning-text)'
						}
					>
						{hasChecks ? `Config health ${score}%` : 'Config not evaluated'}
					</span>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search environment"
					placeholder="Variable, section, value…"
					value={query}
					onChange={setQuery}
				/>
				<div className="ml-auto flex items-center gap-3">
					<span className="flex items-center gap-1.5 text-xs text-(--brand-text)">
						<CheckCircle2 className="h-3.5 w-3.5" /> {valid} valid
					</span>
					<span className="flex items-center gap-1.5 text-xs text-(--warning-text)">
						<CircleAlert className="h-3.5 w-3.5" /> {failures} review
					</span>
				</div>
			</Toolbar>
			{filtered.length > visibleEntries.length ? (
				<PanelNotice title="Environment rendering is bounded." tone="info">
					Search covers all {filtered.length} matching values; the grid renders
					the first {MAX_RENDERED_ENVIRONMENT_VALUES}.
				</PanelNotice>
			) : null}
			<div className="panel-scroll p-5">
				<div className="mb-5 grid grid-cols-[220px_1fr] overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.025]">
					<div className="grid place-items-center border-r border-foreground/8 p-5">
						<div
							className="relative grid h-28 w-28 place-items-center rounded-full bg-[conic-gradient(var(--signal)_0deg,var(--signal)_calc(var(--score)*3.6deg),color-mix(in_oklab,var(--foreground)_8%,transparent)_calc(var(--score)*3.6deg))] p-1.5"
							style={{ '--score': score } as React.CSSProperties}
						>
							<div className="grid h-full w-full place-items-center rounded-full bg-surface text-center">
								<div>
									<div className="font-mono text-2xl font-semibold tabular-nums tracking-[-0.04em] text-(--foreground)">
										{hasChecks ? `${score}%` : '—'}
									</div>
									<div className="mt-0.5 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Health
									</div>
								</div>
							</div>
						</div>
					</div>
					<div className="flex flex-col justify-center p-5">
						<h2 className="m-0 text-sm font-semibold text-(--foreground)">
							{!hasChecks
								? 'No validation rules were evaluated'
								: failures === 0
									? 'Runtime configuration is healthy'
									: `${failures} value${failures === 1 ? '' : 's'} need review`}
						</h2>
						<p className="mb-0 mt-2 max-w-xl text-xs leading-5 text-(--muted)">
							Validation is performed against declared requirements. Secrets are
							not auto-discovered; only explicitly supplied, client-safe values
							appear here.
						</p>
					</div>
				</div>
				<LocalSupabaseChecks entries={entries} traffic={traffic} />
				{sections.length === 0 ? (
					<EmptyPanel
						icon={<Settings2 className="h-5 w-5" />}
						title="No matching values"
						description="Try a different key, value, or environment section."
					/>
				) : (
					<div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
						{sections.map((section) => (
							<Card
								className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-0 shadow-none"
								key={section.title}
								variant="secondary"
							>
								<Card.Header className="flex h-11 items-center justify-between border-b border-foreground/8 px-4">
									<Card.Title className="m-0 text-xs font-medium uppercase tracking-[0.07em] text-(--muted)">
										{section.title}
									</Card.Title>
									<span className="font-mono text-xs tabular-nums text-(--text-3)">
										{section.entries.length} values
									</span>
								</Card.Header>
								<Card.Content className="p-0">
									{section.entries.map((entry) => (
										<div
											className="grid grid-cols-[minmax(160px,.75fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
											key={entry.id}
										>
											<div className="min-w-0">
												<p className="m-0 truncate font-mono text-xs text-(--foreground)">
													{entry.key}
												</p>
												{entry.description ? (
													<p className="mb-0 mt-1 truncate text-xs text-(--text-3)">
														{entry.description}
													</p>
												) : null}
											</div>
											<div className="min-w-0">
												<InlineCode className="block truncate">
													{entry.valueText}
												</InlineCode>
											</div>
											<StatusPill tone={validationTone(entry.status)}>
												{statusLabel(entry.status)}
											</StatusPill>
										</div>
									))}
								</Card.Content>
							</Card>
						))}
					</div>
				)}
			</div>
		</section>
	);
}

/**
 * The desktop's own check of the app's declared Supabase URL: values are
 * matched by what they point at, never by their key's name, and only their
 * origin is shown. A lane's stack serves local http, so that reads as
 * expected even where the app's own URL rule accepts only https.
 */
function LocalSupabaseChecks({
	entries,
	traffic,
}: {
	entries: readonly EnvironmentEntry[];
	traffic: AppTraffic;
}) {
	const { state } = useSupabaseState();
	const { openInSupabase } = useSupabaseNavigation();
	const checks = useMemo(
		() => environmentSupabaseChecks(entries, traffic, state),
		[entries, state, traffic]
	);
	if (!traffic.enabled || (checks.length === 0 && !traffic.expects)) {
		return null;
	}
	const stack = traffic.expectedStack;
	return (
		<section
			aria-label="Local Supabase checks"
			className="mb-5 overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.025]"
		>
			<header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-foreground/8 px-4 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<DatabaseZap className="h-3.5 w-3.5 shrink-0 text-(--muted)" />
					<h2 className="m-0 text-xs font-medium uppercase tracking-[0.07em] text-(--muted)">
						Local Supabase
					</h2>
					<span className="truncate text-xs text-(--text-3)">
						{traffic.expects
							? `checked by RN Devtools against ${laneStackPhrase(traffic)}`
							: 'checked by RN Devtools · no lane stack to compare with'}
					</span>
				</div>
				{stack ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() => openInSupabase({ stackId: stack.id })}
					>
						Open in Supabase
					</Button>
				) : null}
			</header>
			{checks.length === 0 ? (
				<p className="m-0 px-4 py-3 text-xs text-(--text-3)">
					No declared value points at a Supabase API, so there is nothing to
					compare with {laneStackPhrase(traffic)}.
				</p>
			) : (
				checks.map((check) => (
					<div
						className="grid grid-cols-[minmax(160px,.75fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
						key={check.id}
					>
						<div className="min-w-0">
							<p className="m-0 truncate font-mono text-xs text-(--foreground)">
								{check.key}
							</p>
							<InlineCode className="mt-1 block truncate">
								{check.origin}
							</InlineCode>
						</div>
						<div className="min-w-0 text-xs leading-5">
							<p className="m-0 text-(--foreground)">{check.text}</p>
							{check.note ? (
								<p className="m-0 text-(--text-3)">{check.note}</p>
							) : null}
						</div>
						<StatusPill tone={check.tone}>{check.status}</StatusPill>
					</div>
				))
			)}
		</section>
	);
}
