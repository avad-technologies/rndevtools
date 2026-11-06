import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createFailureIpcHandlers } from './failure-ipc';

const state = { records: [], checkedAt: 0, monitoring: true, issues: [] };
const event = {} as IpcMainInvokeEvent;
describe('failure IPC boundary', () => {
	it('checks renderer trust and validates requests before invoking privileged code', async () => {
		const getState = vi.fn(() => state);
		const runOperation = vi.fn(async () => ({ state }));
		const trust = vi.fn();
		const handlers = createFailureIpcHandlers(
			{ getState, runOperation },
			trust
		);
		expect(handlers.getState(event)).toEqual(state);
		await expect(
			handlers.runOperation(event, { operation: 'scan', command: 'arbitrary' })
		).rejects.toThrow();
		expect(runOperation).not.toHaveBeenCalled();
		trust.mockImplementation(() => {
			throw new Error('untrusted');
		});
		expect(() => handlers.getState(event)).toThrow('untrusted');
		await expect(
			handlers.runOperation(event, { operation: 'scan' })
		).rejects.toThrow('untrusted');
		expect(getState).toHaveBeenCalledOnce();
		expect(runOperation).not.toHaveBeenCalled();
	});
});
