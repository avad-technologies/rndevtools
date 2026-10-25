import type { IpcMainInvokeEvent } from 'electron';
import type {
	BuildInsightsOperationReceipt,
	BuildInsightsState,
} from '../shared/build-insights-protocol';
import {
	buildInsightsOperationReceiptSchema,
	buildInsightsOperationSchema,
	buildInsightsStateSchema,
} from '../shared/build-insights-protocol';
import { safeErrorText } from './security';

type BuildInsightsIpcService = {
	getState: () => BuildInsightsState;
	importXcresult: (selectedPath: string) => Promise<BuildInsightsState>;
	addWatchRoot: (selectedPath: string) => Promise<BuildInsightsState>;
	refresh: (sourceId?: string) => Promise<BuildInsightsState>;
	export: (format: 'csv' | 'json', destinationPath: string) => Promise<void>;
};

type BuildInsightsIpcDependencies = {
	service: BuildInsightsIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	selectXcresult: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
	selectWatchRoot: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
	selectExportDestination: (
		event: IpcMainInvokeEvent,
		format: 'csv' | 'json'
	) => Promise<string | undefined>;
};

export function createBuildInsightsIpcHandlers({
	service,
	assertTrustedRenderer,
	selectXcresult,
	selectWatchRoot,
	selectExportDestination,
}: BuildInsightsIpcDependencies) {
	return {
		getState: (event: IpcMainInvokeEvent): BuildInsightsState => {
			assertTrustedRenderer(event);
			return buildInsightsStateSchema.parse(service.getState());
		},
		runOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<BuildInsightsOperationReceipt> => {
			assertTrustedRenderer(event);
			const operation = buildInsightsOperationSchema.parse(value);
			try {
				if (operation.kind === 'build.import-xcresult') {
					const selectedPath = await selectXcresult(event);
					if (!selectedPath) {
						return buildInsightsOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
						});
					}
					const state = await service.importXcresult(selectedPath);
					return buildInsightsOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					});
				}
				if (operation.kind === 'build.add-watch-root') {
					const selectedPath = await selectWatchRoot(event);
					if (!selectedPath) {
						return buildInsightsOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
						});
					}
					const state = await service.addWatchRoot(selectedPath);
					return buildInsightsOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					});
				}
				if (operation.kind === 'build.refresh') {
					const state = await service.refresh(operation.sourceId);
					return buildInsightsOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					});
				}
				const destinationPath = await selectExportDestination(
					event,
					operation.format
				);
				if (!destinationPath) {
					return buildInsightsOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						cancelled: true,
					});
				}
				await service.export(operation.format, destinationPath);
				return buildInsightsOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
				});
			} catch (error) {
				return buildInsightsOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: false,
					error: safeErrorText(error),
				});
			}
		},
	};
}
