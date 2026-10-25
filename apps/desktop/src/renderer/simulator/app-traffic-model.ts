import { formatAgo } from '@/lib/format';
import { laneBackendStack, portOf } from '@/simulator/supabase-cross-panel';
import type { LaneView } from '../../shared/lane-protocol';
import type { DeviceInfo, EnvironmentEntry } from '../../shared/protocol';
import {
	type SupabaseStackSummary,
	type SupabaseState,
	type SupabaseTrafficSignature,
	supabaseStackTitle,
} from '../../shared/supabase-protocol';
import {
	appTrafficLabel,
	classifyAppTraffic,
	explainAppTraffic,
	type SupabaseTrafficClassification,
	type SupabaseTrafficEntry,
	type SupabaseTrafficLabels,
	type SupabaseTrafficTarget,
	supabaseTrafficTarget,
} from '../../shared/supabase-traffic';

/**
 * Which backend the connected app talks to, joined the only way the data
 * allows: the app's DeviceSession reports its Simulator, a lane runs on that
 * Simulator, and the lane's backend names the stack it should use. Every
 * verdict comes from the shared classifier over already-redacted entries
 * and main's signature; nothing here reads a key or a storage value.
 */

type Tone = 'success' | 'warning' | 'danger' | 'default';

export type AppTrafficInputs = Readonly<{
	device: Readonly<{ info: Pick<DeviceInfo, 'simulatorUdid'> }> | null;
	entries: readonly SupabaseTrafficEntry[];
	/** The lane on the app's Simulator, when one runs there. */
	lane: Pick<LaneView, 'id' | 'backend'> | undefined;
	state: Pick<SupabaseState, 'feature' | 'stacks' | 'trafficSignature'>;
}>;

export type AppTrafficView = Readonly<{
	/** Local Supabase is on. */
	enabled: boolean;
	/** The app reports its Simulator, so its traffic can be tied to a lane. */
	linked: boolean;
	hasLane: boolean;
	/** The lane asked for a backend, so there is a stack to compare with. */
	expects: boolean;
	/** The lane's stack, also when main has not listed it yet. */
	expectedStackId?: string;
	expectedStack?: SupabaseStackSummary;
	classification: SupabaseTrafficClassification;
	labels: SupabaseTrafficLabels;
}>;

/** What the app should talk to: its lane's stack, when the lane has one. */
export function appTrafficExpectation(
	lane: Pick<LaneView, 'id' | 'backend'> | undefined,
	state: Pick<SupabaseState, 'stacks'>
): Readonly<{
	expects: boolean;
	stack?: SupabaseStackSummary;
	stackId?: string;
	port?: number;
}> {
	if (!lane) return { expects: false };
	const stack = laneBackendStack(lane, state);
	const policy = lane.backend?.policy;
	const expects =
		stack !== undefined || (policy !== undefined && policy !== 'off');
	const stackId = stack?.id ?? lane.backend?.stackId;
	const port = stack?.ports.api ?? portOf(lane.backend?.apiUrl);
	return {
		expects,
		...(stack ? { stack } : {}),
		...(stackId === undefined ? {} : { stackId }),
		...(port === undefined ? {} : { port }),
	};
}

/** Labels the classifier's sentences use: branch names and the lane's port. */
function appTrafficLabels(
	state: Pick<SupabaseState, 'stacks'>,
	expectedPort: number | undefined
): SupabaseTrafficLabels {
	return {
		stackLabel: (stackId) => {
			const stack = state.stacks.find((candidate) => candidate.id === stackId);
			return stack ? supabaseStackTitle(stack) : undefined;
		},
		...(expectedPort === undefined ? {} : { expectedPort }),
	};
}

/** The app's traffic, classified against its lane's stack. */
export function appTrafficView(inputs: AppTrafficInputs): AppTrafficView {
	const enabled = inputs.state.feature.enabled;
	const linked = Boolean(inputs.device?.info.simulatorUdid);
	const expectation = appTrafficExpectation(inputs.lane, inputs.state);
	const classification = classifyAppTraffic(
		enabled ? inputs.entries : [],
		inputs.state.trafficSignature,
		{
			linked,
			...(expectation.stackId === undefined
				? {}
				: { expectedStackId: expectation.stackId }),
		}
	);
	return {
		enabled,
		linked,
		hasLane: inputs.lane !== undefined,
		expects: expectation.expects,
		...(expectation.stackId === undefined
			? {}
			: { expectedStackId: expectation.stackId }),
		...(expectation.stack ? { expectedStack: expectation.stack } : {}),
		classification,
		labels: appTrafficLabels(inputs.state, expectation.port),
	};
}

type AppTrafficBanner = Readonly<{
	text: string;
	tone: 'warning' | 'danger';
	/** Announced when it changes; the counts in `text` are not. */
	announcement: string;
	/** The stack Open in Supabase lands on. */
	stackId?: string;
	/** The traffic Show this traffic filters Network to. */
	filter?: NetworkTargetFilter;
}>;

function lowerFirst(text: string): string {
	return text.length === 0 ? text : `${text[0]?.toLowerCase()}${text.slice(1)}`;
}

/**
 * The connected workspace banner: only for a real mismatch, a lane whose app
 * talks to another stack, a hosted or remote project, an unknown local
 * server, the legacy :54321, or several at once. No traffic, an app that is
 * not linked, or a lane without a backend never shows one.
 */
export function appTrafficBanner(
	view: AppTrafficView,
	appName: string
): AppTrafficBanner | undefined {
	const { classification } = view;
	if (
		!view.enabled ||
		!view.linked ||
		!view.expects ||
		(classification.tone !== 'warning' && classification.tone !== 'danger')
	) {
		return undefined;
	}
	const sentence = explainAppTraffic(classification, view.labels);
	const text =
		classification.verdict === 'mixed'
			? `${appName}'s ${lowerFirst(sentence.replace(/^Its /, ''))}`
			: `${appName} ${lowerFirst(sentence)}`;
	const dominant = classification.dominant;
	const stackId =
		dominant?.kind === 'other-stack'
			? dominant.stackId
			: view.expectedStack?.id;
	return {
		text,
		tone: classification.tone,
		announcement: `App traffic: ${appTrafficLabel(classification, view.labels)}.`,
		...(stackId === undefined ? {} : { stackId }),
		...(dominant ? { filter: networkTargetFilter(dominant) } : {}),
	};
}

/** The stack detail Overview's App traffic row (P5). */
export type StackAppTrafficRow = Readonly<{
	/** The connected app the row describes; Show traffic selects it. */
	deviceId: string;
	/** `uses this stack · 48 requests · 5 s ago`. */
	text: string;
	tone: Tone;
	/** What Show traffic filters Network to; absent before any traffic. */
	filter?: NetworkTargetFilter;
}>;

/**
 * The first connected app on a Simulator one of the stack's lanes runs on,
 * classified against this stack. Undefined while local Supabase is off, when
 * no such app is connected, or when that Simulator's lane uses another stack.
 */
export function stackAppTrafficRow(
	stack: Pick<SupabaseStackSummary, 'id' | 'lanes'>,
	inputs: Readonly<{
		devices: readonly Readonly<{
			info: Pick<DeviceInfo, 'id' | 'simulatorUdid'>;
			status: 'online' | 'offline' | 'simulated';
			tools: Readonly<{ network: readonly SupabaseTrafficEntry[] }>;
		}>[];
		laneForSimulator: (
			udid: string
		) => Pick<LaneView, 'id' | 'backend'> | undefined;
		state: Pick<SupabaseState, 'feature' | 'stacks' | 'trafficSignature'>;
		now: number;
	}>
): StackAppTrafficRow | undefined {
	const udids = new Set(stack.lanes.map((lane) => lane.simulatorUdid));
	const device = inputs.devices.find(
		(candidate) =>
			candidate.status !== 'offline' &&
			candidate.info.simulatorUdid !== undefined &&
			udids.has(candidate.info.simulatorUdid)
	);
	const udid = device?.info.simulatorUdid;
	if (!device || udid === undefined) return undefined;
	const view = appTrafficView({
		device: { info: { simulatorUdid: udid } },
		entries: device.tools.network,
		lane: inputs.laneForSimulator(udid),
		state: inputs.state,
	});
	if (!view.enabled || view.expectedStackId !== stack.id) return undefined;
	const { classification } = view;
	const parts = [appTrafficLabel(classification, view.labels)];
	if (classification.total > 0) {
		parts.push(
			`${classification.total} ${classification.total === 1 ? 'request' : 'requests'}`
		);
	}
	if (classification.lastAt !== undefined) {
		parts.push(formatAgo(classification.lastAt, inputs.now));
	}
	return {
		deviceId: device.info.id,
		text: parts.join(' · '),
		tone: classification.tone,
		...(classification.dominant
			? { filter: networkTargetFilter(classification.dominant) }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Network: per-request target badges and the backend filter

/** One backend a request went to; the Network filter matches on `key`. */
export type NetworkTargetFilter = Readonly<{ key: string; label: string }>;

/** A stable key per backend target: the same stack, host or port. */
export function networkTargetKey(target: SupabaseTrafficTarget): string {
	switch (target.kind) {
		case 'this-stack':
		case 'other-stack':
			return `stack:${target.stackId}`;
		case 'hosted':
		case 'remote':
			return `host:${target.host}`;
		case 'unknown-local':
		case 'legacy':
			return `local:${target.port}`;
	}
}

/** Where a target lives, the way the Network host cell writes it. */
export function networkTargetOrigin(target: SupabaseTrafficTarget): string {
	switch (target.kind) {
		case 'hosted':
		case 'remote':
			return target.host;
		default:
			return `127.0.0.1:${target.port}`;
	}
}

/** The Network filter for one target: `origin 127.0.0.1:24410`. */
export function networkTargetFilter(
	target: SupabaseTrafficTarget
): NetworkTargetFilter {
	return {
		key: networkTargetKey(target),
		label: `origin ${networkTargetOrigin(target)}`,
	};
}

export type NetworkTargetBadge = Readonly<{
	label: string;
	tone: Tone;
	/** The detail pane's explanation, e.g. `not this lane's stack (:21734)`. */
	detail: string;
}>;

/**
 * The badge in a Supabase-shaped request's host cell: `lane stack`,
 * `feat-payments stack`, `hosted abcd1234`, `legacy :54321`. Without a lane
 * stack to compare with nothing is amber; the Docker-era port stays red.
 */
export function networkTargetBadge(
	target: SupabaseTrafficTarget,
	view: Pick<AppTrafficView, 'expects' | 'labels'>
): NetworkTargetBadge {
	const port =
		view.labels.expectedPort === undefined
			? ''
			: ` (:${view.labels.expectedPort})`;
	const lanePort = `this lane's stack${port}`;
	const mismatch = (label: string, what: string): NetworkTargetBadge =>
		view.expects
			? { label, tone: 'warning', detail: `${what}, not ${lanePort}` }
			: { label, tone: 'default', detail: what };
	switch (target.kind) {
		case 'this-stack':
			return {
				label: 'lane stack',
				tone: 'success',
				detail: `This lane's stack${port}`,
			};
		case 'other-stack': {
			const name =
				view.labels.stackLabel?.(target.stackId) ??
				`${target.stackId.slice(0, 8)}…`;
			return mismatch(
				`${name} stack`,
				`The stack for ${name} (:${target.port})`
			);
		}
		case 'hosted':
			return mismatch(
				`hosted ${target.projectRef}`,
				`The hosted project ${target.projectRef}`
			);
		case 'remote':
			return mismatch('remote', `A remote Supabase API on ${target.host}`);
		case 'unknown-local':
			return mismatch(
				`local :${target.port}`,
				`An unknown local server on :${target.port}`
			);
		case 'legacy':
			return {
				label: `legacy :${target.port}`,
				tone: 'danger',
				detail: `The Docker-era default port :${target.port}; a Docker stack there listens on your network`,
			};
	}
}

/**
 * Where one request went, against main's signature and the lane's stack;
 * nothing while local Supabase is off.
 */
export function appTrafficTarget(
	entry: SupabaseTrafficEntry,
	signature: SupabaseTrafficSignature,
	context: Readonly<{ enabled: boolean; expectedStackId?: string | undefined }>
): SupabaseTrafficTarget | undefined {
	if (!context.enabled) return undefined;
	return supabaseTrafficTarget(entry, signature, context.expectedStackId);
}

// ---------------------------------------------------------------------------
// Diagnostics: the Local Supabase health card

type AppTrafficHealth = Readonly<{
	value: string;
	detail: string;
	tone: Tone;
}>;

/** The Diagnostics card: verdict, stack and evidence, never OK without proof. */
export function appTrafficHealth(view: AppTrafficView): AppTrafficHealth {
	const { classification } = view;
	if (!view.linked) {
		return {
			value: 'App not linked',
			detail: "It doesn't report its Simulator, so no lane can be matched.",
			tone: 'default',
		};
	}
	if (!view.hasLane) {
		return {
			value: 'No lane',
			detail: 'No lane runs on its Simulator.',
			tone: 'default',
		};
	}
	if (!view.expects) {
		return {
			value: 'No lane backend',
			detail: 'Its lane runs without a local backend.',
			tone: 'default',
		};
	}
	const stack = view.expectedStack
		? `${supabaseStackTitle(view.expectedStack)}${view.labels.expectedPort === undefined ? '' : ` :${view.labels.expectedPort}`}`
		: "the lane's stack";
	if (classification.verdict === 'no-traffic') {
		return {
			value: 'No app traffic seen',
			detail: `Lane stack ${stack} · no Supabase requests yet, which is not proof.`,
			tone: 'default',
		};
	}
	return {
		value: appTrafficLabel(classification, view.labels),
		detail: `Lane stack ${stack} · ${classification.matching} of ${classification.total} requests`,
		tone: classification.tone,
	};
}

// ---------------------------------------------------------------------------
// Environment: the declared Supabase URL against the lane's stack

type EnvironmentSupabaseCheck = Readonly<{
	id: string;
	key: string;
	/** The value's origin only, never its path or query. */
	origin: string;
	status: string;
	tone: Tone;
	text: string;
	/** Why the app's own https-only URL rule flags a local stack. */
	note?: string;
}>;

function declaredUrl(value: string): URL | undefined {
	const text = value.trim();
	if (!/^https?:\/\//i.test(text)) return undefined;
	try {
		const url = new URL(text);
		return url.host ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every declared value that points at a Supabase API, matched by its value
 * (loopback port, hosted domain, legacy port), never by its key name, and
 * compared with the lane's stack API URL. Local http is what a lane's stack
 * serves, so it reads as expected even where the core URL rule only
 * accepts https.
 */
export function environmentSupabaseChecks(
	entries: readonly EnvironmentEntry[],
	view: AppTrafficView,
	state: Pick<SupabaseState, 'trafficSignature'>
): readonly EnvironmentSupabaseCheck[] {
	if (!view.enabled) return [];
	const lane =
		view.labels.expectedPort === undefined
			? "this lane's stack"
			: `this lane's stack (:${view.labels.expectedPort})`;
	return entries.flatMap((entry): EnvironmentSupabaseCheck[] => {
		const url = declaredUrl(entry.valueText);
		if (!url) return [];
		const target = supabaseTrafficTarget(
			{ at: 0, url: url.href, host: url.host, path: url.pathname },
			state.trafficSignature,
			view.expectedStackId
		);
		if (!target) return [];
		const origin = url.origin;
		const badge = networkTargetBadge(target, view);
		const base = { id: entry.id, key: entry.key, origin };
		if (target.kind === 'this-stack') {
			const note =
				url.protocol === 'http:' && entry.status === 'valueMismatch'
					? "Local http is expected for a lane's stack; the app's URL rule only accepts https."
					: undefined;
			return [
				{
					...base,
					status: 'matches',
					tone: 'success',
					text: `Matches ${lane}.`,
					...(note ? { note } : {}),
				},
			];
		}
		return [
			{
				...base,
				status: badge.label,
				tone: badge.tone,
				text: `Points at ${lowerFirst(badge.detail)}.`,
			},
		];
	});
}
