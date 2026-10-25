import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DenseVirtualList } from './simulator-ui';

type ListViewProps = {
	items: readonly object[];
	dependencies?: readonly unknown[];
	children: (item: object) => ReactNode;
};

// React Aria keeps each rendered row until `dependencies` change; this stand-in
// records what the list hands it.
const listViews = vi.hoisted(() => [] as ListViewProps[]);
vi.mock('@heroui-pro/react/list-view', () => ({
	ListView: Object.assign(
		(props: ListViewProps) => {
			listViews.push(props);
			return createElement(
				Fragment,
				null,
				props.items.map((item, index) =>
					createElement(Fragment, { key: index }, props.children(item))
				)
			);
		},
		{
			Item: ({ children }: { children: ReactNode }) =>
				createElement('div', null, children),
		}
	),
}));

describe('DenseVirtualList', () => {
	it('re-renders cached rows when data renderItem reads beside the item changes', () => {
		const targets = [{ udid: 'AAAAAAAA-0000-4000-8000-000000000001' }];
		const render = (chips: ReadonlyMap<string, string>) =>
			renderToStaticMarkup(
				createElement(DenseVirtualList<{ udid: string }>, {
					ariaLabel: 'Simulator fleet',
					items: targets,
					getId: (target) => target.udid,
					dependencies: [chips],
					textValue: (target) => target.udid,
					renderItem: (target) => chips.get(target.udid) ?? 'no lane',
				})
			);
		const before = new Map<string, string>();
		const after = new Map([[targets[0]?.udid ?? '', ':8102 ready']]);
		expect(render(before)).toContain('no lane');
		expect(render(after)).toContain(':8102 ready');
		const [first, second] = listViews.map((props) => props.dependencies);
		// Same items, so only a changed dependency makes React Aria drop its row.
		expect(first).toContain(before);
		expect(second).toContain(after);
		expect(first).toHaveLength(second?.length ?? 0);
	});
});
