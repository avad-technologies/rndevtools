import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The Supabase CLI's stack id, recomputed as a canary (DESIGN: identity
 * check). Supabase CLI 2.121.0 derives it in
 * packages/stack/src/identity/Identity.ts: SHA-256 over three UTF-8 fields,
 * each prefixed with its byte length as a big-endian uint32: the canonical
 * project root, the branch context, and the stack name. The CLI's own id
 * always wins; a mismatch only flags that worktree.
 */

const DEFAULT_STACK_NAME = 'default';
const BRANCH_CONTEXT = /^(?:refs\/.+|detached|ordinary-workspace)$/;

type StackIdentityInput = {
	/** Realpath of the directory holding `supabase/config.toml`. */
	projectRoot: string;
	/** Full ref (`refs/heads/main`), `detached`, or `ordinary-workspace`. */
	branchContext: string;
	/** Stack name; the desktop only ever uses the default stack. */
	name?: string;
};

function encodeTuple(fields: readonly string[]): Uint8Array {
	const encoder = new TextEncoder();
	const encoded = fields.map((field) => encoder.encode(field));
	const length = encoded.reduce((total, bytes) => total + 4 + bytes.length, 0);
	const tuple = new Uint8Array(length);
	const view = new DataView(tuple.buffer);
	let offset = 0;
	for (const bytes of encoded) {
		view.setUint32(offset, bytes.length, false);
		offset += 4;
		tuple.set(bytes, offset);
		offset += bytes.length;
	}
	return tuple;
}

/**
 * The 64-hex stack id the CLI would assign. The project root is hashed
 * exactly as given (no realpath, no Unicode normalization), so callers pass
 * the realpath. Throws a RangeError for inputs the CLI could never produce,
 * such as a relative root or a bare branch name without `refs/heads/`.
 */
export function expectedStackId(input: StackIdentityInput): string {
	const name = input.name ?? DEFAULT_STACK_NAME;
	if (input.projectRoot.trim().length === 0) {
		throw new RangeError('The project root must not be blank.');
	}
	if (!path.isAbsolute(input.projectRoot)) {
		throw new RangeError('The project root must be an absolute realpath.');
	}
	if (name.trim().length === 0) {
		throw new RangeError('The stack name must not be blank.');
	}
	if (!BRANCH_CONTEXT.test(input.branchContext)) {
		throw new RangeError(
			'The branch context must be a full ref, detached, or ordinary-workspace.'
		);
	}
	return createHash('sha256')
		.update(encodeTuple([input.projectRoot, input.branchContext, name]))
		.digest('hex');
}
