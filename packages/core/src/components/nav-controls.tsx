import {
	Button as UniversalButton,
	Host as UniversalHost,
	Icon as UniversalIcon,
} from '@expo/ui';
import { Button, Host, Image } from '@expo/ui/swift-ui';
import { buttonStyle, tint } from '@expo/ui/swift-ui/modifiers';
import { Platform, PlatformColor } from 'react-native';
import type { DevToolsSystemImage } from '../types';
import { colors } from './panel-ui';
import { universalIconForSystemImage } from './system-icon';

/**
 * Icon button for the panel shell's trailing slot, composed entirely from
 * Expo UI on iOS (SwiftUI plain Button + SF Symbol). Android uses the
 * universal Expo UI button and Material Symbol implementation.
 */
export function NavIconButton({
	systemImage,
	accessibilityLabel,
	destructive = false,
	onPress,
	testID,
}: {
	systemImage: DevToolsSystemImage;
	accessibilityLabel: string;
	destructive?: boolean;
	onPress: () => void;
	testID?: string;
}) {
	if (Platform.OS !== 'ios') {
		return (
			<UniversalHost matchContents testID={testID}>
				<UniversalButton
					onPress={onPress}
					variant="text"
					style={{ height: 44, width: 44 }}
				>
					<UniversalIcon
						accessibilityLabel={accessibilityLabel}
						color={destructive ? colors.red : colors.blue}
						name={universalIconForSystemImage(systemImage)}
						size={20}
					/>
				</UniversalButton>
			</UniversalHost>
		);
	}
	return (
		<Host matchContents testID={testID}>
			<Button
				modifiers={[
					buttonStyle('plain'),
					tint(
						destructive
							? PlatformColor('systemRedColor')
							: PlatformColor('systemBlueColor'),
					),
				]}
				onPress={onPress}
			>
				<Image
					color={
						destructive
							? PlatformColor('systemRedColor')
							: PlatformColor('systemBlueColor')
					}
					size={18}
					systemName={systemImage}
				/>
			</Button>
		</Host>
	);
}
