import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * Creates `directory` if needed, refuses a symlink or anything that is not a
 * directory, makes it 0700, and returns its real path. `label` names the
 * storage in the error; `ownedByUser` also refuses another user's directory.
 */
export async function ensurePrivateDirectory(
	directory: string,
	label: string,
	{
		recursive = true,
		ownedByUser = false,
	}: { recursive?: boolean; ownedByUser?: boolean } = {}
): Promise<string> {
	await mkdir(directory, { recursive, mode: 0o700 });
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`${label} must be a private local directory.`);
	}
	const userId = process.getuid?.();
	if (ownedByUser && userId !== undefined && metadata.uid !== userId) {
		throw new Error(`${label} must be owned by the current user.`);
	}
	await chmod(directory, 0o700);
	return realpath(directory);
}

export function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Replaces `destinationPath` so a crash leaves the old file or the new one,
 * never part of either: a fresh 0600 `.tmp` file beside it is fsynced and
 * renamed over it, then the directory is fsynced. A failed write removes the
 * temporary file.
 */
export async function writeFileAtomic(
	destinationPath: string,
	contents: string,
	temporaryPrefix: string
): Promise<void> {
	const directory = path.dirname(destinationPath);
	const temporaryPath = path.join(
		directory,
		`.${temporaryPrefix}-${process.pid}-${randomUUID()}.tmp`
	);
	const handle = await open(
		temporaryPath,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
		0o600
	);
	try {
		try {
			await handle.writeFile(contents, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, destinationPath);
		await chmod(destinationPath, 0o600);
		await syncDirectory(directory);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}
