import { MenuView } from '@expo/ui/community/menu';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { RectButton, ScrollView } from 'react-native-gesture-handler';
import { groupPlugins, hasPillQuickAction } from '../core/plugins';
import type { DevToolsPlugin } from '../types';
import { colors } from './panel-ui';
import { SystemIcon } from './system-icon';

type ToolListProps = {
	plugins: readonly DevToolsPlugin[];
	onSelect: (plugin: DevToolsPlugin) => void;
	pinnedPillQuickActionIds?: readonly string[];
	onQuickActionPinnedChange?: (pluginId: string, isPinned: boolean) => void;
};

export function ToolList({
	plugins,
	onSelect,
	pinnedPillQuickActionIds = [],
	onQuickActionPinnedChange,
}: ToolListProps) {
	const sections = groupPlugins(plugins);
	const RowButton = Platform.OS === 'ios' ? RectButton : Pressable;
	const renderRow = (
		plugin: DevToolsPlugin,
		index: number,
		sectionLength: number,
	) => {
		const row = (
			<RowButton
				accessibilityHint={plugin.description}
				accessibilityLabel={plugin.title}
				accessibilityRole="button"
				onPress={() => onSelect(plugin)}
				style={styles.row}
				testID={`devtools-tool-row-${plugin.id}`}
			>
				<View style={styles.iconSurface}>
					<SystemIcon
						color={colors.blue}
						systemName={plugin.systemImage}
						size={16}
					/>
				</View>
				<View
					style={[
						styles.rowContent,
						index < sectionLength - 1 && styles.separator,
					]}
				>
					<View style={styles.copy}>
						<Text style={styles.title}>{plugin.title}</Text>
					</View>
					<SystemIcon
						color={colors.secondaryLabel}
						size={12}
						systemName={
							plugin.kind === 'action' ? 'arrow.up.right' : 'chevron.right'
						}
					/>
				</View>
			</RowButton>
		);
		if (!onQuickActionPinnedChange || !hasPillQuickAction(plugin)) return row;
		const isPinned = pinnedPillQuickActionIds.includes(plugin.id);
		return (
			<MenuView
				actions={[
					{
						id: 'toggle-pin',
						title: isPinned ? 'Remove from Pill' : 'Pin to Pill',
					},
				]}
				onPressAction={() => onQuickActionPinnedChange(plugin.id, !isPinned)}
				shouldOpenOnLongPress
			>
				{row}
			</MenuView>
		);
	};

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			showsVerticalScrollIndicator={false}
		>
			{sections.map((section) => (
				<View key={section.title} style={styles.section}>
					<Text style={styles.sectionTitle}>{section.title}</Text>
					<View style={styles.group}>
						{section.plugins.map((plugin, index) => (
							<View key={plugin.id}>
								{renderRow(plugin, index, section.plugins.length)}
							</View>
						))}
					</View>
				</View>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: {
		gap: 14,
		paddingBottom: 20,
		paddingHorizontal: 12,
		paddingTop: 10,
	},
	section: {
		gap: 7,
	},
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
	row: {
		alignItems: 'center',
		alignSelf: 'stretch',
		flexDirection: 'row',
		minHeight: 48,
		paddingLeft: 13,
		width: '100%',
	},
	iconSurface: {
		alignItems: 'center',
		height: 24,
		justifyContent: 'center',
		width: 22,
	},
	rowContent: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		marginLeft: 10,
		minHeight: 48,
		paddingRight: 14,
	},
	separator: {
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	copy: {
		flex: 1,
	},
	title: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '400',
	},
});
