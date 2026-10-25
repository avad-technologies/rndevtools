import { describe, expect, it } from 'vitest';
import { desktopActionSchema } from '../shared/protocol';
import { desktopActionConfirmationCopy } from './desktop-action-confirmation';

function action(command: string, payload: Record<string, unknown>) {
	return desktopActionSchema.parse({
		actionId: `action-${command}`,
		deviceId: 'device-1',
		tool: 'scenarios',
		command,
		payload,
	});
}

const scenarioDocument = JSON.stringify({
	schemaVersion: 1,
	namespace: 'rndevtools-scenarios',
	scenarios: [],
});

describe('desktop action confirmation policy', () => {
	it.each([
		['execute', { id: 'scenario-1', version: 1, definitionToken: 'token-1' }],
		['undo', { receiptId: 'receipt-1' }],
		['discardRecovery', { recoveryError: 'Stored journal is corrupt.' }],
		['import', { json: scenarioDocument, mode: 'merge' }],
		['remove', { id: 'scenario-1', version: 1, definitionToken: 'token-1' }],
	])(
		'requires main-owned confirmation for scenarios.%s',
		(command, payload) => {
			const parsed = action(command, payload);
			expect(desktopActionConfirmationCopy(parsed)).toMatchObject({
				detail: expect.stringContaining('device-1'),
				confirmLabel: expect.any(String),
			});
		}
	);

	it('marks replacement imports destructive and states their removal impact', () => {
		const copy = desktopActionConfirmationCopy(
			action('import', { json: scenarioDocument, mode: 'replace' })
		);
		expect(copy).toMatchObject({ destructive: true });
		expect(copy?.detail).toContain('remove its current user scenario set');
	});

	it('normalizes spoofing controls and binds import copy to exact bytes', () => {
		const unsafeName = `Line one\n\u202E${'x'.repeat(512)}`;
		const source = JSON.stringify({
			schemaVersion: 1,
			namespace: 'rndevtools-scenarios',
			scenarios: [
				{
					schemaVersion: 1,
					id: 'unsafe-name',
					version: 1,
					name: unsafeName,
					variables: [],
					preconditions: [],
					steps: [
						{
							id: 'open-home',
							type: 'navigation',
							input: { path: '/home' },
						},
					],
				},
			],
		});
		const copy = desktopActionConfirmationCopy(
			action('import', { json: source, mode: 'merge' })
		);
		expect(copy?.detail).not.toMatch(/[\n\r\u202e]/u);
		expect(copy?.detail).toContain('SHA-256');
		expect(copy?.detail).toContain(
			`${Buffer.byteLength(source, 'utf8')} bytes`
		);
		expect(copy?.detail.length).toBeLessThan(500);
	});

	it('does not prompt for a read-only-safe connected-app action', () => {
		const parsed = desktopActionSchema.parse({
			actionId: 'refresh-1',
			deviceId: 'device-1',
			tool: 'components',
			command: 'refresh',
			payload: {},
		});
		expect(desktopActionConfirmationCopy(parsed)).toBeUndefined();
	});
});
