import { Host as UniversalHost, Picker as UniversalPicker } from '@expo/ui';
import { Host, Picker, Text as SwiftUIText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Platform, StyleSheet } from 'react-native';
import type { DevToolsSystemImage } from '../types';

/**
 * Segmented control for the shell's own chrome (presentation switcher).
 * Panels build their pickers directly in Expo UI.
 */
export function PanelSegmentedControl<T extends string>({
	options,
	selected,
	onChange,
	accessibilityLabel,
}: {
	options: ReadonlyArray<{
		id: T;
		label: string;
		systemImage?: DevToolsSystemImage;
	}>;
	selected: T;
	onChange: (value: T) => void;
	accessibilityLabel?: string;
}) {
	if (Platform.OS !== 'ios') {
		return (
			<UniversalHost style={styles.segmentedHost}>
				<UniversalPicker<T>
					appearance="menu"
					onValueChange={onChange}
					selectedValue={selected}
					testID={accessibilityLabel}
				>
					{options.map((option) => (
						<UniversalPicker.Item
							key={option.id}
							label={option.label}
							value={option.id}
						/>
					))}
				</UniversalPicker>
			</UniversalHost>
		);
	}
	return (
		<Host style={styles.segmentedHost}>
			<Picker<T>
				label={accessibilityLabel ?? 'Selection'}
				modifiers={[pickerStyle('segmented')]}
				onSelectionChange={onChange}
				selection={selected}
			>
				{options.map((option) => (
					<SwiftUIText key={option.id} modifiers={[tag(option.id)]}>
						{option.label}
					</SwiftUIText>
				))}
			</Picker>
		</Host>
	);
}

const styles = StyleSheet.create({
	segmentedHost: {
		height: 32,
		width: '100%',
	},
});
