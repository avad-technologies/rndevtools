import {
	formatSupabaseSize,
	isLiveStackState,
	isSupabaseStackLanExposed,
	type SupabaseAgentRequest,
	type SupabaseOperation,
	type SupabaseStackSummary,
	type SupabaseState,
	supabaseAgentLabel,
	supabaseConfirmationRequired,
	supabasePolicyTrustChanges,
	supabaseStackTitle,
} from '../../shared/supabase-protocol';
import type { SupabaseConfirmationFacts } from './service-ports';

/**
 * What the main-owned native dialog says for each operation that needs one.
 * Every line is built from main's own state (a fresh stack list, records,
 * measurements); nothing comes from the renderer, and an agent's note never
 * appears. Cancel is always the default, added by the dialog itself.
 */

const MAX_NAMED = 10;

/** Facts main knows that the renderer state does not carry. */
type SupabaseConfirmationContext = Readonly<{
	state: SupabaseState;
	now: number;
	/** Public ports a stack holds in the port registry. */
	reservedPorts?: (stackId: string) => number | undefined;
}>;

function shortId(id: string): string {
	return `${id.slice(0, 8)}…`;
}

function size(bytes: number | undefined): string | undefined {
	return bytes === undefined ? undefined : formatSupabaseSize(bytes);
}

function ago(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function names(values: readonly string[]): string {
	const shown = values.slice(0, MAX_NAMED);
	const rest = values.length - shown.length;
	return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

function totalBytes(
	stacks: readonly SupabaseStackSummary[]
): number | undefined {
	const known = stacks.filter((stack) => stack.diskBytes !== undefined);
	return known.length === 0
		? undefined
		: known.reduce((total, stack) => total + (stack.diskBytes ?? 0), 0);
}

function liveAgentLines(
	stack: SupabaseStackSummary,
	consequence: string,
	skip?: Pick<SupabaseAgentRequest['requester'], 'kind' | 'sessionId'>
): string[] {
	const labels = new Set<string>();
	for (const hold of stack.holds) {
		if (!hold.live || hold.holder === 'operator' || !hold.agent) continue;
		if (
			skip &&
			hold.agent.kind === skip.kind &&
			hold.agent.sessionId === skip.sessionId
		) {
			continue;
		}
		labels.add(supabaseAgentLabel(hold.agent));
	}
	for (const keeper of stack.cwdKeepers) {
		labels.add(supabaseAgentLabel(keeper.agent));
	}
	return [...labels]
		.slice(0, 4)
		.map((label) => `${label} (live) uses it; ${consequence}`);
}

function hasLiveAgent(
	stack: SupabaseStackSummary,
	skip?: Pick<SupabaseAgentRequest['requester'], 'kind' | 'sessionId'>
): boolean {
	return (
		stack.holds.some(
			(hold) =>
				hold.live &&
				hold.holder !== 'operator' &&
				hold.agent !== undefined &&
				!(
					skip &&
					hold.agent.kind === skip.kind &&
					hold.agent.sessionId === skip.sessionId
				)
		) || stack.cwdKeepers.length > 0
	);
}

function stackLine(
	stack: SupabaseStackSummary,
	context: SupabaseConfirmationContext,
	withPorts: boolean
): string {
	const parts = [`Stack ${shortId(stack.id)}`, stack.runtime];
	const bytes = size(stack.diskBytes);
	if (bytes) parts.push(bytes);
	const ports = context.reservedPorts?.(stack.id);
	if (withPorts && ports !== undefined && ports > 0) {
		parts.push(`frees ${ports} ${ports === 1 ? 'port' : 'ports'}`);
	}
	const cache = size(context.state.disk.cacheBytes);
	if (withPorts && cache) parts.push(`keeps the ${cache} cache`);
	return parts.join(' · ');
}

function worktreeLine(stack: SupabaseStackSummary): string {
	if (!stack.worktreeExists) return 'Its worktree was deleted.';
	return stack.worktreeLabel ? `Worktree ${stack.worktreeLabel}` : '';
}

function requesterLine(
	request: SupabaseAgentRequest,
	now: number,
	verb: string
): string {
	const label = supabaseAgentLabel({
		kind: request.requester.kind,
		sessionId: request.requester.sessionId,
		synthetic: request.requester.synthetic,
	});
	return `${label} (${request.requester.live ? 'live' : 'gone'}) asked to ${verb} it ${ago(request.createdAt, now)}.`;
}

function destroyFacts(
	stacks: readonly SupabaseStackSummary[],
	context: SupabaseConfirmationContext,
	request?: SupabaseAgentRequest
): SupabaseConfirmationFacts | undefined {
	const [first] = stacks;
	if (!first) return undefined;
	const bytes = size(totalBytes(stacks));
	const withUploads = stacks.filter((stack) => stack.worktreeExists);
	const uploadBytes = withUploads.reduce(
		(total, stack) => total + (stack.uploadsBytes ?? 0),
		0
	);
	const uploadsKnown = withUploads.some(
		(stack) => stack.uploadsBytes !== undefined
	);
	const checkbox =
		withUploads.length === 0
			? undefined
			: {
					label:
						stacks.length === 1
							? `Also delete Storage uploads (${uploadsKnown ? formatSupabaseSize(uploadBytes) : 'size unknown'} in …/stack-uploads/${shortId(first.id)})`
							: `Also delete their Storage uploads (${uploadsKnown ? formatSupabaseSize(uploadBytes) : 'size unknown'})`,
					checkedByDefault: false,
				};
	const uploadsGone =
		withUploads.length < stacks.length
			? stacks.length === 1
				? 'Uploads lived in the deleted worktree and are already gone.'
				: 'Uploads of stacks whose worktree was deleted are already gone.'
			: '';
	if (stacks.length === 1) {
		const branch = supabaseStackTitle(first);
		const skip = request?.requester;
		const anyway = hasLiveAgent(first, skip);
		return {
			title: anyway
				? `Destroy the local Supabase stack for ${branch} while it is in use?`
				: `Destroy the local Supabase stack for ${branch}?`,
			lines: [
				"Deletes its database and logs. This can't be undone.",
				worktreeLine(first),
				stackLine(first, context, true),
				...(request ? [requesterLine(request, context.now, 'destroy')] : []),
				...(isSupabaseStackLanExposed(first)
					? [
							'It runs on a container runtime; nothing is deleted if that runtime does not answer.',
						]
					: []),
				...liveAgentLines(
					first,
					'its app loses its database until a new one starts.',
					skip
				),
				uploadsGone,
			].filter(Boolean),
			choices: [
				{
					label: anyway
						? `Destroy anyway${bytes ? ` (${bytes})` : ''}`
						: `Destroy ${branch}${bytes ? ` (${bytes})` : ''}`,
				},
			],
			...(checkbox ? { checkbox } : {}),
		};
	}
	const titles = stacks.map((stack) => supabaseStackTitle(stack));
	const ports = stacks.reduce(
		(total, stack) => total + (context.reservedPorts?.(stack.id) ?? 0),
		0
	);
	const inUse = stacks.filter((stack) => hasLiveAgent(stack));
	return {
		title: `Destroy ${stacks.length} local Supabase stacks${bytes ? ` (${bytes})` : ''}?`,
		lines: [
			`Stacks: ${names(titles)}.`,
			"Deletes their databases and logs. This can't be undone.",
			...(ports > 0 ? [`Frees ${ports} ports.`] : []),
			...(inUse.length > 0
				? [
						`${names(inUse.map((stack) => supabaseStackTitle(stack)))} ${inUse.length === 1 ? 'is' : 'are'} in use by a live agent.`,
					]
				: []),
			uploadsGone,
		].filter(Boolean),
		choices: [
			{
				label: `Destroy ${stacks.length} stacks${bytes ? ` (${bytes})` : ''}`,
			},
		],
		...(checkbox ? { checkbox } : {}),
	};
}

function resetFacts(
	stack: SupabaseStackSummary,
	seed: boolean,
	context: SupabaseConfirmationContext,
	request?: SupabaseAgentRequest
): SupabaseConfirmationFacts {
	const branch = supabaseStackTitle(stack);
	const migrations =
		stack.migrationCount === 1
			? '1 migration'
			: `${stack.migrationCount} migrations`;
	return {
		title: `Reset the database for ${branch}?`,
		lines: [
			seed
				? `Drops all data and auth users, then re-runs ${migrations} and the seed (about 5 s).`
				: `Drops all data and auth users, then re-runs ${migrations} without the seed.`,
			'Keeps the stack id, URL, ports and keys. No backup is kept.',
			worktreeLine(stack),
			...(request ? [requesterLine(request, context.now, 'reset')] : []),
			...liveAgentLines(
				stack,
				'its app sees an empty database and signed-out users.',
				request?.requester
			),
		].filter(Boolean),
		choices: [{ label: seed ? `Reset ${branch}` : 'Reset without seed' }],
	};
}

/**
 * The dialog for an operation, or undefined when none is needed. Defined
 * for every case supabaseConfirmationRequired asks for, as long as its
 * stacks are in the state.
 */
export function describeSupabaseConfirmation(
	operation: SupabaseOperation,
	context: SupabaseConfirmationContext
): SupabaseConfirmationFacts | undefined {
	const { state } = context;
	if (!supabaseConfirmationRequired(operation, state)) return undefined;
	const stack = (id: string) => state.stacks.find((entry) => entry.id === id);
	switch (operation.kind) {
		case 'set-enabled': {
			if (operation.enabled) {
				return {
					title: 'Turn on local Supabase (alpha)?',
					lines: [
						'Each worktree and branch gets its own local Supabase on 127.0.0.1, run natively rather than in Docker as Supabase recommends for several projects: listeners stay on this Mac, but stacks are separate databases, not isolated tenants.',
						'It assumes a single-user Mac: every stack trusts supabase_admin on loopback and accepts the public default keys.',
						'Stacks RN Devtools starts run outside any agent sandbox.',
						'Codex calls over MCP are attributed by worktree.',
						'Supabase marks these stack commands experimental.',
					],
					choices: [{ label: 'Turn on' }],
				};
			}
			const running = state.stacks.filter(
				(entry) =>
					(entry.origin === 'managed' || entry.origin === 'adopted') &&
					isLiveStackState(entry.state)
			);
			return {
				title: 'Turn off local Supabase?',
				lines: [
					`${running.length} managed ${running.length === 1 ? 'stack is' : 'stacks are'} running: ${names(running.map((entry) => supabaseStackTitle(entry)))}.`,
					'Leaving them running keeps their data and ports; agents start their own native stacks while local Supabase is off.',
					'Stopping them also keeps their data.',
				],
				choices: [
					{ label: 'Leave them running', disposition: 'leave-running' },
					{ label: 'Stop managed stacks', disposition: 'stop-managed' },
				],
			};
		}
		case 'stop': {
			const targets = operation.stackIds.flatMap((id) => {
				const found = stack(id);
				return found ? [found] : [];
			});
			const [first] = targets;
			if (!first) return undefined;
			const name = supabaseStackTitle(first);
			return {
				title: `Stop the stack for ${name}? RN Devtools didn't start it.`,
				lines: [
					"RN Devtools didn't start this stack; an agent or you may be using it.",
					worktreeLine(first),
					stackLine(first, context, false),
					...liveAgentLines(
						first,
						'its app loses the database until it starts again.'
					),
					...(first.runtime === 'docker' || first.runtime === 'podman'
						? [
								'It runs on a container runtime; stopping waits for that runtime to answer.',
							]
						: []),
					'Data and ports are kept; it restarts in about a second.',
				].filter(Boolean),
				choices: [{ label: `Stop ${name}` }],
			};
		}
		case 'destroy': {
			const targets = operation.stackIds.flatMap((id) => {
				const found = stack(id);
				return found ? [found] : [];
			});
			return destroyFacts(targets, context);
		}
		case 'recreate': {
			const target = stack(operation.stackId);
			if (!target) return undefined;
			const branch = supabaseStackTitle(target);
			const changes = (target.recreateChanges ?? [])
				.slice(0, 6)
				.map(
					(change) =>
						`${change.key ?? change.path ?? 'A setting'}: saved ${change.saved ?? 'unknown'}, requested ${change.requested ?? 'unknown'}.`
				);
			return {
				title: `Recreate the stack for ${branch}?`,
				lines: [
					...changes,
					"Destroys its database and logs, then creates a fresh stack with its migrations and seed. This can't be undone.",
					worktreeLine(target),
					stackLine(target, context, false),
					...(isSupabaseStackLanExposed(target)
						? [
								'It runs on a container runtime and listens on your network; the new stack is native.',
							]
						: []),
					...liveAgentLines(target, 'its app loses its data.'),
				].filter(Boolean),
				choices: [{ label: `Recreate ${branch}` }],
			};
		}
		case 'reset': {
			const target = stack(operation.stackId);
			return target ? resetFacts(target, operation.seed, context) : undefined;
		}
		case 'set-studio': {
			const target = stack(operation.stackId);
			if (!target) return undefined;
			const endpoint = target.apiUrl
				? `${target.apiUrl.replace(/\/$/, '')}/mcp`
				: 'its /mcp endpoint';
			return {
				title: `Enable Studio for ${supabaseStackTitle(target)}?`,
				lines: [
					`Studio and its SQL endpoint ${endpoint} have no authentication and answer any origin: any program on this Mac, and web pages your browser lets reach 127.0.0.1, can run SQL while it is on.`,
					'Studio uses about 1-2 GB awake and takes about 18 s to wake.',
					'Turning it on restarts the stack; its data is kept.',
				],
				choices: [{ label: 'Enable Studio' }],
			};
		}
		case 'update-policy': {
			const changes = supabasePolicyTrustChanges(operation.patch, state.policy);
			const lines = changes.map((change) =>
				change === 'include-studio'
					? 'New stacks start with Studio, whose SQL endpoint has no authentication while it runs; it uses about 1-2 GB awake.'
					: change === 'allow-unverified-patch'
						? 'RN Devtools manages newer patch releases of a verified Supabase CLI minor. Their stack commands are not verified.'
						: "RN Devtools writes each worktree's own keys into supabase/.env.local, only where git ignores that file. Keys apply the next time each stack starts."
			);
			const [first] = changes;
			const title =
				changes.length > 1
					? 'Apply these Supabase trust changes?'
					: first === 'include-studio'
						? 'Stop excluding Studio by default?'
						: first === 'allow-unverified-patch'
							? 'Allow unverified Supabase CLI patch releases?'
							: 'Write per-stack keys into each worktree?';
			return {
				title,
				lines,
				choices: [
					{
						label:
							changes.length > 1
								? 'Apply'
								: first === 'include-studio'
									? 'Include Studio'
									: first === 'allow-unverified-patch'
										? 'Allow'
										: 'Write per-stack keys',
					},
				],
			};
		}
		case 'request.approve': {
			const request = state.requests.find(
				(entry) => entry.id === operation.requestId
			);
			if (!request || request.stackId === undefined) return undefined;
			const target = stack(request.stackId);
			if (!target) return undefined;
			if (request.kind === 'reset') {
				return resetFacts(target, request.seed ?? true, context, request);
			}
			const facts = destroyFacts([target], context, request);
			if (!facts) return undefined;
			return target.state === 'running' ||
				target.state === 'partial' ||
				target.state === 'unhealthy'
				? {
						...facts,
						lines: [
							...facts.lines,
							'It is running; RN Devtools stops it first.',
						],
					}
				: facts;
		}
		default:
			return undefined;
	}
}
