import { createRefCountedInstaller } from './ref-counted-installer';

describe('createRefCountedInstaller', () => {
	it('sets up once and cleans up after the final idempotent reference', () => {
		const cleanup = jest.fn();
		const setup = jest.fn(({ addCleanup }) => addCleanup(cleanup));
		const install = createRefCountedInstaller(setup);
		const first = install();
		const second = install();

		expect(setup).toHaveBeenCalledTimes(1);
		first();
		first();
		expect(cleanup).not.toHaveBeenCalled();
		second();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('rolls back partial setup and allows a later retry', () => {
		const cleanup = jest.fn();
		let attempts = 0;
		const install = createRefCountedInstaller(({ addCleanup }) => {
			attempts += 1;
			addCleanup(cleanup);
			if (attempts === 1) throw new Error('subscription failed');
		});

		expect(install).toThrow('subscription failed');
		expect(cleanup).toHaveBeenCalledTimes(1);
		const dispose = install();
		expect(attempts).toBe(2);
		dispose();
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
});
