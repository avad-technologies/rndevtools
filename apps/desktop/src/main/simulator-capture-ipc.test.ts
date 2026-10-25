import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { SimulatorCapture } from '../shared/simulator-protocol';
import {
	createSimulatorCaptureIpcHandlers,
	type SimulatorCaptureIpcService,
} from './simulator-capture-ipc';

const CAPTURE_ID = 'capture-12345678-1234-4123-8123-123456789abc';
const CAPTURE: SimulatorCapture = {
	id: CAPTURE_ID,
	deviceUdid: '11111111-2222-3333-4444-555555555555',
	kind: 'screenshot',
	status: 'complete',
	createdAt: 1,
	name: 'screenshot.png',
	mimeType: 'image/png',
	bytes: 12,
};
const RETENTION = {
	policy: { maxAgeDays: 30, maxTotalBytes: 10 * 1024 * 1024 * 1024 },
	captureCount: 1,
	totalBytes: 12,
};
const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent;

function fixture({ trusted = true, confirm = true } = {}) {
	const calls = {
		delete: vi.fn(async () => true),
		export: vi.fn(async () => undefined),
		reveal: vi.fn(async () => undefined),
	};
	const service: SimulatorCaptureIpcService = {
		getCapture: vi.fn(() => CAPTURE),
		getCaptureAccess: vi.fn(async (captureId) => ({
			captureId,
			available: true,
			url: `rndevtools-capture://capture/${captureId}`,
		})),
		getCaptureRetention: vi.fn(() => RETENTION),
		deleteCapture: calls.delete,
		exportCapture: calls.export,
		verifiedCapturePath: vi.fn(async () => '/private/managed/capture.png'),
		configureCaptureRetention: vi.fn(async (policy) => ({
			...RETENTION,
			policy,
		})),
	};
	const handlers = createSimulatorCaptureIpcHandlers({
		service,
		assertTrustedRenderer: () => {
			if (!trusted) throw new Error('Rejected IPC from an untrusted renderer.');
		},
		confirmDelete: vi.fn(async () => confirm),
		confirmRetentionUpdate: vi.fn(async () => confirm),
		selectExportDestination: vi.fn(async () => '/main-selected/export.png'),
		revealPath: calls.reveal,
	});
	return { calls, handlers, service };
}

describe('Simulator capture IPC', () => {
	it('checks renderer trust before parsing or invoking every capture endpoint', async () => {
		const { calls, handlers, service } = fixture({ trusted: false });
		await expect(handlers.getAccess(event, CAPTURE_ID)).rejects.toThrow(
			'untrusted renderer'
		);
		expect(() => handlers.getRetention(event)).toThrow('untrusted renderer');
		await expect(
			handlers.runOperation(event, {
				actionId: 'delete',
				kind: 'capture.delete',
				captureId: CAPTURE_ID,
			})
		).rejects.toThrow('untrusted renderer');
		expect(service.getCapture).not.toHaveBeenCalled();
		expect(calls.delete).not.toHaveBeenCalled();
	});

	it('rejects renderer-supplied paths at the strict IPC schema boundary', async () => {
		const { calls, handlers } = fixture();
		await expect(
			handlers.runOperation(event, {
				actionId: 'export',
				kind: 'capture.export',
				captureId: CAPTURE_ID,
				destinationPath: '/tmp/renderer-controlled',
			})
		).rejects.toThrow();
		expect(calls.export).not.toHaveBeenCalled();
	});

	it('returns only an opaque protocol URL for a verified capture', async () => {
		const { handlers } = fixture();
		await expect(handlers.getAccess(event, CAPTURE_ID)).resolves.toEqual({
			captureId: CAPTURE_ID,
			available: true,
			url: `rndevtools-capture://capture/${CAPTURE_ID}`,
		});
	});

	it('keeps delete confirmation and export destination selection in main', async () => {
		const cancelled = fixture({ confirm: false });
		await expect(
			cancelled.handlers.runOperation(event, {
				actionId: 'delete-cancelled',
				kind: 'capture.delete',
				captureId: CAPTURE_ID,
			})
		).resolves.toMatchObject({ completed: false, cancelled: true });
		expect(cancelled.calls.delete).not.toHaveBeenCalled();

		const accepted = fixture();
		const receipt = await accepted.handlers.runOperation(event, {
			actionId: 'export',
			kind: 'capture.export',
			captureId: CAPTURE_ID,
		});
		expect(accepted.calls.export).toHaveBeenCalledWith(
			CAPTURE_ID,
			'/main-selected/export.png'
		);
		expect(receipt).toEqual({
			actionId: 'export',
			kind: 'capture.export',
			completed: true,
			captureId: CAPTURE_ID,
		});
		expect(JSON.stringify(receipt)).not.toContain('/main-selected');
	});

	it('reveals only the store-verified internal path without returning it', async () => {
		const { calls, handlers, service } = fixture();
		const receipt = await handlers.runOperation(event, {
			actionId: 'reveal',
			kind: 'capture.reveal',
			captureId: CAPTURE_ID,
		});
		expect(service.verifiedCapturePath).toHaveBeenCalledWith(CAPTURE_ID);
		expect(calls.reveal).toHaveBeenCalledWith('/private/managed/capture.png');
		expect(JSON.stringify(receipt)).not.toContain('/private/managed');
	});

	it('applies only bounded retention policies and returns the resulting state', async () => {
		const cancelled = fixture({ confirm: false });
		await expect(
			cancelled.handlers.runOperation(event, {
				actionId: 'retention-cancelled',
				kind: 'capture.retention.update',
				policy: { maxAgeDays: 7, maxTotalBytes: 5 * 1024 * 1024 * 1024 },
			})
		).resolves.toMatchObject({ completed: false, cancelled: true });
		expect(cancelled.service.configureCaptureRetention).not.toHaveBeenCalled();

		const { handlers, service } = fixture();
		const receipt = await handlers.runOperation(event, {
			actionId: 'retention',
			kind: 'capture.retention.update',
			policy: { maxAgeDays: 7, maxTotalBytes: 5 * 1024 * 1024 * 1024 },
		});
		expect(service.configureCaptureRetention).toHaveBeenCalledWith({
			maxAgeDays: 7,
			maxTotalBytes: 5 * 1024 * 1024 * 1024,
		});
		expect(receipt).toMatchObject({
			completed: true,
			retention: { policy: { maxAgeDays: 7 } },
		});
	});
});
