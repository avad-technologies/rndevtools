import { createHash } from 'node:crypto';
import {
	DEFAULT_SCENARIO_USER_LIMIT,
	parseScenarioDocumentJson,
} from '@rndevtools/core/scenario-model';
import type { DesktopAction } from '../shared/protocol';

export type DesktopActionConfirmationCopy = Readonly<{
	title: string;
	message: string;
	detail: string;
	confirmLabel: string;
	destructive: boolean;
}>;

function payloadText(action: DesktopAction, key: string): string | undefined {
	const value = action.payload[key];
	return typeof value === 'string' ? value : undefined;
}

function payloadNumber(action: DesktopAction, key: string): number | undefined {
	const value = action.payload[key];
	return typeof value === 'number' ? value : undefined;
}

function securityDialogText(
	value: string | undefined,
	fallback: string
): string {
	const normalized = Array.from((value ?? '').normalize('NFKC'))
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const isControl =
				codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
			const isBidirectionalControl =
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069);
			return isControl || isBidirectionalControl ? ' ' : character;
		})
		.join('')
		.replace(/\s+/gu, ' ')
		.trim();
	if (!normalized) return fallback;
	return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
}

export function desktopActionConfirmationCopy(
	action: DesktopAction
): DesktopActionConfirmationCopy | undefined {
	if (action.tool !== 'scenarios') return undefined;
	const device = securityDialogText(action.deviceId, 'unknown device');
	if (action.command === 'execute') {
		return {
			title: 'Run this scenario?',
			message: 'Run this scenario on the connected app?',
			detail: `Device ${device} will execute scenario ${securityDialogText(payloadText(action, 'id'), 'unknown')} at version ${payloadNumber(action, 'version') ?? 'unknown'}. The mobile engine will retain rollback authority.`,
			confirmLabel: 'Run Scenario',
			destructive: false,
		};
	}
	if (action.command === 'undo') {
		return {
			title: 'Undo this scenario?',
			message: 'Restore the scenario rollback checkpoint?',
			detail: `Device ${device} will roll back exact receipt ${securityDialogText(payloadText(action, 'receiptId'), 'unknown')}.`,
			confirmLabel: 'Undo Scenario',
			destructive: true,
		};
	}
	if (action.command === 'discardRecovery') {
		return {
			title: 'Discard corrupt recovery data?',
			message: 'Remove the unreadable scenario recovery journal?',
			detail: `Device ${device} will discard only the corrupt scenario journal that matches the displayed error. Any app state left by the unreadable transaction must be reviewed manually.`,
			confirmLabel: 'Discard Journal',
			destructive: true,
		};
	}
	if (action.command === 'import') {
		const document = parseScenarioDocumentJson(
			payloadText(action, 'json') ?? '',
			{
				maxScenarios: DEFAULT_SCENARIO_USER_LIMIT,
			}
		);
		const mode = payloadText(action, 'mode');
		const source = payloadText(action, 'json') ?? '';
		const digest = createHash('sha256').update(source, 'utf8').digest('hex');
		const sourceBytes = Buffer.byteLength(source, 'utf8');
		const names = document.scenarios
			.slice(0, 3)
			.map((scenario) => securityDialogText(scenario.name, 'Unnamed scenario'))
			.join(', ');
		const remaining = Math.max(0, document.scenarios.length - 3);
		const summary = names
			? `${names}${remaining > 0 ? `, and ${remaining} more` : ''}`
			: 'no replacement scenarios';
		return {
			title: 'Import scenario definitions?',
			message: 'Change the connected app scenario library?',
			detail:
				mode === 'replace'
					? `Device ${device} will remove its current user scenario set and replace it with ${document.scenarios.length} strictly validated scenario${document.scenarios.length === 1 ? '' : 's'}: ${summary}. Exact document: ${sourceBytes} bytes, SHA-256 ${digest}.`
					: `Device ${device} will merge ${document.scenarios.length} strictly validated scenario${document.scenarios.length === 1 ? '' : 's'}: ${summary}. Existing definitions are preserved; matching IDs or a result above the ${DEFAULT_SCENARIO_USER_LIMIT}-scenario device limit are rejected atomically. Exact document: ${sourceBytes} bytes, SHA-256 ${digest}.`,
			confirmLabel: 'Import Scenarios',
			destructive: mode === 'replace',
		};
	}
	if (action.command === 'remove') {
		return {
			title: 'Delete this scenario?',
			message: 'Delete this user scenario from the connected app?',
			detail: `Device ${device} will delete scenario ${securityDialogText(payloadText(action, 'id'), 'unknown')} at version ${payloadNumber(action, 'version') ?? 'unknown'}.`,
			confirmLabel: 'Delete Scenario',
			destructive: true,
		};
	}
	return undefined;
}
