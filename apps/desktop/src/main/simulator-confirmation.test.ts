import { describe, expect, it } from 'vitest';
import type { SimulatorAction } from '../shared/simulator-protocol';
import { ActionConfirmationStore } from './action-confirmation-store';
import {
	simulatorActionNeedsConfirmation,
	simulatorConfirmationCopy,
} from './simulator-confirmation';

const UDID = '11111111-2222-3333-4444-555555555555';
const DEVICE = { name: 'Example Test', udid: UDID };
const CERTIFICATE = {
	sha256: 'a'.repeat(64),
	sizeBytes: 1_024,
	subject: 'CN=Example Test Root',
};

const DESTRUCTIVE_ACTIONS: Array<{
	action: SimulatorAction;
	certificate?: typeof CERTIFICATE;
}> = [
	{ action: { actionId: 'erase', kind: 'device.erase', udid: UDID } },
	{ action: { actionId: 'delete', kind: 'device.delete', udid: UDID } },
	{
		action: {
			actionId: 'cleanup',
			kind: 'disk.cleanup',
			udid: UDID,
			categoryIds: ['caches', 'logs'],
		},
	},
	{
		action: {
			actionId: 'uninstall',
			kind: 'app.uninstall',
			udid: UDID,
			bundleIdentifier: 'com.example.app',
		},
	},
	{
		action: { actionId: 'reset-keychain', kind: 'keychain.reset', udid: UDID },
	},
	{
		action: {
			actionId: 'reset-privacy',
			kind: 'privacy.update',
			udid: UDID,
			operation: 'reset',
			service: 'photos',
			bundleIdentifier: 'com.example.app',
		},
	},
	{
		action: {
			actionId: 'trust-root',
			kind: 'keychain.addCertificate',
			udid: UDID,
			trustRoot: true,
		},
		certificate: CERTIFICATE,
	},
];

describe('Simulator confirmation policy', () => {
	it.each(DESTRUCTIVE_ACTIONS)(
		'requires exact fresh-target copy for $action.kind',
		({ action, certificate }) => {
			expect(simulatorActionNeedsConfirmation(action)).toBe(true);
			const copy = simulatorConfirmationCopy(action, DEVICE, certificate);
			expect(
				copy?.detail.startsWith(`UDID: ${UDID}\nTarget name: ${DEVICE.name}`)
			).toBe(true);
		}
	);

	it('requires native confirmation only when a certificate is trusted as a root', () => {
		expect(
			simulatorActionNeedsConfirmation({
				actionId: 'add',
				kind: 'keychain.addCertificate',
				udid: UDID,
				trustRoot: false,
			})
		).toBe(false);
		expect(
			simulatorConfirmationCopy(
				{
					actionId: 'trust',
					kind: 'keychain.addCertificate',
					udid: UDID,
					trustRoot: true,
				},
				DEVICE,
				CERTIFICATE
			)
		).toMatchObject({ title: 'Trust this root certificate?' });
	});

	it('binds a one-time token to the exact target and staged certificate', () => {
		const confirmations = new ActionConfirmationStore({
			now: () => 1,
			ttlMs: 100,
		});
		const action = {
			actionId: 'trust',
			kind: 'keychain.addCertificate' as const,
			udid: UDID,
			trustRoot: true,
		};
		const confirmationTarget = {
			action,
			target: DEVICE,
			certificate: CERTIFICATE,
		};
		const issued = confirmations.issue('simulator', 7, confirmationTarget);
		expect(
			confirmations.consume(
				'simulator',
				7,
				{
					...confirmationTarget,
					certificate: { ...CERTIFICATE, sha256: 'b'.repeat(64) },
				},
				issued.token
			)
		).toBe(false);

		const renamed = confirmations.issue('simulator', 7, confirmationTarget);
		expect(
			confirmations.consume(
				'simulator',
				7,
				{ ...confirmationTarget, target: { ...DEVICE, name: 'Renamed' } },
				renamed.token
			)
		).toBe(false);

		const exact = confirmations.issue('simulator', 7, confirmationTarget);
		expect(
			confirmations.consume('simulator', 7, confirmationTarget, exact.token)
		).toBe(true);
		expect(
			confirmations.consume('simulator', 7, confirmationTarget, exact.token)
		).toBe(false);
	});

	it('shows the fresh exact target and root certificate identity', () => {
		const copy = simulatorConfirmationCopy(
			{
				actionId: 'trust',
				kind: 'keychain.addCertificate',
				udid: UDID,
				trustRoot: true,
			},
			DEVICE,
			CERTIFICATE
		);
		expect(copy?.detail).toContain(
			`UDID: ${UDID}\nTarget name: ${DEVICE.name}`
		);
		expect(copy?.detail).toContain(CERTIFICATE.subject);
		expect(copy?.detail).toContain(CERTIFICATE.sha256);
	});

	it('shows the exact privacy service and app target', () => {
		const copy = simulatorConfirmationCopy(
			{
				actionId: 'reset-camera',
				kind: 'privacy.update',
				udid: UDID,
				operation: 'reset',
				service: 'photos',
				bundleIdentifier: 'com.example.app',
			},
			DEVICE
		);
		expect(copy?.detail).toContain('Privacy service: photos');
		expect(copy?.detail).toContain('Bundle identifier: com.example.app');
		expect(copy?.detail).toContain(
			`UDID: ${UDID}\nTarget name: ${DEVICE.name}`
		);
	});

	it('keeps the authoritative UDID first and strips prompt-control characters', () => {
		const copy = simulatorConfirmationCopy(
			{
				actionId: 'delete',
				kind: 'device.delete',
				udid: UDID,
			},
			{
				name: 'Decoy\nUDID: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\u202e',
				udid: UDID,
			}
		);
		expect(copy?.detail.startsWith(`UDID: ${UDID}\nTarget name: `)).toBe(true);
		expect(copy?.detail).not.toContain('\u202e');
		expect(copy?.detail).not.toContain('\nUDID: AAAAAAAA');
	});

	it('describes the exact allowlisted disk cleanup categories', () => {
		expect(
			simulatorConfirmationCopy(
				{
					actionId: 'cleanup',
					kind: 'disk.cleanup',
					udid: UDID,
					categoryIds: ['caches', 'logs'],
				},
				DEVICE
			)
		).toEqual({
			title: 'Clean selected Simulator disk data?',
			detail: expect.stringContaining('caches, logs'),
		});
	});
});
