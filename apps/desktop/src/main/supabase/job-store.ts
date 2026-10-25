import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
	isActiveSupabaseJob,
	type SupabaseErrorView,
	type SupabaseJob,
	type SupabaseJobKind,
	sanitizeSupabaseDisplayText,
	supabaseJobIdSchema,
	supabaseJobSchema,
	supabaseStackIdSchema,
} from '../../shared/supabase-protocol';
import {
	ensureSupabaseStoreDirectory,
	loadSupabaseStoreFile,
	SupabaseStoreQueue,
	writeSupabaseStoreFile,
} from './policy-store';
import {
	redactSupabaseErrorView,
	redactSupabaseStoredText,
} from './stack-store';

/**
 * Supabase jobs: the in-memory map the tab, lanes and `wait --condition job`
 * read, a persisted ring of the last 64 terminal states (`<root>/jobs.json`)
 * so a `wait` after a desktop restart can answer job_lost, and the detached
 * lifecycle children the service adopts on boot. Progress steps come from
 * the CLI's redacted stderr lines; no percentages are ever invented.
 */

const JOBS_FILE = 'jobs.json';
const MAX_JOBS_BYTES = 1024 * 1024;
const MAX_RING = 64;
const MAX_ACTIVE = 64;
const MAX_CHILDREN = 16;
const MAX_STEPS = 16;
const MAX_LINE_LENGTH = 512;
const MAX_DETAIL_LENGTH = 256;
/** Terminal jobs stay in the state this long so the tab can show how they ended. */
const RECENT_JOB_MS = 10 * 60 * 1_000;

export type SupabaseJobStep = NonNullable<SupabaseJob['steps']>[number];
export type SupabaseJobStepState = SupabaseJobStep['state'];
type JobRequester = SupabaseJob['requestedBy'];

// ---------------------------------------------------------------------------
// Steps

/**
 * Step ids. The CLI's progress lines drive the CLI steps; the service marks
 * `room` (admission), `verify` (lsof) and `attach` (the lane) itself.
 */
type SupabaseJobStepId =
	| 'room'
	| 'database'
	| 'migrations'
	| 'seed'
	| 'buckets'
	| 'verify'
	| 'attach'
	| 'stop'
	| 'restart'
	| 'destroy'
	| 'reset'
	| 'export'
	| 'download';

const STEP_LABELS: Readonly<Record<SupabaseJobStepId, string>> = {
	room: 'Check room',
	database: 'Start the database',
	migrations: 'Apply migrations',
	seed: 'Seed data',
	buckets: 'Seed buckets',
	verify: 'Verify it listens only on 127.0.0.1',
	attach: 'Attach to the lane',
	stop: 'Stop services',
	restart: 'Restart services',
	destroy: 'Destroy the stack',
	reset: 'Reset the database',
	export: 'Export the database',
	download: 'Download services',
};

const CLI_STEPS: ReadonlySet<string> = new Set([
	'database',
	'migrations',
	'seed',
	'buckets',
	'stop',
	'restart',
	'destroy',
	'reset',
	'export',
	'download',
]);

/**
 * What a job's step list depends on.
 */
export type SupabaseJobStepOptions = Readonly<{
	/** Local migration files; no migrations step when 0. */
	migrationTotal?: number;
	/** The lane the stack attaches to, for an attach step. */
	lanePort?: number;
	/** Reset or create without the seed. */
	seed?: boolean;
}>;

function step(
	id: SupabaseJobStepId,
	label: string = STEP_LABELS[id]
): SupabaseJobStep {
	return { id, label, state: 'pending' };
}

/** The steps a job of `kind` shows before anything has happened. */
export function initialSupabaseJobSteps(
	kind: SupabaseJobKind,
	options: SupabaseJobStepOptions = {}
): SupabaseJobStep[] {
	const migrations =
		options.migrationTotal !== undefined && options.migrationTotal > 0
			? [
					step(
						'migrations',
						`Apply ${options.migrationTotal} ${options.migrationTotal === 1 ? 'migration' : 'migrations'}`
					),
				]
			: [];
	const seed = options.seed === false ? [] : [step('seed')];
	const attach =
		options.lanePort === undefined
			? []
			: [step('attach', `Attach to lane :${options.lanePort}`)];
	const start = [step('room'), step('database')];
	switch (kind) {
		case 'create':
			return [...start, ...migrations, ...seed, step('verify'), ...attach];
		case 'resume':
			return [...start, step('verify'), ...attach];
		case 'recreate':
			return [
				step('destroy'),
				...start,
				...migrations,
				...seed,
				step('verify'),
				...attach,
			];
		case 'stop':
		case 'disable':
			return [step('stop')];
		case 'restart':
			return [step('restart')];
		case 'stop-and-start':
		case 'studio':
			return [step('stop'), step('database'), step('verify')];
		case 'destroy':
			return [step('destroy')];
		case 'reset':
			return [step('reset'), ...migrations, ...seed];
		case 'migrate':
			return [step('migrations')];
		case 'seed-buckets':
			return [step('buckets')];
		case 'export':
			return [step('export')];
		case 'prepare':
			return [step('download'), step('stop')];
	}
}

/** Sets one step's state (and detail), leaving the others alone. */
export function markSupabaseJobStep(
	steps: readonly SupabaseJobStep[],
	stepId: string,
	state: SupabaseJobStepState,
	detail?: string
): SupabaseJobStep[] {
	return steps.map((candidate) =>
		candidate.id === stepId
			? {
					id: candidate.id,
					label: candidate.label,
					state,
					...(detail === undefined
						? candidate.detail === undefined
							? {}
							: { detail: candidate.detail }
						: { detail: safeDetail(detail) }),
				}
			: candidate
	);
}

function safeDetail(value: string): string {
	return sanitizeSupabaseDisplayText(
		redactSupabaseStoredText(value, MAX_DETAIL_LENGTH * 2),
		MAX_DETAIL_LENGTH
	);
}

/**
 * A progress line as one display-safe line: redacted, no controls, bounded.
 */
function safeSupabaseProgressLine(line: string): string {
	return sanitizeSupabaseDisplayText(
		redactSupabaseStoredText(line, MAX_LINE_LENGTH * 2),
		MAX_LINE_LENGTH
	);
}

/**
 * What one CLI stderr line means for progress.
 */
export type SupabaseProgressEvent =
	| Readonly<{
			kind: 'task-start';
			step: 'database' | 'restart' | 'destroy' | 'download' | 'stop';
	  }>
	| Readonly<{ kind: 'task-done' }>
	| Readonly<{ kind: 'task-failed'; message: string }>
	| Readonly<{ kind: 'roles' }>
	| Readonly<{ kind: 'migration'; file: string }>
	| Readonly<{ kind: 'seed' }>
	| Readonly<{ kind: 'buckets' }>
	| Readonly<{ kind: 'reset' }>
	| Readonly<{ kind: 'export' }>
	| Readonly<{ kind: 'destroy' }>
	| Readonly<{ kind: 'finished' }>
	| Readonly<{ kind: 'note' }>;

const TASK_LINE = /^\[task\] (start|done|failed): ?(.*)$/;
const MIGRATION_LINE = /^Applying migration (.+?)(?:\.{3}|…)?$/;

/**
 * Classifies one redacted CLI stderr line: `[task] start|done|failed`,
 * `Seeding globals from roles.sql...`, `Applying migration <file>...`,
 * `Seeding data from ...`, bucket lines, `Resetting local database...`,
 * `Dumping ...`, `Permanently destroying stack ...` and `Finished ...`.
 * Blank lines are undefined; anything else is a note.
 */
export function parseSupabaseProgressLine(
	line: string
): SupabaseProgressEvent | undefined {
	const text = safeSupabaseProgressLine(line);
	if (text.length === 0) return undefined;
	const task = TASK_LINE.exec(text);
	if (task) {
		const message = task[2] ?? '';
		if (task[1] === 'done') return { kind: 'task-done' };
		if (task[1] === 'failed') {
			return { kind: 'task-failed', message: safeDetail(message) };
		}
		if (/^Destroying\b/i.test(message))
			return { kind: 'task-start', step: 'destroy' };
		if (/^Restarting\b/i.test(message))
			return { kind: 'task-start', step: 'restart' };
		if (/^Preparing\b/i.test(message))
			return { kind: 'task-start', step: 'download' };
		if (/^Stopping\b/i.test(message))
			return { kind: 'task-start', step: 'stop' };
		return { kind: 'task-start', step: 'database' };
	}
	if (/^Seeding globals from\b/.test(text)) return { kind: 'roles' };
	const migration = MIGRATION_LINE.exec(text);
	if (migration) {
		return {
			kind: 'migration',
			file: path.basename(migration[1] ?? '').slice(0, 200),
		};
	}
	if (/^Seeding data from\b/.test(text)) return { kind: 'seed' };
	if (/\bbuckets?\b/i.test(text)) return { kind: 'buckets' };
	if (/^Resetting (?:the )?(?:local )?database\b/i.test(text)) {
		return { kind: 'reset' };
	}
	if (/^Dumping\b/.test(text)) return { kind: 'export' };
	if (/^Permanently destroying stack\b/.test(text)) return { kind: 'destroy' };
	if (/^Finished\b/.test(text)) return { kind: 'finished' };
	return { kind: 'note' };
}

/** A job's progress: its steps, the migration count, the newest line. */
export type SupabaseJobProgress = Readonly<{
	steps: readonly SupabaseJobStep[];
	migration?: Readonly<{ done: number; total: number }>;
	latestLine?: string;
	/** Set when a line said the CLI task finished or failed. */
	outcome?: 'done' | 'failed';
}>;

/** Makes `stepId` current; CLI steps before it that were current are done. */
function advanceTo(
	steps: readonly SupabaseJobStep[],
	stepId: string
): SupabaseJobStep[] {
	const target = steps.findIndex((candidate) => candidate.id === stepId);
	if (target === -1) return [...steps];
	return steps.map((candidate, index) => {
		if (index < target && candidate.state === 'current') {
			return { ...candidate, state: 'done' };
		}
		if (
			index === target &&
			candidate.state !== 'done' &&
			candidate.state !== 'failed'
		) {
			return { ...candidate, state: 'current' };
		}
		return candidate;
	});
}

/** The CLI steps of one start or reset invocation. */
const START_GROUP: ReadonlySet<string> = new Set([
	'database',
	'migrations',
	'seed',
	'reset',
]);

/**
 * Ends the CLI steps of the invocation that just finished: current ones are
 * done, and untouched ones in a start or reset (no seed file, nothing to
 * migrate) are skipped. Service steps and later invocations stay pending.
 */
function finishInvocation(
	steps: readonly SupabaseJobStep[]
): SupabaseJobStep[] {
	const current = steps.find(
		(candidate) => candidate.state === 'current' && CLI_STEPS.has(candidate.id)
	);
	const startLike = current !== undefined && START_GROUP.has(current.id);
	return steps.map((candidate) => {
		if (candidate.state === 'current' && CLI_STEPS.has(candidate.id)) {
			return { ...candidate, state: 'done' };
		}
		if (
			startLike &&
			candidate.state === 'pending' &&
			START_GROUP.has(candidate.id) &&
			candidate.id !== 'database' &&
			candidate.id !== 'reset'
		) {
			return { ...candidate, state: 'skipped' };
		}
		return candidate;
	});
}

/** Applies one redacted stderr line to a job's progress. */
export function advanceSupabaseJobProgress(
	progress: SupabaseJobProgress,
	line: string
): SupabaseJobProgress {
	const event = parseSupabaseProgressLine(line);
	if (event === undefined) return progress;
	const latestLine = safeSupabaseProgressLine(line);
	let steps = [...progress.steps];
	let migration = progress.migration;
	let outcome = progress.outcome;
	const has = (id: string) => steps.some((candidate) => candidate.id === id);
	switch (event.kind) {
		case 'task-start':
			if (has(event.step)) {
				steps = advanceTo(steps, event.step);
			} else {
				const next = steps.find(
					(candidate) =>
						candidate.state === 'pending' && CLI_STEPS.has(candidate.id)
				);
				if (next) steps = advanceTo(steps, next.id);
			}
			outcome = undefined;
			break;
		case 'roles': {
			// Roles are seeded once the new database is up.
			steps = markSupabaseJobStep(steps, 'database', 'done');
			const next = has('migrations')
				? 'migrations'
				: has('seed')
					? 'seed'
					: undefined;
			if (next) steps = advanceTo(steps, next);
			break;
		}
		case 'migration': {
			const done = (migration?.done ?? 0) + 1;
			const total = Math.max(migration?.total ?? 0, done);
			migration = { done, total };
			if (!has('migrations')) steps = insertMigrationsStep(steps);
			steps = advanceTo(markDoneBefore(steps, 'migrations'), 'migrations');
			steps = markSupabaseJobStep(
				steps,
				'migrations',
				'current',
				`${done} of ${total}`
			);
			break;
		}
		case 'seed':
			steps = advanceTo(markDoneBefore(steps, 'seed'), 'seed');
			break;
		case 'buckets':
			if (has('buckets')) steps = advanceTo(steps, 'buckets');
			break;
		case 'reset':
			steps = advanceTo(steps, 'reset');
			break;
		case 'export':
			steps = advanceTo(steps, 'export');
			break;
		case 'destroy':
			steps = advanceTo(steps, 'destroy');
			break;
		case 'task-done':
		case 'finished':
			steps = finishInvocation(steps);
			outcome = 'done';
			break;
		case 'task-failed': {
			const failing =
				steps.find(
					(candidate) =>
						candidate.state === 'current' && CLI_STEPS.has(candidate.id)
				) ??
				steps.find(
					(candidate) =>
						candidate.state === 'pending' && CLI_STEPS.has(candidate.id)
				);
			if (failing) {
				steps = markSupabaseJobStep(
					steps,
					failing.id,
					'failed',
					event.message.length > 0 ? event.message : undefined
				);
			}
			outcome = 'failed';
			break;
		}
		case 'note':
			break;
	}
	return {
		steps,
		...(migration === undefined ? {} : { migration }),
		latestLine,
		...(outcome === undefined ? {} : { outcome }),
	};
}

/**
 * Adds a migrations step when the CLI applies migrations the job did not
 * expect (the count was unknown): before the seed, else before verify.
 */
function insertMigrationsStep(
	steps: readonly SupabaseJobStep[]
): SupabaseJobStep[] {
	if (steps.length >= MAX_STEPS) return [...steps];
	const before = steps.findIndex(
		(candidate) => candidate.id === 'seed' || candidate.id === 'verify'
	);
	const index = before === -1 ? steps.length : before;
	return [...steps.slice(0, index), step('migrations'), ...steps.slice(index)];
}

/** Marks the start steps before `stepId` done (their lines may be missing). */
function markDoneBefore(
	steps: readonly SupabaseJobStep[],
	stepId: string
): SupabaseJobStep[] {
	const target = steps.findIndex((candidate) => candidate.id === stepId);
	return steps.map((candidate, index) =>
		index < target &&
		START_GROUP.has(candidate.id) &&
		(candidate.state === 'pending' || candidate.state === 'current')
			? { ...candidate, state: 'done' }
			: candidate
	);
}

// ---------------------------------------------------------------------------
// Store

/** A detached lifecycle CLI child, recorded so a restarted desktop can adopt it. */
const childSchema = z.strictObject({
	jobId: supabaseJobIdSchema,
	/** Never 0 or 1: those would signal a process group or launchd. */
	pid: z.number().int().min(2).max(2_147_483_647),
	startedAt: z.number().int().nonnegative(),
	/** sha256 of its command line, to recognize the process before adopting it. */
	argvDigest: z.string().regex(/^[0-9a-f]{64}$/),
	/** The 0600 stderr progress file the child writes. */
	progressFile: z
		.string()
		.min(2)
		.max(1_024)
		.refine(
			(value) =>
				path.isAbsolute(value) &&
				path.normalize(value) === value &&
				!value.includes('\0'),
			{ message: 'The progress file must be an absolute path.' }
		),
	stackIds: z.array(supabaseStackIdSchema).max(32),
});
export type SupabaseDetachedChild = z.infer<typeof childSchema>;

const jobsFileSchema = z.strictObject({
	version: z.literal(1),
	/** Terminal jobs, newest first. */
	ring: z.array(supabaseJobSchema).max(MAX_RING),
	/** Jobs that were queued or running at the last write. */
	active: z.array(supabaseJobSchema).max(MAX_ACTIVE),
	children: z.array(childSchema).max(MAX_CHILDREN),
});
type JobsFile = z.infer<typeof jobsFileSchema>;

function parseJobsFile(value: unknown): JobsFile | undefined {
	const parsed = jobsFileSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * What strvis(3) with VIS_TAB | VIS_NL | VIS_NOSLASH, the encoding ps applies
 * to a command line, writes for one byte in the C locale.
 */
function cLocaleVisByte(byte: number): string {
	// Tab, newline and the high-bit space come out as `\` and three octal digits.
	if (byte === 0x09 || byte === 0x0a || byte === 0xa0) {
		return `\\${byte.toString(8).padStart(3, '0')}`;
	}
	if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
	const meta = byte & 0x80 ? 'M' : '';
	const low = byte & 0x7f;
	if (low === 0x7f) return `${meta}^?`;
	return low < 0x20
		? `${meta}^${String.fromCharCode(low + 0x40)}`
		: `${meta}-${String.fromCharCode(low)}`;
}

/**
 * A command line in the form `ps -o args=` prints it in the C locale: every
 * byte outside printable ASCII escaped, so `é` reads `M-CM-)`. That is the
 * locale ps inherits from a desktop opened from the Dock or Finder, which has
 * no LANG or LC_ALL. In a UTF-8 locale ps prints printable characters as they
 * are; this maps that line to the same form, and leaves the escapes, which
 * are printable ASCII, alone. Characters a UTF-8 locale counts unprintable
 * (U+200B, say) it escapes differently, so such a line does not match.
 */
function cLocalePsLine(line: string): string {
	return Array.from(Buffer.from(line, 'utf8'), cLocaleVisByte).join('');
}

/**
 * The sha256 the child bookkeeping keeps instead of the argv itself: of the
 * binary and its arguments space-joined, in the C-locale form ps prints. The
 * argv a child was spawned with and the line ps shows for it later both pass
 * through that form, so they match whichever locale ps runs in.
 */
export function supabaseArgvDigest(command: readonly string[]): string {
	return createHash('sha256')
		.update(cLocalePsLine(command.join(' ')), 'utf8')
		.digest('hex');
}

/**
 * What a new job needs; the store fills in id, status and times.
 */
export type SupabaseJobInput = Readonly<{
	kind: SupabaseJobKind;
	stackIds: readonly string[];
	requestedBy: JobRequester;
	cancellable: boolean;
	expectedMs?: number;
	coldCache?: boolean;
	steps?: readonly SupabaseJobStep[];
	/** Starts `migration` at 0 of N. */
	migrationTotal?: number;
}>;

type JobEntry = { job: SupabaseJob; progress: SupabaseJobProgress };

function settleSteps(
	steps: readonly SupabaseJobStep[] | undefined,
	status: SupabaseJob['status']
): SupabaseJobStep[] | undefined {
	if (steps === undefined) return undefined;
	return steps.map((candidate) => {
		if (candidate.state === 'current') {
			return {
				...candidate,
				state:
					status === 'complete'
						? 'done'
						: status === 'cancelled'
							? 'skipped'
							: 'failed',
			};
		}
		if (candidate.state === 'pending' && status === 'complete') {
			return { ...candidate, state: 'skipped' };
		}
		return candidate;
	});
}

/**
 * The job map and its persisted ring. Progress updates live in memory only;
 * creating, finishing and child bookkeeping are written through. A write
 * failure is logged and never fails the job: the ring is a convenience for
 * `wait` after a restart, not a source of truth.
 */
export class SupabaseJobStore {
	readonly #directory: string;
	readonly #file: string;
	readonly #now: () => number;
	readonly #newId: () => string;
	readonly #log: (line: string) => void;
	readonly #queue = new SupabaseStoreQueue();
	readonly #listeners = new Set<() => void>();
	readonly #entries = new Map<string, JobEntry>();
	#ring: SupabaseJob[] = [];
	#children: SupabaseDetachedChild[] = [];
	#health: 'ok' | 'quarantined' = 'ok';

	constructor(
		options: Readonly<{
			/** The service root, `<userData>/supabase`. */
			directory: string;
			now?: () => number;
			/** A UUID; ids are `supabase-job-<uuid>`. */
			newId?: () => string;
			log?: (line: string) => void;
		}>
	) {
		this.#directory = path.resolve(options.directory);
		this.#file = path.join(this.#directory, JOBS_FILE);
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? randomUUID;
		this.#log = options.log ?? (() => undefined);
	}

	get file(): string {
		return this.#file;
	}

	get health(): 'ok' | 'quarantined' {
		return this.#health;
	}

	/**
	 * Reads the ring. Jobs that were in flight when the desktop last wrote
	 * become `lost` (a `wait` on them answers job_lost); the detached children
	 * are returned for the service to adopt by pid and argv.
	 */
	async load(): Promise<
		Readonly<{
			health: 'ok' | 'quarantined';
			lost: readonly string[];
			children: readonly SupabaseDetachedChild[];
		}>
	> {
		const loaded = await this.#queue.run(async () => {
			await ensureSupabaseStoreDirectory(this.#directory);
			return loadSupabaseStoreFile(this.#file, {
				maxBytes: MAX_JOBS_BYTES,
				parse: parseJobsFile,
				now: this.#now(),
			});
		});
		const now = this.#now();
		const lost: string[] = [];
		this.#entries.clear();
		if (loaded.status === 'ok') {
			this.#health = 'ok';
			this.#ring = loaded.data.ring.filter((job) => !isActiveSupabaseJob(job));
			this.#children = loaded.data.children;
			for (const job of loaded.data.active) {
				if (this.#ring.some((candidate) => candidate.id === job.id)) continue;
				lost.push(job.id);
				this.#ring.unshift(lostJob(job, now));
			}
			this.#ring = this.#ring.slice(0, MAX_RING);
		} else {
			this.#health = loaded.status === 'missing' ? 'ok' : 'quarantined';
			this.#ring = [];
			this.#children = [];
			if (loaded.status === 'quarantined') {
				this.#log(
					`Supabase job history was unreadable (${loaded.reason}) and was set aside.`
				);
			}
		}
		if (lost.length > 0) await this.#persist();
		this.#notify();
		return { health: this.#health, lost, children: [...this.#children] };
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Queues a new job and writes it through, so a restart reports it lost. */
	async create(input: SupabaseJobInput): Promise<SupabaseJob> {
		const now = this.#now();
		const steps = input.steps ? [...input.steps].slice(0, MAX_STEPS) : [];
		const migration =
			input.migrationTotal !== undefined && input.migrationTotal > 0
				? { done: 0, total: input.migrationTotal }
				: undefined;
		const job = supabaseJobSchema.parse({
			id: `supabase-job-${this.#newId()}`,
			kind: input.kind,
			stackIds: [...input.stackIds],
			status: 'queued',
			...(steps.length > 0 ? { steps } : {}),
			...(migration === undefined ? {} : { migration }),
			...(input.coldCache === undefined ? {} : { coldCache: input.coldCache }),
			startedAt: now,
			updatedAt: now,
			...(input.expectedMs === undefined
				? {}
				: { expectedMs: input.expectedMs }),
			cancellable: input.cancellable,
			requestedBy: input.requestedBy,
		});
		this.#entries.set(job.id, {
			job,
			progress: {
				steps,
				...(migration === undefined ? {} : { migration }),
			},
		});
		this.#notify();
		await this.#persist();
		return job;
	}

	/** Queued to running; the first pending step becomes current. */
	start(jobId: string): SupabaseJob | undefined {
		const entry = this.#entries.get(jobId);
		if (entry?.job.status !== 'queued') return copyJob(entry?.job);
		const first = entry.progress.steps.find(
			(candidate) => candidate.state === 'pending'
		);
		const progress: SupabaseJobProgress = first
			? {
					...entry.progress,
					steps: markSupabaseJobStep(entry.progress.steps, first.id, 'current'),
				}
			: entry.progress;
		entry.progress = progress;
		return this.#change(jobId, (job) =>
			withProgress({ ...job, status: 'running' }, progress)
		);
	}

	/** Applies one redacted stderr line to a running job. */
	progress(jobId: string, line: string): SupabaseJob | undefined {
		const entry = this.#entries.get(jobId);
		if (!entry || !isActiveSupabaseJob(entry.job)) return copyJob(entry?.job);
		const progress = advanceSupabaseJobProgress(entry.progress, line);
		entry.progress = progress;
		return this.#change(jobId, (job) => withProgress(job, progress));
	}

	/** Sets a service-driven step: room, verify, attach. */
	markStep(
		jobId: string,
		stepId: string,
		state: SupabaseJobStepState,
		detail?: string
	): SupabaseJob | undefined {
		const entry = this.#entries.get(jobId);
		if (!entry || !isActiveSupabaseJob(entry.job)) return copyJob(entry?.job);
		const progress: SupabaseJobProgress = {
			...entry.progress,
			steps: markSupabaseJobStep(entry.progress.steps, stepId, state, detail),
		};
		entry.progress = progress;
		return this.#change(jobId, (job) => withProgress(job, progress));
	}

	/** Updates what the tab shows about a running job. */
	setDetails(
		jobId: string,
		fields: Readonly<{
			expectedMs?: number;
			coldCache?: boolean;
			cancellable?: boolean;
		}>
	): SupabaseJob | undefined {
		return this.#change(jobId, (job) =>
			isActiveSupabaseJob(job)
				? {
						...job,
						...(fields.expectedMs === undefined
							? {}
							: { expectedMs: fields.expectedMs }),
						...(fields.coldCache === undefined
							? {}
							: { coldCache: fields.coldCache }),
						...(fields.cancellable === undefined
							? {}
							: { cancellable: fields.cancellable }),
					}
				: job
		);
	}

	/** Records that the operator asked to cancel; the CLI cleans up first. */
	requestCancel(jobId: string): SupabaseJob | undefined {
		return this.#change(jobId, (job) =>
			isActiveSupabaseJob(job) && job.cancellable
				? { ...job, cancelRequested: true }
				: job
		);
	}

	/** Ends a job and moves it into the persisted ring. */
	async finish(
		jobId: string,
		result: Readonly<{
			status: 'complete' | 'failed' | 'cancelled' | 'lost';
			error?: SupabaseErrorView;
		}>
	): Promise<SupabaseJob | undefined> {
		const entry = this.#entries.get(jobId);
		if (!entry) return copyJob(this.#ring.find((job) => job.id === jobId));
		if (!isActiveSupabaseJob(entry.job)) return copyJob(entry.job);
		const steps = settleSteps(entry.job.steps, result.status);
		const { cancelRequested: _cancelRequested, ...rest } = entry.job;
		const finished = supabaseJobSchema.parse({
			...rest,
			status: result.status,
			...(steps === undefined ? {} : { steps }),
			...(result.error === undefined
				? {}
				: { error: redactSupabaseErrorView(result.error) }),
			cancellable: false,
			updatedAt: this.#now(),
		});
		entry.job = finished;
		this.#ring = [
			finished,
			...this.#ring.filter((job) => job.id !== finished.id),
		].slice(0, MAX_RING);
		this.#forgetFinished();
		this.#notify();
		await this.#persist();
		return structuredClone(finished);
	}

	/**
	 * Revives a job lost at boot whose detached child the service adopted:
	 * it runs again until the child exits.
	 */
	adopt(jobId: string): SupabaseJob | undefined {
		if (this.#entries.has(jobId)) return copyJob(this.#entries.get(jobId)?.job);
		const lost = this.#ring.find(
			(job) => job.id === jobId && job.status === 'lost'
		);
		if (!lost) return undefined;
		const { error: _error, ...rest } = lost;
		const revived = supabaseJobSchema.parse({
			...rest,
			status: 'running',
			cancellable: false,
			updatedAt: this.#now(),
		});
		this.#ring = this.#ring.filter((job) => job.id !== jobId);
		this.#entries.set(jobId, {
			job: revived,
			progress: {
				steps: revived.steps ?? [],
				...(revived.migration === undefined
					? {}
					: { migration: revived.migration }),
			},
		});
		this.#notify();
		return structuredClone(revived);
	}

	/** A job by id: in flight, finished recently, or from the ring. A copy. */
	job(jobId: string): SupabaseJob | undefined {
		const job =
			this.#entries.get(jobId)?.job ??
			this.#ring.find((candidate) => candidate.id === jobId);
		return job === undefined ? undefined : structuredClone(job);
	}

	activeJobs(): readonly SupabaseJob[] {
		return structuredClone(this.#activeJobs());
	}

	/**
	 * What the state carries: every active job, then jobs that ended within
	 * the last 10 minutes, newest first, at most 64.
	 */
	jobs(
		options: Readonly<{ now?: number; recentMs?: number }> = {}
	): readonly SupabaseJob[] {
		const now = options.now ?? this.#now();
		const recentMs = options.recentMs ?? RECENT_JOB_MS;
		const all = [...this.#entries.values()].map((entry) => entry.job);
		const active = all
			.filter(isActiveSupabaseJob)
			.sort((left, right) => right.startedAt - left.startedAt);
		const recent = all
			.filter(
				(job) => !isActiveSupabaseJob(job) && now - job.updatedAt <= recentMs
			)
			.sort((left, right) => right.updatedAt - left.updatedAt);
		return structuredClone([...active, ...recent].slice(0, MAX_RING));
	}

	/**
	 * Resolves once the job is terminal, or with its current state at the
	 * timeout or abort. Undefined for an id this store never saw.
	 */
	waitFor(
		jobId: string,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<SupabaseJob | undefined> {
		const current = this.job(jobId);
		if (!current || !isActiveSupabaseJob(current) || signal?.aborted) {
			return Promise.resolve(current);
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener('abort', finish);
				resolve(this.job(jobId));
			};
			const timer = setTimeout(finish, Math.max(0, timeoutMs));
			timer.unref?.();
			const unsubscribe = this.subscribe(() => {
				const job = this.job(jobId);
				if (!job || !isActiveSupabaseJob(job)) finish();
			});
			signal?.addEventListener('abort', finish, { once: true });
		});
	}

	/** Records a detached child so a restarted desktop can adopt it. */
	async recordChild(child: SupabaseDetachedChild): Promise<void> {
		const validated = childSchema.parse(child);
		this.#children = [
			...this.#children.filter((candidate) => candidate.pid !== validated.pid),
			validated,
		].slice(-MAX_CHILDREN);
		await this.#persist();
	}

	/** Forgets a job's detached child once it exited. */
	async releaseChild(jobId: string): Promise<void> {
		const before = this.#children.length;
		this.#children = this.#children.filter(
			(candidate) => candidate.jobId !== jobId
		);
		if (this.#children.length !== before) await this.#persist();
	}

	children(): readonly SupabaseDetachedChild[] {
		return [...this.#children];
	}

	/**
	 * Drops finished jobs the state no longer lists (older than the recent
	 * window, or past the newest 64) from memory; the ring answers for them.
	 */
	#forgetFinished(): void {
		const now = this.#now();
		// Newest first; jobs that ended at the same time, newest created first.
		const finished = [...this.#entries.values()]
			.map((entry) => entry.job)
			.filter((job) => !isActiveSupabaseJob(job))
			.reverse()
			.sort((left, right) => right.updatedAt - left.updatedAt);
		for (const [index, job] of finished.entries()) {
			if (index >= MAX_RING || now - job.updatedAt > RECENT_JOB_MS) {
				this.#entries.delete(job.id);
			}
		}
	}

	#activeJobs(): SupabaseJob[] {
		return [...this.#entries.values()]
			.map((entry) => entry.job)
			.filter(isActiveSupabaseJob);
	}

	#change(
		jobId: string,
		next: (job: SupabaseJob) => SupabaseJob
	): SupabaseJob | undefined {
		const entry = this.#entries.get(jobId);
		if (!entry) return undefined;
		const changed = next(entry.job);
		if (changed === entry.job) return structuredClone(entry.job);
		entry.job = supabaseJobSchema.parse({
			...changed,
			updatedAt: this.#now(),
		});
		this.#notify();
		return structuredClone(entry.job);
	}

	async #persist(): Promise<void> {
		const snapshot: JobsFile = {
			version: 1,
			ring: [...this.#ring],
			active: this.#activeJobs().slice(0, MAX_ACTIVE),
			children: [...this.#children],
		};
		await this.#queue.run(async () => {
			try {
				const validated = jobsFileSchema.parse(snapshot);
				await writeSupabaseStoreFile(
					this.#file,
					`${JSON.stringify(validated)}\n`,
					MAX_JOBS_BYTES
				);
				this.#health = 'ok';
			} catch (error) {
				this.#log(
					`Supabase job history could not be saved: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		});
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// A listener's failure never affects a job.
			}
		}
	}
}

function copyJob(job: SupabaseJob | undefined): SupabaseJob | undefined {
	return job === undefined ? undefined : structuredClone(job);
}

function withProgress(
	job: SupabaseJob,
	progress: SupabaseJobProgress
): SupabaseJob {
	return {
		...job,
		...(progress.steps.length > 0
			? { steps: progress.steps.slice(0, MAX_STEPS) }
			: {}),
		...(progress.migration === undefined
			? {}
			: { migration: progress.migration }),
		...(progress.latestLine === undefined || progress.latestLine.length === 0
			? {}
			: { latestLine: progress.latestLine }),
	};
}

function lostJob(job: SupabaseJob, now: number): SupabaseJob {
	const { cancelRequested: _cancelRequested, ...rest } = job;
	const steps = settleSteps(job.steps, 'lost');
	return {
		...rest,
		status: 'lost',
		...(steps === undefined ? {} : { steps }),
		cancellable: false,
		updatedAt: Math.max(job.updatedAt, now),
	};
}
