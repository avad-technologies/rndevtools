import path from 'node:path';
import {
	isPathWithin,
	nodeStaticFileSystem,
	STATIC_READ_LIMIT_BYTES,
	type StaticFileSystem,
} from './bounded-read';
import {
	scanDotenvKeys,
	scanTomlAssignments,
	type TomlAssignment,
} from './static-config';

/**
 * Static, bounded detection of a worktree's Supabase project (DESIGN: when a
 * worktree "actually uses Supabase"). It reads files only between the app
 * directory and the worktree root, never above, never more than the per-file
 * cap, and never evaluates project code. Dotenv values are never returned.
 */

const CONFIG_TOML = path.join('supabase', 'config.toml');
const CONFIG_JSON = path.join('supabase', 'config.json');

/**
 * `config.toml` keys that pin a public listener port at CLI 2.121.0
 * (stack-config.ts endpoint settings, db-config.toml-read.ts shadow_port, and
 * the deprecated `[inbucket]` alias of `[local_smtp]`).
 */
const PINNED_LISTENER_KEYS = new Set([
	'api.port',
	'db.port',
	'db.shadow_port',
	'db.pooler.port',
	'studio.port',
	'inbucket.port',
	'inbucket.smtp_port',
	'inbucket.pop3_port',
	'local_smtp.port',
	'local_smtp.smtp_port',
	'local_smtp.pop3_port',
	'analytics.port',
	'edge_runtime.inspector_port',
]);

const PORT_OVERRIDE = /^SUPABASE_[A-Z0-9_]+_PORT$/;
/** `SUPABASE_AUTH_*` ports name remote servers (the SMTP relay), not listeners. */
const NON_LISTENER_PORT_PREFIX = 'SUPABASE_AUTH_';

/**
 * Dotenv files the CLI reads for `SUPABASE_*` overrides with SUPABASE_ENV
 * unset (development), in both `supabase/` and the project root
 * (project-environment.ts candidateDotenvFilenames).
 */
const SUPABASE_DOTENV_FILES = [
	'.env.development.local',
	'.env.local',
	'.env.development',
	'.env',
] as const;

/** App-root files Expo 57 dev bundles merge over Metro's environment. */
const EXPO_DOTENV_FILES = [
	'.env',
	'.env.local',
	'.env.development',
	'.env.development.local',
] as const;

const LOCKFILE_RUNNERS = [
	['pnpm-lock.yaml', 'pnpm exec'],
	['package-lock.json', 'npx'],
	['yarn.lock', 'yarn'],
	['bun.lockb', 'bunx'],
	['bun.lock', 'bunx'],
] as const;

const APP_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_REFERENCE = /^env\(.*\)$/s;
const MAX_MAPPED_NAMES = 32;
const MAX_FINDINGS = 256;
const MAX_PROJECT_ID_LENGTH = 256;

type StackFlag =
	| { optedIn: true; line: number }
	| {
			optedIn: false;
			reason:
				| 'missing'
				| 'false'
				| 'not-boolean'
				| 'env-reference'
				| 'duplicate'
				| 'unreadable-config';
			line?: number;
	  };

/**
 * A line that pins a listener port; delete it to get automatic ports.
 */
export type PinnedListener = {
	source: 'config' | 'dotenv';
	file: string;
	line: number;
	/** Dotted config key (`db.pooler.port`) or variable (`SUPABASE_API_PORT`). */
	key: string;
	port?: number;
};

/**
 * An app dotenv line that would override a mapped Metro variable.
 */
type ShadowedAppVariable = { name: string; file: string; line: number };

type StaticFileIssue = {
	file: string;
	issue: 'too-large' | 'not-a-file' | 'unreadable';
};

type SupabaseRunnerHint = {
	command: (typeof LOCKFILE_RUNNERS)[number][1];
	lockfile: string;
};

export type SupabaseProjectDetection =
	| {
			status: 'none';
			reason:
				| 'invalid-path'
				| 'missing-path'
				| 'app-outside-worktree'
				| 'no-config'
				| 'unreadable';
	  }
	| {
			status: 'found';
			/** Realpaths of the inputs. */
			appRoot: string;
			worktreeRoot: string;
			/** Nearest directory at or above the app holding supabase/config.toml. */
			projectRoot: string;
			configPath: string;
			stackFlag: StackFlag;
			/** `supabase/config.json` exists; CLI routing would prefer it. */
			configConflict: boolean;
			/** config.toml declares storage buckets (`[storage.buckets.<name>]`). */
			bucketsConfigured?: true;
			projectId?: string;
			studioEnabled?: boolean;
			analyticsEnabled?: boolean;
			s3ProtocolEnabled?: boolean;
			pinnedListeners: PinnedListener[];
			shadowedAppVariables: ShadowedAppVariable[];
			runner?: SupabaseRunnerHint;
			fileIssues: StaticFileIssue[];
	  };

type ReadResult = Awaited<ReturnType<StaticFileSystem['readText']>>;

type DetectionInput = {
	/** The app directory a lane runs (where app.json lives). */
	appPath: string;
	/** The git worktree root that contains the app directory. */
	worktreePath: string;
	/** Metro variable names the desktop would inject, e.g. from the preset. */
	mappedNames?: readonly string[];
};

type DetectionOptions = { fs?: StaticFileSystem; maxFileBytes?: number };

/** `start`, its parents, up to and including `stop`; never above `stop`. */
function directoriesUpTo(start: string, stop: string): string[] {
	const directories = [start];
	let current = start;
	while (current !== stop) {
		const parent = path.dirname(current);
		if (parent === current || !isPathWithin(stop, parent)) break;
		directories.push(parent);
		current = parent;
	}
	return directories;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((segment, index) => segment === right[index])
	);
}

function lastAssignment(
	assignments: readonly TomlAssignment[],
	keyPath: readonly string[]
): TomlAssignment | undefined {
	return assignments.findLast((entry) => samePath(entry.path, keyPath));
}

function booleanAt(
	assignments: readonly TomlAssignment[],
	keyPath: readonly string[]
): boolean | undefined {
	const value = lastAssignment(assignments, keyPath)?.value;
	return value?.kind === 'boolean' ? value.value : undefined;
}

function stackFlagFrom(assignments: readonly TomlAssignment[]): StackFlag {
	const matches = assignments.filter((entry) =>
		samePath(entry.path, ['experimental', 'stack'])
	);
	const [first, second] = matches;
	if (!first) return { optedIn: false, reason: 'missing' };
	// TOML forbids redefinition; the CLI would refuse this config.
	if (second) return { optedIn: false, reason: 'duplicate', line: second.line };
	const { value, line } = first;
	if (value.kind === 'boolean') {
		return value.value
			? { optedIn: true, line }
			: { optedIn: false, reason: 'false', line };
	}
	if (value.kind === 'string' && ENV_REFERENCE.test(value.value.trim())) {
		return { optedIn: false, reason: 'env-reference', line };
	}
	return { optedIn: false, reason: 'not-boolean', line };
}

function projectIdFrom(
	assignments: readonly TomlAssignment[]
): string | undefined {
	const value = lastAssignment(assignments, ['project_id'])?.value;
	if (value?.kind !== 'string') return undefined;
	const projectId = value.value.replace(/\p{Cc}/gu, '').trim();
	return projectId && projectId.length <= MAX_PROJECT_ID_LENGTH
		? projectId
		: undefined;
}

function pinnedFromConfig(
	assignments: readonly TomlAssignment[],
	file: string
): PinnedListener[] {
	return assignments
		.filter((entry) => PINNED_LISTENER_KEYS.has(entry.path.join('.')))
		.map((entry) => ({
			source: 'config' as const,
			file,
			line: entry.line,
			key: entry.path.join('.'),
			...(entry.value.kind === 'integer' &&
			entry.value.value >= 1 &&
			entry.value.value <= 65_535
				? { port: entry.value.value }
				: {}),
		}));
}

function mappedNameSet(names: readonly string[] | undefined): Set<string> {
	return new Set(
		(names ?? [])
			.filter((name) => APP_VARIABLE_NAME.test(name))
			.slice(0, MAX_MAPPED_NAMES)
	);
}

async function findRunner(
	fs: StaticFileSystem,
	directories: readonly string[]
): Promise<SupabaseRunnerHint | undefined> {
	const kinds = await Promise.all(
		directories.map((directory) =>
			Promise.all(
				LOCKFILE_RUNNERS.map(([lockfile]) =>
					fs.kind(path.join(directory, lockfile))
				)
			)
		)
	);
	for (const [index, directory] of directories.entries()) {
		const found = kinds[index]?.indexOf('file') ?? -1;
		const runner = LOCKFILE_RUNNERS[found];
		if (runner) {
			return { command: runner[1], lockfile: path.join(directory, runner[0]) };
		}
	}
	return undefined;
}

async function detect(
	input: DetectionInput,
	options: DetectionOptions
): Promise<SupabaseProjectDetection> {
	const fs = options.fs ?? nodeStaticFileSystem;
	const limit = options.maxFileBytes ?? STATIC_READ_LIMIT_BYTES;
	if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.worktreePath)) {
		return { status: 'none', reason: 'invalid-path' };
	}
	const [appRoot, worktreeRoot] = await Promise.all([
		fs.realpath(input.appPath),
		fs.realpath(input.worktreePath),
	]);
	if (!appRoot || !worktreeRoot)
		return { status: 'none', reason: 'missing-path' };
	if (!isPathWithin(worktreeRoot, appRoot)) {
		return { status: 'none', reason: 'app-outside-worktree' };
	}

	const directories = directoriesUpTo(appRoot, worktreeRoot);
	const configKinds = await Promise.all(
		directories.map((directory) => fs.kind(path.join(directory, CONFIG_TOML)))
	);
	// Like the CLI's upward search, any non-directory entry counts as found.
	const projectRoot =
		directories[
			configKinds.findIndex(
				(kind) => kind !== 'missing' && kind !== 'directory'
			)
		];
	if (!projectRoot) return { status: 'none', reason: 'no-config' };

	const reads = new Map<string, Promise<ReadResult>>();
	const read = (file: string): Promise<ReadResult> => {
		let pending = reads.get(file);
		if (!pending) {
			pending = fs.readText(file, limit);
			reads.set(file, pending);
		}
		return pending;
	};

	const configPath = path.join(projectRoot, CONFIG_TOML);
	const supabaseDotenvFiles = [
		path.join(projectRoot, 'supabase'),
		projectRoot,
	].flatMap((directory) =>
		SUPABASE_DOTENV_FILES.map((file) => path.join(directory, file))
	);
	const names = mappedNameSet(input.mappedNames);
	const appDotenvFiles =
		names.size > 0
			? EXPO_DOTENV_FILES.map((file) => path.join(appRoot, file))
			: [];
	const [config, conflictKind, supabaseDotenv, appDotenv, runner] =
		await Promise.all([
			read(configPath),
			fs.kind(path.join(projectRoot, CONFIG_JSON)),
			Promise.all(supabaseDotenvFiles.map(read)),
			Promise.all(appDotenvFiles.map(read)),
			findRunner(fs, directories),
		]);

	const assignments =
		config.status === 'ok' ? scanTomlAssignments(config.text) : undefined;
	const pinnedListeners: PinnedListener[] = assignments
		? pinnedFromConfig(assignments, configPath)
		: [];
	for (const [index, result] of supabaseDotenv.entries()) {
		const file = supabaseDotenvFiles[index];
		if (!file || result.status !== 'ok') continue;
		for (const entry of scanDotenvKeys(result.text)) {
			if (
				!PORT_OVERRIDE.test(entry.key) ||
				entry.key.startsWith(NON_LISTENER_PORT_PREFIX)
			) {
				continue;
			}
			pinnedListeners.push({
				source: 'dotenv',
				file,
				line: entry.line,
				key: entry.key,
				...(entry.integer !== undefined &&
				entry.integer >= 1 &&
				entry.integer <= 65_535
					? { port: entry.integer }
					: {}),
			});
		}
	}
	const shadowedAppVariables: ShadowedAppVariable[] = [];
	for (const [index, result] of appDotenv.entries()) {
		const file = appDotenvFiles[index];
		if (!file || result.status !== 'ok') continue;
		for (const entry of scanDotenvKeys(result.text)) {
			if (names.has(entry.key)) {
				shadowedAppVariables.push({ name: entry.key, file, line: entry.line });
			}
		}
	}

	const issues = new Map<string, StaticFileIssue['issue']>();
	for (const [file, pending] of reads) {
		const result = await pending;
		if (result.status === 'too-large') issues.set(file, 'too-large');
		else if (result.status === 'not-a-file') issues.set(file, 'not-a-file');
		else if (result.status === 'error') issues.set(file, 'unreadable');
	}

	const projectId = assignments ? projectIdFrom(assignments) : undefined;
	const studioEnabled = assignments
		? booleanAt(assignments, ['studio', 'enabled'])
		: undefined;
	const analyticsEnabled = assignments
		? booleanAt(assignments, ['analytics', 'enabled'])
		: undefined;
	const s3ProtocolEnabled = assignments
		? booleanAt(assignments, ['storage', 's3_protocol', 'enabled'])
		: undefined;
	const bucketsConfigured = assignments?.some(
		(entry) => entry.path[0] === 'storage' && entry.path[1] === 'buckets'
	);
	return {
		status: 'found',
		appRoot,
		worktreeRoot,
		projectRoot,
		configPath,
		stackFlag: assignments
			? stackFlagFrom(assignments)
			: { optedIn: false, reason: 'unreadable-config' },
		configConflict: conflictKind !== 'missing',
		...(bucketsConfigured ? { bucketsConfigured } : {}),
		...(projectId !== undefined ? { projectId } : {}),
		...(studioEnabled !== undefined ? { studioEnabled } : {}),
		...(analyticsEnabled !== undefined ? { analyticsEnabled } : {}),
		...(s3ProtocolEnabled !== undefined ? { s3ProtocolEnabled } : {}),
		pinnedListeners: pinnedListeners.slice(0, MAX_FINDINGS),
		shadowedAppVariables: shadowedAppVariables.slice(0, MAX_FINDINGS),
		...(runner ? { runner } : {}),
		fileIssues: [...issues].map(([file, issue]) => ({ file, issue })),
	};
}

/**
 * Finds the Supabase project an app in a worktree would use: the nearest
 * `supabase/config.toml` at or above `appPath`, stopping at `worktreePath`.
 * Reports the `[experimental] stack` opt-in (a TOML boolean only), a
 * `config.json` conflict, pinned listener ports with file and line, app
 * dotenv lines that would shadow mapped Metro variables, and the package
 * runner implied by the nearest lockfile. Never throws.
 */
export async function detectSupabaseProject(
	input: DetectionInput,
	options: DetectionOptions = {}
): Promise<SupabaseProjectDetection> {
	try {
		return await detect(input, options);
	} catch {
		return { status: 'none', reason: 'unreadable' };
	}
}
