import type { PropsWithChildren, ReactNode } from 'react';
import {
	Platform,
	PlatformColor,
	Pressable,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { SystemIcon } from './system-icon';

/**
 * The single piece of custom chrome in the tools: a navigation row on the
 * same grouped background as the panel body (never a contrasting bar), with
 * everything below it rendered by Expo UI. Kept in React Native because
 * Expo UI has no navigation container and the row must host both SwiftUI
 * and Jetpack Compose accessories.
 */
export type PanelShellProps = PropsWithChildren<{
	title: string;
	onBack: () => void;
	backLabel?: string;
	trailing?: ReactNode;
}>;

export const iosColor = (name: string, fallback: string) =>
	Platform.OS === 'ios' ? PlatformColor(name) : fallback;

export const shellColors = {
	background: iosColor('systemGroupedBackgroundColor', '#F2F2F7'),
	label: iosColor('labelColor', '#000000'),
	tint: iosColor('systemBlueColor', '#007AFF'),
};

export function PanelShell({
	title,
	onBack,
	backLabel = 'Tools',
	trailing,
	children,
}: PanelShellProps) {
	return (
		<View style={styles.screen}>
			<View style={styles.nav}>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Back to ${backLabel}`}
					hitSlop={8}
					onPress={onBack}
					style={styles.back}
					testID="devtools-panel-back"
				>
					<SystemIcon
						color={shellColors.tint}
						size={17}
						systemName="chevron.left"
					/>
					<Text numberOfLines={1} style={styles.backLabel}>
						{backLabel}
					</Text>
				</Pressable>
				<View pointerEvents="none" style={styles.titleWrap}>
					<Text numberOfLines={1} style={styles.title}>
						{title}
					</Text>
				</View>
				<View style={styles.trailing}>{trailing}</View>
			</View>
			<View style={styles.body}>{children}</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		backgroundColor: shellColors.background,
		flex: 1,
	},
	nav: {
		alignItems: 'center',
		flexDirection: 'row',
		height: 48,
		justifyContent: 'space-between',
		paddingHorizontal: 16,
	},
	back: {
		alignItems: 'center',
		flexDirection: 'row',
		gap: 3,
		minWidth: 70,
	},
	backLabel: {
		color: shellColors.tint,
		fontSize: 17,
	},
	titleWrap: {
		alignItems: 'center',
		bottom: 0,
		justifyContent: 'center',
		left: 70,
		position: 'absolute',
		right: 70,
		top: 0,
	},
	title: {
		color: shellColors.label,
		fontSize: 17,
		fontWeight: '600',
	},
	trailing: {
		alignItems: 'center',
		flexDirection: 'row',
		gap: 14,
		justifyContent: 'flex-end',
		minWidth: 70,
	},
	body: {
		flex: 1,
	},
});
