import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProbeNotes, readProbeIdentity } from '../src/database-probe.ts';

const identity = readProbeIdentity({ label: 'qa-example-a' });
const own = { body: 'RN Devtools QA: qa-example-a' };
const foreign = { body: 'RN Devtools QA: qa-example-b' };

test('requires an explicit valid identity before a connection can pass', () => {
	for (const config of [
		undefined,
		{},
		{ label: '' },
		{ label: 'invalid label' },
	]) {
		assert.equal(
			checkProbeNotes([own], readProbeIdentity(config)).status,
			'unconfigured',
		);
	}
});

test('accepts the exact expected marker with neutral seed notes', () => {
	assert.deepEqual(checkProbeNotes([{ body: 'Hello' }, own], identity), {
		status: 'expected-only',
		notes: ['Hello', own.body],
	});
});

test('fails on a misrouted backend or a non-exact marker', () => {
	for (const rows of [[], [foreign], [{ body: `${own.body}-suffix` }]]) {
		assert.equal(checkProbeNotes(rows, identity).status, 'missing-expected');
	}
});

test('fails when an expected marker appears alongside a foreign marker', () => {
	assert.equal(
		checkProbeNotes([own, foreign], identity).status,
		'foreign-marker',
	);
});

test('rejects malformed rows even when they include the expected marker', () => {
	for (const rows of [{ notes: [own] }, [own, null], [own, { body: 1 }]]) {
		assert.deepEqual(checkProbeNotes(rows, identity), {
			status: 'malformed',
			notes: [],
		});
	}
});
