import path from 'node:path';
import { nodeStaticFileSystem, type StaticFileSystem } from './bounded-read';

/**
 * Reads a worktree's HEAD the way the Supabase CLI's stack identity does
 * (packages/stack/src/identity/GitBranchContext.ts at v2.121.0), without
 * running git: a `.git` directory, or a `.git` file naming the worktree's
 * private gitdir, then `HEAD` inside it.
 */

const GIT_METADATA_LIMIT_BYTES = 4 * 1024;
const FULL_REF = /^refs\/.+$/;
const OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * Files and directories git keeps in a worktree's own gitdir while an
 * operation that rewrites HEAD is in progress, in reporting order.
 */
export const GIT_OPERATION_MARKERS = [
	'rebase-merge',
	'rebase-apply',
	'MERGE_HEAD',
	'CHERRY_PICK_HEAD',
	'REVERT_HEAD',
	'BISECT_LOG',
] as const;

type GitOperationMarker = (typeof GIT_OPERATION_MARKERS)[number];

type GitHeadUnavailableReason =
	| 'missing-worktree'
	| 'no-git'
	| 'not-a-repository'
	| 'invalid-gitdir-file'
	| 'dangling-gitdir'
	| 'unreadable-head'
	| 'invalid-head';

export type GitHead =
	| {
			status: 'ok';
			/** `refs/...` for a symbolic HEAD, `detached` for an object id. */
			branchContext: string;
			/** Realpath of the worktree's own gitdir (holds HEAD and markers). */
			gitDir: string;
			/** Realpath of the shared gitdir; equals `gitDir` for a main checkout. */
			commonDir: string;
			/** The first operation marker found, while git is mid-operation. */
			operation?: GitOperationMarker;
	  }
	| { status: 'unavailable'; reason: GitHeadUnavailableReason };

type Unavailable = Extract<GitHead, { status: 'unavailable' }>;

function unavailable(reason: GitHeadUnavailableReason): Unavailable {
	return { status: 'unavailable', reason };
}

async function exists(fs: StaticFileSystem, target: string): Promise<boolean> {
	return (await fs.kind(target)) !== 'missing';
}

/** A `.git` directory counts only with HEAD, or with both objects and refs. */
async function hasRepositoryMarkers(
	fs: StaticFileSystem,
	gitDir: string
): Promise<boolean> {
	if (await exists(fs, path.join(gitDir, 'HEAD'))) return true;
	return (
		(await exists(fs, path.join(gitDir, 'objects'))) &&
		(await exists(fs, path.join(gitDir, 'refs')))
	);
}

async function resolveGitDir(
	fs: StaticFileSystem,
	worktreeRoot: string
): Promise<string | Unavailable> {
	const entry = path.join(worktreeRoot, '.git');
	const kind = await fs.kind(entry);
	if (kind === 'missing') return unavailable('no-git');
	if (kind === 'directory') {
		const gitDir = await fs.realpath(entry);
		if (!gitDir || !(await hasRepositoryMarkers(fs, gitDir))) {
			return unavailable('not-a-repository');
		}
		return gitDir;
	}
	if (kind !== 'file') return unavailable('invalid-gitdir-file');
	const file = await fs.readText(entry, GIT_METADATA_LIMIT_BYTES);
	if (file.status !== 'ok') return unavailable('invalid-gitdir-file');
	const line = file.text
		.split('\n')
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.toLowerCase().startsWith('gitdir:'));
	const target = line?.slice('gitdir:'.length).trim();
	if (!target) return unavailable('invalid-gitdir-file');
	const gitDir = await fs.realpath(path.resolve(worktreeRoot, target));
	return gitDir ?? unavailable('dangling-gitdir');
}

async function readBranchContext(
	fs: StaticFileSystem,
	gitDir: string
): Promise<string | Unavailable> {
	const file = await fs.readText(
		path.join(gitDir, 'HEAD'),
		GIT_METADATA_LIMIT_BYTES
	);
	if (file.status === 'too-large') return unavailable('invalid-head');
	if (file.status !== 'ok') return unavailable('unreadable-head');
	const head = file.text.trim();
	if (head.length === 0) return unavailable('invalid-head');
	if (head.startsWith('ref:')) {
		const ref = head.slice('ref:'.length).trim();
		return FULL_REF.test(ref) ? ref : unavailable('invalid-head');
	}
	return OBJECT_ID.test(head) ? 'detached' : unavailable('invalid-head');
}

async function readCommonDir(
	fs: StaticFileSystem,
	gitDir: string
): Promise<string> {
	const file = await fs.readText(
		path.join(gitDir, 'commondir'),
		GIT_METADATA_LIMIT_BYTES
	);
	const target = file.status === 'ok' ? file.text.trim() : '';
	if (!target) return gitDir;
	return (await fs.realpath(path.resolve(gitDir, target))) ?? gitDir;
}

async function findOperation(
	fs: StaticFileSystem,
	gitDir: string
): Promise<GitOperationMarker | undefined> {
	const present = await Promise.all(
		GIT_OPERATION_MARKERS.map((marker) => exists(fs, path.join(gitDir, marker)))
	);
	return GIT_OPERATION_MARKERS.find((_marker, index) => present[index]);
}

/**
 * Reads `<worktreePath>/.git` and the HEAD it leads to. Paths are canonical
 * (realpath) because the stack identity hashes the canonical project root.
 * Never throws; a broken or missing repository is a typed `unavailable`.
 */
export async function readGitHead(
	worktreePath: string,
	options: { fs?: StaticFileSystem } = {}
): Promise<GitHead> {
	const fs = options.fs ?? nodeStaticFileSystem;
	try {
		if (!path.isAbsolute(worktreePath)) return unavailable('missing-worktree');
		const worktreeRoot = await fs.realpath(worktreePath);
		if (!worktreeRoot) return unavailable('missing-worktree');
		const gitDir = await resolveGitDir(fs, worktreeRoot);
		if (typeof gitDir !== 'string') return gitDir;
		const branchContext = await readBranchContext(fs, gitDir);
		if (typeof branchContext !== 'string') return branchContext;
		const [commonDir, operation] = await Promise.all([
			readCommonDir(fs, gitDir),
			findOperation(fs, gitDir),
		]);
		return {
			status: 'ok',
			branchContext,
			gitDir,
			commonDir,
			...(operation ? { operation } : {}),
		};
	} catch {
		return unavailable('unreadable-head');
	}
}
