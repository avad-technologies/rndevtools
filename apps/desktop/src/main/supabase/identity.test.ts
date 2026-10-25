import { describe, expect, it } from 'vitest';
import { expectedStackId } from './identity';

describe('expectedStackId', () => {
	it('reproduces the documented Supabase CLI 2.121.0 test vector', () => {
		// packages/stack/src/identity/identity.integration.test.ts:63-77
		expect(
			expectedStackId({
				projectRoot: '/tmp/project',
				branchContext: 'refs/heads/main',
				name: 'default',
			})
		).toBe('64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f');
	});

	it('reproduces the stack ids the spike CLI assigned to real worktrees', () => {
		expect(
			expectedStackId({
				projectRoot: '/private/tmp/supa-spike/work/repo',
				branchContext: 'refs/heads/main',
			})
		).toBe('b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8');
		expect(
			expectedStackId({
				projectRoot: '/private/tmp/supa-spike/work/wt-b',
				branchContext: 'refs/heads/feature-b',
			})
		).toBe('b7d2540d73c761df0a9c08923965e2172482324bb631b0d9d71962daa1b499e6');
		expect(
			expectedStackId({
				projectRoot: '/private/tmp/supa-spike/work/wt-c',
				branchContext: 'refs/heads/feature-c',
			})
		).toBe('caa17ef5f48a374c852df92e3c2f8d4d6f6d4e446b606b21388dc9fcdf555fb6');
	});

	it('uses the default stack name unless one is given', () => {
		const root = {
			projectRoot: '/tmp/project',
			branchContext: 'refs/heads/main',
		};
		expect(expectedStackId(root)).toBe(
			expectedStackId({ ...root, name: 'default' })
		);
		// Vectors below were computed independently with Python hashlib.
		expect(expectedStackId({ ...root, name: 'preview' })).toBe(
			'49675ece0d1f8880d9cabc2ed29024eb4d8de787c478c481fb2f079f4af6f5c3'
		);
	});

	it('hashes the detached and ordinary-workspace contexts', () => {
		expect(
			expectedStackId({
				projectRoot: '/tmp/project',
				branchContext: 'detached',
			})
		).toBe('1e01cd5e6711e0adc49d6f70e16df688abdebf16c16510393069aeeb2ff638e3');
		expect(
			expectedStackId({
				projectRoot: '/tmp/project',
				branchContext: 'ordinary-workspace',
			})
		).toBe('b50f9f22af36bf87dc2288fdb54490bca9b4be5c21384146d0df7f89742f2d09');
	});

	it('prefixes byte lengths, not character counts, and never normalizes', () => {
		// NFC: precomposed letters, as macOS APFS keeps names typed in Finder.
		const composed = {
			projectRoot: '/Users/developer/Projets/Caf\u00e9 App',
			branchContext: 'refs/heads/feature/\u00fcn\u00efcode',
		};
		expect(expectedStackId(composed)).toBe(
			'1fee6e087c9a902b78435c4ab4a57c7a10287bb0c57a548ffd89e97c40de095a'
		);
		// NFD: the same text with combining marks hashes differently.
		expect(
			expectedStackId({
				projectRoot: '/Users/developer/Projets/Cafe\u0301 App',
				branchContext: 'refs/heads/feature/u\u0308ni\u0308code',
			})
		).toBe('34285fa9a37253d7e4819cf1a10f1b544e1dd93111bbf6776d41dbd08eed8a3a');
	});

	it('keeps sibling worktrees and branches apart', () => {
		const ids = new Set([
			expectedStackId({
				projectRoot: '/Users/dev/app',
				branchContext: 'refs/heads/main',
			}),
			expectedStackId({
				projectRoot: '/Users/dev/app-feature',
				branchContext: 'refs/heads/main',
			}),
			expectedStackId({
				projectRoot: '/Users/dev/app',
				branchContext: 'refs/heads/feature',
			}),
		]);
		expect(ids.size).toBe(3);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects inputs the CLI could never hash', () => {
		const valid = {
			projectRoot: '/tmp/project',
			branchContext: 'refs/heads/main',
		};
		expect(() => expectedStackId({ ...valid, projectRoot: ' ' })).toThrow(
			RangeError
		);
		expect(() =>
			expectedStackId({ ...valid, projectRoot: 'tmp/project' })
		).toThrow(RangeError);
		expect(() => expectedStackId({ ...valid, name: ' ' })).toThrow(RangeError);
		// lane-worktree.ts stores branches without refs/heads/; that is not a context.
		expect(() => expectedStackId({ ...valid, branchContext: 'main' })).toThrow(
			RangeError
		);
		expect(() =>
			expectedStackId({ ...valid, branchContext: 'refs/heads/main\nx' })
		).toThrow(RangeError);
	});
});
