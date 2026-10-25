import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeStaticFileSystem } from './bounded-read';
import { GIT_OPERATION_MARKERS, readGitHead } from './git-head';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = `${SHA1}0123456789abcdef01234567`;

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-git-head-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A main checkout written by hand: no git binary involved. */
async function mainCheckout(
	name: string,
	head = 'ref: refs/heads/main\n'
): Promise<string> {
	const checkout = path.join(root, name);
	await mkdir(path.join(checkout, '.git', 'objects'), { recursive: true });
	await mkdir(path.join(checkout, '.git', 'refs', 'heads'), {
		recursive: true,
	});
	await writeFile(path.join(checkout, '.git', 'HEAD'), head);
	return checkout;
}

/** The layout `git worktree add` creates: a gitdir file plus an admin dir. */
async function linkedWorktree(
	checkout: string,
	name: string,
	options: { head?: string; gitdirFile?: (admin: string) => string } = {}
): Promise<{ worktree: string; admin: string }> {
	const admin = path.join(checkout, '.git', 'worktrees', name);
	const worktree = path.join(root, name);
	await mkdir(admin, { recursive: true });
	await mkdir(worktree, { recursive: true });
	await writeFile(
		path.join(admin, 'HEAD'),
		options.head ?? `ref: refs/heads/${name}\n`
	);
	await writeFile(path.join(admin, 'commondir'), '../..\n');
	await writeFile(path.join(admin, 'gitdir'), `${worktree}/.git\n`);
	await writeFile(
		path.join(worktree, '.git'),
		options.gitdirFile?.(admin) ?? `gitdir: ${admin}\n`
	);
	return { worktree, admin };
}

describe('readGitHead', () => {
	it('reads a main checkout with a symbolic HEAD', async () => {
		const checkout = await mainCheckout('repo');
		const gitDir = await realpath(path.join(checkout, '.git'));
		expect(await readGitHead(checkout)).toEqual({
			status: 'ok',
			branchContext: 'refs/heads/main',
			gitDir,
			commonDir: gitDir,
		});
	});

	it('keeps the full ref, including nested branch names', async () => {
		const checkout = await mainCheckout(
			'nested',
			'ref: refs/heads/feature/deploy\n'
		);
		expect(await readGitHead(checkout)).toMatchObject({
			status: 'ok',
			branchContext: 'refs/heads/feature/deploy',
		});
	});

	it.each([
		['a SHA-1 object id', SHA1],
		['a SHA-256 object id', SHA256],
		['an upper-case object id', SHA1.toUpperCase()],
	])('maps %s to detached', async (_label, head) => {
		const checkout = await mainCheckout('detached', `${head}\n`);
		expect(await readGitHead(checkout)).toMatchObject({
			status: 'ok',
			branchContext: 'detached',
		});
	});

	it('follows a linked worktree gitdir file written as an absolute path', async () => {
		const checkout = await mainCheckout('repo');
		const { worktree, admin } = await linkedWorktree(checkout, 'wt-c', {
			head: 'ref: refs/heads/feature-c\n',
		});
		expect(await readGitHead(worktree)).toEqual({
			status: 'ok',
			branchContext: 'refs/heads/feature-c',
			gitDir: await realpath(admin),
			commonDir: await realpath(path.join(checkout, '.git')),
		});
	});

	it('resolves a relative gitdir against the worktree, in any case and CRLF', async () => {
		const checkout = await mainCheckout('repo');
		const { worktree, admin } = await linkedWorktree(checkout, 'wt-rel', {
			gitdirFile: (target) =>
				`  GitDir: ${path.relative(path.join(root, 'wt-rel'), target)}  \r\n`,
		});
		expect(await readGitHead(worktree)).toMatchObject({
			status: 'ok',
			branchContext: 'refs/heads/wt-rel',
			gitDir: await realpath(admin),
		});
	});

	it('canonicalizes a symlinked worktree path before resolving the gitdir', async () => {
		const checkout = await mainCheckout('repo');
		const { worktree, admin } = await linkedWorktree(checkout, 'wt-link', {
			gitdirFile: () => 'gitdir: ../repo/.git/worktrees/wt-link\n',
		});
		// Resolved against the link's own directory, `..` would miss the repo.
		await mkdir(path.join(root, 'links', 'nested'), { recursive: true });
		const link = path.join(root, 'links', 'nested', 'alias');
		await symlink(worktree, link);
		expect(await readGitHead(link)).toMatchObject({
			status: 'ok',
			gitDir: await realpath(admin),
		});
	});

	it.each(GIT_OPERATION_MARKERS)(
		'reports %s in the worktree gitdir as an operation in progress',
		async (marker) => {
			const checkout = await mainCheckout('repo');
			const { worktree, admin } = await linkedWorktree(checkout, 'wt-busy');
			if (marker.startsWith('rebase-')) {
				await mkdir(path.join(admin, marker));
			} else {
				await writeFile(path.join(admin, marker), `${SHA1}\n`);
			}
			expect(await readGitHead(worktree)).toMatchObject({
				status: 'ok',
				operation: marker,
			});
		}
	);

	it('ignores operation markers that belong to another checkout', async () => {
		const checkout = await mainCheckout('repo');
		const { worktree } = await linkedWorktree(checkout, 'wt-quiet');
		await mkdir(path.join(checkout, '.git', 'rebase-merge'));
		await writeFile(path.join(checkout, '.git', 'MERGE_HEAD'), `${SHA1}\n`);
		const linked = await readGitHead(worktree);
		expect(linked.status).toBe('ok');
		expect(linked).not.toHaveProperty('operation');
		expect(await readGitHead(checkout)).toMatchObject({
			operation: 'rebase-merge',
		});
	});

	it('reports a dangling gitdir after the main checkout moved', async () => {
		const worktree = path.join(root, 'orphan');
		await mkdir(worktree);
		await writeFile(
			path.join(worktree, '.git'),
			`gitdir: ${path.join(root, 'gone', '.git', 'worktrees', 'orphan')}\n`
		);
		expect(await readGitHead(worktree)).toEqual({
			status: 'unavailable',
			reason: 'dangling-gitdir',
		});
	});

	it.each([
		['no gitdir line', 'worktree: elsewhere\n'],
		['an empty gitdir target', 'gitdir:   \n'],
		['an oversized file', `gitdir: ${'x'.repeat(8 * 1024)}\n`],
	])('rejects a .git file with %s', async (_label, content) => {
		const worktree = path.join(root, 'broken');
		await mkdir(worktree);
		await writeFile(path.join(worktree, '.git'), content);
		expect(await readGitHead(worktree)).toEqual({
			status: 'unavailable',
			reason: 'invalid-gitdir-file',
		});
	});

	it.each([
		['a bare branch name', 'ref: main\n'],
		['a non-object id', 'not-a-commit\n'],
		['an empty file', '\n'],
		['a ref followed by junk lines', 'ref: refs/heads/main\nextra\n'],
		['an oversized file', `ref: refs/heads/${'b'.repeat(8 * 1024)}\n`],
	])('rejects HEAD with %s', async (_label, head) => {
		const checkout = await mainCheckout('bad-head', head);
		expect(await readGitHead(checkout)).toEqual({
			status: 'unavailable',
			reason: 'invalid-head',
		});
	});

	it('reports a gitdir whose HEAD is missing or not a file', async () => {
		const checkout = await mainCheckout('repo');
		const { worktree, admin } = await linkedWorktree(checkout, 'wt-headless');
		await rm(path.join(admin, 'HEAD'));
		expect(await readGitHead(worktree)).toEqual({
			status: 'unavailable',
			reason: 'unreadable-head',
		});
		await mkdir(path.join(admin, 'HEAD'));
		expect(await readGitHead(worktree)).toEqual({
			status: 'unavailable',
			reason: 'unreadable-head',
		});
	});

	it('treats a .git directory without repository markers as no repository', async () => {
		const project = path.join(root, 'stray');
		await mkdir(path.join(project, '.git', 'gk'), { recursive: true });
		expect(await readGitHead(project)).toEqual({
			status: 'unavailable',
			reason: 'not-a-repository',
		});
	});

	it('distinguishes a folder without git from a missing worktree', async () => {
		const plain = path.join(root, 'plain');
		await mkdir(plain);
		expect(await readGitHead(plain)).toEqual({
			status: 'unavailable',
			reason: 'no-git',
		});
		expect(await readGitHead(path.join(root, 'missing'))).toEqual({
			status: 'unavailable',
			reason: 'missing-worktree',
		});
		expect(await readGitHead('relative/worktree')).toEqual({
			status: 'unavailable',
			reason: 'missing-worktree',
		});
	});

	it('never throws when the filesystem port fails unexpectedly', async () => {
		const checkout = await mainCheckout('repo');
		const result = await readGitHead(checkout, {
			fs: {
				...nodeStaticFileSystem,
				readText: async () => {
					throw new Error('disk on fire');
				},
			},
		});
		expect(result).toEqual({
			status: 'unavailable',
			reason: 'unreadable-head',
		});
	});
});
