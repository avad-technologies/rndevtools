import { Button } from '@heroui/react/button';
import {
	Activity,
	AlertTriangle,
	Clock3,
	Download,
	FilePlus2,
	FolderSearch,
	Gauge,
	PackageCheck,
	RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	DenseVirtualList,
	formatDuration,
	SimulatorMetric,
} from '@/components/simulator-ui';
import { Badge, PanelHeader, PanelNotice, StatusPill } from '@/components/ui';
import { nextActionId, type WithoutActionId } from '@/lib/runtime-action';
import type {
	BuildInsight,
	BuildInsightsBridge,
	BuildInsightsOperation,
	BuildInsightsState,
} from '../../../shared/build-insights-protocol';

const EMPTY_STATE: BuildInsightsState = {
	revision: 0,
	updatedAt: 0,
	retentionMonths: 12,
	sources: [],
	builds: [],
	stats: { totalBuilds: 0, succeededBuilds: 0, activity: [] },
};

export const BUILD_INSIGHTS_FOUNDATION_COPY =
	"Current foundation: Apple's public xcresulttool get build-results view. Duration, status, and diagnostic counts are available; scheme, configuration, Xcode version, clean/incremental classification, and Swift FSEvents live watching are deferred.";

type BuildInsightsOperationInput = WithoutActionId<BuildInsightsOperation>;

function getBridge(): BuildInsightsBridge | null {
	const bridge = window.rnDevtools;
	if (
		!bridge ||
		typeof bridge.getBuildInsightsState !== 'function' ||
		typeof bridge.subscribeBuildInsightsState !== 'function' ||
		typeof bridge.runBuildInsightsOperation !== 'function'
	) {
		return null;
	}
	return bridge;
}

function errorText(error: unknown): string {
	return error instanceof Error
		? error.message.slice(0, 4 * 1024)
		: 'Build action failed.';
}

export function BuildInsightsPanel() {
	const bridge = useMemo(getBridge, []);
	const [state, setState] = useState(EMPTY_STATE);
	const [selectedBuildId, setSelectedBuildId] = useState('');
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [action, setAction] = useState<string | null>(null);
	const [message, setMessage] = useState<
		{ kind: 'error' | 'success'; text: string } | undefined
	>();
	const activeAction = useRef<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeBuildInsightsState((nextState) => {
				if (active) setState(nextState);
			});
		} catch (error) {
			setMessage({ kind: 'error', text: errorText(error) });
		}
		void bridge
			.getBuildInsightsState()
			.then((nextState) => {
				if (active) setState(nextState);
			})
			.catch((error: unknown) => {
				if (active) setMessage({ kind: 'error', text: errorText(error) });
			})
			.finally(() => {
				if (active) setIsLoading(false);
			});
		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty native disposer must not break React teardown.
			}
		};
	}, [bridge]);

	const runOperation = useCallback(
		async (operation: BuildInsightsOperation, successMessage: string) => {
			if (!bridge || activeAction.current) return;
			activeAction.current = operation.kind;
			setAction(operation.kind);
			setMessage(undefined);
			try {
				const receipt = await bridge.runBuildInsightsOperation(operation);
				if (receipt.state) setState(receipt.state);
				if (receipt.cancelled) return;
				if (!receipt.completed) {
					setMessage({
						kind: 'error',
						text: receipt.error ?? 'Build action did not complete.',
					});
					return;
				}
				setMessage({ kind: 'success', text: successMessage });
			} catch (error) {
				setMessage({ kind: 'error', text: errorText(error) });
			} finally {
				activeAction.current = null;
				setAction(null);
			}
		},
		[bridge]
	);

	const selectedBuild =
		state.builds.find((build) => build.id === selectedBuildId) ??
		state.builds[0] ??
		null;
	const isBusy = action !== null;
	const execute = (
		operation: BuildInsightsOperationInput,
		successMessage: string
	) =>
		void runOperation(
			{
				...operation,
				actionId: nextActionId('build-insights'),
			} as BuildInsightsOperation,
			successMessage
		);

	return (
		<section className="panel-root build-insights-panel">
			<PanelHeader
				actions={
					<div className="sim-header-action-group">
						<Button
							isDisabled={!bridge || isBusy}
							size="sm"
							variant="secondary"
							onPress={() =>
								execute(
									{ kind: 'build.import-xcresult' },
									'Build result imported.'
								)
							}
						>
							<FilePlus2 className="h-3.5 w-3.5" /> Import result
						</Button>
						<Button
							isDisabled={!bridge || isBusy}
							size="sm"
							variant="secondary"
							onPress={() =>
								execute(
									{ kind: 'build.add-watch-root' },
									'DerivedData scan root added.'
								)
							}
						>
							<FolderSearch className="h-3.5 w-3.5" /> Add build folder
						</Button>
						<Button
							aria-label="Refresh local build results"
							isDisabled={!bridge || isBusy}
							isIconOnly
							size="sm"
							variant="secondary"
							onPress={() =>
								execute({ kind: 'build.refresh' }, 'Build history refreshed.')
							}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`}
							/>
						</Button>
					</div>
				}
				description={`Review local Xcode build times and errors. Import an .xcresult file or choose a DerivedData folder to scan. ${BUILD_INSIGHTS_FOUNDATION_COPY}`}
				meta={`${state.stats.totalBuilds} builds · ${state.retentionMonths} month retention`}
				title="Build Insights"
			/>
			{!bridge ? (
				<PanelNotice title="Build Insights bridge unavailable." tone="danger">
					The narrow Build Insights bridge is unavailable. Reopen the updated
					desktop app; this renderer never reads local paths directly.
				</PanelNotice>
			) : null}
			{message ? (
				<PanelNotice
					title={message.kind === 'error' ? 'Build action failed.' : 'Done.'}
					tone={message.kind === 'error' ? 'danger' : 'info'}
				>
					{message.text}
				</PanelNotice>
			) : null}
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail="All retained builds"
					icon={<Clock3 className="h-4 w-4" />}
					label="Median"
					value={formatOptionalDuration(state.stats.medianDurationMs)}
				/>
				<SimulatorMetric
					detail="75th percentile"
					icon={<Gauge className="h-4 w-4" />}
					label="p75"
					value={formatOptionalDuration(state.stats.p75DurationMs)}
				/>
				<SimulatorMetric
					detail="95th percentile"
					icon={<AlertTriangle className="h-4 w-4" />}
					label="p95"
					value={formatOptionalDuration(state.stats.p95DurationMs)}
				/>
				<SimulatorMetric
					detail="Completed in the last 7 days"
					icon={<Activity className="h-4 w-4" />}
					label="7-day average"
					value={formatOptionalDuration(state.stats.sevenDayAverageMs)}
				/>
			</div>
			<div className="sim-build-layout">
				<section className="sim-list-pane">
					<header className="sim-subpane-header">
						<span>Build history</span>
						<code>{isLoading ? 'indexing…' : state.builds.length}</code>
					</header>
					<DenseVirtualList
						ariaLabel="Build history"
						className="sim-build-list"
						emptyDescription="Import an .xcresult file or choose a DerivedData folder."
						emptyTitle="No local build results"
						items={state.builds}
						getId={(build) => build.id}
						rowHeight={68}
						selectedId={selectedBuild?.id}
						textValue={(build) => `${build.name} ${build.scheme ?? ''}`}
						onSelect={(build) => setSelectedBuildId(build.id)}
						renderItem={(build) => <BuildRow build={build} />}
					/>
				</section>
				<section className="sim-build-detail panel-scroll">
					{selectedBuild ? (
						<BuildDetail
							build={selectedBuild}
							state={state}
							onExport={(format) =>
								execute(
									{ kind: 'build.export', format },
									`Build history exported as ${format.toUpperCase()}.`
								)
							}
						/>
					) : (
						<EmptyBuildDetail
							state={state}
							onExport={(format) =>
								execute(
									{ kind: 'build.export', format },
									`Build history exported as ${format.toUpperCase()}.`
								)
							}
						/>
					)}
				</section>
			</div>
		</section>
	);
}

function BuildRow({ build }: { build: BuildInsight }) {
	return (
		<>
			<div className={`sim-list-leading is-${build.status}`}>
				<PackageCheck className="h-3.5 w-3.5" />
			</div>
			<div className="sim-list-copy">
				<strong>{build.name}</strong>
				<span>
					{build.scheme ?? build.configuration ?? 'Metadata not reported'} ·{' '}
					{new Date(build.createdAt).toLocaleString()}
				</span>
			</div>
			<div className="sim-build-row-metrics">
				<code>{formatDuration(build.durationMs)}</code>
				<span>{build.warnings} warnings</span>
			</div>
		</>
	);
}

function BuildDetail({
	build,
	state,
	onExport,
}: {
	build: BuildInsight;
	state: BuildInsightsState;
	onExport: (format: 'csv' | 'json') => void;
}) {
	const classification = buildClassificationPresentation(build);
	return (
		<div className="sim-build-report">
			<header className="sim-report-heading">
				<div>
					<p className="sim-eyebrow">Selected build</p>
					<h2>{build.name}</h2>
					<span>{build.destination}</span>
				</div>
				<StatusPill tone={statusTone(build.status)}>{build.status}</StatusPill>
			</header>
			<section className="sim-build-facts">
				<Fact label="Duration" value={formatDuration(build.durationMs)} />
				<Fact
					label="Started"
					value={new Date(build.startedAt).toLocaleString()}
				/>
				<Fact label="Warnings" value={String(build.warnings)} />
				<Fact label="Errors" value={String(build.errors)} />
				<Fact
					label="Analyzer warnings"
					value={String(build.analyzerWarnings)}
				/>
				<Fact
					label="Xcode"
					value={build.xcodeVersion ?? 'Not reported by build-results'}
				/>
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>{classification.title}</h3>
						<p>{classification.subtitle}</p>
					</div>
					<code>{classification.confidence}</code>
				</div>
				<div className="sim-classification-card">
					<strong>{classification.label}</strong>
					<p>{classification.detail}</p>
				</div>
			</section>
			<SourcesAndActivity state={state} />
			<ExportActions onExport={onExport} />
		</div>
	);
}

function EmptyBuildDetail({
	state,
	onExport,
}: {
	state: BuildInsightsState;
	onExport: (format: 'csv' | 'json') => void;
}) {
	return (
		<div className="sim-build-report">
			<div className="sim-empty-preview">
				<PackageCheck className="h-5 w-5" />
				<strong>Build evidence appears here</strong>
				<span>Select a build to review its duration and errors.</span>
			</div>
			<SourcesAndActivity state={state} />
			<ExportActions onExport={onExport} />
		</div>
	);
}

function SourcesAndActivity({ state }: { state: BuildInsightsState }) {
	const maximum = Math.max(
		1,
		...state.stats.activity.map((month) => month.count)
	);
	return (
		<>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Build folders</h3>
						<p>Selected folders are scanned when you refresh.</p>
					</div>
					<code>{state.sources.length}</code>
				</div>
				<div className="sim-build-sources">
					{state.sources.length === 0 ? (
						<p>No result bundles or scan roots selected.</p>
					) : (
						state.sources.map((source) => (
							<div key={source.id}>
								<span className={`sim-source-status is-${source.status}`} />
								<strong>{source.label}</strong>
								<Badge>
									{source.kind === 'xcresult' ? 'result' : 'scan root'}
								</Badge>
								{source.error ? <small>{source.error}</small> : null}
							</div>
						))
					)}
				</div>
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>12-month activity</h3>
						<p>Build count and total duration by month</p>
					</div>
					<Activity className="h-3.5 w-3.5" />
				</div>
				<div className="sim-build-activity">
					{state.stats.activity.length === 0 ? (
						<p>No retained activity.</p>
					) : (
						state.stats.activity.map((month) => (
							<div key={month.month}>
								<span>{month.month}</span>
								<i>
									<i
										style={{
											width: `${Math.max(4, (month.count / maximum) * 100)}%`,
										}}
									/>
								</i>
								<code>{month.count}</code>
							</div>
						))
					)}
				</div>
			</section>
		</>
	);
}

function ExportActions({
	onExport,
}: {
	onExport: (format: 'csv' | 'json') => void;
}) {
	return (
		<div className="sim-build-export-actions">
			<Button size="sm" variant="secondary" onPress={() => onExport('json')}>
				<Download className="h-3.5 w-3.5" /> Export JSON
			</Button>
			<Button size="sm" variant="ghost" onPress={() => onExport('csv')}>
				<Download className="h-3.5 w-3.5" /> Export CSV
			</Button>
		</div>
	);
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function formatOptionalDuration(value: number | undefined): string {
	return value === undefined ? '—' : formatDuration(value);
}

export function buildClassificationPresentation(
	build: Pick<BuildInsight, 'classification' | 'classificationConfidence'>
): {
	title: string;
	subtitle: string;
	confidence: string;
	label: string;
	detail: string;
} {
	if (build.classification === 'unknown') {
		return {
			title: 'Classification unavailable',
			subtitle: 'No clean vs incremental evidence in public build-results',
			confidence: 'not reported',
			label: 'Unknown',
			detail:
				"Apple's public build-results view does not expose unambiguous clean-versus-incremental evidence, so this adapter does not infer a classification.",
		};
	}
	return {
		title: 'Build classification',
		subtitle: 'Evidence-aware clean or incremental status',
		confidence: build.classificationConfidence,
		label: build.classification,
		detail: `This build is ${build.classification} with ${build.classificationConfidence} evidence.`,
	};
}

function statusTone(
	status: BuildInsight['status']
): 'success' | 'danger' | 'warning' {
	if (status === 'succeeded') return 'success';
	if (status === 'failed') return 'danger';
	return 'warning';
}
