import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopForQuit } from './quit-sequence';

describe('stopForQuit', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('stops the services recipe teardown needs only after recipe runs have stopped', async () => {
		const order: string[] = [];
		let finishRecipes: () => void = () => undefined;
		const recipesStopped = new Promise<void>((resolve) => {
			finishRecipes = () => {
				order.push('recipes');
				resolve();
			};
		});
		const quitting = stopForQuit(recipesStopped, () => {
			order.push('services');
			return [Promise.resolve(), undefined];
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(order).toEqual([]);
		finishRecipes();
		await quitting;
		expect(order).toEqual(['recipes', 'services']);
	});

	it('stops the services anyway once the recipe budget runs out', async () => {
		vi.useFakeTimers();
		const stopServices = vi.fn(() => [Promise.resolve()]);
		const quitting = stopForQuit(
			new Promise(() => undefined),
			stopServices,
			1_000
		);
		await vi.advanceTimersByTimeAsync(999);
		expect(stopServices).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await quitting;
		expect(stopServices).toHaveBeenCalledTimes(1);
	});

	it('never rejects, whether a stop rejects or throws', async () => {
		await expect(
			stopForQuit(Promise.reject(new Error('teardown failed')), () => [
				Promise.reject(new Error('broker failed')),
			])
		).resolves.toBeUndefined();
		await expect(
			stopForQuit(undefined, () => {
				throw new Error('stop threw');
			})
		).resolves.toBeUndefined();
	});
});
