import type { PropsWithChildren, ReactNode } from 'react';
import {
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';
import { colors } from './panel-ui';

export function AndroidPanelScroll({ children }: PropsWithChildren) {
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			showsVerticalScrollIndicator={false}
		>
			{children}
		</ScrollView>
	);
}

export function AndroidPanelSection({
	title,
	footer,
	children,
}: PropsWithChildren<{ title?: string; footer?: string }>) {
	return (
		<View style={styles.section}>
			{title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
			<View style={styles.group}>{children}</View>
			{footer ? <Text style={styles.footer}>{footer}</Text> : null}
		</View>
	);
}

export function AndroidPanelRow({
	label,
	value,
	detail,
	onPress,
	tone = 'default',
	trailing,
}: {
	label: string;
	value?: string;
	detail?: string;
	onPress?: () => void;
	tone?: 'default' | 'danger' | 'success' | 'warning';
	trailing?: ReactNode;
}) {
	const content = (
		<>
			<View style={styles.rowCopy}>
				<Text
					style={[
						styles.rowLabel,
						tone === 'danger' && styles.danger,
						tone === 'success' && styles.success,
						tone === 'warning' && styles.warning,
					]}
				>
					{label}
				</Text>
				{detail ? <Text style={styles.detail}>{detail}</Text> : null}
			</View>
			{value ? (
				<Text numberOfLines={2} style={styles.value}>
					{value}
				</Text>
			) : null}
			{trailing}
		</>
	);

	return onPress ? (
		<Pressable
			accessibilityRole="button"
			onPress={onPress}
			style={({ pressed }) => [styles.row, pressed && styles.pressed]}
		>
			{content}
		</Pressable>
	) : (
		<View style={styles.row}>{content}</View>
	);
}

export function AndroidPanelTextBlock({
	label,
	value,
	tone = 'default',
}: {
	label: string;
	value: string;
	tone?: 'default' | 'danger' | 'warning';
}) {
	return (
		<View style={styles.textBlock}>
			<Text style={styles.textBlockLabel}>{label}</Text>
			<Text
				selectable
				style={[
					styles.textBlockValue,
					tone === 'danger' && styles.danger,
					tone === 'warning' && styles.warning,
				]}
			>
				{value}
			</Text>
		</View>
	);
}

export function AndroidPanelSearch({
	placeholder,
	value,
	onChangeText,
	secureTextEntry = false,
}: {
	placeholder: string;
	value: string;
	onChangeText: (value: string) => void;
	secureTextEntry?: boolean;
}) {
	return (
		<TextInput
			autoCapitalize="none"
			autoCorrect={false}
			onChangeText={onChangeText}
			placeholder={placeholder}
			placeholderTextColor={colors.secondaryLabel}
			secureTextEntry={secureTextEntry}
			style={styles.search}
			value={value}
		/>
	);
}

export function AndroidPanelTabs<T extends string>({
	options,
	selected,
	onSelect,
}: {
	options: readonly { label: string; value: T }[];
	selected: T;
	onSelect: (value: T) => void;
}) {
	return (
		<View style={styles.tabs}>
			{options.map((option) => (
				<Pressable
					accessibilityRole="tab"
					accessibilityState={{ selected: option.value === selected }}
					key={option.value}
					onPress={() => onSelect(option.value)}
					style={[styles.tab, option.value === selected && styles.selectedTab]}
				>
					<Text
						style={[
							styles.tabText,
							option.value === selected && styles.selectedTabText,
						]}
					>
						{option.label}
					</Text>
				</Pressable>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { gap: 14, padding: 12, paddingBottom: 32 },
	section: { gap: 6 },
	sectionTitle: {
		color: colors.secondaryLabel,
		fontSize: 13,
		fontWeight: '600',
		paddingHorizontal: 4,
	},
	group: {
		backgroundColor: colors.card,
		borderRadius: 13,
		overflow: 'hidden',
	},
	footer: { color: colors.secondaryLabel, fontSize: 12, paddingHorizontal: 4 },
	row: {
		alignItems: 'center',
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		gap: 12,
		minHeight: 52,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	pressed: { backgroundColor: colors.fill },
	rowCopy: { flex: 1, gap: 2 },
	rowLabel: { color: colors.label, fontSize: 15 },
	detail: { color: colors.secondaryLabel, fontSize: 12 },
	value: {
		color: colors.secondaryLabel,
		fontSize: 13,
		maxWidth: '48%',
		textAlign: 'right',
	},
	textBlock: { gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
	textBlockLabel: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
	},
	textBlockValue: {
		color: colors.label,
		fontFamily: 'monospace',
		fontSize: 12,
		lineHeight: 17,
	},
	danger: { color: '#D70015' },
	success: { color: '#1D8A3E' },
	warning: { color: '#C45A00' },
	search: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.label,
		fontSize: 15,
		height: 48,
		paddingHorizontal: 14,
	},
	tabs: {
		backgroundColor: colors.fill,
		borderRadius: 10,
		flexDirection: 'row',
		padding: 3,
	},
	tab: {
		alignItems: 'center',
		borderRadius: 8,
		flex: 1,
		justifyContent: 'center',
		minHeight: 36,
		paddingHorizontal: 6,
	},
	selectedTab: { backgroundColor: colors.card },
	tabText: { color: colors.secondaryLabel, fontSize: 12, fontWeight: '600' },
	selectedTabText: { color: colors.label },
});
