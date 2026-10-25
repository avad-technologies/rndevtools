import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Small, bounded filesystem reads (static project detection, the Supabase
 * store files and the CLI resolver's package manifests) and lexical path
 * checks. Nothing here evaluates project code, follows a FIFO into a blocking
 * read, or reads more than the caller's byte cap.
 */

/** DESIGN: static detection reads at most 256 KiB of any one file. */
export const STATIC_READ_LIMIT_BYTES = 256 * 1024;

type PathKind = 'file' | 'directory' | 'other' | 'missing' | 'error';

type BoundedTextResult =
	| { status: 'ok'; text: string }
	| { status: 'missing' }
	| { status: 'not-a-file' }
	| { status: 'too-large' }
	| { status: 'error' };

/** The filesystem calls static detection needs, so tests can substitute them. */
export type StaticFileSystem = {
	kind: (target: string) => Promise<PathKind>;
	realpath: (target: string) => Promise<string | undefined>;
	readText: (target: string, maxBytes: number) => Promise<BoundedTextResult>;
};

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

async function kindOf(target: string): Promise<PathKind> {
	try {
		const info = await stat(target);
		if (info.isFile()) return 'file';
		return info.isDirectory() ? 'directory' : 'other';
	} catch (error) {
		return isMissing(error) ? 'missing' : 'error';
	}
}

async function canonical(target: string): Promise<string | undefined> {
	try {
		return await realpath(target);
	} catch {
		return undefined;
	}
}

/**
 * Reads a regular file of at most `maxBytes` as UTF-8, BOM included. With
 * `noFollow`, a final symlink is refused (an `error`, as the open fails).
 */
export async function readBoundedText(
	target: string,
	maxBytes: number,
	options: Readonly<{ noFollow?: boolean }> = {}
): Promise<BoundedTextResult> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		// O_NONBLOCK keeps a FIFO planted at a config path from blocking the
		// read; fstat below then rejects anything that is not a regular file.
		handle = await open(
			target,
			constants.O_RDONLY |
				constants.O_NONBLOCK |
				(options.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)
		);
	} catch (error) {
		return isMissing(error) ? { status: 'missing' } : { status: 'error' };
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) return { status: 'not-a-file' };
		if (info.size > maxBytes) return { status: 'too-large' };
		// One extra byte detects a file that grew past the cap after fstat.
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length
			);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > maxBytes) return { status: 'too-large' };
		return { status: 'ok', text: buffer.subarray(0, length).toString('utf8') };
	} catch {
		return { status: 'error' };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export const nodeStaticFileSystem: StaticFileSystem = {
	kind: kindOf,
	realpath: canonical,
	// Static detection reads text without its BOM.
	readText: async (target, maxBytes) => {
		const read = await readBoundedText(target, maxBytes);
		return read.status === 'ok'
			? { status: 'ok', text: read.text.replace(/^\uFEFF/, '') }
			: read;
	},
};

/** True when `candidate` is `root` itself or lies below it (lexically). */
export function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/** True when `candidate` lies below `root`, never `root` itself (lexically). */
export function isPathStrictlyWithin(root: string, candidate: string): boolean {
	return isPathWithin(root, candidate) && path.relative(root, candidate) !== '';
}
