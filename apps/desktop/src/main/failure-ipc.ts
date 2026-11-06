import type { IpcMainInvokeEvent } from 'electron';
import {
	failureRequestSchema,
	failureResultSchema,
	failureStateSchema,
} from '../shared/failure-protocol';
import type { FailureService } from './failure-service';

export function createFailureIpcHandlers(
	service: Pick<FailureService, 'getState' | 'runOperation'>,
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void
) {
	return {
		getState: (event: IpcMainInvokeEvent) => {
			assertTrustedRenderer(event);
			return failureStateSchema.parse(service.getState());
		},
		runOperation: async (event: IpcMainInvokeEvent, value: unknown) => {
			assertTrustedRenderer(event);
			return failureResultSchema.parse(
				await service.runOperation(failureRequestSchema.parse(value))
			);
		},
	};
}
