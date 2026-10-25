import { Button } from '@heroui/react/button';
import {
	Activity,
	Cpu,
	Gauge,
	MemoryStick,
	Play,
	Square,
	TimerReset,
} from 'lucide-react';
import { useMemo } from 'react';
import {
	InfoPopover,
	PanelHeader,
	PanelNotice,
	SectionCard,
	StatusPill,
} from '@/components/ui';
import { formatDuration, formatPercent } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { PerformanceSample } from '../../shared/protocol';

function average(values: number[]): number | undefined {
	return values.length === 0
		? undefined
		: values.reduce((total, value) => total + value, 0) / values.length;
}

function sparklinePoints(
	values: number[],
	width: number,
	height: number,
	minValue?: number,
	maxValue?: number
): string {
	if (values.length === 0) return '';
	const min = minValue ?? Math.min(...values);
	const max = maxValue ?? Math.max(...values);
	const range = Math.max(1, max - min);
	return values
		.map((value, index) => {
			const x =
				values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
			const boundedValue = Math.max(min, Math.min(max, value));
			const y = height - ((boundedValue - min) / range) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(' ');
}

// Series palette: JS FPS is the headline metric and uses the brand green; lag,
// CPU, and memory are distinct secondary series (amber / green / violet) so the
// four KPIs stay visually separable. Brand is drawn from the CSS token.
const SERIES = {
	brand: {
		line: 'var(--brand)',
		tint: 'bg-(--brand-soft)',
		text: 'text-(--brand-text)',
	},
	amber: {
		line: 'var(--warning)',
		tint: 'bg-warning/10',
		text: 'text-warning-text',
	},
	green: {
		line: 'var(--chart-cpu)',
		tint: 'bg-brand/10',
		text: 'text-green-700 dark:text-green-300',
	},
	violet: {
		line: 'var(--chart-memory)',
		tint: 'bg-violet-400/10',
		text: 'text-violet-700 dark:text-violet-300',
	},
} as const;

function MetricCard({
	label,
	value,
	suffix,
	icon,
	values,
	tone = 'brand',
	description,
	maxValue,
}: {
	label: string;
	value: string;
	suffix?: string | undefined;
	icon: React.ReactNode;
	values: number[];
	tone?: keyof typeof SERIES;
	description: string;
	maxValue?: number;
}) {
	const color = SERIES[tone];
	return (
		<div className="relative overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.025] p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-1 text-xs text-(--text-3)">
						{label}
						<InfoPopover label={label}>{description}</InfoPopover>
					</div>
					<p className="mb-0 mt-2 font-mono text-2xl font-semibold tracking-[-0.045em] text-(--foreground)">
						{value}
						{suffix ? (
							<span className="ml-1 text-xs font-normal text-(--text-3)">
								{suffix}
							</span>
						) : null}
					</p>
				</div>
				<div
					className={`grid h-8 w-8 place-items-center rounded-md ${color.tint} ${color.text}`}
				>
					{icon}
				</div>
			</div>
			<svg
				aria-hidden="true"
				className="mt-4 h-10 w-full overflow-visible"
				viewBox="0 0 180 40"
				preserveAspectRatio="none"
			>
				<line x1="0" x2="180" y1="39.5" y2="39.5" stroke="var(--separator)" />
				<polyline
					fill="none"
					points={sparklinePoints(values, 180, 36, 0, maxValue)}
					stroke={color.line}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="1.5"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
		</div>
	);
}

function gradeTone(
	grade: string
): 'success' | 'warning' | 'danger' | 'default' {
	if (grade === 'healthy') return 'success';
	if (grade === 'needsAttention') return 'warning';
	if (grade === 'critical') return 'danger';
	return 'default';
}

export function PerformancePanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const review = selectedDevice?.tools.performance;
	const samples = review?.samples ?? [];
	const latest = samples.at(-1);
	const summary = review?.summary;
	const routeStats = useMemo(() => {
		const byRoute = new Map<string, PerformanceSample[]>();
		for (const sample of samples) {
			const route = sample.route ?? 'Unknown route';
			const routeSamples = byRoute.get(route);
			if (routeSamples) routeSamples.push(sample);
			else byRoute.set(route, [sample]);
		}
		return [...byRoute.entries()]
			.map(([route, routeSamples]) => ({
				route,
				samples: routeSamples.length,
				jsFps: average(routeSamples.map((sample) => sample.jsFps)) ?? 0,
				lag: average(routeSamples.map((sample) => sample.eventLoopLagMs)) ?? 0,
				longFrames: routeSamples.reduce(
					(total, sample) => total + sample.longFrames,
					0
				),
			}))
			.sort((left, right) => right.lag - left.lag);
	}, [samples]);

	return (
		<section className="panel-root">
			<PanelHeader
				title="Performance"
				description="Record interactions to inspect JavaScript responsiveness. The app supplies the overall grade, including severe stalls that averages can hide. CPU and memory appear only when a native sampler reports them. Use a release build for representative measurements."
				meta={
					<StatusPill tone={gradeTone(summary?.grade ?? 'idle')} dot>
						{summary?.grade === 'needsAttention'
							? 'Needs attention'
							: (summary?.grade ?? 'idle')}
					</StatusPill>
				}
				actions={
					review?.isActive ? (
						<Button
							isDisabled={!canRunAction('performance', 'stop')}
							size="sm"
							variant="danger-soft"
							onPress={() =>
								void runAction(
									'performance',
									'stop',
									{},
									'Performance review stopped.'
								)
							}
						>
							<Square className="h-3 w-3 fill-current" /> Stop review
						</Button>
					) : (
						<Button
							isDisabled={!canRunAction('performance', 'start')}
							size="sm"
							variant="primary"
							onPress={() =>
								void runAction(
									'performance',
									'start',
									{},
									'Performance review started.'
								)
							}
						>
							<Play className="h-3.5 w-3.5 fill-current" /> Start review
						</Button>
					)
				}
			/>
			{review?.error ? (
				<div className="runtime-banner" role="alert">
					<strong>Performance collector stopped</strong>
					<span>{review.error}</span>
				</div>
			) : null}
			{review && review.droppedSampleCount > 0 ? (
				<PanelNotice title="Earlier performance samples were omitted.">
					{review.droppedSampleCount} sample
					{review.droppedSampleCount === 1 ? ' was' : 's were'} dropped by the
					on-device or desktop capture budget. Charts and route rankings reflect
					the retained window only.
				</PanelNotice>
			) : null}
			<div className="panel-scroll p-5">
				<div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
					<MetricCard
						label="JS FPS"
						value={latest ? Math.round(latest.jsFps).toString() : '—'}
						suffix="fps"
						icon={<Gauge className="h-4 w-4" />}
						values={samples.slice(-60).map((sample) => sample.jsFps)}
						maxValue={60}
						tone="brand"
						description="Animation-frame cadence on the JavaScript runtime."
					/>
					<MetricCard
						label="Event loop lag"
						value={latest ? latest.eventLoopLagMs.toFixed(1) : '—'}
						suffix="ms"
						icon={<TimerReset className="h-4 w-4" />}
						values={samples.slice(-60).map((sample) => sample.eventLoopLagMs)}
						tone="amber"
						description="Scheduler drift that reveals blocked JS interactions."
					/>
					{samples.some((sample) => sample.cpuPercent !== undefined) ? (
						<MetricCard
							label="CPU"
							value={formatPercent(latest?.cpuPercent)}
							icon={<Cpu className="h-4 w-4" />}
							values={samples
								.slice(-60)
								.flatMap((sample) =>
									sample.cpuPercent === undefined ? [] : [sample.cpuPercent]
								)}
							maxValue={100}
							tone="green"
							description="Native process CPU when the host exposes it."
						/>
					) : null}
					{samples.some((sample) => sample.memoryMb !== undefined) ? (
						<MetricCard
							label="Memory"
							value={
								latest?.memoryMb === undefined
									? '—'
									: latest.memoryMb.toFixed(1)
							}
							suffix={latest?.memoryMb === undefined ? undefined : 'MB'}
							icon={<MemoryStick className="h-4 w-4" />}
							values={samples
								.slice(-60)
								.flatMap((sample) =>
									sample.memoryMb === undefined ? [] : [sample.memoryMb]
								)}
							tone="violet"
							description="Resident memory when native instrumentation is installed."
						/>
					) : null}
				</div>

				<div className="mb-4 grid grid-cols-[minmax(0,1.6fr)_minmax(320px,.8fr)] gap-4 max-[1120px]:grid-cols-1">
					<SectionCard
						title="Interaction trace"
						actions={
							<span className="flex items-center gap-1.5 font-mono text-xs text-(--text-3)">
								<span
									className={`h-1.5 w-1.5 rounded-full ${review?.isActive ? 'animate-pulse bg-(--danger)' : 'bg-foreground/20'}`}
								/>
								{review?.isActive ? 'Recording' : `${samples.length} samples`}
							</span>
						}
					>
						<p className="m-0 mb-3 text-xs text-(--text-3)">
							JS FPS and event-loop lag over the current review
						</p>
						<PerformanceTrace samples={samples.slice(-120)} />
					</SectionCard>
					<SectionCard icon={<Activity />} title="Review summary">
						<div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-foreground/8 bg-foreground/8">
							{[
								['Duration', formatDuration(summary?.durationMs)],
								[
									'Average JS FPS',
									summary ? summary.averageJsFps.toFixed(1) : '—',
								],
								[
									'P95 loop lag',
									summary ? `${summary.p95EventLoopLagMs.toFixed(1)} ms` : '—',
								],
								['Long frames', summary?.longFrameCount ?? '—'],
							].map(([label, value]) => (
								<div className="bg-surface p-3" key={label}>
									<p className="m-0 text-xs uppercase tracking-[0.06em] text-(--text-3)">
										{label}
									</p>
									<p className="mb-0 mt-1 font-mono text-sm text-(--foreground)">
										{value}
									</p>
								</div>
							))}
						</div>
					</SectionCard>
				</div>

				<div className="grid grid-cols-[minmax(0,1fr)_minmax(420px,1.4fr)] gap-4 max-[1120px]:grid-cols-1">
					<SectionCard title="Route ranking" bodyClassName="p-0">
						{routeStats.length === 0 ? (
							<p className="m-0 p-4 text-xs leading-5 text-(--text-3)">
								Record an interaction to compare responsiveness by route.
							</p>
						) : (
							routeStats.map((route) => (
								<div
									className="grid grid-cols-[minmax(0,1fr)_70px_70px] items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
									key={route.route}
								>
									<div className="min-w-0">
										<p className="m-0 truncate font-mono text-xs text-(--foreground)">
											{route.route}
										</p>
										<p className="mb-0 mt-1 text-xs text-(--text-3)">
											{route.samples} samples · {route.longFrames} long frames
										</p>
									</div>
									<span className="text-right font-mono text-xs text-(--muted)">
										{route.jsFps.toFixed(1)} fps
									</span>
									<span
										className={`text-right font-mono text-xs ${route.lag > 32 ? 'text-warning-text' : 'text-(--brand-text)'}`}
									>
										{route.lag.toFixed(1)} ms
									</span>
								</div>
							))
						)}
					</SectionCard>
					<SectionCard title="Latest samples" bodyClassName="p-0">
						<div className="max-h-[340px] overflow-auto">
							<table className="w-full border-collapse text-left">
								<thead className="sticky top-0 bg-overlay text-xs uppercase tracking-[0.06em] text-(--text-3)">
									<tr>
										<th className="px-4 py-2 font-medium">JS FPS</th>
										<th className="px-3 py-2 font-medium">Loop lag</th>
										<th className="px-3 py-2 font-medium">Max frame</th>
										<th className="px-4 py-2 text-right font-medium">Long</th>
									</tr>
								</thead>
								<tbody>
									{samples.length === 0 ? (
										<tr>
											<td
												className="px-4 py-6 text-center text-xs text-(--text-3)"
												colSpan={4}
											>
												No samples recorded yet.
											</td>
										</tr>
									) : (
										samples
											.slice(-20)
											.reverse()
											.map((sample) => (
												<tr
													className="border-t border-foreground/[0.06] font-mono text-xs text-(--muted)"
													key={sample.id}
												>
													<td className="px-4 py-2.5 text-(--foreground)">
														{sample.jsFps.toFixed(1)}
													</td>
													<td
														className={`px-3 py-2.5 ${sample.eventLoopLagMs > 32 ? 'text-warning-text' : ''}`}
													>
														{sample.eventLoopLagMs.toFixed(1)} ms
													</td>
													<td className="px-3 py-2.5">
														{sample.maxFrameMs.toFixed(1)} ms
													</td>
													<td className="px-4 py-2.5 text-right">
														{sample.longFrames}
													</td>
												</tr>
											))
									)}
								</tbody>
							</table>
						</div>
					</SectionCard>
				</div>
			</div>
		</section>
	);
}

function PerformanceTrace({ samples }: { samples: PerformanceSample[] }) {
	const width = 720;
	const height = 190;
	const jsPoints = sparklinePoints(
		samples.map((sample) => sample.jsFps),
		width,
		height - 20,
		0,
		60
	);
	const lagPoints = sparklinePoints(
		samples.map((sample) => sample.eventLoopLagMs),
		width,
		height - 20,
		0,
		Math.max(80, ...samples.map((sample) => sample.eventLoopLagMs))
	);
	return (
		<div>
			<div className="mb-3 flex items-center gap-4 text-xs uppercase tracking-[0.06em] text-(--text-3)">
				<span className="flex items-center gap-1.5">
					<span className="h-1.5 w-3 rounded-full bg-(--brand)" /> JS FPS
				</span>
				<span className="flex items-center gap-1.5">
					<span className="h-1.5 w-3 rounded-full bg-warning" /> Loop lag
				</span>
			</div>
			<svg
				aria-label="Performance trace"
				className="h-[210px] w-full"
				role="img"
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
			>
				{[0, 1, 2, 3, 4].map((line) => (
					<line
						key={line}
						x1="0"
						x2={width}
						y1={(line / 4) * (height - 20)}
						y2={(line / 4) * (height - 20)}
						stroke="var(--separator)"
						strokeDasharray="3 5"
					/>
				))}
				<polyline
					fill="none"
					points={lagPoints}
					stroke="var(--warning)"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeOpacity=".65"
					strokeWidth="1.25"
					vectorEffect="non-scaling-stroke"
				/>
				<polyline
					fill="none"
					points={jsPoints}
					stroke="var(--brand)"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="1.75"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
		</div>
	);
}
