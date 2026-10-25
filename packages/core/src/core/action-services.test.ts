import { Alert } from 'react-native';
import { createActionServices } from './action-services';

describe('createActionServices', () => {
	it('runs actions even when the host audit callback throws', async () => {
		const action = jest.fn();
		const services = createActionServices({
			onAuditEvent: () => {
				throw new Error('audit unavailable');
			},
		});

		await expect(
			services.run({ pluginId: 'safe', label: 'Safe action', action }),
		).resolves.toBe(true);
		expect(action).toHaveBeenCalledTimes(1);
	});
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('audits successful actions', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(1234);
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		const services = createActionServices({ onAuditEvent });

		await expect(
			services.run({ pluginId: 'query', label: 'Refetch', action }),
		).resolves.toBe(true);

		expect(action).toHaveBeenCalledTimes(1);
		expect(onAuditEvent.mock.calls).toEqual([
			[
				{
					at: 1234,
					pluginId: 'query',
					label: 'Refetch',
					status: 'started',
				},
			],
			[
				{
					at: 1234,
					pluginId: 'query',
					label: 'Refetch',
					status: 'succeeded',
				},
			],
		]);
	});

	it('does not run a cancelled confirmed action', async () => {
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		jest
			.spyOn(Alert, 'alert')
			.mockImplementation((_title, _message, buttons) => {
				buttons?.[0]?.onPress?.();
			});
		const services = createActionServices({ onAuditEvent });

		await expect(
			services.run({
				pluginId: 'storage',
				label: 'Clear',
				confirmation: {
					title: 'Clear storage?',
					destructive: true,
				},
				action,
			}),
		).resolves.toBe(false);

		expect(action).not.toHaveBeenCalled();
		expect(onAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		);
	});

	it('treats a dismissed confirmation as cancellation', async () => {
		const action = jest.fn();
		jest
			.spyOn(Alert, 'alert')
			.mockImplementation((_title, _message, _buttons, options) => {
				options?.onDismiss?.();
			});
		const services = createActionServices({});

		await expect(
			services.run({
				pluginId: 'restore',
				label: 'Restore',
				confirmation: { title: 'Restore state?' },
				action,
			}),
		).resolves.toBe(false);
		expect(action).not.toHaveBeenCalled();
	});

	it('routes failures, shows a useful alert, and audits the error', async () => {
		const error = new Error('database unavailable');
		const onError = jest.fn();
		const onAuditEvent = jest.fn();
		const alert = jest.spyOn(Alert, 'alert').mockImplementation();
		const services = createActionServices({ onError, onAuditEvent });

		await expect(
			services.run({
				pluginId: 'database',
				label: 'Refresh database',
				action: () => {
					throw error;
				},
			}),
		).resolves.toBe(false);

		expect(onError).toHaveBeenCalledWith(error, 'database');
		expect(alert).toHaveBeenCalledWith(
			'Refresh database failed',
			'database unavailable',
		);
		expect(onAuditEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				error: 'database unavailable',
			}),
		);
	});

	it('redacts credentials before surfacing action failures', async () => {
		const onAuditEvent = jest.fn();
		const alert = jest.spyOn(Alert, 'alert').mockImplementation();
		const services = createActionServices({ onAuditEvent });

		await services.run({
			pluginId: 'network',
			label: 'Replay',
			action: () => {
				throw new Error('token=private-action-token');
			},
		});

		expect(JSON.stringify(onAuditEvent.mock.calls)).not.toContain(
			'private-action-token',
		);
		expect(JSON.stringify(alert.mock.calls)).not.toContain(
			'private-action-token',
		);
	});

	it('rejects malformed requests without invoking extension accessors', async () => {
		const action = jest.fn();
		const labelGetter = jest.fn(() => 'Unsafe action');
		const request = { pluginId: 'unsafe', action } as Record<string, unknown>;
		Object.defineProperty(request, 'label', {
			enumerable: true,
			get: labelGetter,
		});
		const onError = jest.fn();
		const services = createActionServices({ onError });

		await expect(services.run(request as never)).resolves.toBe(false);
		expect(labelGetter).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(expect.any(Error), 'unknown');
	});

	it('fails closed when a panel supplies a malformed confirmation', async () => {
		const action = jest.fn();
		const alert = jest.spyOn(Alert, 'alert').mockImplementation();
		const titleGetter = jest.fn(() => 'Delete everything?');
		const confirmation = {} as Record<string, unknown>;
		Object.defineProperty(confirmation, 'title', {
			enumerable: true,
			get: titleGetter,
		});
		const services = createActionServices({});

		await expect(
			services.run({
				pluginId: 'storage',
				label: 'Clear',
				confirmation: confirmation as never,
				action,
			}),
		).resolves.toBe(false);
		expect(titleGetter).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});

	it('detaches and redacts labels before auditing extension actions', async () => {
		const onAuditEvent = jest.fn();
		const request = {
			pluginId: 'network',
			label: 'Replay token=private-label-token',
			action: jest.fn(),
		};
		const services = createActionServices({ onAuditEvent });

		await expect(services.run(request)).resolves.toBe(true);
		request.label = 'Changed after start';

		expect(JSON.stringify(onAuditEvent.mock.calls)).not.toContain(
			'private-label-token',
		);
		expect(onAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Replay token=[REDACTED]' }),
		);
	});

	it('bounds long display text without disabling otherwise valid actions', async () => {
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		jest
			.spyOn(Alert, 'alert')
			.mockImplementation((_title, _message, buttons) => {
				buttons?.[1]?.onPress?.();
			});
		const services = createActionServices({ onAuditEvent });

		await expect(
			services.run({
				pluginId: 'components',
				label: `Highlight ${'target'.repeat(100)}`,
				confirmation: {
					title: `Highlight ${'target'.repeat(100)}?`,
					message: 'details '.repeat(500),
				},
				action,
			}),
		).resolves.toBe(true);

		expect(action).toHaveBeenCalledTimes(1);
		const confirmationCall = jest.mocked(Alert.alert).mock.calls[0];
		expect(
			new TextEncoder().encode(confirmationCall?.[0]).byteLength,
		).toBeLessThanOrEqual(256);
		expect(
			new TextEncoder().encode(confirmationCall?.[1] ?? '').byteLength,
		).toBeLessThanOrEqual(1_024);
		expect(
			new TextEncoder().encode(onAuditEvent.mock.calls[0]?.[0]?.label)
				.byteLength,
		).toBeLessThanOrEqual(256);
	});
});
