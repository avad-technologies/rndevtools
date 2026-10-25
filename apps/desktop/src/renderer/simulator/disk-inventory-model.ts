import type {
	SimulatorDiskCleanupCategoryId,
	SimulatorDiskInventory,
} from '../../shared/simulator-protocol';

const CLEANABLE_CATEGORY_IDS = new Set<SimulatorDiskCleanupCategoryId>([
	'caches',
	'logs',
	'temporary',
	'linguistic-data',
]);

export function diskInventorySelectionRevision(
	inventory: SimulatorDiskInventory | undefined
): string {
	if (!inventory) return 'none';
	return JSON.stringify([
		inventory.simulatorUdid,
		inventory.inspectedAt,
		inventory.lastCleanup?.cleanedAt ?? null,
	]);
}

export function sanitizeDiskCleanupCategoryIds(
	inventory: SimulatorDiskInventory,
	categoryIds: readonly string[]
): SimulatorDiskCleanupCategoryId[] {
	const allowed = new Set(
		inventory.categories
			.filter(
				(
					category
				): category is typeof category & {
					id: SimulatorDiskCleanupCategoryId;
				} =>
					category.canClean &&
					CLEANABLE_CATEGORY_IDS.has(
						category.id as SimulatorDiskCleanupCategoryId
					)
			)
			.map((category) => category.id)
	);
	return [...new Set(categoryIds)]
		.filter((id): id is SimulatorDiskCleanupCategoryId =>
			CLEANABLE_CATEGORY_IDS.has(id as SimulatorDiskCleanupCategoryId)
		)
		.filter((id) => allowed.has(id))
		.slice(0, 4);
}

export function defaultDiskCleanupCategoryIds(
	inventory: SimulatorDiskInventory
): SimulatorDiskCleanupCategoryId[] {
	return sanitizeDiskCleanupCategoryIds(
		inventory,
		inventory.categories
			.filter((category) => category.defaultSelected)
			.map((category) => category.id)
	);
}
