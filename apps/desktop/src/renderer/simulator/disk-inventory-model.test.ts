import { describe, expect, it } from 'vitest';
import type { SimulatorDiskInventory } from '../../shared/simulator-protocol';
import {
	defaultDiskCleanupCategoryIds,
	diskInventorySelectionRevision,
	sanitizeDiskCleanupCategoryIds,
} from './disk-inventory-model';

const INVENTORY: SimulatorDiskInventory = {
	simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
	totalBytes: 1_000,
	cleanableBytes: 400,
	inspectedAt: 100,
	categories: [
		{
			id: 'caches',
			name: 'Caches',
			description: 'Rebuildable caches.',
			downside: 'First launch may be slower.',
			recovery: 'Launch the app again.',
			risk: 'low',
			defaultSelected: true,
			canClean: true,
			bytes: 250,
			targets: 2,
		},
		{
			id: 'linguistic-data',
			name: 'Linguistic data',
			description: 'Optional language assets.',
			downside: 'May be downloaded again.',
			recovery: 'Use affected language features.',
			risk: 'medium',
			defaultSelected: false,
			canClean: true,
			bytes: 150,
			targets: 1,
		},
		{
			id: 'required-siri-assets',
			name: 'Required Siri assets',
			description: 'Required runtime content.',
			downside: 'Must remain installed.',
			recovery: 'Reinstall the runtime.',
			risk: 'blocked',
			defaultSelected: true,
			canClean: false,
			bytes: 600,
			targets: 1,
		},
	],
	storage: [],
};

describe('Fleet disk cleanup selection', () => {
	it('selects only allowlisted, explicitly cleanable defaults', () => {
		expect(defaultDiskCleanupCategoryIds(INVENTORY)).toEqual(['caches']);
	});

	it('drops duplicates, blocked categories, and unknown input', () => {
		expect(
			sanitizeDiskCleanupCategoryIds(INVENTORY, [
				'linguistic-data',
				'linguistic-data',
				'required-siri-assets',
				'arbitrary-host-path',
			])
		).toEqual(['linguistic-data']);
	});

	it('does not reset selection for equivalent cloned state broadcasts', () => {
		const equivalentClone = structuredClone(INVENTORY);
		expect(diskInventorySelectionRevision(equivalentClone)).toBe(
			diskInventorySelectionRevision(INVENTORY)
		);
		expect(
			diskInventorySelectionRevision({ ...equivalentClone, inspectedAt: 101 })
		).not.toBe(diskInventorySelectionRevision(INVENTORY));
	});
});
