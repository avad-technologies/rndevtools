import { Alert } from 'react-native';
import type {
	DevToolsActionConfirmation,
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsAuditEvent,
} from '../types';
import {
	createDevToolsActionCoordinator,
	DEVTOOLS_ACTION_POLICY_VERSION,
} from './action-policy';
import { normalizeActionRequest } from './action-validation';
import { diagnosticErrorText } from './redact';
import { truncateText } from './serialize';

type ActionServicesOptions = {
	onError?: (error: unknown, pluginId: string) => void;
	onAuditEvent?: (event: DevToolsAuditEvent) => void;
};

function confirmAction(
	confirmation: DevToolsActionConfirmation,
): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			Alert.alert(
				confirmation.title,
				confirmation.message,
				[
					{
						text: 'Cancel',
						style: 'cancel',
						onPress: () => resolve(false),
					},
					{
						text: confirmation.confirmLabel ?? 'Continue',
						style: confirmation.destructive ? 'destructive' : 'default',
						onPress: () => resolve(true),
					},
				],
				{
					cancelable: true,
					onDismiss: () => resolve(false),
				},
			);
		} catch {
			resolve(false);
		}
	});
}

export function createActionServices({
	onError,
	onAuditEvent,
}: ActionServicesOptions): DevToolsActionServices {
	let nextRequestId = 0;
	const audit = (event: Omit<DevToolsAuditEvent, 'at'>) => {
		try {
			onAuditEvent?.({ ...event, at: Date.now() });
		} catch {
			// Host observability must never affect the requested operation.
		}
	};
	const coordinator = createDevToolsActionCoordinator({
		confirm: confirmAction,
	});

	return {
		run: async (request: DevToolsActionRequest): Promise<boolean> => {
			const normalizedRequest = normalizeActionRequest(request);
			if (!normalizedRequest) {
				const error = new Error('Invalid developer-tools action request.');
				try {
					onError?.(error, 'unknown');
				} catch {
					// A faulty host reporter must not escape validation either.
				}
				return false;
			}
			request = normalizedRequest;
			let actionError: unknown;
			const requestId = `legacy-${++nextRequestId}`;
			const confirmation = request.confirmation
				? { required: true as const, ...request.confirmation }
				: { required: false as const };
			const receipt = await coordinator.execute({
				plan: {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					requestId,
					actionFingerprint: requestId,
					capability: {
						schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
						id: request.pluginId,
						availability: 'available',
					},
					pluginId: request.pluginId,
					label: request.label,
					risk: request.confirmation?.destructive
						? 'destructive'
						: request.confirmation
							? 'confirmation'
							: 'safe',
					confirmation,
					rollback: { availability: 'not-applicable' },
				},
				action: async () => {
					audit({
						pluginId: request.pluginId,
						label: request.label,
						status: 'started',
					});
					try {
						await request.action();
					} catch (error) {
						actionError = error;
						throw error;
					}
				},
			});

			if (receipt.status === 'cancelled') {
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'cancelled',
				});
				return false;
			}
			if (receipt.status === 'succeeded') {
				audit({
					pluginId: request.pluginId,
					label: request.label,
					status: 'succeeded',
				});
				return true;
			}

			const error =
				actionError ?? new Error(receipt.error ?? 'Action rejected.');
			const message = truncateText(
				diagnosticErrorText(receipt.error ?? error),
				8 * 1024,
			).text;
			audit({
				pluginId: request.pluginId,
				label: request.label,
				status: 'failed',
				error: message,
			});
			try {
				onError?.(error, request.pluginId);
			} catch {
				// A faulty host reporter must not escape an action failure boundary.
			}
			try {
				Alert.alert(`${request.label} failed`, message);
			} catch {
				// Alerts are best-effort on unsupported/test renderers.
			}
			return false;
		},
	};
}
