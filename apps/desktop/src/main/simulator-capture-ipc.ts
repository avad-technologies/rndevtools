import type { IpcMainInvokeEvent } from 'electron';
import type {
	SimulatorCapture,
	SimulatorCaptureAccessResult,
	SimulatorCaptureOperationReceipt,
	SimulatorCaptureRetentionPolicy,
	SimulatorCaptureRetentionState,
} from '../shared/simulator-protocol';
import {
	simulatorCaptureAccessResultSchema,
	simulatorCaptureIdSchema,
	simulatorCaptureOperationReceiptSchema,
	simulatorCaptureOperationSchema,
	simulatorCaptureRetentionStateSchema,
} from '../shared/simulator-protocol';
import { safeErrorText } from './security';

export type SimulatorCaptureIpcService = {
	getCapture: (captureId: string) => SimulatorCapture | undefined;
	getCaptureAccess: (
		captureId: string
	) => Promise<SimulatorCaptureAccessResult>;
	getCaptureRetention: () => SimulatorCaptureRetentionState;
	deleteCapture: (captureId: string) => Promise<boolean>;
	exportCapture: (captureId: string, destinationPath: string) => Promise<void>;
	verifiedCapturePath: (captureId: string) => Promise<string>;
	configureCaptureRetention: (
		policy: SimulatorCaptureRetentionPolicy
	) => Promise<SimulatorCaptureRetentionState>;
};

type CaptureIpcDependencies = {
	service: SimulatorCaptureIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	confirmDelete: (
		event: IpcMainInvokeEvent,
		capture: SimulatorCapture
	) => Promise<boolean>;
	confirmRetentionUpdate: (
		event: IpcMainInvokeEvent,
		policy: SimulatorCaptureRetentionPolicy,
		current: SimulatorCaptureRetentionState
	) => Promise<boolean>;
	selectExportDestination: (
		event: IpcMainInvokeEvent,
		capture: SimulatorCapture
	) => Promise<string | undefined>;
	revealPath: (capturePath: string) => Promise<void> | void;
};

function failedReceipt(
	actionId: string,
	kind: SimulatorCaptureOperationReceipt['kind'],
	error: unknown,
	captureId?: string
): SimulatorCaptureOperationReceipt {
	return simulatorCaptureOperationReceiptSchema.parse({
		actionId,
		kind,
		completed: false,
		...(captureId ? { captureId } : {}),
		error: safeErrorText(error),
	});
}

export function createSimulatorCaptureIpcHandlers({
	service,
	assertTrustedRenderer,
	confirmDelete,
	confirmRetentionUpdate,
	selectExportDestination,
	revealPath,
}: CaptureIpcDependencies) {
	return {
		getAccess: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<SimulatorCaptureAccessResult> => {
			assertTrustedRenderer(event);
			const captureId = simulatorCaptureIdSchema.parse(value);
			return simulatorCaptureAccessResultSchema.parse(
				await service.getCaptureAccess(captureId)
			);
		},
		getRetention: (
			event: IpcMainInvokeEvent
		): SimulatorCaptureRetentionState => {
			assertTrustedRenderer(event);
			return simulatorCaptureRetentionStateSchema.parse(
				service.getCaptureRetention()
			);
		},
		runOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<SimulatorCaptureOperationReceipt> => {
			assertTrustedRenderer(event);
			const operation = simulatorCaptureOperationSchema.parse(value);
			if (operation.kind === 'capture.retention.update') {
				try {
					const current = service.getCaptureRetention();
					if (
						!(await confirmRetentionUpdate(event, operation.policy, current))
					) {
						return simulatorCaptureOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
							retention: current,
						});
					}
					const retention = await service.configureCaptureRetention(
						operation.policy
					);
					return simulatorCaptureOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						retention,
					});
				} catch (error) {
					return failedReceipt(operation.actionId, operation.kind, error);
				}
			}

			const capture = service.getCapture(operation.captureId);
			if (!capture) {
				return failedReceipt(
					operation.actionId,
					operation.kind,
					'Capture is not available.',
					operation.captureId
				);
			}
			try {
				if (operation.kind === 'capture.delete') {
					if (!(await confirmDelete(event, capture))) {
						return simulatorCaptureOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
							captureId: operation.captureId,
						});
					}
					if (!(await service.deleteCapture(operation.captureId))) {
						throw new Error('Capture is no longer available.');
					}
				} else if (operation.kind === 'capture.export') {
					const destinationPath = await selectExportDestination(event, capture);
					if (!destinationPath) {
						return simulatorCaptureOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
							captureId: operation.captureId,
						});
					}
					await service.exportCapture(operation.captureId, destinationPath);
				} else {
					const capturePath = await service.verifiedCapturePath(
						operation.captureId
					);
					await revealPath(capturePath);
				}
				return simulatorCaptureOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
					captureId: operation.captureId,
				});
			} catch (error) {
				return failedReceipt(
					operation.actionId,
					operation.kind,
					error,
					operation.captureId
				);
			}
		},
	};
}
