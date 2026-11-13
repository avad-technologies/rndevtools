import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	truncate,
	unlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type DiagnosticReportCache,
	failureText,
	parseDiagnosticReport,
	readDiagnosticReports,
} from './failure-diagnostics';

const udid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const now = Date.now();
function report(overrides = {}) {
	return JSON.stringify({
		procName: 'ExampleApp',
		parentProc: 'launchd_sim',
		coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
		exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
		captureTime: new Date(now).toISOString(),
		threads: [{ frames: [{ symbol: 'exampleFrame' }] }],
		...overrides,
	});
}

describe('bounded simulator diagnostics', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndt-failure-report-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it('reads both IPS formats and projects symbols without memory or credentials', () => {
		const raw = report({
			memory: 'DO_NOT_EXPOSE',
			threads: [
				{
					frames: [
						{ symbol: 'Authorization: Bearer secret-value' },
						...Array.from({ length: 40 }, (_, i) => ({ symbol: `frame${i}` })),
					],
				},
			],
		});
		for (const content of [raw, `{"bug_type":"309"}\n${raw}`]) {
			const parsed = parseDiagnosticReport(content, 'ExampleApp.ips', now);
			expect(parsed).toMatchObject({
				kind: 'app-crash',
				severity: 'error',
				simulatorUdid: udid,
				at: now,
			});
			expect(parsed?.detail).toContain('frame14');
			expect(parsed?.detail).not.toContain('frame15');
			expect(parsed?.detail).not.toContain('DO_NOT_EXPOSE');
			expect(parsed?.detail).not.toContain('secret-value');
		}
	});
	it('removes terminal escape sequences before redacting, so colored output cannot shield a credential', () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const raw of [
			`\u001b[32m${jwt}\u001b[0m`,
			'Bearer \u001b[1msecret-value\u001b[0m',
			// The 8-bit CSI, and an OSC 8 hyperlink terminated by BEL.
			`\u009b31m${jwt}`,
			`token \u001b]8;;https://example.com\u0007${jwt}\u001b]8;;\u0007`,
		]) {
			const text = failureText(raw);
			expect(text).not.toMatch(/eyJ|secret-value/);
			// No escape parameters are left behind as visible text either.
			expect(text).not.toMatch(/\[\d+m|\]8;;/);
		}
		expect(failureText('Error: example failure\n  at exampleFrame')).toBe(
			'Error: example failure\n  at exampleFrame'
		);
	});
	it('redacts a token that an escape sequence glues to the word before it', () => {
		// The JWT and Bearer rules start at a word boundary, which neither the
		// letter that ends a sequence nor the word left once it is removed has
		// before the token.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			[
				`Error: fetching\u001b[32m${jwt}\u001b[0m done`,
				'Error: fetching[REDACTED JWT] done',
			],
			['Error: Bearer\u001b[1msecret-value', 'Error: Bearer [REDACTED]'],
			// A two-byte escape, the 8-bit CSI, and a lone ESC.
			[`Error: fetching\u001b7${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u009b32m${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u001b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			// A secret's value and a token a sequence glues to it are one secret.
			[`password=example\u001b[0m${jwt}`, 'password=[REDACTED]'],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
		// Redacting the raw text first cut this sequence at the `;` between its
		// parameters, and left the rest of it, `32m`, on the token.
		const text = failureText(`GET /callback?code=\u001b[1;32m${jwt}\u001b[0m`);
		expect(text).toContain('GET /callback?code=[REDACTED');
		expect(text).not.toMatch(/eyJ|32m/);
	});
	it('redacts a token that a removed control character would join to the word before it', () => {
		// The JWT and Bearer rules start at a word boundary, and a removed
		// control leaves none between the word and the token it parted.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			[`Error: fetching\r${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u000b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u0008${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u200b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			['Error: Bearer\rsecret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u000bsecret-value', 'Error: Bearer [REDACTED]'],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
	});
	it('redacts a Bearer token after a format character or a backspace, which is not white space', () => {
		// Bearer and an Authorization scheme take the token after white space,
		// so the rules have to read such a character as a separator before it
		// is removed.
		for (const [raw, redacted] of [
			// A zero-width space, a zero-width joiner, a word joiner, a
			// left-to-right mark, and a backspace.
			['Error: Bearer\u200bsecret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u200dsecret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u2060secret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u200esecret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u0008secret-value', 'Error: Bearer [REDACTED]'],
			[
				'Error: Authorization:\u200bBearer secret-value',
				'Error: Authorization:[REDACTED]',
			],
			[
				'Authorization: Digest\u200busername="example", response="secret-value"',
				'Authorization: [REDACTED]',
			],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
	});
	it('hides all of a token that a removed sequence or character splits', () => {
		// Read as a break, the run splits the token into two words, of which
		// the rules know at most one. Read as nothing, it leaves the token
		// whole, and what either reading hides is hidden.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			['Bearer example-\u001b[1mbearer-value', 'Bearer [REDACTED]'],
			['key sb_secret_example\u200b-key-value', 'key [REDACTED SECRET KEY]'],
			[
				`token ${jwt.slice(0, -4)}\u001b[0m${jwt.slice(-4)}`,
				'token [REDACTED JWT]',
			],
			['mail us\u200ber@example.com', 'mail [REDACTED EMAIL]'],
			['mail us\u001b[0m.er@example.com', 'mail [REDACTED EMAIL]'],
			// Read with the sequences gone, a full stop between two of them
			// inside a token is the token's.
			['Bearer example\u001b[0m.\u001b[0mbearer-value', 'Bearer [REDACTED]'],
			// Only read as nothing is this soft hyphen not a break in the JWT.
			[
				`token ${jwt.slice(0, 12)}\u00ad${jwt.slice(12)}`,
				'token [REDACTED JWT]',
			],
			// A word that ends where the token starts stays, and so does a full
			// stop after an address. Read with the sequence gone, the JWT rule
			// starts at the payload and takes a full stop after the signature for
			// a third part, so after a JWT glued to a word the stop goes too.
			[`fetching\u001b[32m${jwt}\u001b[0m.`, 'fetching[REDACTED JWT]'],
			['mail \u001b[1muser@example.com\u001b[0m.', 'mail [REDACTED EMAIL].'],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
	});
	it('hides a token that one sequence joins to the word before it and another splits', () => {
		// Neither reading of every run the same way finds it: read as nothing,
		// the runs join the token to the word, and read as breaks, they split
		// it. Read as a break before the token only, it is whole.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			[
				`fetching\u001b[32m${jwt.slice(0, 12)}\u001b[0m${jwt.slice(12)}`,
				'fetching[REDACTED JWT]',
			],
			[
				'fetching\u001b[32mBea\u001b[0mrer example-bearer-value',
				'fetchingBearer [REDACTED]',
			],
			// At the token's own `eyJ`, a character Unicode shows as nothing
			// takes the break, and the token runs on past it.
			[
				`fetching\u001b[32m${jwt}abc\u00adeyJzZWNyZXQ`,
				'fetching[REDACTED JWT]',
			],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
	});
	it('hides the rest of a token past a removed sequence, which no reading finds whole', () => {
		// The break before `Bearer` that the glued word needs also comes
		// before the `eyJ` inside the token, so every reading that sees
		// `Bearer` stops the token there.
		expect(
			failureText('fetching\u001b[32mBearer example\u001b[0meyJsecret-value')
		).toBe('fetchingBearer [REDACTED]');
		// A full stop after it ends a sentence more often than a token.
		expect(
			failureText('fetching\u001b[32mBearer example\u001b[0meyJsecret-value.')
		).toBe('fetchingBearer [REDACTED].');
	});
	it('redacts a credential whose name a stray ESC takes a letter of', () => {
		// A terminal reads an ESC and the letter after it as a two-byte
		// escape, or with intermediates as an nF one, but before a word the
		// ESC is likely a stray one, so the text is read with it gone too.
		for (const [raw, redacted] of [
			[
				'Error: pa\u001bssword=hunter2-example-secret done',
				'Error: pasword=[REDACTED] done',
			],
			[
				'Error: Be\u001barer example-bearer-token-value done',
				'Error: Bearer [REDACTED] done',
			],
			[
				'Error: A\u001buthorization: Basic dXNlcjpwYXNzd29yZGV4YW1wbGU= done',
				'Error: Athorization: [REDACTED] done',
			],
			// With another sequence inside the name or the list.
			[
				'Error: \u001b(Authorization: Digest u\u001b]8;;https://example.test\u001b\\sername="example", response="secret-value" done',
				'Error: uthorization: [REDACTED]',
			],
			// A cursor save is a real escape, whatever follows it.
			[
				'"\u001bBeare\u001b7r \u001b[0mexample-bearer-token-value, next',
				'"Bearer [REDACTED], next',
			],
			// Before a name's last letter, or the letter before its hyphen.
			[
				'Error: passwor\u001bd=hunter2-example-secret done',
				'Error: passwor=[REDACTED] done',
			],
			[
				'Error: Beare\u001br example-bearer-token-value done',
				'Error: Bearer [REDACTED] done',
			],
			[
				'Error: x-ap\u001bi-key: AKexampleapikeyvalue0123 done',
				'Error: x-ap-key: [REDACTED] done',
			],
			// Read with the ESC gone, with a break at each sequence, without
			// a soft hyphen, and with a break before the glued token only.
			[
				'Error: \u001bBearer\u001b[0mexample-bearer-token-value done',
				'Error: Bearer [REDACTED] done',
			],
			[
				'Error: pa\u001bss\u00adword=hunter2-example-secret done',
				'Error: pas\u00adword=[REDACTED] done',
			],
			[
				'Error: fetching\u001b[32me\u001byJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl done',
				'Error: fetching[REDACTED JWT] done',
			],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
	});
	it('writes only markers for what the text as it came hides, never the escape strings it holds', () => {
		// Here only the text as it came holds the name whole, and its rule
		// runs on into the title string, whose words must not reach the
		// output with the marker.
		expect(failureText('\u001b[1;token=abc\u001b]0;X Y]\u0007 rest')).toBe(
			'oken=[REDACTED] rest'
		);
	});
	it('hides all of the difference when a later rule takes part of an earlier marker', () => {
		// The JWT rule takes the `Bearer` the Bearer rule wrote as the token's
		// third part, which leaves a space the text never had.
		expect(
			failureText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bearer\tx\u001b[0m')
		).toBe('[REDACTED JWT]');
	});
	it('returns text that a second redaction leaves as it is', () => {
		// Records are redacted again when they are stored.
		for (const raw of [
			'\u0007token=a Bearer a',
			'password=a \u001b[0m password=b',
			'\rBearer ctoken=bx',
			'Authorization: Digest username\u001b[0m="example", response="secret-value"',
			'fetching\u001b[32meyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln\u001b[0m done',
		]) {
			const once = failureText(raw);
			expect({ raw, again: failureText(once) }).toEqual({ raw, again: once });
		}
		// Text between two markers that the first secret holds as well could
		// be either, so all of it is hidden.
		expect(
			failureText('password="a , password=b" , password="c"\u001b[0m')
		).toBe('password="[REDACTED]"');
		// When no other reading hides more, the text is what the rules make of
		// the shown text, two addresses side by side included.
		expect(
			failureText('mail a@example.com%20b@example.org\u001b[0m and more')
		).toBe('mail [REDACTED EMAIL][REDACTED EMAIL] and more');
	});
	it('cuts failure text short of a surrogate pair it would split', () => {
		expect(failureText(`${'a'.repeat(9)}\u{1f600}`, 10)).toBe('a'.repeat(9));
		expect(failureText(`${'a'.repeat(8)}\u{1f600}`, 10)).toBe(
			`${'a'.repeat(8)}\u{1f600}`
		);
	});
	it('redacts all of an Authorization parameter list that a removed sequence or character parts from its first `=`', () => {
		// Read as a break, the run ends the first parameter's name, and the
		// rule takes the scheme's credentials for one token, up to the first
		// comma. Read as nothing, it leaves the list whole.
		for (const raw of [
			'Authorization: Digest username\u001b[0m="example", response="secret-value"',
			'Authorization: Digest username=\u001b[0m"example", response="secret-value"',
			'Authorization: Digest username\r="example", response="secret-value"',
			'Authorization: AWS4-HMAC-SHA256 Credential\u001b[1m=EXAMPLEKEY/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=secret-value',
		]) {
			expect(failureText(raw)).toBe('Authorization: [REDACTED]');
		}
	});
	it('redacts a token whose first letter an escape sequence takes', () => {
		// A lone ESC before a space reads as an escape whose final byte is the
		// token's first letter, and no rule knows the rest; as it came, the
		// text still holds the token whole.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		expect(failureText(`Error: fetching\u001b ${jwt}`)).toBe(
			'Error: fetching[REDACTED JWT]'
		);
		// A two-byte escape goes whole, even right before a word.
		expect(failureText('\u001bMline')).toBe('line');
	});
	it('redacts a Bearer token after a character Unicode shows as nothing that stays in the text', () => {
		// Soft hyphens, variation selectors, tags and fillers are shown as they
		// are, but read as breaks as well.
		for (const character of ['\u00ad', '\ufe0f', '\u{e0020}', '\u3164']) {
			expect(failureText(`Error: Bearer${character}secret-value`)).toBe(
				'Error: Bearer [REDACTED]'
			);
		}
	});
	it('cuts the free fields of a crash report before it redacts them', () => {
		// Each field is redacted, and a crafted report can fill one with
		// megabytes, so each is cut to 1,024 characters first, as a text
		// report's fields are.
		const parsed = parseDiagnosticReport(
			report({
				procName: 'x'.repeat(200_000),
				exception: { type: 'E'.repeat(200_000), signal: 'SIGABRT' },
			}),
			'Crafted.ips',
			now
		);
		expect(parsed?.process).toBe('x'.repeat(256));
		expect(parsed?.detail).toContain(`Process: ${'x'.repeat(1_024)}\n`);
		expect(parsed?.detail).toContain(`Exception: ${'E'.repeat(1_024)} SIGABRT`);
		expect(parsed?.detail.length).toBeLessThan(4_096);
	});
	it('distinguishes SpringBoard crashes from CoreSimulator resource diagnostics', () => {
		expect(
			parseDiagnosticReport(
				report({ procName: 'SpringBoard' }),
				'SpringBoard.ips',
				now
			)?.kind
		).toBe('simulator-crash');
		const diagnostic = parseDiagnosticReport(
			'Command: com.apple.CoreSimulator.CoreSimulatorService\nEvent: disk writes\nAction taken: none\nWrites: 34 GB\nsecret: DO_NOT_EXPOSE',
			'service.diag',
			now
		);
		expect(diagnostic).toMatchObject({
			kind: 'simulator-diagnostic',
			severity: 'warning',
		});
		expect(diagnostic?.detail).toContain('Action taken: none');
		expect(diagnostic?.detail).not.toContain('DO_NOT_EXPOSE');
		expect(
			parseDiagnosticReport(
				report({ exception: {}, procName: 'Simulator' }),
				'Simulator.ips',
				now
			)?.kind
		).toBe('simulator-diagnostic');
	});
	it('keeps nonfatal resource reports as warnings even when an exception type is present', () => {
		for (const overrides of [
			{ exception: { type: 'EXC_RESOURCE' } },
			{
				exception: { type: 'EXC_RESOURCE', signal: 'SIGKILL' },
				isNonFatalCorpse: 1,
			},
		]) {
			expect(
				parseDiagnosticReport(report(overrides), 'ExampleApp.ips', now)
			).toMatchObject({
				kind: 'simulator-diagnostic',
				severity: 'warning',
			});
		}
		expect(
			parseDiagnosticReport(
				report({ exception: { type: 'EXC_RESOURCE', signal: 'SIGKILL' } }),
				'ExampleApp.ips',
				now
			)?.kind
		).toBe('app-crash');
		expect(
			parseDiagnosticReport(
				'Process: Simulator [123]\nEvent: disk writes\nAction taken: none',
				'Simulator.crash',
				now
			)?.kind
		).toBe('simulator-diagnostic');
		expect(
			parseDiagnosticReport(
				report({ captureTime: '1960-01-01' }),
				'ExampleApp.ips',
				now
			)?.at
		).toBe(now);
	});
	it('ignores unrelated host crashes and malformed reports', () => {
		expect(
			parseDiagnosticReport(
				report({
					parentProc: 'launchd',
					coalitionName: '',
					procName: 'ExampleApp',
				}),
				'ExampleApp.ips',
				now
			)
		).toBeUndefined();
		expect(
			parseDiagnosticReport('bad json', 'ExampleApp.ips', now)
		).toBeUndefined();
	});
	it('identifies Apple simulator daemons without blaming the development app', () => {
		const record = parseDiagnosticReport(
			report({
				procName: 'searchd',
				codeSigningID: 'com.apple.searchd',
			}),
			'searchd.ips',
			now
		);
		expect(record?.kind).toBe('simulator-crash');
		expect(record?.detail).toContain(
			'does not establish that the development app'
		);
		expect(
			parseDiagnosticReport(
				report({ codeSigningID: 'com.example.app' }),
				'ExampleApp.ips',
				now
			)?.kind
		).toBe('app-crash');
	});
	it('never follows report symlinks and skips stale or oversized files with bounded feedback', async () => {
		await mkdir(path.join(root, 'reports'));
		await writeFile(path.join(root, 'external.ips'), report());
		await symlink(
			path.join(root, 'external.ips'),
			path.join(root, 'reports/link.ips')
		);
		await writeFile(path.join(root, 'reports/old.ips'), report());
		await utimes(path.join(root, 'reports/old.ips'), new Date(0), new Date(0));
		await writeFile(path.join(root, 'reports/large.ips'), '');
		await truncate(path.join(root, 'reports/large.ips'), 5 * 1024 * 1024);
		const result = await readDiagnosticReports(
			[path.join(root, 'reports'), path.join(root, 'missing')],
			now
		);
		expect(result.records).toEqual([]);
		expect(result.issues).toEqual([expect.stringContaining('oversized')]);
	});
	it('prioritizes newest reports by time rather than process name', async () => {
		await Promise.all(
			Array.from({ length: 300 }, async (_, i) => {
				const file = path.join(root, `Z${i}.ips`);
				await writeFile(file, '{}');
				await utimes(file, new Date(now - 10_000), new Date(now - 10_000));
			})
		);
		await writeFile(path.join(root, 'A-newest.ips'), report());
		const result = await readDiagnosticReports([root], now);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.source).toBe('A-newest.ips');
		expect(result.issues).toEqual([expect.stringContaining('newest 300')]);
	}, 15_000);

	describe('across scans', () => {
		// Whole seconds, so setting the time again reproduces it exactly.
		const listedAt = new Date(Math.floor(now / 1_000) * 1_000 - 60_000);
		const changedAt = new Date(listedAt.getTime() + 1_000);
		async function place(name: string, content: string, at = listedAt) {
			const file = path.join(root, name);
			await writeFile(file, content);
			await utimes(file, at, at);
			return file;
		}
		const processes = (
			result: Awaited<ReturnType<typeof readDiagnosticReports>>
		) => result.records.map((record) => record.process);

		it('reuses what it parsed while a report keeps its size and modification time, and reads it again once either changes', async () => {
			const cache: DiagnosticReportCache = new Map();
			const file = await place('ExampleApp.ips', report());
			const first = await readDiagnosticReports([root], now, cache);
			expect(processes(first)).toEqual(['ExampleApp']);

			// New bytes of the same length under the same time are not read.
			await place('ExampleApp.ips', report({ procName: 'ExampleApq' }));
			expect(await readDiagnosticReports([root], now, cache)).toEqual(first);
			expect(processes(await readDiagnosticReports([root], now))).toEqual([
				'ExampleApq',
			]);

			await utimes(file, changedAt, changedAt);
			expect(
				processes(await readDiagnosticReports([root], now, cache))
			).toEqual(['ExampleApq']);
			await place(
				'ExampleApp.ips',
				report({ procName: 'SpringBoard' }),
				changedAt
			);
			expect(
				processes(await readDiagnosticReports([root], now, cache))
			).toEqual(['SpringBoard']);

			// A report that vanished leaves nothing behind.
			await unlink(file);
			expect(await readDiagnosticReports([root], now, cache)).toEqual({
				records: [],
				issues: [],
			});
			expect(cache.size).toBe(0);
		});

		it.skipIf(process.getuid?.() === 0)(
			'never opens an unchanged report again',
			async () => {
				const cache: DiagnosticReportCache = new Map();
				const file = await place('ExampleApp.ips', report());
				const first = await readDiagnosticReports([root], now, cache);
				expect(first.records).toHaveLength(1);
				// chmod moves only the change time, so the report is unchanged,
				// and any open(2) of it now fails.
				await chmod(file, 0o000);
				try {
					expect(await readDiagnosticReports([root], now, cache)).toEqual(
						first
					);
					expect((await readDiagnosticReports([root], now)).records).toEqual(
						[]
					);
				} finally {
					await chmod(file, 0o600);
				}
			}
		);

		it('charges reports it already knows to the folder limits, as if it read them again', async () => {
			const cache: DiagnosticReportCache = new Map();
			// Four 4 MB reports fill the 16 MB folder budget, so the older,
			// smaller report behind them is never inspected.
			for (let index = 0; index < 4; index += 1) {
				const file = await place(`Large-${index}.ips`, '');
				await truncate(file, 4 * 1024 * 1024);
				await utimes(file, listedAt, listedAt);
			}
			const oversized = await place('Oversized.ips', '');
			await truncate(oversized, 5 * 1024 * 1024);
			await utimes(oversized, listedAt, listedAt);
			await place(
				'ExampleApp.ips',
				report(),
				new Date(listedAt.getTime() - 60_000)
			);
			const first = await readDiagnosticReports([root], now, cache);
			expect(first).toEqual({
				records: [],
				issues: [
					expect.stringContaining('oversized'),
					expect.stringContaining('16 MB folder limit'),
				],
			});
			expect(await readDiagnosticReports([root], now, cache)).toEqual(first);
		});
	});
});
