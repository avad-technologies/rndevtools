/**
 * How long quitting lets running recipes cancel and run their teardown before
 * it stops the services that teardown needs anyway.
 */
const RECIPE_QUIT_BUDGET_MS = 10_000;

/**
 * Stops the desktop's services for quit, and never rejects. Recipe runs stop
 * first: a cancelled run still runs its teardown, which drives the Simulator,
 * slimming, and broker services, so `stopServices` is called only once the
 * teardown has finished, or once `budgetMs` has passed.
 */
export async function stopForQuit(
	recipesStopped: Promise<unknown> | undefined,
	stopServices: () => readonly (Promise<unknown> | undefined)[],
	budgetMs = RECIPE_QUIT_BUDGET_MS
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.resolve(recipesStopped).catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, budgetMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	try {
		await Promise.allSettled(stopServices());
	} catch {
		// A stop that throws instead of rejecting must not keep the app open.
	}
}
