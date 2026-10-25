import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { DevToolsPanelProps } from '../types';
import { createLazyCustomPlugin } from './custom';

const panelProps: DevToolsPanelProps = {
	onBack: jest.fn(),
	onClose: jest.fn(),
	presentationMode: 'sheet',
	onPresentationModeChange: jest.fn(),
	actions: { run: jest.fn(async () => true) },
};

describe('lazy custom plugins', () => {
	it('shows a loading state and resolves the application panel on demand', async () => {
		let resolvePanel:
			| ((panel: React.ComponentType<DevToolsPanelProps>) => void)
			| undefined;
		const plugin = createLazyCustomPlugin({
			id: 'lazy-fixtures',
			title: 'Lazy fixtures',
			description: 'Loaded only when opened',
			systemImage: 'shippingbox',
			load: () =>
				new Promise((resolve) => {
					resolvePanel = resolve;
				}),
		});
		const Panel = plugin.Panel;
		await render(<Panel {...panelProps} />);

		expect(screen.getByLabelText('Loading Lazy fixtures')).toBeOnTheScreen();
		resolvePanel?.(() => <Text>Application tool loaded</Text>);

		expect(
			await screen.findByText('Application tool loaded'),
		).toBeOnTheScreen();
	});
});
