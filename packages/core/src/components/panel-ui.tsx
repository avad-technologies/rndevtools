import { Platform, PlatformColor } from 'react-native';

const nativeColor = (iosName: string, androidColor: string) =>
	Platform.OS === 'ios' ? PlatformColor(iosName) : androidColor;

/**
 * iOS system palette for the shell's React Native chrome (launcher, pill,
 * floating window). Panel content renders in Expo UI and takes system
 * colors natively — do not build new panel UI from these tokens.
 */
export const colors = {
	background: nativeColor('systemGroupedBackgroundColor', '#FFFBFE'),
	card: nativeColor('secondarySystemGroupedBackgroundColor', '#F7F2FA'),
	label: nativeColor('labelColor', '#1D1B20'),
	secondaryLabel: nativeColor('secondaryLabelColor', '#49454F'),
	separator: nativeColor('separatorColor', '#CAC4D0'),
	fill: nativeColor('tertiarySystemFillColor', '#E8DEF8'),
	groupedFill: nativeColor('tertiarySystemGroupedBackgroundColor', '#F3EDF7'),
	blue: nativeColor('systemBlueColor', '#6750A4'),
	green: nativeColor('systemGreenColor', '#386A20'),
	orange: nativeColor('systemOrangeColor', '#8B5000'),
	red: nativeColor('systemRedColor', '#BA1A1A'),
	// PlatformColor('whiteColor') resolves unreliably on iOS 26.
	onAccent: '#FFFFFF',
	shadow: nativeColor('blackColor', '#000000'),
};
