import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import {
	checkSupabaseOperation,
	isSupabaseStackRunning,
	SUPABASE_CLIPBOARD_CLEAR_MS,
	SUPABASE_PREPARABLE_CAPABILITIES,
	type SupabaseDatabasePayload,
	type SupabaseErrorView,
	type SupabaseLogRecord,
	type SupabaseMigrationsView,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	sanitizeSupabaseDisplayText,
	supabaseAgentLabel,
	supabaseBranchLabel,
	supabaseConfirmationRequired,
	supabaseDesktopError,
	supabaseStackTitle,
} from '../../shared/supabase-protocol';
import { trustedLoopbackHttpUrl } from '../security';
import {
	parseSupabaseDbReset,
	parseSupabaseInspectDbStats,
	parseSupabaseInspectTableStats,
	parseSupabaseMigrationList,
	parseSupabaseMigrationUp,
	parseSupabaseSeedBuckets,
	type SupabaseMigrationStatus,
} from './cli-contract';
import type { SupabasePreparableCapability } from './dialect';
import {
	hasSupabaseControlCharacters,
	shellQuote,
	supabaseRealpath,
	supabaseUploadsPath,
} from './engine-support';
import { initialSupabaseJobSteps } from './job-store';
import { supabaseLaneEnv } from './lane-backend';
import type {
	SupabaseEngine,
	SupabaseEngineJobOutcome,
	SupabaseStackView,
} from './service-engine';
import type { SupabaseOperationContext } from './service-ports';

/**
 * The operator's operations from the Supabase tab, after the IPC layer
 * checked the sender and consumed any one-time token. Each one is checked
 * again here against a fresh state with the same availability rules the
 * renderer uses, then runs: quick ones answer with their result, long ones
 * start a job and answer with its id while it keeps running (the job stays
 * listed until it ends). Messages are main's own copy.
 */

const DEFAULT_PREPARE: readonly SupabasePreparableCapability[] = [
	'database',
	'rest',
	'auth',
	'realtime',
	'storage',
	'functions',
	'mail',
];
const MAX_TOP_TABLES = 10;
const MAX_MIGRATION_ROWS = 500;

type Receipt = SupabaseOperationReceipt;
type Op<K extends SupabaseOperation['kind']> = Extract<
	SupabaseOperation,
	{ kind: K }
>;

function failed(
	operation: SupabaseOperation,
	error: SupabaseErrorView
): Receipt {
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: false,
		error,
	};
}

function message(text: string): string {
	return sanitizeSupabaseDisplayText(text, 1_024);
}

function title(view: SupabaseStackView): string {
	return view.summary
		? supabaseStackTitle(view.summary)
		: (supabaseBranchLabel(
				view.entry?.branchContext ?? view.record?.branchContext
			) ?? `${view.id.slice(0, 8)}…`);
}

function done(
	engine: SupabaseEngine,
	operation: SupabaseOperation,
	extra: Partial<Receipt> = {}
): Receipt {
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		state: engine.getState(),
		...extra,
	};
}

function refusedView(text: string): SupabaseErrorView {
	return supabaseDesktopError('refused', text);
}

function headMoved(view: SupabaseStackView): SupabaseErrorView {
	const current =
		view.facts?.head?.status === 'ok'
			? view.facts.head.branchContext
			: undefined;
	const branch = supabaseBranchLabel(
		view.entry?.branchContext ?? view.record?.branchContext
	);
	return refusedView(
		`The worktree is on ${supabaseBranchLabel(current) ?? 'another branch'}. Switch back to ${branch ?? 'its branch'} first.`
	);
}

/** Starts a job and answers with its id once it is listed. */
async function asJob(
	engine: SupabaseEngine,
	operation: SupabaseOperation,
	started: Promise<
		Readonly<{ jobId: string; done: Promise<SupabaseEngineJobOutcome> }>
	>,
	text?: string
): Promise<Receipt> {
	const { jobId } = await started;
	return done(engine, operation, {
		jobId,
		...(text ? { message: message(text) } : {}),
	});
}

/** Runs `task` for each id two at a time, each under its stack's lock and the lifecycle gate. */
async function forEachStack(
	engine: SupabaseEngine,
	stackIds: readonly string[],
	task: (stackId: string) => Promise<void>
): Promise<void> {
	await Promise.all(
		stackIds.map((stackId) =>
			engine
				.lifecycleGate()
				.run(() => engine.lockStack(stackId, () => task(stackId)))
		)
	);
}

async function stop(
	engine: SupabaseEngine,
	operation: Op<'stop'>
): Promise<Receipt> {
	const ids = operation.stackIds;
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'stop',
				stackIds: ids,
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('stop'),
			},
			async (job) => {
				job.begin();
				const errors: SupabaseErrorView[] = [];
				const calledOff: SupabaseEngineJobOutcome[] = [];
				let finished = 0;
				await forEachStack(engine, ids, async (stackId) => {
					// A stack whose turn comes once the feature is off keeps running.
					const off = engine.calledOff();
					if (off) {
						calledOff.push(off);
						return;
					}
					const result = await engine.stopStep(stackId, job, {
						clearPin: true,
					});
					finished += 1;
					if (!result.ok) errors.push(result.error);
					if (ids.length > 1)
						job.progress(`Stopped ${finished} of ${ids.length}.`);
				});
				const [first] = errors;
				const [off] = calledOff;
				if (!first && off) return off;
				return first
					? {
							status: 'failed',
							error:
								ids.length > 1
									? {
											...first,
											message: message(
												`Stopped ${finished - errors.length} of ${ids.length}. ${first.message}`
											),
										}
									: first,
						}
					: { status: 'complete' };
			}
		)
	);
}

async function start(
	engine: SupabaseEngine,
	operation: Op<'start'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const facts = view.facts
		? await engine.worktreeFacts(view.facts.worktreePath, view.facts.appPath)
		: undefined;
	if (!facts) {
		return failed(
			operation,
			refusedView(
				"RN Devtools can't find this stack's worktree. Refresh, then try again."
			)
		);
	}
	if (facts.expectedStackId !== operation.stackId) {
		// The worktree moved since the row was listed: starting would load
		// another branch's settings, or create another branch's stack.
		return failed(operation, headMoved({ ...view, facts }));
	}
	const creating =
		view.summary === undefined ||
		view.summary.state === 'not-created' ||
		view.summary.state === 'never-started' ||
		view.summary.state === 'failed';
	// New stacks start one at a time: say so when another one is starting.
	const queued = creating && engine.creationGate().active > 0;
	return new Promise<Receipt>((resolve) => {
		let answered = false;
		const answer = (receipt: Receipt) => {
			if (answered) return;
			answered = true;
			resolve(receipt);
		};
		const settled = engine.track(
			engine.ensureStack(facts, {
				requestedBy: { kind: 'operator' },
				createdBy: { via: 'desktop' },
				pin: creating ? 'always' : 'if-unheld',
				onJob: (jobId) => {
					answer(
						done(engine, operation, {
							jobId,
							...(queued
								? { message: 'Queued · new stacks start one at a time.' }
								: {}),
						})
					);
				},
			})
		);
		void settled.then((result) => {
			if (result.kind === 'ready') {
				const port = engine
					.getState()
					.stacks.find((stack) => stack.id === result.stackId)?.ports.api;
				answer(
					done(engine, operation, {
						message: message(
							`${title(view)} is running${port === undefined ? '' : ` on :${port}`}.`
						),
					})
				);
				return;
			}
			answer(failed(operation, result.error ?? refusedView(result.message)));
		});
	});
}

async function stopAndStart(
	engine: SupabaseEngine,
	operation: Op<'stop-and-start'> | Op<'reapply-exclusions'>,
	successText: string
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	if (!(await engine.headMatches(view)))
		return failed(operation, headMoved(view));
	const facts = view.facts;
	if (!facts)
		return failed(
			operation,
			refusedView("This stack's worktree isn't tracked.")
		);
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'stop-and-start',
				stackIds: [view.id],
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('stop-and-start'),
			},
			(job) =>
				engine.lifecycleGate().run(() =>
					engine.lockStack(view.id, async () => {
						const off = engine.calledOff();
						if (off) return off;
						job.begin();
						const stopped = await engine.stopStep(view.id, job, {
							clearPin: false,
						});
						if (!stopped.ok) return { status: 'failed', error: stopped.error };
						const started = await engine.startStep(
							{
								facts,
								stackId: view.id,
								mode: 'resume',
								exclusions: engine.exclusionsFor(view.id),
							},
							job
						);
						if (!started.ok) return { status: 'failed', error: started.error };
						return engine.verifyAfterStart(started.stackId, job);
					})
				)
		),
		successText
	);
}

async function restart(
	engine: SupabaseEngine,
	operation: Op<'restart'> | Op<'resume-saved'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const cli = engine.manageCli(view.facts);
	if (!cli) {
		return failed(
			operation,
			refusedView("This worktree's Supabase CLI can't restart this stack.")
		);
	}
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'restart',
				stackIds: [view.id],
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: [
					...initialSupabaseJobSteps('restart'),
					...initialSupabaseJobSteps('resume').filter(
						(step) => step.id === 'verify'
					),
				],
			},
			(job) =>
				engine.lifecycleGate().run(() =>
					engine.lockStack(view.id, async () => {
						const off = engine.calledOff();
						if (off) return off;
						job.begin();
						const restarted = await engine.restartStep(view, job, cli);
						if (!restarted.ok)
							return { status: 'failed', error: restarted.error };
						if (
							operation.kind === 'resume-saved' &&
							view.record &&
							!engine.holdsOf(view.id)?.held
						) {
							await engine.stackStore.setPinned(view.id, true);
						}
						return engine.verifyAfterStart(view.id, job);
					})
				)
		)
	);
}

async function readLogs(
	engine: SupabaseEngine,
	operation: Op<'read-logs'>
): Promise<Receipt> {
	const cli = await engine.ownerCli(operation.stackId);
	if (!cli) {
		return failed(
			operation,
			refusedView(
				'No Supabase CLI RN Devtools can run is available to read these logs.'
			)
		);
	}
	const outcome = await engine.readLogs(cli, {
		kind: 'stack.logs',
		stackId: operation.stackId,
		tail: operation.tail,
		...(operation.services ? { services: operation.services } : {}),
		...(operation.since ? { since: operation.since } : {}),
	});
	if (!outcome.ok) return failed(operation, engine.errorView(outcome.error));
	const records: SupabaseLogRecord[] = outcome.value.records
		.slice(-5_000)
		.map((record) =>
			record.type === 'entry'
				? record
				: {
						type: 'marker',
						timestamp: record.timestamp,
						source: record.source,
						service: record.service,
						instanceId: record.instanceId,
						kind: record.kind,
						...(record.stream ? { stream: record.stream } : {}),
						...(record.count === undefined ? {} : { count: record.count }),
					}
		);
	const bytes = records.reduce(
		(total, record) =>
			total +
			(record.type === 'entry' ? Buffer.byteLength(record.line, 'utf8') : 0),
		0
	);
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		logs: {
			records,
			truncated: outcome.value.truncated,
			bytes,
			readAt: engine.now(),
		},
	};
}

function migrationsView(
	status: SupabaseMigrationStatus
): SupabaseMigrationsView {
	const rows = status.rows.slice(-MAX_MIGRATION_ROWS).map((row) => ({
		version: row.version,
		time: sanitizeSupabaseDisplayText(row.time, 64),
		status: row.status,
	}));
	return {
		comparable: true,
		state: status.state,
		rows,
		total: status.rows.length,
		applied: status.applied,
		pending: status.pending.slice(0, MAX_MIGRATION_ROWS),
		outOfOrder: status.outOfOrder.slice(0, MAX_MIGRATION_ROWS),
		missingLocal: status.missingLocal.slice(0, MAX_MIGRATION_ROWS),
	};
}

/**
 * Database reads: `--local` when the worktree is on the stack's branch and
 * the owner runs its release, else through the DB_URL main holds in memory
 * (reads only; migration status is then not comparable).
 */
async function readDatabase(
	engine: SupabaseEngine,
	operation: Op<'read-database'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const cli = engine.readCli(view.facts) ?? engine.newestCli();
	const projectRoot =
		view.facts?.detection?.status === 'found'
			? view.facts.detection.projectRoot
			: (view.entry?.projectRoot ?? view.record?.projectRoot);
	if (!cli || projectRoot === undefined) {
		return failed(
			operation,
			refusedView('No Supabase CLI RN Devtools can run reads this database.')
		);
	}
	const local = (await engine.headMatches(view)) && !view.summary?.cli.mismatch;
	let target: 'local' | Readonly<{ dbUrl: string }> = 'local';
	if (!local) {
		let dbUrl = engine.credentialsOf(view.id)?.dbUrl;
		if (dbUrl === undefined) {
			await engine.readStatus(view.id);
			dbUrl = engine.credentialsOf(view.id)?.dbUrl;
		}
		if (dbUrl === undefined) {
			return failed(
				operation,
				refusedView('Start the stack first. Database reads need it running.')
			);
		}
		target = { dbUrl };
	}
	const [stats, tables, migrations] = await Promise.all([
		engine.runRead(
			cli,
			{ kind: 'inspect', name: 'db-stats', workdir: projectRoot, target },
			parseSupabaseInspectDbStats
		),
		engine.runRead(
			cli,
			{ kind: 'inspect', name: 'table-stats', workdir: projectRoot, target },
			parseSupabaseInspectTableStats
		),
		local
			? engine.runRead(
					cli,
					{ kind: 'migration.list', workdir: projectRoot, target: 'local' },
					parseSupabaseMigrationList
				)
			: Promise.resolve(undefined),
	]);
	if (!stats.ok && !tables.ok)
		return failed(operation, engine.errorView(stats.error));
	const current =
		view.facts?.head?.status === 'ok'
			? view.facts.head.branchContext
			: undefined;
	const database: SupabaseDatabasePayload = {
		target: local ? 'local' : 'db-url',
		...(stats.ok && stats.value
			? {
					stats: Object.fromEntries(
						Object.entries(stats.value).filter(
							([, value]) => value !== undefined
						)
					),
				}
			: {}),
		topTables: tables.ok
			? tables.value.slice(0, MAX_TOP_TABLES).map((table) => ({
					name: table.name,
					...(table.tableSize ? { tableSize: table.tableSize } : {}),
					...(table.indexSize ? { indexSize: table.indexSize } : {}),
					...(table.totalSize ? { totalSize: table.totalSize } : {}),
					...(table.estimatedRowCount
						? { estimatedRowCount: table.estimatedRowCount }
						: {}),
					...(table.seqScans ? { seqScans: table.seqScans } : {}),
				}))
			: [],
		...(local
			? migrations?.ok
				? { migrations: migrationsView(migrations.value.status) }
				: {}
			: {
					migrations: {
						comparable: false,
						reasonText: message(
							`Migration status can't be worked out while the worktree is on ${supabaseBranchLabel(current) ?? 'another branch'}; its migration files belong to that branch.`
						).slice(0, 512),
					},
				}),
		readAt: engine.now(),
	};
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		database,
	};
}

async function databaseJob(
	engine: SupabaseEngine,
	operation: Op<'apply-migrations'> | Op<'reset'> | Op<'seed-buckets'>,
	view: SupabaseStackView,
	extra: Readonly<{ requestId?: string; seed?: boolean }> = {}
): Promise<
	| Readonly<{ jobId: string; done: Promise<SupabaseEngineJobOutcome> }>
	| SupabaseErrorView
> {
	if (!(await engine.headMatches(view))) return headMoved(view);
	const projectRoot =
		view.facts?.detection?.status === 'found'
			? view.facts.detection.projectRoot
			: undefined;
	if (projectRoot === undefined)
		return refusedView("This stack's project isn't tracked.");
	const migrationTotal = view.facts?.migrationCount ?? 0;
	const kind =
		operation.kind === 'apply-migrations'
			? 'migrate'
			: operation.kind === 'reset'
				? 'reset'
				: 'seed-buckets';
	const seed =
		operation.kind === 'reset' ? operation.seed : (extra.seed ?? true);
	return engine.startJob(
		{
			kind,
			stackIds: [view.id],
			requestedBy: { kind: 'operator' },
			cancellable: false,
			steps: initialSupabaseJobSteps(kind, { migrationTotal, seed }),
		},
		(job) =>
			engine.lockStack(view.id, async () => {
				const off = engine.calledOff();
				if (off) return off;
				job.begin();
				let result:
					| Readonly<{ ok: true; value: unknown }>
					| Readonly<{ ok: false; error: SupabaseErrorView }>;
				if (operation.kind === 'apply-migrations') {
					result = await engine.databaseStep(
						view,
						job,
						{ kind: 'migration.up', workdir: projectRoot },
						parseSupabaseMigrationUp,
						'migrations'
					);
				} else if (operation.kind === 'reset') {
					result = await engine.databaseStep(
						view,
						job,
						{
							kind: 'db.reset',
							workdir: projectRoot,
							...(operation.seed ? {} : { noSeed: true }),
						},
						(json) => {
							const reset = parseSupabaseDbReset(json);
							if (reset.target !== 'local') {
								throw new Error('The reset reported a non-local target.');
							}
							return reset;
						},
						'reset'
					);
				} else {
					result = await engine.databaseStep(
						view,
						job,
						{ kind: 'seed.buckets', workdir: projectRoot },
						parseSupabaseSeedBuckets,
						'buckets'
					);
				}
				await engine.readStatus(view.id);
				return result.ok
					? { status: 'complete' }
					: { status: 'failed', error: result.error };
			})
	);
}

async function exportDatabase(
	engine: SupabaseEngine,
	operation: Op<'export'>,
	context: SupabaseOperationContext
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const cli = engine.readCli(view.facts);
	const projectRoot =
		view.facts?.detection?.status === 'found'
			? view.facts.detection.projectRoot
			: undefined;
	if (!cli || projectRoot === undefined) {
		return failed(
			operation,
			refusedView("This worktree's Supabase CLI can't export this database.")
		);
	}
	const branch = (
		supabaseBranchLabel(view.summary?.branchContext) ?? view.id.slice(0, 8)
	)
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.slice(0, 64);
	const owner =
		context.actor.kind === 'operator'
			? { senderId: context.actor.senderId }
			: undefined;
	const choice = await engine.deps.dialog.showSaveDialog(
		{
			title: `Export ${operation.content === 'schema' ? 'the schema' : 'the data'} of ${title(view)}`,
			buttonLabel: 'Export',
			defaultPath: `${branch}-${operation.content}.sql`,
			filters: [{ name: 'SQL', extensions: ['sql'] }],
		},
		owner
	);
	if (choice.canceled || !choice.filePath) {
		return {
			actionId: operation.actionId,
			kind: operation.kind,
			completed: false,
			cancelled: true,
		};
	}
	const file = path.normalize(choice.filePath);
	if (!path.isAbsolute(file) || hasSupabaseControlCharacters(file)) {
		return failed(operation, refusedView('That file name cannot be used.'));
	}
	const local = (await engine.headMatches(view)) && !view.summary?.cli.mismatch;
	let target: 'local' | Readonly<{ dbUrl: string }> = 'local';
	if (!local) {
		const dbUrl = engine.credentialsOf(view.id)?.dbUrl;
		if (!dbUrl)
			return failed(
				operation,
				refusedView(
					'Start the stack first. An export reads the running database.'
				)
			);
		target = { dbUrl };
	}
	const { done: finished } = await engine.startJob(
		{
			kind: 'export',
			stackIds: [view.id],
			requestedBy: { kind: 'operator' },
			cancellable: false,
			steps: initialSupabaseJobSteps('export'),
		},
		async (job) => {
			// Turned off while the save dialog was open: nothing is dumped.
			const off = engine.calledOff();
			if (off) return off;
			job.begin();
			job.step('export', 'current');
			const outcome = await engine.runRead(
				cli,
				{
					kind: 'db.dump',
					workdir: projectRoot,
					file,
					target,
					...(operation.content === 'data' ? { dataOnly: true } : {}),
				},
				() => undefined,
				{
					expectOutput: 'none',
					...(target === 'local'
						? { precondition: () => engine.stillOnBranch(view) }
						: {}),
				}
			);
			if (!outcome.ok) {
				const error = engine.errorView(outcome.error);
				job.step('export', 'failed', error.title);
				return { status: 'failed', error };
			}
			job.step('export', 'done');
			return { status: 'complete' };
		}
	);
	const outcome = await finished;
	if (outcome.status !== 'complete') {
		return failed(
			operation,
			outcome.error ?? refusedView('The export failed.')
		);
	}
	engine.exportPaths.set(view.id, file);
	let bytes: number | undefined;
	try {
		bytes = (await stat(file)).size;
	} catch {
		bytes = undefined;
	}
	return done(engine, operation, {
		export: {
			content: operation.content,
			...(bytes === undefined ? {} : { bytes }),
			revealable: true,
		},
		message: message(
			`Exported ${title(view)}'s ${operation.content === 'schema' ? 'schema' : 'data'}. Storage files aren't included.`
		),
	});
}

async function destroy(
	engine: SupabaseEngine,
	operation: Op<'destroy'>
): Promise<Receipt> {
	// Destroy only what a fresh list still shows, as the state now says.
	await engine.refreshList();
	const fresh = checkSupabaseOperation(operation, engine.getState(), {
		bridgeAvailable: true,
		now: engine.now(),
	});
	if (!fresh.allowed) return failed(operation, fresh.error);
	const ids = [...operation.stackIds].sort();
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'destroy',
				stackIds: ids,
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('destroy'),
			},
			async (job) => {
				job.begin();
				const locked = ids.reduceRight<() => Promise<SupabaseEngineJobOutcome>>(
					(inner, stackId) => () => engine.lockStack(stackId, inner),
					async () => {
						const off = engine.calledOff();
						if (off) return off;
						const result = await engine.destroyStep(ids, job, {
							removeUploads: operation.removeUploads,
						});
						if (operation.pruneRevision !== undefined) {
							engine.notePruneResult({
								destroyed: result.destroyed.length,
								failed: result.failed.length,
								freedBytes: result.freedBytes,
							});
						}
						const [first] = result.failed;
						if (!first) return { status: 'complete' };
						return {
							status: 'failed',
							error: {
								...first.error,
								message: message(
									ids.length > 1
										? `Destroyed ${result.destroyed.length} of ${ids.length}. ${first.error.message}`
										: first.error.message
								),
							},
						};
					}
				);
				return locked();
			}
		)
	);
}

async function recreate(
	engine: SupabaseEngine,
	operation: Op<'recreate'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const facts = view.facts
		? await engine.worktreeFacts(view.facts.worktreePath, view.facts.appPath)
		: undefined;
	if (!facts || facts.expectedStackId !== view.id) {
		return failed(
			operation,
			headMoved({ ...view, ...(facts ? { facts } : {}) })
		);
	}
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'recreate',
				stackIds: [view.id],
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('recreate', {
					migrationTotal: facts.migrationCount,
				}),
				...(facts.migrationCount > 0
					? { migrationTotal: facts.migrationCount }
					: {}),
			},
			(job) =>
				engine.creationGate().run(() =>
					engine.lockStack(view.id, async () => {
						const off = engine.calledOff();
						if (off) return off;
						job.begin();
						if (engine.isLive(view.id)) {
							const stopped = await engine.stopStep(view.id, job, {
								clearPin: true,
							});
							if (!stopped.ok)
								return { status: 'failed', error: stopped.error };
						}
						const result = await engine.destroyStep([view.id], job, {
							removeUploads: false,
						});
						const [failure] = result.failed;
						if (failure) return { status: 'failed', error: failure.error };
						const room = await engine.admit(view.id, job);
						if (!room.ok) return { status: 'failed', error: room.error };
						const started = await engine.startStep(
							{
								facts,
								mode: 'create',
								exclusions: engine.exclusionsFor(undefined),
								createdBy: { via: 'desktop' },
							},
							job
						);
						if (!started.ok) return { status: 'failed', error: started.error };
						const verified = await engine.verifyAfterStart(
							started.stackId,
							job
						);
						if (verified.status === 'complete') {
							await engine.stackStore.setPinned(started.stackId, true);
						}
						return verified;
					})
				)
		)
	);
}

async function setStudio(
	engine: SupabaseEngine,
	operation: Op<'set-studio'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	if (!view.record)
		return failed(
			operation,
			refusedView("RN Devtools didn't start this stack. Adopt it first.")
		);
	if (!(await engine.headMatches(view)))
		return failed(operation, headMoved(view));
	await engine.stackStore.updateRecord(view.id, (draft) => ({
		...draft,
		studioEnabled: operation.enabled,
	}));
	const running = view.summary ? isSupabaseStackRunning(view.summary) : false;
	if (!running || !view.facts) {
		return done(engine, operation, {
			message: message(
				operation.enabled
					? `Studio will be on when ${title(view)} next starts.`
					: `Studio stays off when ${title(view)} next starts.`
			),
		});
	}
	const facts = view.facts;
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'studio',
				stackIds: [view.id],
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('studio'),
			},
			(job) =>
				engine.lifecycleGate().run(() =>
					engine.lockStack(view.id, async () => {
						const off = engine.calledOff();
						if (off) return off;
						job.begin();
						const stopped = await engine.stopStep(view.id, job, {
							clearPin: false,
						});
						if (!stopped.ok) return { status: 'failed', error: stopped.error };
						const started = await engine.startStep(
							{
								facts,
								stackId: view.id,
								mode: 'resume',
								exclusions: engine.exclusionsFor(view.id),
							},
							job
						);
						if (!started.ok) return { status: 'failed', error: started.error };
						return engine.verifyAfterStart(started.stackId, job);
					})
				)
		),
		operation.enabled
			? `Turning Studio on for ${title(view)}. It sleeps after 5 min idle.`
			: `Turning Studio off for ${title(view)}.`
	);
}

async function copy(
	engine: SupabaseEngine,
	operation: Op<'copy'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const summary = view.summary;
	let endpoints = engine.endpointsOf(view.id);
	let credentials = engine.credentialsOf(view.id);
	const needsRead =
		(operation.what === 'publishable-key' && !credentials?.publishableKey) ||
		(operation.what === 'psql-command' && !credentials?.dbUrl) ||
		(operation.what === 'app-env' &&
			(!endpoints || !credentials?.publishableKey)) ||
		(operation.what === 'api-url' && !endpoints);
	if (needsRead && engine.entry(view.id)) {
		await engine.readStatus(view.id);
		endpoints = engine.endpointsOf(view.id);
		credentials = engine.credentialsOf(view.id);
	}
	let text: string | undefined;
	let secret = false;
	let note: string | undefined;
	switch (operation.what) {
		case 'api-url':
			text = endpoints?.apiUrl;
			break;
		case 'publishable-key':
			text = credentials?.publishableKey;
			secret = true;
			note = engine.policySnapshot().policy.perStackKeys
				? "Copied the publishable key. It is this stack's own key; don't commit it."
				: "Copied the publishable key. It's the local default every local stack shares; don't commit it.";
			break;
		case 'psql-command':
			text = credentials?.dbUrl
				? `psql ${shellQuote(credentials.dbUrl)}`
				: undefined;
			secret = true;
			note = `Copied a psql command for ${title(view)}. It contains the local database password; paste it only into a terminal on this Mac.`;
			break;
		case 'app-env': {
			const lane = supabaseLaneEnv(
				engine.policySnapshot().policy.appEnv,
				endpoints,
				credentials
			);
			text =
				lane.names.length > 0
					? `${lane.names.map((name) => `${name}=${lane.env[name]}`).join('\n')}\n`
					: undefined;
			secret = true;
			note = `Copied ${lane.names.length} app ${lane.names.length === 1 ? 'variable' : 'variables'} · local only, do not commit.`;
			break;
		}
		case 'status-command':
			text = summary?.cli.statusCommand;
			break;
		case 'inspect-command':
			text = summary?.cli.inspectCommand;
			break;
	}
	if (text === undefined || text.length === 0) {
		return failed(
			operation,
			refusedView(
				operation.what === 'psql-command'
					? 'Start the stack first. The database address is only known while it runs.'
					: operation.what === 'api-url'
						? "The API URL is known after the stack's first start."
						: operation.what === 'publishable-key' ||
								operation.what === 'app-env'
							? 'The key is read when the stack starts. Start it once.'
							: "The command is known once this worktree's Supabase CLI is found."
			)
		);
	}
	const clearsAt = await engine.copyToClipboard(
		text,
		secret ? SUPABASE_CLIPBOARD_CLEAR_MS : undefined
	);
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		copy: {
			copied: true,
			what: operation.what,
			...(clearsAt === undefined ? {} : { clearsAt }),
		},
		...(note ? { message: message(note) } : {}),
	};
}

async function open(
	engine: SupabaseEngine,
	operation: Op<'open'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const url =
		operation.surface === 'mailpit'
			? view.summary?.mailpitUrl
			: view.summary?.studioUrl;
	const trusted = url === undefined ? undefined : trustedLoopbackHttpUrl(url);
	if (!trusted) {
		return failed(
			operation,
			refusedView(
				operation.surface === 'mailpit'
					? 'Mailpit is not running for this stack.'
					: 'Studio is not running for this stack.'
			)
		);
	}
	await engine.deps.shell.openExternal(trusted);
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		open: { opened: true, surface: operation.surface },
	};
}

async function isRealDirectory(target: string): Promise<boolean> {
	try {
		const info = await lstat(target);
		return info.isDirectory() && !info.isSymbolicLink();
	} catch {
		return false;
	}
}

async function reveal(
	engine: SupabaseEngine,
	operation: Op<'reveal'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const projectRoot = view.entry?.projectRoot ?? view.record?.projectRoot;
	let target: string | undefined;
	switch (operation.what) {
		case 'uploads': {
			const uploads =
				projectRoot === undefined
					? undefined
					: supabaseUploadsPath(projectRoot, view.id);
			target =
				uploads && (await isRealDirectory(uploads)) ? uploads : undefined;
			break;
		}
		case 'stack-folder': {
			const home = await supabaseRealpath(engine.supabaseHome());
			const folder =
				home === undefined ? undefined : path.join(home, 'stacks', view.id);
			const real =
				folder === undefined ? undefined : await supabaseRealpath(folder);
			target =
				folder !== undefined &&
				real === folder &&
				home !== undefined &&
				real.startsWith(`${home}/`) &&
				(await isRealDirectory(folder))
					? folder
					: undefined;
			break;
		}
		case 'config': {
			const config =
				projectRoot === undefined
					? undefined
					: path.join(projectRoot, 'supabase', 'config.toml');
			try {
				target = config && (await lstat(config)).isFile() ? config : undefined;
			} catch {
				target = undefined;
			}
			break;
		}
		case 'export': {
			const file = engine.exportPaths.get(view.id);
			try {
				target = file && (await lstat(file)).isFile() ? file : undefined;
			} catch {
				target = undefined;
			}
			break;
		}
	}
	if (!target) return failed(operation, refusedView('The folder is gone.'));
	engine.deps.shell.showItemInFolder(target);
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		reveal: { revealed: true, what: operation.what },
	};
}

async function approve(
	engine: SupabaseEngine,
	operation: Op<'request.approve'>
): Promise<Receipt> {
	const request = engine.stackStore.request(operation.requestId);
	if (!request) {
		return failed(
			operation,
			supabaseDesktopError('unknown_target', 'That request has expired.')
		);
	}
	const settle = async (
		status: 'approved' | 'failed',
		error?: SupabaseErrorView
	) => {
		const now = engine.now();
		await engine.stackStore.updateRequest(request.id, (draft) => {
			draft.status = status;
			draft.settledAt = now;
			if (error) draft.error = error;
		});
	};
	await engine.stackStore.updateRequest(request.id, (draft) => {
		draft.status = 'settling';
	});
	const requester = supabaseAgentLabel({
		kind: request.requester.kind,
		sessionId: request.requester.sessionId,
		synthetic: request.requester.synthetic,
	});
	if (request.kind === 'start-capacity') {
		const worktree = request.worktreePath;
		const stopId = operation.stopStackId;
		if (!worktree || !stopId) {
			await settle('failed', refusedView('Choose a stack to stop.'));
			return failed(operation, refusedView('Choose a stack to stop.'));
		}
		const facts = await engine.worktreeFacts(worktree);
		if (!facts) {
			await settle('failed', refusedView("The requester's worktree is gone."));
			return failed(
				operation,
				refusedView("The requester's worktree is gone.")
			);
		}
		const stopJob = await engine.stopJob(
			stopId,
			{ kind: 'operator' },
			{ clearPin: true }
		);
		engine.track(
			stopJob.done.then(async (stopped) => {
				if (stopped.status !== 'complete') {
					await settle('failed', stopped.error);
					return;
				}
				const result = await engine.ensureStack(facts, {
					requestedBy: {
						kind: 'agent',
						agent: {
							kind: request.requester.kind,
							sessionId: request.requester.sessionId,
						},
					},
					createdBy: {
						via: 'agent',
						agent: {
							kind: request.requester.kind,
							sessionId: request.requester.sessionId,
						},
					},
					hold: {
						holder: request.requester.synthetic ? 'worktree' : 'session',
						agent: {
							kind: request.requester.kind,
							sessionId: request.requester.sessionId,
							synthetic: request.requester.synthetic,
						},
						since: engine.now(),
					},
				});
				await settle(
					result.kind === 'ready' ? 'approved' : 'failed',
					result.kind === 'ready'
						? undefined
						: (result.error ?? refusedView(result.message))
				);
			})
		);
		return done(engine, operation, {
			jobId: stopJob.jobId,
			message: message(
				`Making room for ${request.branch}, as ${requester} asked.`
			),
		});
	}
	const stackId = request.stackId;
	if (!stackId) {
		await settle('failed', refusedView('The request names no stack.'));
		return failed(operation, refusedView('The request names no stack.'));
	}
	const view = engine.view(stackId);
	if (request.kind === 'reset') {
		const started = await databaseJob(
			engine,
			{
				actionId: operation.actionId,
				kind: 'reset',
				stackId,
				seed: request.seed ?? true,
			},
			view,
			{ requestId: request.id }
		);
		if (!('jobId' in started)) {
			await settle('failed', started);
			return failed(operation, started);
		}
		engine.track(
			started.done.then((outcome) =>
				settle(
					outcome.status === 'complete' ? 'approved' : 'failed',
					outcome.error
				)
			)
		);
		return done(engine, operation, {
			jobId: started.jobId,
			message: message(`Resetting ${request.branch} as ${requester} asked.`),
		});
	}
	const job = await engine.startJob(
		{
			kind: 'destroy',
			stackIds: [stackId],
			requestedBy: { kind: 'operator' },
			cancellable: false,
			steps: [
				...initialSupabaseJobSteps('stop'),
				...initialSupabaseJobSteps('destroy'),
			],
		},
		(work) =>
			engine.lifecycleGate().run(() =>
				engine.lockStack(stackId, async () => {
					const off = engine.calledOff();
					if (off) return off;
					work.begin();
					if (engine.isLive(stackId)) {
						const stopped = await engine.stopStep(stackId, work, {
							clearPin: true,
						});
						if (!stopped.ok) return { status: 'failed', error: stopped.error };
					} else {
						work.step('stop', 'skipped');
					}
					const result = await engine.destroyStep([stackId], work, {
						removeUploads: operation.removeUploads === true,
					});
					const [failure] = result.failed;
					return failure
						? { status: 'failed', error: failure.error }
						: { status: 'complete' };
				})
			)
	);
	engine.track(
		job.done.then((outcome) =>
			settle(
				outcome.status === 'complete' ? 'approved' : 'failed',
				outcome.error
			)
		)
	);
	return done(engine, operation, {
		jobId: job.jobId,
		message: message(`Destroying ${request.branch} as ${requester} asked.`),
	});
}

async function setEnabled(
	engine: SupabaseEngine,
	operation: Op<'set-enabled'>
): Promise<Receipt> {
	if (operation.enabled) {
		await engine.policyStore.setEnabled(true, engine.now());
		engine.syncActivation();
		return done(engine, operation, {
			message:
				'Local Supabase is on. Development lanes on opted-in worktrees now get their own database.',
		});
	}
	const running = engine
		.getState()
		.stacks.filter(
			(stack) =>
				(stack.origin === 'managed' || stack.origin === 'adopted') &&
				(isSupabaseStackRunning(stack) || stack.state === 'starting')
		)
		.map((stack) => stack.id);
	await engine.policyStore.setEnabled(false);
	engine.syncActivation();
	// Off now, nothing new begins: every ensure asks again first, and a job
	// still waiting its turn is called off when it comes. One that can bring
	// a stack up and already runs finishes first, and its stack counts too:
	// the state shows it starting only once its CLI says so.
	const stackIds = [
		...new Set([
			...running,
			...engine
				.activeStarts()
				.filter((job) => job.status === 'running')
				.flatMap((job) => job.stackIds),
		]),
	];
	if (operation.disposition !== 'stop-managed' || stackIds.length === 0) {
		engine.clearLiveCaches();
		return done(engine, operation, {
			message:
				running.length > 0
					? `Local Supabase is off. ${running.length} ${running.length === 1 ? 'stack keeps' : 'stacks keep'} running.`
					: 'Local Supabase is off.',
		});
	}
	engine.setDisabling({
		remaining: stackIds.length,
		total: stackIds.length,
		waitingForStarts: true,
	});
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'disable',
				stackIds: stackIds.slice(0, 32),
				requestedBy: { kind: 'operator' },
				cancellable: false,
				steps: initialSupabaseJobSteps('disable'),
			},
			async (job) => {
				job.begin();
				try {
					await engine.whenStartsSettled();
					const failures: SupabaseErrorView[] = [];
					let remaining = stackIds.length;
					engine.setDisabling({
						remaining,
						total: stackIds.length,
						waitingForStarts: false,
					});
					// One at a time, so the progress reads 1 of 3, 2 of 3.
					for (const stackId of stackIds) {
						job.progress(
							`Stopping ${stackIds.length - remaining + 1} of ${stackIds.length} managed stacks.`
						);
						const result = await engine.lockStack(stackId, () =>
							engine.stopStep(stackId, job, { clearPin: false })
						);
						if (!result.ok) failures.push(result.error);
						remaining -= 1;
						engine.setDisabling({
							remaining,
							total: stackIds.length,
							waitingForStarts: false,
						});
					}
					const [first] = failures;
					return first
						? { status: 'failed', error: first }
						: { status: 'complete' };
				} finally {
					engine.setDisabling(undefined);
					engine.clearLiveCaches();
				}
			}
		),
		`Turning off… stopping ${stackIds.length} managed ${stackIds.length === 1 ? 'stack' : 'stacks'}.`
	);
}

async function updatePolicy(
	engine: SupabaseEngine,
	operation: Op<'update-policy'>
): Promise<Receipt> {
	const before = engine.policySnapshot().policy;
	const result = await engine.policyStore.updatePolicy(operation.patch);
	if (!result.ok) {
		return failed(
			operation,
			refusedView(
				Object.values(result.errors).join(' ') || 'That setting is not valid.'
			)
		);
	}
	const patch = operation.patch;
	if (patch.allowUnverifiedPatch !== undefined || patch.appEnv !== undefined) {
		engine.track(engine.refreshRepositories());
	}
	if (
		patch.perStackKeys !== undefined &&
		patch.perStackKeys !== before.perStackKeys
	) {
		engine.track(engine.applyPerStackKeys());
	}
	engine.track(engine.reconcileHolds());
	return done(engine, operation, {
		message:
			patch.perStackKeys === true
				? 'Supabase settings saved. Per-stack keys apply the next time each stack starts.'
				: 'Supabase settings saved. They apply to the next start; running stacks keep theirs.',
	});
}

async function choosePath(
	engine: SupabaseEngine,
	operation: Op<'choose-path'>,
	context: SupabaseOperationContext
): Promise<Receipt> {
	const owner =
		context.actor.kind === 'operator'
			? { senderId: context.actor.senderId }
			: undefined;
	const home = operation.field === 'supabase-home';
	const choice = await engine.deps.dialog.showOpenDialog(
		{
			title: home ? 'Choose the Supabase home' : 'Choose a certificate bundle',
			buttonLabel: 'Choose',
			properties: home ? ['openDirectory', 'createDirectory'] : ['openFile'],
		},
		owner
	);
	const picked = choice.filePaths[0];
	if (choice.canceled || !picked) {
		return {
			actionId: operation.actionId,
			kind: operation.kind,
			completed: false,
			cancelled: true,
		};
	}
	const real = await supabaseRealpath(picked);
	let usable = false;
	if (real !== undefined && path.isAbsolute(real)) {
		try {
			const info = await lstat(real);
			usable = home ? info.isDirectory() : info.isFile();
		} catch {
			usable = false;
		}
	}
	if (!usable || real === undefined) {
		return failed(
			operation,
			refusedView(
				'That folder can’t be used: it is missing or not the right kind.'
			)
		);
	}
	await engine.policyStore.setPath(operation.field, real);
	if (home) {
		engine.clearLiveCaches();
		engine.track(engine.refreshAll());
	}
	return done(engine, operation, {
		message: message(
			home
				? `Supabase home set to ${engine.pathLabel(real)}.`
				: `Certificate bundle set to ${engine.pathLabel(real)}.`
		),
	});
}

async function handle(
	engine: SupabaseEngine,
	operation: SupabaseOperation,
	context: SupabaseOperationContext
): Promise<Receipt> {
	switch (operation.kind) {
		case 'refresh':
			await engine.refreshAll();
			return done(engine, operation);
		case 'read-logs':
			return readLogs(engine, operation);
		case 'read-database':
			return readDatabase(engine, operation);
		case 'start':
			return start(engine, operation);
		case 'resume-saved':
		case 'restart':
			return restart(engine, operation);
		case 'stop':
			return stop(engine, operation);
		case 'stop-and-start':
			return stopAndStart(
				engine,
				operation,
				operation.purpose === 'switch-cli'
					? "Restarting the stack with this worktree's Supabase CLI."
					: 'Restarting the stack with its current settings.'
			);
		case 'reapply-exclusions':
			return stopAndStart(engine, operation, 'Applying the exclusions again.');
		case 'pin': {
			await engine.stackStore.setPinned(operation.stackId, true);
			engine.track(engine.reconcileHolds());
			const view = engine.view(operation.stackId);
			return done(engine, operation, {
				message: message(
					`${title(view)} keeps running until you unpin or stop it.`
				),
			});
		}
		case 'unpin': {
			await engine.stackStore.setPinned(operation.stackId, false);
			engine.track(engine.reconcileHolds());
			const view = engine.view(operation.stackId);
			return done(engine, operation, {
				message: message(
					`Unpinned. ${title(view)} stops after the linger when nothing holds it.`
				),
			});
		}
		case 'release': {
			const released = await engine.stackStore.releaseHolder(
				{
					kind: operation.holder.agentKind,
					sessionId: operation.holder.sessionId,
				},
				{ stackIds: [operation.stackId] }
			);
			await engine.reconcileHolds();
			const view = engine.view(operation.stackId);
			return done(engine, operation, {
				message: message(
					released.length > 0
						? `Released the hold. ${title(view)} stops after the linger unless something else holds it.`
						: 'That hold was already released.'
				),
			});
		}
		case 'adopt':
			return adopt(engine, operation);
		case 'prepare':
			return prepare(engine, operation);
		case 'apply-migrations':
		case 'reset':
		case 'seed-buckets': {
			const view = engine.view(operation.stackId);
			const started = await databaseJob(engine, operation, view);
			if (!('jobId' in started)) return failed(operation, started);
			return done(engine, operation, { jobId: started.jobId });
		}
		case 'export':
			return exportDatabase(engine, operation, context);
		case 'destroy':
			return destroy(engine, operation);
		case 'recreate':
			return recreate(engine, operation);
		case 'set-studio':
			return setStudio(engine, operation);
		case 'follow-branch':
			return follow(engine, operation);
		case 'open':
			return open(engine, operation);
		case 'copy':
			return copy(engine, operation);
		case 'reveal':
			return reveal(engine, operation);
		case 'request.approve':
			return approve(engine, operation);
		case 'request.deny': {
			const request = engine.stackStore.request(operation.requestId);
			await engine.stackStore.updateRequest(operation.requestId, (draft) => {
				draft.status = 'denied';
				draft.settledAt = engine.now();
			});
			return done(engine, operation, {
				message: message(
					request
						? `Request denied. ${supabaseAgentLabel({ kind: request.requester.kind, sessionId: request.requester.sessionId, synthetic: request.requester.synthetic })} is told on its next call.`
						: 'Request denied.'
				),
			});
		}
		case 'set-enabled':
			return setEnabled(engine, operation);
		case 'update-policy':
			return updatePolicy(engine, operation);
		case 'repository.recheck':
			await engine.refreshRepositories();
			return done(engine, operation);
		case 'repository.set-mode':
			await engine.policyStore.setRepositoryMode(
				operation.repositoryId,
				operation.mode
			);
			await engine.refreshRepositories();
			engine.track(engine.reconcileHolds());
			return done(engine, operation);
		case 'cancel-job':
			if (!engine.cancelJob(operation.jobId)) {
				return failed(
					operation,
					supabaseDesktopError('unknown_target', 'That job has finished.')
				);
			}
			return done(engine, operation, {
				message: 'Cancelling… the CLI is cleaning up (up to 45 s).',
			});
		case 'restart-metro':
			try {
				await engine.deps.lanes.restartMetro(operation.laneId, 'operator');
			} catch (error) {
				return failed(
					operation,
					refusedView(
						error instanceof Error
							? error.message
							: 'Metro could not be restarted.'
					)
				);
			}
			return done(engine, operation, {
				message: "Metro restarted with the lane's database.",
			});
		case 'choose-path':
			return choosePath(engine, operation, context);
	}
}

async function adopt(
	engine: SupabaseEngine,
	operation: Op<'adopt'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const facts = view.facts;
	if (
		!facts ||
		facts.expectedStackId !== view.id ||
		facts.detection?.status !== 'found'
	) {
		return failed(
			operation,
			refusedView("Its branch isn't checked out in that worktree anymore.")
		);
	}
	if (engine.ownerOf(view.id)) {
		await engine.readStatus(view.id);
		const exposure = await engine.lockStack(view.id, async () => {
			// Turned off while this waited for the lock: nothing is probed.
			const off = engine.calledOff();
			return off
				? { ok: false as const, error: off.error }
				: engine.enforceExposure(view.id, undefined);
		});
		if (!exposure.ok) return failed(operation, exposure.error);
	}
	const now = engine.now();
	const existing = engine.stackStore.record(view.id);
	if (existing) {
		await engine.stackStore.updateRecord(view.id, (draft) => ({
			...draft,
			origin: 'adopted',
			worktreePath: facts.worktreePath,
			appPaths: [...new Set([...draft.appPaths, facts.appPath])].slice(-16),
			repositoryId: facts.repositoryId,
		}));
	} else if (facts.head?.status === 'ok') {
		await engine.stackStore.upsertRecord({
			id: view.id,
			origin: 'adopted',
			name: view.entry?.name || 'default',
			projectRoot: facts.detection.projectRoot,
			worktreePath: facts.worktreePath,
			appPaths: [facts.appPath],
			repositoryId: facts.repositoryId,
			branchContext: view.entry?.branchContext ?? facts.head.branchContext,
			createdBy: { via: 'external' },
			createdAt: now,
			lastUsedAt: now,
			runtime: 'native',
			pinned: false,
			holds: [],
			clocks: {},
			exclusions: [],
			studioEnabled: false,
			flags: {},
		});
	}
	engine.track(engine.reconcileHolds());
	return done(engine, operation, {
		message: message(`${title(view)} is now managed by RN Devtools.`),
	});
}

async function prepare(
	engine: SupabaseEngine,
	operation: Op<'prepare'>
): Promise<Receipt> {
	const facts =
		operation.stackId !== undefined
			? engine.factsForStack(operation.stackId)
			: engine
					.repositoryFacts()
					.find((repository) => repository.id === operation.repositoryId)
					?.worktrees.find(
						(worktree) =>
							worktree.mode.value === 'managed' &&
							worktree.detection?.status === 'found' &&
							worktree.head?.status === 'ok'
					);
	if (!facts?.expectedStackId) {
		return failed(
			operation,
			refusedView('No managed worktree in this repository yet.')
		);
	}
	const stackId = facts.expectedStackId;
	const capabilities = operation.capabilities ?? DEFAULT_PREPARE;
	return asJob(
		engine,
		operation,
		engine.startJob(
			{
				kind: 'prepare',
				stackIds: [stackId],
				requestedBy: { kind: 'operator' },
				cancellable: true,
				steps: initialSupabaseJobSteps('prepare'),
				expectedMs: 60_000,
				coldCache: true,
			},
			(job) =>
				engine.creationGate().runCancellable(
					() =>
						engine.lockStack(
							stackId,
							async (): Promise<SupabaseEngineJobOutcome> => {
								const off = engine.calledOff();
								if (off) return off;
								job.begin();
								const result = await engine.prepareStep(
									facts,
									capabilities.filter((capability) =>
										(
											SUPABASE_PREPARABLE_CAPABILITIES as readonly string[]
										).includes(capability)
									),
									job
								);
								return result.ok
									? { status: 'complete' }
									: { status: 'failed', error: result.error };
							}
						),
					job.signal,
					() => ({ status: 'cancelled' })
				)
		),
		'Downloading services… one time, up to about 360 MB.'
	);
}

async function follow(
	engine: SupabaseEngine,
	operation: Op<'follow-branch'>
): Promise<Receipt> {
	const view = engine.view(operation.stackId);
	const worktree = view.facts?.worktreePath ?? view.record?.worktreePath;
	if (!worktree)
		return failed(
			operation,
			refusedView("This stack's worktree isn't tracked.")
		);
	return new Promise<Receipt>((resolve) => {
		let answered = false;
		const answer = (receipt: Receipt) => {
			if (answered) return;
			answered = true;
			resolve(receipt);
		};
		const followed = engine.track(
			engine.followBranch(
				worktree,
				[operation.stackId],
				{ kind: 'operator' },
				(jobId) => answer(done(engine, operation, { jobId }))
			)
		);
		void followed.then((outcome) =>
			answer(
				outcome.status === 'complete'
					? done(engine, operation, {
							message: 'Now following the worktree’s branch.',
						})
					: failed(
							operation,
							outcome.error ?? refusedView('The branch was not followed.')
						)
			)
		);
	});
}

/**
 * Runs an operator operation: re-checked against a fresh state with the
 * shared availability rules, and refused without a consumed token when the
 * native dialog guards it. Never throws.
 */
export async function runSupabaseOperation(
	engine: SupabaseEngine,
	operation: SupabaseOperation,
	context: SupabaseOperationContext
): Promise<Receipt> {
	const state = engine.getState();
	const check = checkSupabaseOperation(operation, state, {
		bridgeAvailable: true,
		now: engine.now(),
	});
	if (!check.allowed) return failed(operation, check.error);
	if (supabaseConfirmationRequired(operation, state) && !context.confirmed) {
		return failed(
			operation,
			supabaseDesktopError(
				'confirmation_required',
				'A fresh, exact confirmation is required.'
			)
		);
	}
	try {
		return await handle(engine, operation, context);
	} catch (error) {
		engine.log(
			`Supabase ${operation.kind} failed: ${error instanceof Error ? error.name : 'error'}`
		);
		return failed(
			operation,
			supabaseDesktopError(
				'internal',
				'The Supabase operation failed unexpectedly.'
			)
		);
	}
}
