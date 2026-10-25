import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon';
import { HugeiconsIcon } from '@hugeicons/react-native';
import { render } from '@testing-library/react-native';
import { SystemIcon, universalIconForSystemImage } from './system-icon';

jest.mock('@expo/ui', () => ({
	Icon: { select: ({ ios }: { ios: string }) => ios },
}));
jest.mock('@hugeicons/react-native', () => ({
	HugeiconsIcon: jest.fn(() => null),
}));

it('uses Hugeicons for content while preserving native toolbar symbols', async () => {
	await render(
		<SystemIcon systemName="text.bubble.fill" size={18} color="red" />,
	);
	expect(jest.mocked(HugeiconsIcon).mock.calls[0]?.[0]).toEqual(
		expect.objectContaining({ icon: BubbleChatIcon, size: 18, color: 'red' }),
	);
	expect(universalIconForSystemImage('chevron.left')).toBe('chevron.left');
	expect(universalIconForSystemImage('xmark')).toBe('xmark');
});
