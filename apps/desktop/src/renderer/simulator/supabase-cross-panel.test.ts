import { describe, expect, it } from 'vitest';
import type { LaneView } from '../../shared/lane-protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../shared/supabase-demo-data';
import type {
	LaneBackendSummary,
	SupabaseStackSummary,
	SupabaseState,
} from '../../shared/supabase-protocol';
import {
	laneBackendAvailability,
	laneBackendBrief,
	laneBackendReasonText,
	laneBackendSelect,
	laneBackendStack,
	laneBackendStatusText,
	laneBackendView,
	laneChipFor,
	laneRestartMetroAvailability,
	laneStartPendingMessage,
	laneStopBackend,
	laneWorktreeBackend,
	laneWorktreeOptionSuffix,
	releaseBackendPrompt,
	sessionAttachmentLabel,
	sessionRequestLines,
	sessionSupabaseBackends,
	stackBackendChip,
	stackIdPrefix,
	supabaseChipsVisible,
} from './supabase-cross-panel';

const ids = SUPABASE_DEMO_IDS;
const now = SUPABASE_DEMO_NOW;
const demo = createSupabaseDemoState();
const off: SupabaseState = {
	...demo,
	feature: { ...demo.feature, enabled: false },
};

function stack(id: string, state: SupabaseState = demo): SupabaseStackSummary {
	const found = state.stacks.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`No demo stack ${id}`);
	return found;
}

function withStack(
	id: string,
	patch: Partial<SupabaseStackSummary>
): SupabaseState {
	return {
		...demo,
		stacks: demo.stacks.map((candidate) =>
			candidate.id === id ? { ...candidate, ...patch } : candidate
		),
	};
}

function summary(
	overrides: Partial<LaneBackendSummary> = {}
): LaneBackendSummary {
	return {
		policy: 'auto',
		status: 'ready',
		stackId: ids.featCheckout,
		apiUrl: 'http://127.0.0.1:21734',
		appEnvNames: [
			'EXPO_PUBLIC_SUPABASE_URL',
			'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
		],
		warnings: [],
		...overrides,
	};
}

/** A summary that names no stack and no URL. */
function bare(overrides: Partial<LaneBackendSummary> = {}): LaneBackendSummary {
	return {
		policy: 'auto',
		status: 'skipped',
		appEnvNames: [],
		warnings: [],
		...overrides,
	};
}

function lane(overrides: Partial<LaneView> = {}): LaneView {
	return {
		id: ids.laneCheckout,
		worktreePath: '/Users/dev/code/example-app-wt/feat-checkout',
		branch: 'feat-checkout',
		simulatorUdid: ids.simulatorCheckout,
		environment: 'development',
		port: 8_102,
		metro: 'ready',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		backend: summary(),
		...overrides,
	};
}

describe('chips and the lane ↔ stack join', () => {
	it('shows chips only while local Supabase is on', () => {
		expect(supabaseChipsVisible(demo)).toBe(true);
		expect(supabaseChipsVisible(off)).toBe(false);
		expect(laneChipFor(lane(), demo)).toEqual({
			label: 'db :21734',
			tone: 'success',
		});
		expect(laneChipFor(lane(), off)).toBeUndefined();
		expect(laneChipFor(lane({ backend: undefined }), demo)).toBeUndefined();
	});

	it('finds the stack by the summary, else by the stack that lists the lane', () => {
		expect(laneBackendStack(lane(), demo)?.id).toBe(ids.featCheckout);
		expect(laneBackendStack(lane({ backend: undefined }), demo)?.id).toBe(
			ids.featCheckout
		);
		expect(
			laneBackendStack(
				lane({ backend: summary({ stackId: ids.featPayments }) }),
				demo
			)?.id
		).toBe(ids.featPayments);
		expect(
			laneBackendStack(
				lane({
					id: 'lane-00000000-0000-4000-8000-000000000000',
					backend: undefined,
				}),
				demo
			)
		).toBeUndefined();
	});

	it('words a stack chip where no lane summary speaks for it', () => {
		expect(stackBackendChip(stack(ids.featPayments), demo.jobs)).toEqual({
			label: 'db :24410',
			tone: 'success',
		});
		expect(stackBackendChip(stack(ids.fixAuthRedirect), demo.jobs).label).toBe(
			'db starting'
		);
		expect(stackBackendChip(stack(ids.featOldUi), demo.jobs).label).toBe(
			'db stale'
		);
		expect(stackBackendChip(stack(ids.featSearch), demo.jobs)).toEqual({
			label: 'db stopped',
			tone: 'warning',
		});
		expect(stackBackendChip(stack(ids.legacyMain), demo.jobs)).toEqual({
			label: 'db refused · LAN',
			tone: 'danger',
		});
		expect(stackIdPrefix(ids.featCheckout)).toBe('64616c83…');
	});
});

describe('the lane detail Backend section', () => {
	it('is absent while off, and for a lane that never asked for a backend', () => {
		expect(laneBackendView(lane(), off, now)).toBeUndefined();
		expect(
			laneBackendView(
				lane({
					id: 'lane-00000000-0000-4000-8000-000000000000',
					backend: bare({ policy: 'off', reason: 'off' }),
				}),
				demo,
				now
			)
		).toBeUndefined();
	});

	it('names the stack, its API URL, the injected names and who holds it', () => {
		const view = laneBackendView(lane(), demo, now);
		expect(view?.status.text).toMatch(/^Running.* · stack 64616c83…$/);
		expect(view?.status.tone).toBe('success');
		expect(view?.apiUrl).toBe('http://127.0.0.1:21734');
		expect(view?.appEnvNames).toEqual([
			'EXPO_PUBLIC_SUPABASE_URL',
			'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
		]);
		expect(view?.holder).toEqual({
			text: 'Held by this lane · Claude 7f3a2c91 (live)',
			agent: { kind: 'claude', sessionId: ids.claudeCheckout },
		});
		expect(view?.others).toEqual(['Codex 5d1b8f40 (gone · stops in 7 min)']);
		expect(view?.reason).toBeUndefined();
		expect(view?.needsMetroRestart).toBe(false);
		expect(view?.carryOver).toBe(false);
		expect(JSON.stringify(view)).not.toMatch(/sb_publishable_|sb_secret_|eyJ/);
	});

	it('names a lane started from the desktop and the other holders', () => {
		const pinned = withStack(ids.featCheckout, {
			pinned: true,
			holds: [
				{ holder: 'lane', laneId: ids.laneCheckout, since: 1, live: true },
				{ holder: 'operator', since: 1, live: true },
				{
					holder: 'lane',
					laneId: ids.laneFixAuth,
					since: 1,
					live: true,
				},
			],
		});
		const view = laneBackendView(lane(), pinned, now);
		expect(view?.holder).toEqual({ text: 'Held by this lane · You' });
		expect(view?.others).toEqual(['you (pinned)', 'another lane']);
	});

	it('asks for a Metro restart, flags a carried-over session and lists notes', () => {
		const view = laneBackendView(
			lane({
				backend: summary({
					metro: 'needs-restart',
					warnings: ['previous-session-on-simulator', 'shared-default-keys'],
				}),
			}),
			demo,
			now
		);
		expect(view?.needsMetroRestart).toBe(true);
		expect(view?.carryOver).toBe(true);
		expect(view?.notes).toEqual([
			'Every local stack shares the default keys, so a token from one stack also works on the others.',
		]);
		const listed = withStack(ids.featCheckout, {
			lanes: stack(ids.featCheckout).lanes.map((candidate) => ({
				...candidate,
				needsMetroRestart: true,
			})),
		});
		expect(laneBackendView(lane(), listed, now)?.needsMetroRestart).toBe(true);
	});

	it('reads a skipped backend from its summary and reason', () => {
		const skipped = bare({ reason: 'capacity' });
		const view = laneBackendView(
			lane({
				id: 'lane-00000000-0000-4000-8000-000000000000',
				backend: skipped,
			}),
			demo,
			now
		);
		expect(view?.status).toEqual({
			text: 'Skipped · capacity',
			tone: 'warning',
		});
		expect(view?.reason).toBe(
			'Every stack slot was in use when the lane started.'
		);
		expect(view?.holder).toBeUndefined();
		expect(
			laneBackendReasonText(
				summary({ status: 'failed', reasonText: 'Port 21734 is taken' })
			)
		).toBe('Port 21734 is taken.');
		expect(laneBackendReasonText(summary())).toBeUndefined();
		expect(laneBackendStatusText(undefined, undefined, [])).toEqual({
			text: 'Not attached',
			tone: 'default',
		});
	});
});

describe('Restart Metro to attach and Stop backend', () => {
	const context = { bridgeAvailable: true, state: demo };

	it('checks the bridge, the feature, the platform, in-flight work and Metro', () => {
		expect(laneRestartMetroAvailability({ metro: 'ready' }, context)).toEqual({
			allowed: true,
		});
		expect(
			laneRestartMetroAvailability(
				{ metro: 'ready' },
				{ ...context, bridgeAvailable: false }
			)
		).toMatchObject({ allowed: false, check: 'bridge' });
		expect(
			laneRestartMetroAvailability(
				{ metro: 'ready' },
				{ ...context, state: off }
			)
		).toMatchObject({ allowed: false, check: 'off' });
		expect(
			laneRestartMetroAvailability(
				{ metro: 'ready' },
				{ ...context, pending: true }
			)
		).toMatchObject({ allowed: false, check: 'in-flight' });
		expect(laneRestartMetroAvailability({ metro: 'stopped' }, context)).toEqual(
			{
				allowed: false,
				check: 'state',
				reason: "Metro isn't running for this lane.",
			}
		);
	});

	it('confirms Stop inline while a live agent drives the lane', () => {
		const stop = laneStopBackend(stack(ids.featCheckout), demo, {
			bridgeAvailable: true,
		});
		expect(stop?.operation).toEqual({
			kind: 'stop',
			stackIds: [ids.featCheckout],
		});
		expect(stop?.availability).toEqual({ allowed: true });
		expect(stop?.confirmation).toEqual({
			kind: 'inline',
			agents: ['Claude 7f3a2c91'],
		});
		expect(stop?.label).toBe('Stop backend');
	});

	it('has no Stop for a stopped stack, and refuses while one is in flight', () => {
		expect(
			laneStopBackend(stack(ids.featSearch), demo, { bridgeAvailable: true })
		).toBeUndefined();
		expect(laneStopBackend(undefined, demo, { bridgeAvailable: true })).toBe(
			undefined
		);
		expect(
			laneStopBackend(stack(ids.featCheckout), demo, {
				bridgeAvailable: true,
				pending: true,
			})?.availability
		).toMatchObject({ allowed: false, check: 'in-flight' });
	});
});

describe('the start form', () => {
	const at = (path: string) => laneWorktreeBackend({ path }, demo);

	it('reads each worktree from main’s repository rows, by path', () => {
		expect(at('/Users/dev/code/example-app-wt/feat-checkout')).toEqual({
			supabase: { project: 'managed' },
		});
		expect(at('/Users/dev/code/example-app-wt/feat-legal-copy/')).toEqual({
			supabase: { project: 'observed', reasonText: 'stack flag missing' },
		});
		expect(at('/Users/dev/code/example-site')).toEqual({
			supabase: { project: 'none' },
		});
		expect(at('/Volumes/work/elsewhere')).toEqual({ unknown: true });
		const pinned = withStack(ids.featSearch, { flags: ['ports-pinned'] });
		expect(
			laneWorktreeBackend(
				{ path: '/Users/dev/code/example-app-wt/feat-search' },
				pinned
			)
		).toEqual({ supabase: { project: 'managed', portsPinned: true } });
		const repositoryOff: SupabaseState = {
			...demo,
			repositories: demo.repositories.map((repository) =>
				repository.id === ids.repositoryApp
					? {
							...repository,
							mode: 'off',
							worktrees: repository.worktrees.map((worktree) => ({
								...worktree,
								mode: 'off' as const,
								reasonText: 'turned off for this repository',
							})),
						}
					: repository
			),
		};
		expect(
			laneWorktreeBackend(
				{ path: '/Users/dev/code/example-app-wt/feat-checkout' },
				repositoryOff
			)
		).toEqual({ repositoryOff: true });
	});

	it('prefers the project main put on the lane worktree', () => {
		// Main read it from the path itself, so no label has to match.
		expect(
			laneWorktreeBackend(
				{
					path: '/Volumes/work/example-app',
					supabase: { project: 'managed', portsPinned: true },
				},
				demo
			)
		).toEqual({ supabase: { project: 'managed', portsPinned: true } });
		expect(
			laneWorktreeBackend(
				{
					path: '/Users/dev/code/example-app-wt/feat-checkout',
					supabase: { project: 'observed', reasonText: 'stack flag missing' },
				},
				demo
			)
		).toEqual({
			supabase: { project: 'observed', reasonText: 'stack flag missing' },
		});
	});

	it('suffixes the picker options only while on', () => {
		expect(
			laneWorktreeOptionSuffix({ supabase: { project: 'managed' } }, demo)
		).toBe(' · Supabase');
		expect(
			laneWorktreeOptionSuffix(
				{ supabase: { project: 'managed', portsPinned: true } },
				demo
			)
		).toBe(' · Supabase (ports pinned)');
		expect(
			laneWorktreeOptionSuffix({ supabase: { project: 'observed' } }, demo)
		).toBe(' · Supabase (needs opt-in)');
		expect(
			laneWorktreeOptionSuffix({ supabase: { project: 'none' } }, demo)
		).toBe('');
		expect(laneWorktreeOptionSuffix({ repositoryOff: true }, demo)).toBe('');
		expect(
			laneWorktreeOptionSuffix({ supabase: { project: 'managed' } }, off)
		).toBe('');
	});

	it('offers the environment default first and spreads backend only when set', () => {
		const select = laneBackendSelect({
			info: { supabase: { project: 'managed' } },
			environmentId: 'development',
			choice: 'default',
			state: demo,
		});
		expect(select.options).toEqual([
			{ value: 'default', label: 'Auto (development)' },
			{ value: 'off', label: 'Off' },
			{ value: 'required', label: 'Required' },
		]);
		expect(select.value).toBe('default');
		expect(select.backend).toBeUndefined();
		expect(select.starts).toBe(true);
		expect(select.hint).toBe(
			"Backend: starts or resumes this worktree's database (about 5 s); the app opens when it is ready."
		);
		const required = laneBackendSelect({
			info: { supabase: { project: 'managed' } },
			environmentId: 'development',
			choice: 'required',
			state: { ...demo, disk: { cacheState: 'cold' } },
		});
		expect(required.backend).toBe('required');
		expect(required.hint).toBe(
			"Backend: required. The lane starts only if this worktree's database does (about 5 s; first start about 45 s)."
		);
		const offChoice = laneBackendSelect({
			info: { supabase: { project: 'managed' } },
			environmentId: 'development',
			choice: 'off',
			state: demo,
		});
		expect(offChoice.backend).toBe('off');
		expect(offChoice.starts).toBe(false);
	});

	it('labels an environment that defaults to off', () => {
		const select = laneBackendSelect({
			info: { supabase: { project: 'managed' } },
			environmentId: 'production',
			choice: 'off',
			state: demo,
		});
		expect(select.options.map((option) => option.label)).toEqual([
			'Off (production)',
			'Auto',
			'Required',
		]);
		// `off` is the default here, so the stale choice falls back to it.
		expect(select.value).toBe('default');
		expect(select.backend).toBeUndefined();
		expect(select.starts).toBe(false);
	});

	it('disables the select with a visible reason, showing Off', () => {
		const observed = laneBackendSelect({
			info: {
				supabase: { project: 'observed', reasonText: 'stack flag missing' },
			},
			environmentId: 'development',
			choice: 'required',
			state: demo,
		});
		expect(observed).toMatchObject({
			options: [{ value: 'off', label: 'Off' }],
			value: 'off',
			hint: 'Observed only: stack flag missing.',
			starts: false,
		});
		expect(observed.backend).toBeUndefined();
		expect(
			laneBackendSelect({
				info: { supabase: { project: 'managed' } },
				environmentId: 'development',
				choice: 'default',
				state: off,
			}).hint
		).toBe('Turn on local Supabase in the Supabase tab first.');
		expect(laneBackendAvailability({ repositoryOff: true }, demo)).toEqual({
			allowed: false,
			check: 'mode',
			reason:
				'Local Supabase is off for this repository. Turn it back on in Supabase › Repositories.',
		});
		expect(laneBackendAvailability({ unknown: true }, demo)).toEqual({
			allowed: true,
		});
		expect(laneBackendAvailability({ unknown: true }, off)).toMatchObject({
			allowed: false,
			check: 'off',
		});
	});

	it('names the backend in the pending message when one comes up', () => {
		expect(laneStartPendingMessage({ slim: false, backend: true })).toBe(
			'Starting the backend, booting the Simulator, and starting Metro…'
		);
		expect(laneStartPendingMessage({ slim: true, backend: false })).toBe(
			'Booting, slimming, and starting Metro…'
		);
		expect(laneStartPendingMessage({ slim: false, backend: false })).toBe(
			'Booting the Simulator and starting Metro…'
		);
	});
});

describe('Fleet briefs', () => {
	it('carries the chip, the stack line and the ports', () => {
		expect(laneBackendBrief(lane(), demo)).toMatchObject({
			chip: { label: 'db :21734', tone: 'success' },
			stackId: ids.featCheckout,
			apiPort: 21_734,
			dbPort: 21_736,
		});
		expect(laneBackendBrief(lane(), off)).toBeUndefined();
		expect(
			laneBackendBrief(
				lane({
					id: 'lane-00000000-0000-4000-8000-000000000000',
					backend: bare({
						status: 'starting',
						apiUrl: 'http://127.0.0.1:23310',
					}),
				}),
				demo
			)
		).toEqual({
			chip: { label: 'db starting', tone: 'warning' },
			line: 'Starting…',
			apiPort: 23_310,
		});
	});
});

describe('Agents: the stacks a session holds', () => {
	it('lists a lane hold, an abandoned session hold and nothing while off', () => {
		const claude = sessionSupabaseBackends(
			{ kind: 'claude', sessionId: ids.claudeCheckout },
			demo
		);
		expect(claude).toHaveLength(1);
		expect(claude[0]).toMatchObject({
			via: 'lane',
			live: true,
			text: 'feat-checkout · via lane :8102',
			chip: { label: 'db :21734' },
		});
		expect(claude[0]?.release).toBeUndefined();
		const codex = sessionSupabaseBackends(
			{ kind: 'codex', sessionId: ids.codexAbandoned },
			demo
		);
		expect(codex[0]).toMatchObject({
			via: 'session',
			live: false,
			text: 'feat-checkout · supabase up',
			release: {
				holder: 'session',
				agentKind: 'codex',
				sessionId: ids.codexAbandoned,
			},
		});
		expect(codex[0]?.hold?.holder).toBe('session');
		expect(
			sessionSupabaseBackends(
				{ kind: 'claude', sessionId: ids.claudeCheckout },
				off
			)
		).toEqual([]);
	});

	it('ties a session working in a worktree to its kind’s shared MCP hold', () => {
		const backends = sessionSupabaseBackends(
			{
				kind: 'codex',
				sessionId: '0b7c1d2e-0000-4000-8000-000000000000',
				cwd: '/Users/dev/code/example-app-wt/feat-payments/apps/mobile',
			},
			demo
		);
		expect(backends).toHaveLength(1);
		expect(backends[0]).toMatchObject({
			via: 'worktree',
			live: true,
			text: 'feat-payments · held by worktree',
			release: {
				holder: 'worktree',
				agentKind: 'codex',
				sessionId: ids.codexSynthetic,
			},
		});
		expect(
			sessionSupabaseBackends(
				{
					kind: 'claude',
					sessionId: 'claude-elsewhere',
					cwd: '/Users/dev/code/example-app-wt/feat-payments',
				},
				demo
			)
		).toEqual([]);
	});

	it('keeps a cwd keeper without a hold as works in its worktree', () => {
		const kept = withStack(ids.featSearch, {
			cwdKeepers: [
				{
					agent: {
						kind: 'claude',
						sessionId: 'claude-keeper',
						synthetic: false,
					},
				},
			],
		});
		expect(
			sessionSupabaseBackends(
				{ kind: 'claude', sessionId: 'claude-keeper' },
				kept
			)
		).toMatchObject([
			{ via: 'cwd', text: 'feat-search · works in its worktree' },
		]);
	});

	it('counts devices and backends on the card', () => {
		expect(sessionAttachmentLabel(0, 0)).toBe('idle');
		expect(sessionAttachmentLabel(1, 1)).toBe('1 device · 1 backend');
		expect(sessionAttachmentLabel(2, 0)).toBe('2 devices');
		expect(sessionAttachmentLabel(0, 3)).toBe('3 backends');
	});
});

describe('Release from the Agents card', () => {
	it('confirms a live holder and says the database stops when nothing else holds it', () => {
		const [backend] = sessionSupabaseBackends(
			{ kind: 'codex', sessionId: ids.codexSynthetic },
			demo
		);
		if (!backend) throw new Error('expected a backend');
		const prompt = releaseBackendPrompt(backend, demo);
		expect(prompt?.operation).toEqual({
			kind: 'release',
			stackId: ids.featPayments,
			holder: {
				holder: 'worktree',
				agentKind: 'codex',
				sessionId: ids.codexSynthetic,
			},
		});
		expect(prompt?.confirm).toBe(true);
		expect(prompt?.title).toBe(
			"Release Codex · by worktree's hold on feat-payments?"
		);
		expect(prompt?.description).toBe(
			"Nothing else holds feat-payments, so its database stops in 60 s. Data is kept, and the agent's next supabase up starts it again."
		);
	});

	it('releases an abandoned hold without a prompt, and says what keeps it running', () => {
		const [backend] = sessionSupabaseBackends(
			{ kind: 'codex', sessionId: ids.codexAbandoned },
			demo
		);
		if (!backend) throw new Error('expected a backend');
		const prompt = releaseBackendPrompt(backend, demo);
		expect(prompt?.confirm).toBe(false);
		expect(prompt?.description).toBe(
			"feat-checkout keeps running while something else holds it. The agent's next supabase up holds it again."
		);
	});

	it('has no Release for a lane hold', () => {
		const [backend] = sessionSupabaseBackends(
			{ kind: 'claude', sessionId: ids.claudeCheckout },
			demo
		);
		if (!backend) throw new Error('expected a backend');
		expect(releaseBackendPrompt(backend, demo)).toBeUndefined();
	});
});

describe('requests on the Agents card', () => {
	it('lists the session’s pending requests', () => {
		expect(
			sessionRequestLines(
				{ kind: 'codex', sessionId: ids.codexRequester },
				demo,
				now
			)
		).toEqual([
			{
				id: ids.requestOldUi,
				text: 'Asked to destroy feat-old-ui (71 MB) · 4 min ago',
			},
		]);
		expect(
			sessionRequestLines(
				{ kind: 'codex', sessionId: ids.codexRequester },
				off,
				now
			)
		).toEqual([]);
		expect(
			sessionRequestLines(
				{ kind: 'claude', sessionId: ids.claudeCheckout },
				demo,
				now
			)
		).toEqual([]);
	});
});
