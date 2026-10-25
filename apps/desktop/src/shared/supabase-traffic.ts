import type { NetworkEntry } from './protocol';
import type { SupabaseTrafficSignature } from './supabase-protocol';

/**
 * Which backend a connected app actually talks to (P5). Pure: it reads the
 * app's already-redacted network entries and the signature main publishes
 * (loopback API port → stack, hosted and legacy markers), and never sees a
 * key. "No traffic" and "not linked" are never shown as OK.
 */

export type SupabaseTrafficVerdict =
	| 'uses-this-stack'
	| 'other-stack'
	| 'hosted'
	| 'remote'
	| 'unknown-local'
	| 'mixed'
	| 'legacy-54321'
	| 'no-traffic'
	| 'not-linked';

export type SupabaseTrafficTarget =
	| Readonly<{ kind: 'this-stack'; stackId: string; port: number }>
	| Readonly<{ kind: 'other-stack'; stackId: string; port: number }>
	| Readonly<{ kind: 'hosted'; host: string; projectRef: string }>
	| Readonly<{ kind: 'remote'; host: string }>
	| Readonly<{ kind: 'unknown-local'; port: number }>
	| Readonly<{ kind: 'legacy'; port: number }>;

type SupabaseTrafficTargetCount = SupabaseTrafficTarget &
	Readonly<{ count: number; lastAt: number }>;

export type SupabaseTrafficClassification = Readonly<{
	verdict: SupabaseTrafficVerdict;
	tone: 'success' | 'warning' | 'danger' | 'default';
	/** Supabase-shaped requests counted. */
	total: number;
	/** Requests to the dominant target. */
	matching: number;
	/** Every target seen, most requests first. */
	targets: readonly SupabaseTrafficTargetCount[];
	dominant?: SupabaseTrafficTargetCount;
	lastAt?: number;
}>;

/** The entry fields the classifier reads; redacted URLs are fine. */
export type SupabaseTrafficEntry = Pick<
	NetworkEntry,
	'at' | 'url' | 'host' | 'path'
>;

export type SupabaseTrafficContext = Readonly<{
	/** The stack the app should use: its lane's stack, when it has one. */
	expectedStackId?: string | undefined;
	/** The app reports its Simulator, so its traffic can be tied to a lane. */
	linked: boolean;
	/** Only requests at or after this time count. */
	since?: number | undefined;
}>;

/** A target needs at least this share of the requests to decide the verdict. */
export const SUPABASE_TRAFFIC_DOMINANCE = 0.75;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
	'127.0.0.1',
	'localhost',
	'::1',
]);

function hostParts(
	host: string,
	protocol: string
): { hostname: string; port: number } | undefined {
	const lowered = host.trim().toLowerCase();
	if (lowered === '') return undefined;
	let hostname = lowered;
	let portText = '';
	if (lowered.startsWith('[')) {
		const close = lowered.indexOf(']');
		if (close < 0) return undefined;
		hostname = lowered.slice(1, close);
		portText = lowered.slice(close + 1).replace(/^:/, '');
	} else {
		const separator = lowered.lastIndexOf(':');
		if (separator >= 0 && lowered.indexOf(':') === separator) {
			hostname = lowered.slice(0, separator);
			portText = lowered.slice(separator + 1);
		}
	}
	const fallback = protocol === 'https:' ? 443 : 80;
	const port = portText === '' ? fallback : Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	return { hostname, port };
}

function parseEntry(
	entry: SupabaseTrafficEntry
): { hostname: string; port: number; path: string } | undefined {
	try {
		const url = new URL(entry.url);
		const parts = hostParts(url.host, url.protocol);
		if (!parts) return undefined;
		return { ...parts, path: url.pathname };
	} catch {
		const parts = hostParts(entry.host, 'http:');
		if (!parts) return undefined;
		const queryAt = entry.path.search(/[?#]/);
		return {
			...parts,
			path: queryAt < 0 ? entry.path : entry.path.slice(0, queryAt),
		};
	}
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`)
	);
}

/**
 * Where one request went, or undefined when it is not Supabase traffic (a
 * Metro request, a non-Supabase API). Loopback ports in the signature are
 * stacks whatever the path; other hosts count only with a Supabase API path,
 * except hosted projects, which count whatever the path.
 */
export function supabaseTrafficTarget(
	entry: SupabaseTrafficEntry,
	signature: SupabaseTrafficSignature,
	expectedStackId?: string
): SupabaseTrafficTarget | undefined {
	const parsed = parseEntry(entry);
	if (!parsed) return undefined;
	const { hostname, port, path } = parsed;
	if (LOOPBACK_HOSTS.has(hostname)) {
		const stack = signature.apiPorts.find(
			(candidate) => candidate.port === port
		);
		if (stack) {
			return stack.stackId === expectedStackId
				? { kind: 'this-stack', stackId: stack.stackId, port }
				: { kind: 'other-stack', stackId: stack.stackId, port };
		}
		if (signature.legacyPorts.includes(port)) return { kind: 'legacy', port };
		return hasPrefix(path, signature.pathPrefixes)
			? { kind: 'unknown-local', port }
			: undefined;
	}
	const suffix = signature.hostedSuffixes.find((candidate) =>
		hostname.endsWith(candidate)
	);
	if (suffix) {
		const projectRef = hostname.slice(0, -suffix.length).split('.').pop() ?? '';
		if (/^[a-z0-9-]{1,63}$/.test(projectRef)) {
			return { kind: 'hosted', host: hostname, projectRef };
		}
	}
	return hasPrefix(path, signature.pathPrefixes)
		? { kind: 'remote', host: hostname }
		: undefined;
}

function targetKey(target: SupabaseTrafficTarget): string {
	switch (target.kind) {
		case 'this-stack':
		case 'other-stack':
			return `${target.kind}:${target.stackId}`;
		case 'hosted':
		case 'remote':
			return `${target.kind}:${target.host}`;
		case 'unknown-local':
		case 'legacy':
			return `${target.kind}:${target.port}`;
	}
}

const VERDICT_FOR_TARGET: Readonly<
	Record<SupabaseTrafficTarget['kind'], SupabaseTrafficVerdict>
> = {
	'this-stack': 'uses-this-stack',
	'other-stack': 'other-stack',
	hosted: 'hosted',
	remote: 'remote',
	'unknown-local': 'unknown-local',
	legacy: 'legacy-54321',
};

/** The tone a verdict carries: only `uses-this-stack` is OK. */
export function supabaseTrafficTone(
	verdict: SupabaseTrafficVerdict
): SupabaseTrafficClassification['tone'] {
	switch (verdict) {
		case 'uses-this-stack':
			return 'success';
		case 'legacy-54321':
			return 'danger';
		case 'no-traffic':
		case 'not-linked':
			return 'default';
		default:
			return 'warning';
	}
}

/**
 * Classifies an app's captured traffic: the target with at least 75% of its
 * Supabase requests decides the verdict, otherwise it is `mixed`. An app
 * that does not report its Simulator is `not-linked`, and one with no
 * Supabase requests is `no-traffic`.
 */
export function classifyAppTraffic(
	entries: readonly SupabaseTrafficEntry[],
	signature: SupabaseTrafficSignature,
	context: SupabaseTrafficContext
): SupabaseTrafficClassification {
	const counts = new Map<string, SupabaseTrafficTargetCount>();
	let total = 0;
	let lastAt: number | undefined;
	for (const entry of entries) {
		if (context.since !== undefined && entry.at < context.since) continue;
		const target = supabaseTrafficTarget(
			entry,
			signature,
			context.expectedStackId
		);
		if (!target) continue;
		total += 1;
		lastAt = lastAt === undefined ? entry.at : Math.max(lastAt, entry.at);
		const key = targetKey(target);
		const current = counts.get(key);
		counts.set(key, {
			...target,
			count: (current?.count ?? 0) + 1,
			lastAt: Math.max(current?.lastAt ?? entry.at, entry.at),
		});
	}
	const targets = [...counts.values()].sort(
		(left, right) =>
			right.count - left.count ||
			right.lastAt - left.lastAt ||
			targetKey(left).localeCompare(targetKey(right))
	);
	const [dominant] = targets;
	const base = {
		total,
		targets,
		...(lastAt === undefined ? {} : { lastAt }),
	};
	const finish = (
		verdict: SupabaseTrafficVerdict,
		matching: number,
		withDominant: boolean
	): SupabaseTrafficClassification => ({
		verdict,
		tone: supabaseTrafficTone(verdict),
		matching,
		...base,
		...(withDominant && dominant ? { dominant } : {}),
	});
	if (!context.linked) return finish('not-linked', 0, false);
	if (!dominant) return finish('no-traffic', 0, false);
	if (dominant.count / total >= SUPABASE_TRAFFIC_DOMINANCE) {
		return finish(VERDICT_FOR_TARGET[dominant.kind], dominant.count, true);
	}
	return finish('mixed', dominant.count, true);
}

export type SupabaseTrafficLabels = Readonly<{
	/** A stack's display name, such as its branch. */
	stackLabel?: (stackId: string) => string | undefined;
	/** The API port of the lane's own stack, when it has one. */
	expectedPort?: number | undefined;
}>;

function stackName(
	target: Extract<SupabaseTrafficTarget, { stackId: string }>,
	labels: SupabaseTrafficLabels
): string {
	return (
		labels.stackLabel?.(target.stackId) ?? `${target.stackId.slice(0, 8)}…`
	);
}

/** The short verdict label for the Overview row and Network badges. */
export function appTrafficLabel(
	classification: SupabaseTrafficClassification,
	labels: SupabaseTrafficLabels = {}
): string {
	const target = classification.dominant;
	switch (classification.verdict) {
		case 'uses-this-stack':
			return 'uses this stack';
		case 'other-stack':
			return target?.kind === 'other-stack'
				? `other stack · ${stackName(target, labels)} (:${target.port})`
				: 'other stack';
		case 'hosted':
			return target?.kind === 'hosted'
				? `hosted ${target.projectRef}`
				: 'hosted';
		case 'remote':
			return 'remote';
		case 'unknown-local':
			return 'unknown local';
		case 'mixed':
			return 'mixed';
		case 'legacy-54321':
			return 'legacy :54321';
		case 'no-traffic':
			return 'no app traffic seen';
		case 'not-linked':
			return 'app not linked';
	}
}

/**
 * One sentence for the connected banner and the Overview, e.g. "talks to the
 * stack for feat-payments (:24410), not its lane's stack (:21734): 12 of 14
 * requests."
 */
export function explainAppTraffic(
	classification: SupabaseTrafficClassification,
	labels: SupabaseTrafficLabels = {}
): string {
	const target = classification.dominant;
	const share = `${classification.matching} of ${classification.total} requests`;
	const lane =
		labels.expectedPort === undefined
			? "its lane's stack"
			: `its lane's stack (:${labels.expectedPort})`;
	switch (classification.verdict) {
		case 'uses-this-stack':
			return `Uses this stack: ${share}.`;
		case 'other-stack':
			return target?.kind === 'other-stack'
				? `Talks to the stack for ${stackName(target, labels)} (:${target.port}), not ${lane}: ${share}.`
				: `Talks to another stack, not ${lane}: ${share}.`;
		case 'hosted':
			return target?.kind === 'hosted'
				? `Talks to the hosted project ${target.projectRef}, not ${lane}: ${share}.`
				: `Talks to a hosted project, not ${lane}: ${share}.`;
		case 'remote':
			return target?.kind === 'remote'
				? `Talks to ${target.host}, not ${lane}: ${share}.`
				: `Talks to a remote server, not ${lane}: ${share}.`;
		case 'unknown-local':
			return target?.kind === 'unknown-local'
				? `Talks to an unknown local server on :${target.port}, not ${lane}: ${share}.`
				: `Talks to an unknown local server, not ${lane}: ${share}.`;
		case 'legacy-54321':
			return `Talks to :54321, the Docker-era default port, not ${lane}: ${share}. A Docker stack there listens on your network.`;
		case 'mixed':
			return `Its traffic is split across ${classification.targets.length} backends; the largest gets ${share}.`;
		case 'no-traffic':
			return 'No app traffic seen yet. This is not proof the app uses this stack.';
		case 'not-linked':
			return "App not linked: it doesn't report its Simulator, so its traffic can't be tied to a lane.";
	}
}
