import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import type { Lane, LaneWorktree } from '../../shared/lane-protocol';
import {
	isSupabaseStackRunning,
	type SupabasePolicy,
	type SupabaseRepositorySummary,
	type SupabaseStackFlag,
	type SupabaseStackSummary,
	type SupabaseState,
	sanitizeSupabaseDisplayText,
	supabaseBranchLabel,
	supabasePlatformLabel,
	supabaseRepositorySummarySchema,
} from '../../shared/supabase-protocol';
import {
	isPathWithin,
	nodeStaticFileSystem,
	type StaticFileSystem,
} from './bounded-read';
import type {
	SupabaseCliResolution,
	SupabaseCliResolveInput,
} from './cli-resolver';
import { type GitHead, readGitHead } from './git-head';
import { expectedStackId } from './identity';
import {
	detectSupabaseProject,
	type SupabaseProjectDetection,
} from './project';

/**
 * Repository readiness for local Supabase: one summary per repository Lanes
 * tracks, built from static, bounded reads of each worktree (the project's
 * config.toml, its stack flag, a config.json conflict, pinned listener
 * ports, app .env files that would shadow mapped Metro variables), the
 * worktree's own CLI as cli-resolver found it, and the stack id each
 * worktree's HEAD would get. Fixes are copy-only snippets: RN Devtools never
 * edits repository files.
 */

const MAX_REPOSITORIES = 32;
const MAX_WORKTREES = 128;
const MAX_LINES = 16;
const MAX_TEXT = 512;
const MAX_MIGRATION_ENTRIES = 10_000;
const INSPECT_CONCURRENCY = 8;

const STACK_FLAG_SNIPPET = '[experimental]\nstack = true';
const RECOMMENDED_SNIPPET =
	'[studio]\nenabled = false\n[analytics]\nenabled = false';

/** `repo-` plus the first 12 hex of sha256 over the repository's realpath. */
export function supabaseRepositoryId(realRoot: string): string {
	return `repo-${createHash('sha256').update(realRoot, 'utf8').digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Worktree mode

/**
 * Who owns a worktree's stack lifecycle, and why it is not managed.
 */
export type SupabaseWorktreeMode = Readonly<{
	value: 'managed' | 'observed' | 'off';
	reasonText?: string;
}>;

const STACK_FLAG_REASONS: Readonly<
	Record<
		Exclude<
			Extract<SupabaseProjectDetection, { status: 'found' }>['stackFlag'],
			{ optedIn: true }
		>['reason'],
		string
	>
> = {
	missing: 'stack flag missing',
	false: 'stack flag is false',
	'not-boolean': 'stack flag is not a TOML boolean',
	'env-reference': 'stack flag reads an env() value',
	duplicate: 'stack flag is set twice',
	'unreadable-config': "supabase/config.toml can't be read",
};

/**
 * The worktree mode (DESIGN: worktree modes): off while the feature or the
 * repository is off or no project exists; observed while the platform, the
 * stack flag, a config.json conflict or the CLI keeps the desktop from
 * managing it; managed otherwise.
 */
export function supabaseWorktreeMode(
	input: Readonly<{
		featureEnabled: boolean;
		platformSupported: boolean;
		repositoryMode: 'auto' | 'off';
		/** Undefined while not read yet (or while the repository is off). */
		detection: SupabaseProjectDetection | undefined;
		/** Undefined while the CLI is still being checked. */
		cli: SupabaseCliResolution | undefined;
	}>
): SupabaseWorktreeMode {
	if (!input.featureEnabled) {
		return { value: 'off', reasonText: 'local Supabase is off' };
	}
	if (input.repositoryMode === 'off') {
		return { value: 'off', reasonText: 'turned off for this repository' };
	}
	const detection = input.detection;
	if (detection === undefined) {
		return { value: 'observed', reasonText: 'still checking this worktree' };
	}
	if (detection.status === 'none') {
		return { value: 'off', reasonText: 'no supabase/config.toml' };
	}
	if (!input.platformSupported) {
		return {
			value: 'observed',
			reasonText: 'native Supabase needs Apple silicon and macOS 14 or later',
		};
	}
	if (!detection.stackFlag.optedIn) {
		return {
			value: 'observed',
			reasonText: STACK_FLAG_REASONS[detection.stackFlag.reason],
		};
	}
	if (detection.configConflict) {
		return {
			value: 'observed',
			reasonText: 'supabase/config.json conflicts with config.toml',
		};
	}
	const cli = input.cli;
	if (cli === undefined) {
		return { value: 'observed', reasonText: 'still checking the Supabase CLI' };
	}
	if (!cli.ok) return { value: 'observed', reasonText: cli.message };
	if (!cli.cli.dialect.manageable) {
		return {
			value: 'observed',
			reasonText: `Supabase CLI ${cli.cli.version} isn't verified`,
		};
	}
	return { value: 'managed' };
}

// ---------------------------------------------------------------------------
// Gathering facts

/** Everything known about one worktree (and app directory) of a repository. */
export type SupabaseWorktreeFacts = Readonly<{
	/** The checkout root as Lanes tracks it. */
	worktreePath: string;
	/** Its realpath, for matching stacks by project root. */
	realWorktreePath: string;
	/** The app directory detection started from. */
	appPath: string;
	repositoryRoot: string;
	repositoryId: string;
	/** The branch Lanes reports for the worktree. */
	branch: string;
	exists: boolean;
	/** Undefined while the repository is off: nothing is read then. */
	detection?: SupabaseProjectDetection;
	head?: GitHead;
	/** The id the CLI would give this worktree's stack at its HEAD. */
	expectedStackId?: string;
	/** Undefined while checking, or when no project exists. */
	cli?: SupabaseCliResolution;
	mode: SupabaseWorktreeMode;
	/** config.toml declares storage buckets. */
	bucketsConfigured: boolean;
	/** Local migration files, for the first start's step count. */
	migrationCount: number;
}>;

export type SupabaseRepositoryFacts = Readonly<{
	root: string;
	realRoot: string;
	id: string;
	mode: 'auto' | 'off';
	/** The app directory, relative to each worktree, lanes run (`''` for the root). */
	appRelativePath: string;
	worktrees: readonly SupabaseWorktreeFacts[];
	checkedAt: number;
}>;

export type SupabaseRepositoryScanInput = Readonly<{
	/** Tracked repository roots (SupabaseLanePort.repositories()). */
	repositories: readonly string[];
	worktrees: readonly LaneWorktree[];
	lanes: readonly Lane[];
	/** App directories stacks were started for (records), in addition to lanes'. */
	appPaths?: readonly Readonly<{ worktreePath: string; appPath: string }>[];
	policy: Pick<
		SupabasePolicy,
		'repositories' | 'appEnv' | 'allowUnverifiedPatch'
	>;
	featureEnabled: boolean;
	platformSupported: boolean;
	/** The worktree CLI resolver; called only for worktrees with a project. */
	resolveCli?: (
		input: SupabaseCliResolveInput
	) => Promise<SupabaseCliResolution>;
	now: number;
}>;

/**
 * Filesystem and probe seams, defaulting to the real ones.
 */
export type SupabaseRepositoryScanDeps = Readonly<{
	detect?: typeof detectSupabaseProject;
	readHead?: typeof readGitHead;
	fs?: StaticFileSystem;
	/** Counts `supabase/migrations/*.sql` under a project root. */
	countMigrations?: (projectRoot: string) => Promise<number>;
}>;

async function countMigrationFiles(projectRoot: string): Promise<number> {
	let count = 0;
	let seen = 0;
	try {
		for await (const entry of await opendir(
			path.join(projectRoot, 'supabase', 'migrations')
		)) {
			seen += 1;
			if (seen > MAX_MIGRATION_ENTRIES) break;
			if (entry.isFile() && entry.name.endsWith('.sql')) count += 1;
		}
	} catch {
		// No migrations directory.
	}
	return count;
}

async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				const item = items[index] as T;
				results[index] = await run(item);
			}
		}
	);
	await Promise.all(workers);
	return results;
}

/** The app directory, relative to its worktree, the repository's lanes run. */
function appRelativePathFor(
	worktrees: readonly LaneWorktree[],
	lanes: readonly Lane[],
	appPaths: SupabaseRepositoryScanInput['appPaths']
): string {
	const paths = new Set(worktrees.map((worktree) => worktree.path));
	const candidates = [
		...[...lanes]
			.filter((lane) => paths.has(lane.worktreePath))
			.sort((left, right) => right.startedAt - left.startedAt)
			.map((lane) => ({
				worktreePath: lane.worktreePath,
				appPath: lane.appPath ?? lane.worktreePath,
			})),
		...(appPaths ?? []).filter((entry) => paths.has(entry.worktreePath)),
	];
	for (const candidate of candidates) {
		const relative = path.relative(candidate.worktreePath, candidate.appPath);
		if (
			!relative.startsWith('..') &&
			!path.isAbsolute(relative) &&
			isPathWithin(candidate.worktreePath, candidate.appPath)
		) {
			return relative;
		}
	}
	return '';
}

/**
 * Gathers the facts for every tracked repository: realpaths and ids, each
 * worktree's project detection, HEAD, expected stack id and CLI resolution,
 * read with bounded static reads and at most 8 worktrees at a time. Nothing
 * is read for a repository that is off.
 */
export async function inspectSupabaseRepositories(
	input: SupabaseRepositoryScanInput,
	deps: SupabaseRepositoryScanDeps = {}
): Promise<SupabaseRepositoryFacts[]> {
	const detect = deps.detect ?? detectSupabaseProject;
	const readHead = deps.readHead ?? readGitHead;
	const fs = deps.fs ?? nodeStaticFileSystem;
	const countMigrations = deps.countMigrations ?? countMigrationFiles;
	const mappedNames = input.policy.appEnv.map((entry) => entry.name);
	const roots = [...new Set(input.repositories)].slice(0, MAX_REPOSITORIES);
	return Promise.all(
		roots.map(async (root): Promise<SupabaseRepositoryFacts> => {
			const realRoot = (await fs.realpath(root)) ?? root;
			const id = supabaseRepositoryId(realRoot);
			const mode =
				input.policy.repositories.find((entry) => entry.id === id)?.mode ??
				'auto';
			const worktrees = input.worktrees
				.filter((worktree) => worktree.repositoryRoot === root)
				.slice(0, MAX_WORKTREES);
			const relative = appRelativePathFor(
				worktrees,
				input.lanes,
				input.appPaths
			);
			const pairs = worktrees.flatMap((worktree) => {
				const lanePaths = input.lanes
					.filter((lane) => lane.worktreePath === worktree.path)
					.map((lane) => lane.appPath ?? lane.worktreePath);
				const knownPaths = (input.appPaths ?? [])
					.filter(
						(entry) =>
							entry.worktreePath === worktree.path &&
							isPathWithin(worktree.path, entry.appPath)
					)
					.map((entry) => entry.appPath);
				const appPaths = [
					...new Set([
						...lanePaths,
						...knownPaths,
						relative === ''
							? worktree.path
							: path.join(worktree.path, relative),
					]),
				];
				return appPaths.map((appPath) => ({ worktree, appPath }));
			});
			const facts = await mapLimited(
				pairs.slice(0, MAX_WORKTREES),
				INSPECT_CONCURRENCY,
				async ({ worktree, appPath }): Promise<SupabaseWorktreeFacts> => {
					const realWorktree = await fs.realpath(worktree.path);
					const base = {
						worktreePath: worktree.path,
						realWorktreePath: realWorktree ?? worktree.path,
						repositoryRoot: root,
						repositoryId: id,
						branch: worktree.branch,
						exists: realWorktree !== undefined,
					};
					if (!input.featureEnabled || mode === 'off') {
						return {
							...base,
							appPath,
							mode: supabaseWorktreeMode({
								featureEnabled: input.featureEnabled,
								platformSupported: input.platformSupported,
								repositoryMode: mode,
								detection: undefined,
								cli: undefined,
							}),
							bucketsConfigured: false,
							migrationCount: 0,
						};
					}
					// An app directory missing from this worktree falls back to its root.
					const appKind = await fs.kind(appPath);
					const from = appKind === 'directory' ? appPath : worktree.path;
					const [detection, head] = await Promise.all([
						detect({ appPath: from, worktreePath: worktree.path, mappedNames }),
						readHead(worktree.path),
					]);
					let cli: SupabaseCliResolution | undefined;
					let bucketsConfigured = false;
					let migrationCount = 0;
					let expected: string | undefined;
					if (detection.status === 'found') {
						bucketsConfigured = detection.bucketsConfigured === true;
						[cli, migrationCount] = await Promise.all([
							resolveCliSafely(input, detection, realRoot),
							countMigrations(detection.projectRoot),
						]);
						if (head.status === 'ok') {
							try {
								expected = expectedStackId({
									projectRoot: detection.projectRoot,
									branchContext: head.branchContext,
								});
							} catch {
								expected = undefined;
							}
						}
					}
					return {
						...base,
						appPath: from,
						detection,
						head,
						...(expected === undefined ? {} : { expectedStackId: expected }),
						...(cli === undefined ? {} : { cli }),
						mode: supabaseWorktreeMode({
							featureEnabled: input.featureEnabled,
							platformSupported: input.platformSupported,
							repositoryMode: mode,
							detection,
							cli,
						}),
						bucketsConfigured,
						migrationCount,
					};
				}
			);
			return {
				root,
				realRoot,
				id,
				mode,
				appRelativePath: relative,
				worktrees: facts,
				checkedAt: input.now,
			};
		})
	);
}

/** Resolves the worktree CLI; a resolver that throws reads as a failed probe. */
async function resolveCliSafely(
	input: SupabaseRepositoryScanInput,
	detection: Extract<SupabaseProjectDetection, { status: 'found' }>,
	realRoot: string
): Promise<SupabaseCliResolution | undefined> {
	if (!input.resolveCli) return undefined;
	try {
		return await input.resolveCli({
			appPath: detection.appRoot,
			projectRoot: detection.projectRoot,
			worktreeRoot: detection.worktreeRoot,
			...(realRoot !== detection.worktreeRoot
				? { mainCheckoutRoot: realRoot }
				: {}),
			allowUnverifiedPatch: input.policy.allowUnverifiedPatch,
		});
	} catch {
		return {
			ok: false,
			reason: 'version-probe-failed',
			message: 'the Supabase CLI could not be checked',
			recovery: 'Reinstall dependencies in this worktree, then retry.',
			path: undefined,
		};
	}
}

/** The facts for a lane: its worktree with its own app directory. */
export function supabaseFactsForLane(
	lane: Pick<Lane, 'worktreePath' | 'appPath'>,
	repositories: readonly SupabaseRepositoryFacts[]
): SupabaseWorktreeFacts | undefined {
	const appPath = lane.appPath ?? lane.worktreePath;
	const worktrees = repositories.flatMap((repository) => repository.worktrees);
	return (
		worktrees.find(
			(facts) =>
				facts.worktreePath === lane.worktreePath && facts.appPath === appPath
		) ??
		worktrees.find(
			(facts) =>
				facts.worktreePath === lane.worktreePath &&
				facts.detection?.status === 'found' &&
				isPathWithin(facts.detection.appRoot, appPath)
		) ??
		worktrees.find((facts) => facts.worktreePath === lane.worktreePath)
	);
}

// ---------------------------------------------------------------------------
// Summaries

type RepositoryCheck = SupabaseRepositorySummary['checks'][number];
type Found = Extract<SupabaseProjectDetection, { status: 'found' }>;

function text(value: string): string {
	return sanitizeSupabaseDisplayText(value, MAX_TEXT);
}

/**
 * Line text main builds from scan facts (names, keys, ports): controls and
 * bidirectional overrides become spaces, and the elided value stays `…`.
 */
function lineText(value: string): string {
	let output = '';
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		const hidden =
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0x200e ||
			code === 0x200f;
		output += hidden ? ' ' : character;
	}
	const characters = Array.from(output.trim());
	return characters.length <= MAX_TEXT
		? output.trim()
		: `${characters.slice(0, MAX_TEXT - 1).join('')}…`;
}

/** `a, b and 3 more`. */
function names(values: readonly string[], max = 3): string {
	const unique = [...new Set(values)];
	const shown = unique.slice(0, max);
	const rest = unique.length - shown.length;
	if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
	if (shown.length <= 1) return shown[0] ?? '';
	return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** A file inside a worktree, relative to it. */
function relativeFile(worktreeRoot: string, file: string): string {
	const relative = path.relative(worktreeRoot, file);
	return relative.length > 0 && !relative.startsWith('..') ? relative : file;
}

function runnerLabel(detection: Found | undefined): string | undefined {
	return detection?.runner ? `${detection.runner.command} supabase` : undefined;
}

function cliGate(
	resolution: SupabaseCliResolution | undefined
): 'verified' | 'compatible' | 'unsupported' | 'missing' | undefined {
	if (resolution === undefined) return undefined;
	return resolution.ok ? resolution.cli.dialect.gate : 'missing';
}

function checkLines(
	entries: readonly Readonly<{ file: string; line: number; text: string }>[]
): RepositoryCheck['lines'] {
	return entries.slice(0, MAX_LINES).map((entry) => ({
		file: sanitizeSupabaseDisplayText(entry.file, 1_024) || 'a file',
		line: Math.max(1, Math.floor(entry.line)),
		text: lineText(entry.text) || '…',
	}));
}

/**
 * What a stack looks like to a repository summary.
 */
export type SupabaseRepositoryStack = Readonly<{
	id: string;
	state: SupabaseStackSummary['state'];
	repositoryId?: string | undefined;
	/** The checkout root it belongs to, when known (main only). */
	worktreePath?: string | undefined;
	branchContext?: string | undefined;
	flags: readonly SupabaseStackFlag[];
}>;

/**
 * One repository's summary: the readiness word, per-check status with
 * file:line facts and copy-only fixes, counts and the worktree list with the
 * stack each worktree's HEAD would use.
 */
export function summarizeSupabaseRepository(
	facts: SupabaseRepositoryFacts,
	context: Readonly<{
		platform: SupabaseState['availability']['platform'];
		featureEnabled: boolean;
		stacks: readonly SupabaseRepositoryStack[];
		pathLabel: (absolutePath: string) => string;
	}>
): SupabaseRepositorySummary {
	const label = (value: string) =>
		sanitizeSupabaseDisplayText(context.pathLabel(value), 1_024) || value;
	const byWorktree = new Map<string, SupabaseWorktreeFacts>();
	for (const worktree of facts.worktrees) {
		const known = byWorktree.get(worktree.worktreePath);
		// Prefer the entry that found a project for the worktree's row.
		if (!known || (known.detection?.status !== 'found' && worktree.detection)) {
			byWorktree.set(worktree.worktreePath, worktree);
		}
	}
	const rows = [...byWorktree.values()];
	const found = facts.worktrees.filter(
		(worktree): worktree is SupabaseWorktreeFacts & { detection: Found } =>
			worktree.detection?.status === 'found'
	);
	const representative =
		found.find((worktree) => worktree.realWorktreePath === facts.realRoot) ??
		found[0];
	const resolution = representative?.cli;
	const runner = runnerLabel(representative?.detection);
	const repositoryStacks = context.stacks.filter(
		(stack) => stack.repositoryId === facts.id
	);
	const stackIds = new Set(context.stacks.map((stack) => stack.id));
	const off = facts.mode === 'off' || !context.featureEnabled;

	const checks: RepositoryCheck[] = [
		context.platform.supported
			? {
					id: 'platform',
					status: 'ready',
					summary: text(supabasePlatformLabel(context.platform)),
				}
			: {
					id: 'platform',
					status: 'needs-fix',
					summary: text(
						`${supabasePlatformLabel(context.platform)}: ${context.platform.reasonText ?? 'native Supabase needs Apple silicon and macOS 14 or later'}`
					),
				},
	];
	if (!off && found.length === 0) {
		checks.push({
			id: 'project',
			status: 'optional',
			summary: 'No supabase/config.toml in this repository.',
		});
	} else if (!off && representative) {
		checks.push(
			{
				id: 'project',
				status: 'ready',
				summary: text(
					`Found ${relativeFile(representative.detection.worktreeRoot, representative.detection.configPath)}`
				),
			},
			stackFlagCheck(found),
			configJsonCheck(found),
			pinnedPortsCheck(found),
			cliCheck(resolution, runner),
			appEnvCheck(found),
			recommendedCheck(found)
		);
	}

	const managed = rows.filter((row) => row.mode.value === 'managed').length;
	const observed = rows.filter((row) => row.mode.value === 'observed').length;
	const readiness: SupabaseRepositorySummary['readiness'] = off
		? 'off'
		: found.length === 0
			? 'no-supabase'
			: checks.some((check) => check.status === 'checking')
				? 'checking'
				: managed === 0
					? 'observed'
					: checks.some((check) => check.status === 'needs-fix')
						? 'needs-fix'
						: 'ready';

	const worktreeRows = rows.slice(0, MAX_WORKTREES).map((row) => {
		const expected =
			row.expectedStackId !== undefined && stackIds.has(row.expectedStackId)
				? row.expectedStackId
				: undefined;
		const stale =
			expected === undefined
				? repositoryStacks.find(
						(stack) =>
							stack.worktreePath === row.worktreePath &&
							stack.flags.includes('stale-branch')
					)
				: undefined;
		const was = stale ? supabaseBranchLabel(stale.branchContext) : undefined;
		const reasonText = row.mode.reasonText ?? (was ? `was ${was}` : undefined);
		return {
			pathLabel: label(row.worktreePath),
			branch: text(row.branch) || 'unknown branch',
			mode: row.mode.value,
			...(reasonText === undefined ? {} : { reasonText: text(reasonText) }),
			...(expected === undefined ? {} : { stackId: expected }),
		};
	});

	const summary: SupabaseRepositorySummary = {
		id: facts.id,
		label: label(facts.root),
		...(facts.appRelativePath === ''
			? {}
			: { appPathLabel: text(facts.appRelativePath) || facts.appRelativePath }),
		readiness,
		mode: facts.mode,
		counts: {
			worktrees: rows.length,
			managed,
			observed,
			running: repositoryStacks.filter((stack) => isSupabaseStackRunning(stack))
				.length,
		},
		cli: {
			...(resolution?.ok ? { version: text(resolution.cli.version) } : {}),
			...(cliGate(resolution) === undefined
				? {}
				: { gate: cliGate(resolution) }),
			...(runner === undefined ? {} : { runnerLabel: text(runner) }),
		},
		checks: checks.slice(0, 16),
		worktrees: worktreeRows,
		checkedAt: facts.checkedAt,
	};
	return supabaseRepositorySummarySchema.parse(summary);
}

function stackFlagCheck(
	found: readonly (SupabaseWorktreeFacts & { detection: Found })[]
): RepositoryCheck {
	const missing = found.filter(
		(worktree) => !worktree.detection.stackFlag.optedIn
	);
	if (missing.length === 0) {
		return {
			id: 'stack-flag',
			status: 'ready',
			summary: 'Set in every worktree.',
		};
	}
	const lines = missing.flatMap((worktree) => {
		const flag = worktree.detection.stackFlag;
		if (flag.optedIn || flag.line === undefined) return [];
		const value =
			flag.reason === 'false'
				? 'stack = false'
				: flag.reason === 'env-reference'
					? 'stack = env(…)'
					: 'stack = …';
		return [
			{
				file: relativeFile(
					worktree.detection.worktreeRoot,
					worktree.detection.configPath
				),
				line: flag.line,
				text: value,
			},
		];
	});
	const allMissing = missing.every(
		(worktree) =>
			!worktree.detection.stackFlag.optedIn &&
			worktree.detection.stackFlag.reason === 'missing'
	);
	return {
		id: 'stack-flag',
		status: 'needs-fix',
		summary: text(
			`${allMissing ? 'Missing in' : 'Not set to true in'} ${names(missing.map((worktree) => worktree.branch))}.`
		),
		...(lines.length > 0 ? { lines: checkLines(lines) } : {}),
		fix: {
			text: 'Add it to supabase/config.toml:',
			snippet: STACK_FLAG_SNIPPET,
		},
	};
}

function configJsonCheck(
	found: readonly (SupabaseWorktreeFacts & { detection: Found })[]
): RepositoryCheck {
	const conflicting = found.filter(
		(worktree) => worktree.detection.configConflict
	);
	if (conflicting.length === 0) {
		return {
			id: 'config-json',
			status: 'ready',
			summary: 'None (no conflicting supabase/config.json)',
		};
	}
	return {
		id: 'config-json',
		status: 'needs-fix',
		summary: text(
			`supabase/config.json exists in ${names(conflicting.map((worktree) => worktree.branch))}; the CLI would read it instead of config.toml.`
		),
		fix: {
			text: 'Remove supabase/config.json and keep the settings in supabase/config.toml.',
		},
	};
}

function pinnedPortsCheck(
	found: readonly (SupabaseWorktreeFacts & { detection: Found })[]
): RepositoryCheck {
	const pinning = found.filter(
		(worktree) => worktree.detection.pinnedListeners.length > 0
	);
	if (pinning.length === 0) {
		return {
			id: 'pinned-ports',
			status: 'ready',
			summary: 'No pinned listener ports',
		};
	}
	// One set of lines per distinct file and line, from any worktree.
	const seen = new Set<string>();
	const lines = pinning.flatMap((worktree) =>
		worktree.detection.pinnedListeners.flatMap((listener) => {
			const file = relativeFile(worktree.detection.worktreeRoot, listener.file);
			const key = `${file}:${listener.line}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [
				{
					file,
					line: listener.line,
					// Dotenv values are never shown, ports in config.toml are.
					text:
						listener.source === 'config'
							? `${listener.key} = ${listener.port ?? '…'}`
							: `${listener.key}=…`,
				},
			];
		})
	);
	return {
		id: 'pinned-ports',
		status: 'needs-fix',
		summary: text(
			`${names(pinning.map((worktree) => worktree.branch))} ${pinning.length === 1 ? 'pins' : 'pin'} listener ports.`
		),
		lines: checkLines(lines),
		fix: {
			text: 'Delete these lines. Only one stack at a time can use a pinned port; the others fail to start.',
		},
	};
}

function cliCheck(
	resolution: SupabaseCliResolution | undefined,
	runner: string | undefined
): RepositoryCheck {
	if (resolution === undefined) {
		return {
			id: 'cli',
			status: 'checking',
			summary: 'Checking the Supabase CLI…',
		};
	}
	if (!resolution.ok) {
		return {
			id: 'cli',
			status: 'needs-fix',
			summary: text(resolution.message),
			fix: { text: text(resolution.recovery) || 'Reinstall dependencies.' },
		};
	}
	const { version, dialect } = resolution.cli;
	if (dialect.gate === 'verified') {
		return {
			id: 'cli',
			status: 'ready',
			summary: text(`${version} · verified${runner ? ` · ${runner}` : ''}`),
		};
	}
	if (dialect.gate === 'compatible') {
		return {
			id: 'cli',
			status: dialect.manageable ? 'check' : 'needs-fix',
			summary: text(
				dialect.manageable
					? `${version} is an unverified patch of ${dialect.verifiedVersion}; managed because Settings allows it`
					: `${version} is an unverified patch of ${dialect.verifiedVersion}; RN Devtools only observes it`
			),
			fix: {
				text: text(
					`Pin supabase to ${dialect.verifiedVersion} as an exact devDependency.`
				),
			},
		};
	}
	return {
		id: 'cli',
		status: 'needs-fix',
		summary: text(`${version} isn't verified for RN Devtools`),
		fix: {
			text: 'Pin supabase to a release RN Devtools verified, as an exact devDependency.',
		},
	};
}

function appEnvCheck(
	found: readonly (SupabaseWorktreeFacts & { detection: Found })[]
): RepositoryCheck {
	const seen = new Set<string>();
	const lines = found.flatMap((worktree) =>
		worktree.detection.shadowedAppVariables.flatMap((variable) => {
			const file = relativeFile(worktree.detection.worktreeRoot, variable.file);
			const key = `${file}:${variable.line}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [{ file, line: variable.line, text: `${variable.name}=…` }];
		})
	);
	const [first] = lines;
	if (!first) {
		return {
			id: 'app-env-files',
			status: 'ready',
			summary: 'No app .env file defines a mapped name',
		};
	}
	return {
		id: 'app-env-files',
		status: 'check',
		summary: text(
			lines.length === 1
				? `${first.file}:${first.line} shadows a mapped name`
				: `${lines.length} app .env lines shadow mapped names`
		),
		lines: checkLines(lines),
		fix: {
			text: 'Remove these names from the app .env files; Metro gets them from RN Devtools.',
		},
	};
}

function recommendedCheck(
	found: readonly (SupabaseWorktreeFacts & { detection: Found })[]
): RepositoryCheck {
	const enabled = found.filter(
		(worktree) =>
			worktree.detection.studioEnabled !== false ||
			worktree.detection.analyticsEnabled !== false
	);
	if (enabled.length === 0) {
		return {
			id: 'recommended',
			status: 'ready',
			summary: 'Studio and analytics are disabled in config.toml',
		};
	}
	return {
		id: 'recommended',
		status: 'optional',
		summary: 'Disable Studio and analytics for every worktree',
		fix: { text: 'Add to supabase/config.toml:', snippet: RECOMMENDED_SNIPPET },
	};
}
