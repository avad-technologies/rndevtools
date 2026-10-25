import type { SimulatorAction } from '../shared/simulator-protocol';

export type SimulatorConfirmationCopy = { detail: string; title: string };
export type SimulatorConfirmationDevice = { name: string; udid: string };
export type SimulatorCertificateIdentity = {
	sha256: string;
	sizeBytes: number;
	subject?: string;
};

export function simulatorActionNeedsConfirmation(
	action: SimulatorAction
): boolean {
	return (
		action.kind === 'device.erase' ||
		action.kind === 'device.delete' ||
		action.kind === 'disk.cleanup' ||
		action.kind === 'app.uninstall' ||
		action.kind === 'keychain.reset' ||
		(action.kind === 'keychain.addCertificate' && action.trustRoot) ||
		(action.kind === 'privacy.update' && action.operation === 'reset')
	);
}

function safePromptLine(value: string): string {
	const withoutPromptControls = Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const isControl =
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x200e ||
			codePoint === 0x200f ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069);
		return isControl ? ' ' : character;
	}).join('');
	return (
		withoutPromptControls.replaceAll(/\s+/g, ' ').trim().slice(0, 160) ||
		'Unnamed Simulator'
	);
}

function exactTarget(device: SimulatorConfirmationDevice): string {
	return `UDID: ${device.udid}\nTarget name: ${safePromptLine(device.name)}`;
}

export function simulatorConfirmationCopy(
	action: SimulatorAction,
	device: SimulatorConfirmationDevice,
	certificate?: SimulatorCertificateIdentity
): SimulatorConfirmationCopy | undefined {
	if (action.kind === 'device.erase') {
		return {
			title: 'Erase this Simulator?',
			detail: `${exactTarget(device)}\n\nAll apps, app data, settings, and keychain data on this Simulator will be removed.`,
		};
	}
	if (action.kind === 'device.delete') {
		return {
			title: 'Delete this Simulator?',
			detail: `${exactTarget(device)}\n\nThis Simulator and all of its local data will be permanently deleted.`,
		};
	}
	if (action.kind === 'disk.cleanup') {
		return {
			title: 'Clean selected Simulator disk data?',
			detail: `${exactTarget(device)}\n\nOnly these pinned SimSlim cleanup categories will be deleted: ${action.categoryIds.join(', ')}. Durable app documents, app data, installed apps, and user media are never cleanup targets. A booted Simulator will be shut down and restored to its prior boot state.`,
		};
	}
	if (action.kind === 'app.uninstall') {
		return {
			title: 'Uninstall this app?',
			detail: `${exactTarget(device)}\n\nThe app and its data will be removed from this Simulator.\nBundle identifier: ${action.bundleIdentifier}`,
		};
	}
	if (action.kind === 'keychain.reset') {
		return {
			title: 'Reset the Simulator keychain?',
			detail: `${exactTarget(device)}\n\nAll keychain entries on this Simulator will be removed.`,
		};
	}
	if (action.kind === 'keychain.addCertificate' && action.trustRoot) {
		if (!certificate) return undefined;
		const subject = certificate.subject
			? `Certificate subject: ${certificate.subject}\n`
			: '';
		return {
			title: 'Trust this root certificate?',
			detail: `${exactTarget(device)}\n\n${subject}Certificate SHA-256: ${certificate.sha256}\nCertificate size: ${certificate.sizeBytes} bytes\n\nThis exact staged certificate will be added to this Simulator and trusted as a root certificate.`,
		};
	}
	if (action.kind === 'privacy.update' && action.operation === 'reset') {
		return {
			title: 'Reset privacy permissions?',
			detail: `${exactTarget(device)}\n\nPrivacy service: ${action.service}\nBundle identifier: ${action.bundleIdentifier}\n\nOnly this exact privacy permission state will be reset on this Simulator.`,
		};
	}
	return undefined;
}
