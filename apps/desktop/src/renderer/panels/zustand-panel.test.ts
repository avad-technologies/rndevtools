import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ZustandPanel } from './zustand-panel';

type Confirmation = {
	triggerLabel: string;
	title: string;
	description: string;
	confirmLabel: string;
	tone?: 'warning' | 'danger';
	onConfirm: () => void;
};

const { confirmations, runAction, tools } = vi.hoisted(() => ({
	confirmations: [] as Confirmation[],
	runAction: vi.fn(),
	tools: {
		zustandStores: [
			{
				id: 'cart',
				title: 'Cart',
				stateText: '{"items":[]}',
				keys: ['items'],
				updatedAt: 1,
				capabilities: {
					writable: true,
					resettable: true,
					persisted: false,
					restorable: true,
				},
			},
		],
		zustandChanges: [],
		zustandStateSnapshots: [
			{
				id: 'snapshot-1',
				storeId: 'cart',
				storeTitle: 'Cart',
				createdAt: Date.parse('2026-10-17T14:02:11.000Z'),
				stateText: '{"items":[1]}',
				stateBytes: 13,
				truncated: false,
			},
		],
		zustandMutationReceipts: [],
	},
}));

vi.mock('@/components/ui', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/components/ui')>()),
	ConfirmAction: (props: Confirmation) => {
		confirmations.push(props);
		return createElement('button', { type: 'button' }, props.triggerLabel);
	},
}));
vi.mock('@/state/desktop-runtime', () => ({
	useDesktopRuntime: () => ({
		canRunAction: () => true,
		runAction,
		selectedDevice: { tools },
	}),
}));

describe('ZustandPanel', () => {
	it('confirms Restore and Apply patch before they change the live store', () => {
		renderToStaticMarkup(createElement(ZustandPanel));
		const restore = confirmations.find(
			(confirmation) => confirmation.triggerLabel === 'Restore'
		);
		const patch = confirmations.find(
			(confirmation) => confirmation.triggerLabel === 'Apply patch'
		);
		expect(restore).toMatchObject({
			title: 'Restore Cart?',
			confirmLabel: 'Restore',
			tone: 'warning',
			description: expect.stringContaining('checkpointed first'),
		});
		expect(patch).toMatchObject({
			title: 'Apply this patch to Cart?',
			confirmLabel: 'Apply patch',
			tone: 'warning',
		});
		expect(runAction).not.toHaveBeenCalled();
		restore?.onConfirm();
		expect(runAction).toHaveBeenCalledWith(
			'zustand',
			'jump',
			{ storeId: 'cart', snapshotId: 'snapshot-1' },
			'Zustand state restored and verified.'
		);
		patch?.onConfirm();
		expect(runAction).toHaveBeenLastCalledWith(
			'zustand',
			'patch',
			{ storeId: 'cart', patchText: '{}' },
			'Zustand patch applied and verified.'
		);
	});
});
