import { describe, expect, it } from 'vitest';
import {
	scanDotenvKeys,
	scanTomlAssignments,
	type TomlAssignment,
} from './static-config';

function find(
	assignments: readonly TomlAssignment[],
	dotted: string
): TomlAssignment[] {
	return assignments.filter((entry) => entry.path.join('.') === dotted);
}

describe('scanTomlAssignments', () => {
	it('credits keys to their table, dotted keys and quoted segments', () => {
		const assignments = scanTomlAssignments(
			[
				'project_id = "example-app"',
				'experimental.stack = true',
				'',
				'[ "db" ]',
				'port = 54322',
				'pooler.port = 54_329',
				'',
				'[db."network restrictions"] # quoted segment',
				'enabled = false',
			].join('\n')
		);
		expect(find(assignments, 'project_id')).toEqual([
			{
				path: ['project_id'],
				value: { kind: 'string', value: 'example-app' },
				line: 1,
			},
		]);
		expect(find(assignments, 'experimental.stack')[0]).toMatchObject({
			value: { kind: 'boolean', value: true },
			line: 2,
		});
		expect(find(assignments, 'db.port')[0]).toMatchObject({
			value: { kind: 'integer', value: 54_322 },
			line: 5,
		});
		expect(find(assignments, 'db.pooler.port')[0]).toMatchObject({
			value: { kind: 'integer', value: 54_329 },
			line: 6,
		});
		expect(
			find(assignments, 'db.network restrictions.enabled')[0]
		).toMatchObject({ value: { kind: 'boolean', value: false }, line: 9 });
	});

	it('records inline-table members with their own lines', () => {
		const assignments = scanTomlAssignments(
			'experimental = { stack = true, pgdelta = { enabled = false } }\n'
		);
		expect(find(assignments, 'experimental.stack')[0]).toMatchObject({
			value: { kind: 'boolean', value: true },
			line: 1,
		});
		expect(find(assignments, 'experimental.pgdelta.enabled')[0]).toMatchObject({
			value: { kind: 'boolean', value: false },
		});
	});

	it('classifies scalar values', () => {
		const assignments = scanTomlAssignments(
			[
				'[values]',
				'decimal = +5',
				'hex = 0x1F',
				'octal = 0o17',
				'binary = 0b101',
				'float = 1.5',
				'date = 1979-05-27',
				'escaped = "A\\u0042\\t#"',
				"literal = 'C:\\path'",
				'huge = 99999999999999999999',
			].join('\n')
		);
		const value = (key: string) => find(assignments, `values.${key}`)[0]?.value;
		expect(value('decimal')).toEqual({ kind: 'integer', value: 5 });
		expect(value('hex')).toEqual({ kind: 'integer', value: 31 });
		expect(value('octal')).toEqual({ kind: 'integer', value: 15 });
		expect(value('binary')).toEqual({ kind: 'integer', value: 5 });
		expect(value('float')).toEqual({ kind: 'other' });
		expect(value('date')).toEqual({ kind: 'other' });
		expect(value('escaped')).toEqual({ kind: 'string', value: 'AB\t#' });
		expect(value('literal')).toEqual({ kind: 'string', value: 'C:\\path' });
		expect(value('huge')).toEqual({ kind: 'other' });
	});

	it('never reads keys out of strings, comments or arrays', () => {
		const assignments = scanTomlAssignments(
			[
				'[docs]',
				'notes = """',
				'[experimental]',
				'stack = true',
				'"""',
				"literal = '''",
				'[api]',
				"port = 1'''",
				'# [db]',
				'# port = 54322',
				'matrix = [',
				'  [1, 2], # a comment',
				'  ["[db]", "port = 1"],',
				'  { port = 2 },',
				']',
				'hash = "value # not a comment"',
				'[api]',
				'port = 54321',
			].join('\n')
		);
		expect(find(assignments, 'experimental.stack')).toEqual([]);
		expect(find(assignments, 'db.port')).toEqual([]);
		expect(find(assignments, 'docs.notes')).toHaveLength(1);
		expect(find(assignments, 'docs.hash')[0]?.value).toEqual({
			kind: 'string',
			value: 'value # not a comment',
		});
		expect(find(assignments, 'api.port')).toEqual([
			{
				path: ['api', 'port'],
				value: { kind: 'integer', value: 54_321 },
				line: 18,
			},
		]);
	});

	it('handles escaped quotes at the end of multi-line strings', () => {
		const assignments = scanTomlAssignments(
			[
				'a = """ends with a quote\\""""',
				'b = """two quotes"""""',
				'c = true',
			].join('\n')
		);
		expect(find(assignments, 'a')[0]?.value.kind).toBe('string');
		expect(find(assignments, 'b')[0]?.value.kind).toBe('string');
		expect(find(assignments, 'c')[0]).toMatchObject({ line: 3 });
	});

	it('drops keys after a malformed header instead of misattributing them', () => {
		const assignments = scanTomlAssignments(
			[
				'[api]',
				'enabled = true',
				'[db',
				'port = 54322',
				'[[remotes]]',
				'port = 1',
				'[studio]',
				'port = 54323',
			].join('\n')
		);
		expect(find(assignments, 'api.enabled')).toHaveLength(1);
		expect(find(assignments, 'api.port')).toEqual([]);
		expect(find(assignments, 'db.port')).toEqual([]);
		expect(find(assignments, 'remotes.port')).toEqual([]);
		expect(find(assignments, 'studio.port')[0]).toMatchObject({ line: 8 });
	});

	it('skips unknown syntax line by line and keeps counting lines', () => {
		const assignments = scanTomlAssignments(
			[
				'[api]',
				'broken = "unterminated',
				'= no key',
				'odd key = 1',
				'when = 1979-05-27 07:32:00',
				'port = 54321\r',
				'after = true',
			].join('\n')
		);
		expect(find(assignments, 'api.port')[0]).toMatchObject({
			value: { kind: 'integer', value: 54_321 },
			line: 6,
		});
		expect(find(assignments, 'api.after')[0]).toMatchObject({ line: 7 });
		expect(find(assignments, 'api.broken')).toEqual([]);
		expect(find(assignments, 'api.when')).toEqual([]);
	});

	it('reports every definition of a duplicated key', () => {
		const assignments = scanTomlAssignments(
			'[experimental]\nstack = true\nstack = false\n'
		);
		expect(
			find(assignments, 'experimental.stack').map((entry) => entry.line)
		).toEqual([2, 3]);
	});

	it('stays bounded on pathological input', () => {
		expect(() =>
			scanTomlAssignments(`deep = ${'['.repeat(10_000)}${']'.repeat(10_000)}\n`)
		).not.toThrow();
		expect(scanTomlAssignments(`x = {${' a = {'.repeat(5_000)}`)).toEqual([]);
		const many = Array.from({ length: 30_000 }, (_, index) => `k${index} = 1`);
		expect(scanTomlAssignments(many.join('\n'))).toHaveLength(20_000);
	});
});

describe('scanDotenvKeys', () => {
	it('finds assignments with their lines and never returns values', () => {
		const entries = scanDotenvKeys(
			[
				'# comment',
				'',
				'SUPABASE_API_PORT=54321',
				'  export SUPABASE_DB_PORT = "54322" # pinned',
				'EXPO_PUBLIC_SUPABASE_URL: http://127.0.0.1:54321',
				'SECRET=value-that-must-not-leak',
				'not an assignment',
			].join('\n')
		);
		expect(entries).toEqual([
			{ key: 'SUPABASE_API_PORT', line: 3, integer: 54_321 },
			{ key: 'SUPABASE_DB_PORT', line: 4, integer: 54_322 },
			{ key: 'EXPO_PUBLIC_SUPABASE_URL', line: 5 },
			{ key: 'SECRET', line: 6 },
		]);
		expect(JSON.stringify(entries)).not.toContain('value-that-must-not-leak');
	});

	it('skips the body of a multi-line quoted value', () => {
		const entries = scanDotenvKeys(
			[
				'PRIVATE_KEY="-----BEGIN KEY-----',
				'SUPABASE_API_PORT=1',
				'-----END KEY-----"',
				"NOTE='one line # kept'",
				'TEMPLATE=`a',
				'EXPO_PUBLIC_SUPABASE_URL=x`',
				'LAST=2',
			].join('\r\n')
		);
		expect(entries).toEqual([
			{ key: 'PRIVATE_KEY', line: 1 },
			{ key: 'NOTE', line: 4 },
			{ key: 'TEMPLATE', line: 5 },
			{ key: 'LAST', line: 7, integer: 2 },
		]);
	});

	it('ignores an escaped quote when looking for the closing quote', () => {
		expect(
			scanDotenvKeys('A="say \\"hi\\""\nB=3\n').map((entry) => entry.key)
		).toEqual(['A', 'B']);
	});
});
