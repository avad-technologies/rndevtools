import { MenuView } from '@expo/ui/community/menu';
import {
	BottomSheet,
	Button,
	ContextMenu,
	Group,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Menu,
	RNHostView,
	Section,
	Spacer,
	TextField,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	backgroundOverlay,
	buttonStyle,
	clipShape,
	fixedSize,
	font,
	foregroundStyle,
	frame,
	listSectionMargins,
	listSectionSpacing,
	padding,
	presentationDetents,
	presentationDragIndicator,
	scrollContentBackground,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import {
	type ColorValue,
	Modal,
	Platform,
	PlatformColor,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	useWindowDimensions,
	View,
} from 'react-native';
import { groupPlugins, hasPillQuickAction } from '../core/plugins';
import type {
	DevToolsActionServices,
	DevToolsHomeStatusRow,
	DevToolsPanelPlugin,
	DevToolsPlugin,
	DevToolsPresentationMode,
} from '../types';
import { colors } from './panel-ui';
import { PluginPanelRenderer } from './plugin-panel-renderer';
import { SystemIcon } from './system-icon';
import { ToolList } from './tool-list';

/**
 * UIKit's `UIButton(type: .close)` is a 30pt circle, but that is one specific
 * control, not a rule for sheet chrome — and 30pt sits under the HIG's 44pt
 * touch-target floor. 36 pairs with the 22pt bold title and stays tappable.
 */
const HEADER_CONTROL_SIZE = 36;

const CHIP_COLORS = [
	'#007AFF',
	'#AF52DE',
	'#8E8E93',
	'#30B0C7',
	'#FF9500',
	'#5856D6',
	'#FF2D55',
	'#34C759',
] as const;

const BADGE_TONES = {
	info: '#0E7E93',
	success: '#1D8A3E',
	warning: '#C93400',
	danger: '#D70015',
} as const;

function chipColor(plugin: DevToolsPlugin): ColorValue {
	if (plugin.tint) return plugin.tint;
	let hash = 0;
	for (let index = 0; index < plugin.id.length; index += 1) {
		hash = (hash * 31 + plugin.id.charCodeAt(index)) | 0;
	}
	return CHIP_COLORS[Math.abs(hash) % CHIP_COLORS.length] as string;
}

type ToolsSheetProps = {
	isPresented: boolean;
	plugins: readonly DevToolsPlugin[];
	selectedPlugin?: DevToolsPanelPlugin;
	onSelectPlugin: (plugin: DevToolsPlugin) => void;
	onBack: () => void;
	onClose: () => void;
	onPresentationModeChange: (mode: DevToolsPresentationMode) => void;
	title: string;
	onPluginError?: (error: unknown, pluginId: string) => void;
	actions: DevToolsActionServices;
	pinnedPillQuickActionIds: readonly string[];
	onQuickActionPinnedChange: (pluginId: string, isPinned: boolean) => void;
	safeAreaTop: number;
	homeStatus?: readonly DevToolsHomeStatusRow[];
	onOpenPlugin?: (pluginId: string) => void;
};

export function ToolsSheet({
	isPresented,
	plugins,
	selectedPlugin,
	onSelectPlugin,
	onBack,
	onClose,
	onPresentationModeChange,
	title,
	onPluginError,
	actions,
	pinnedPillQuickActionIds,
	onQuickActionPinnedChange,
	safeAreaTop,
	homeStatus = [],
	onOpenPlugin,
}: ToolsSheetProps) {
	const [query, setQuery] = useState('');
	const colorScheme = useColorScheme();
	const window = useWindowDimensions();
	// SwiftUI quaternary-fill approximation for the circular header controls
	// (Maps/Find My-style sheet dismiss buttons).
	const headerControlFill = colorScheme === 'dark' ? '#7676803D' : '#7676801F';
	const normalizedQuery = query.trim().toLowerCase();
	const sections = groupPlugins(plugins)
		.map((section) => ({
			...section,
			plugins: section.plugins.filter(
				(plugin) =>
					normalizedQuery.length === 0 ||
					plugin.title.toLowerCase().includes(normalizedQuery),
			),
		}))
		.filter((section) => section.plugins.length > 0);
	const panelProps = {
		onBack,
		onClose,
		presentationMode: 'sheet' as const,
		safeAreaTop,
		onPresentationModeChange,
		actions,
	};
	// The search field is native-owned and unmounts with the home branch, so a
	// query that outlived it would filter the tool list behind an empty box.
	const selectPlugin = (plugin: DevToolsPlugin) => {
		setQuery('');
		onSelectPlugin(plugin);
	};
	if (Platform.OS !== 'ios') {
		const visiblePlugins = sections.flatMap((section) => section.plugins);
		const sheetHeight = Math.max(360, window.height - safeAreaTop - 24);
		return (
			<Modal
				animationType="slide"
				onRequestClose={onClose}
				presentationStyle="overFullScreen"
				statusBarTranslucent
				transparent
				visible={isPresented}
			>
				<View style={styles.androidBackdrop}>
					<View
						style={[styles.androidSheet, { height: sheetHeight }]}
						testID="devtools-sheet"
					>
						<View style={styles.androidDragIndicator} />
						{selectedPlugin ? (
							<PluginPanelRenderer
								onError={onPluginError}
								panelProps={panelProps}
								plugin={selectedPlugin}
							/>
						) : (
							<>
								<View style={styles.androidHeader}>
									<MenuView
										actions={[
											{ id: 'sheet', state: 'on', title: 'Sheet' },
											{ id: 'window', title: 'Window' },
											{ id: 'pill', title: 'Pill' },
										]}
										onPressAction={(event) =>
											onPresentationModeChange(
												event.nativeEvent.event as DevToolsPresentationMode,
											)
										}
										testID="devtools-presentation-menu"
									>
										<View
											accessible
											accessibilityLabel="Tool presentation"
											style={styles.androidHeaderControl}
										>
											<SystemIcon
												color={colors.blue}
												size={20}
												systemName="wrench.and.screwdriver.fill"
											/>
										</View>
									</MenuView>
									<Text numberOfLines={1} style={styles.androidTitle}>
										{title}
									</Text>
									<Pressable
										accessibilityLabel="Close developer tools"
										accessibilityRole="button"
										onPress={onClose}
										style={styles.androidHeaderControl}
										testID="devtools-sheet-close"
									>
										<SystemIcon
											color={colors.secondaryLabel}
											size={20}
											systemName="xmark"
										/>
									</Pressable>
								</View>
								<View style={styles.androidSearch}>
									<SystemIcon
										color={colors.secondaryLabel}
										size={18}
										systemName="magnifyingglass"
									/>
									<TextInput
										autoCapitalize="none"
										autoCorrect={false}
										onChangeText={setQuery}
										placeholder="Search tools"
										placeholderTextColor={colors.secondaryLabel}
										style={styles.androidSearchInput}
										value={query}
									/>
								</View>
								{homeStatus.length > 0 ? (
									<View style={styles.androidStatusGroup}>
										{homeStatus.map((row) => {
											const content = (
												<>
													<Text style={styles.androidStatusLabel}>
														{row.label}
													</Text>
													<View style={styles.androidStatusValueWrap}>
														{row.badge ? (
															<Text
																style={[
																	styles.androidBadge,
																	{
																		color:
																			BADGE_TONES[row.badge.tone ?? 'info'],
																	},
																]}
															>
																{row.badge.label}
															</Text>
														) : null}
														<Text
															numberOfLines={1}
															style={styles.androidStatusValue}
														>
															{row.value}
														</Text>
													</View>
												</>
											);
											return row.onPressPluginId && onOpenPlugin ? (
												<Pressable
													key={row.id}
													onPress={() => {
														setQuery('');
														onOpenPlugin(row.onPressPluginId ?? '');
													}}
													style={styles.androidStatusRow}
												>
													{content}
												</Pressable>
											) : (
												<View key={row.id} style={styles.androidStatusRow}>
													{content}
												</View>
											);
										})}
									</View>
								) : null}
								<View style={styles.androidList}>
									<ToolList
										onQuickActionPinnedChange={onQuickActionPinnedChange}
										onSelect={selectPlugin}
										pinnedPillQuickActionIds={pinnedPillQuickActionIds}
										plugins={visiblePlugins}
									/>
								</View>
								<Text style={styles.androidFooter}>
									Collectors stay active while this sheet is closed
								</Text>
							</>
						)}
					</View>
				</View>
			</Modal>
		);
	}

	return (
		<Host matchContents style={styles.host}>
			<BottomSheet
				isPresented={isPresented}
				onIsPresentedChange={(next) => {
					if (!next) onClose();
				}}
			>
				<Group
					modifiers={[
						presentationDetents(['medium', 'large']),
						presentationDragIndicator('visible'),
					]}
				>
					{selectedPlugin ? (
						<RNHostView>
							<View style={styles.panel}>
								<PluginPanelRenderer
									plugin={selectedPlugin}
									panelProps={panelProps}
									onError={onPluginError}
								/>
							</View>
						</RNHostView>
					) : (
						<VStack alignment="leading" spacing={0}>
							<HStack
								modifiers={[
									padding({ leading: 20, trailing: 16, top: 14, bottom: 10 }),
								]}
								spacing={12}
							>
								<Menu
									label={
										// Tinted glyph on the same quaternary fill as the dismiss
										// control, not a filled accent tile: the pair reads as
										// system chrome instead of an app icon.
										<Image
											color={PlatformColor('systemBlueColor')}
											modifiers={[
												frame({
													width: HEADER_CONTROL_SIZE,
													height: HEADER_CONTROL_SIZE,
												}),
												backgroundOverlay({ color: headerControlFill }),
												clipShape('circle'),
											]}
											size={17}
											systemName="wrench.and.screwdriver.fill"
										/>
									}
								>
									<Button
										label="Sheet"
										onPress={() => onPresentationModeChange('sheet')}
										systemImage="checkmark"
									/>
									<Button
										label="Window"
										onPress={() => onPresentationModeChange('window')}
										systemImage="macwindow"
									/>
									<Button
										label="Pill"
										onPress={() => onPresentationModeChange('pill')}
										systemImage="capsule"
									/>
								</Menu>
								<UIText modifiers={[font({ size: 22, weight: 'bold' })]}>
									{title}
								</UIText>
								<Spacer />
								<Button
									modifiers={[buttonStyle('plain')]}
									onPress={onClose}
									testID="devtools-sheet-close"
								>
									<Image
										color={PlatformColor('secondaryLabelColor')}
										modifiers={[
											frame({
												width: HEADER_CONTROL_SIZE,
												height: HEADER_CONTROL_SIZE,
											}),
											backgroundOverlay({ color: headerControlFill }),
											clipShape('circle'),
										]}
										size={15}
										systemName="xmark"
									/>
								</Button>
							</HStack>
							{/* Search belongs to the header, not the list: pinned above the
							    scroll it filters, and free of the grouped list's top inset
							    that pushed it away from the title. */}
							<HStack
								modifiers={[padding({ leading: 20, trailing: 16, bottom: 12 })]}
								spacing={0}
							>
								<HStack
									modifiers={[
										padding({ horizontal: 10, vertical: 8 }),
										backgroundOverlay({ color: headerControlFill }),
										clipShape('capsule'),
									]}
									spacing={6}
								>
									<Image
										color={PlatformColor('secondaryLabelColor')}
										size={15}
										systemName="magnifyingglass"
									/>
									<TextField
										modifiers={[autocorrectionDisabled(true)]}
										onTextChange={setQuery}
										placeholder="Search tools"
									/>
								</HStack>
							</HStack>
							{/* Hidden scroll background keeps the whole sheet on the same
							    glass material as the header row. */}
							<List
								modifiers={[
									scrollContentBackground('hidden'),
									listSectionSpacing('compact'),
									// The grouped list's own top margin sits under a header that
									// already spaced itself; without this the first card floats.
									listSectionMargins({ edges: 'top', length: 4 }),
								]}
							>
								{homeStatus.length > 0 ? (
									<Section>
										{homeStatus.map((row) =>
											row.onPressPluginId && onOpenPlugin ? (
												<Button
													key={row.id}
													modifiers={[buttonStyle('plain')]}
													onPress={() => {
														setQuery('');
														onOpenPlugin(row.onPressPluginId ?? '');
													}}
												>
													<HomeStatusRowContent row={row} />
												</Button>
											) : (
												<HomeStatusRowContent key={row.id} row={row} />
											),
										)}
									</Section>
								) : null}
								{sections.map((section, sectionIndex) => (
									<Section
										key={section.title}
										title={section.title}
										footer={
											sectionIndex === sections.length - 1 ? (
												<UIText>
													Collectors stay active while this sheet is closed
												</UIText>
											) : undefined
										}
									>
										{section.plugins.map((plugin) => (
											<ToolRow
												isPinned={pinnedPillQuickActionIds.includes(plugin.id)}
												key={plugin.id}
												onPinnedChange={(isPinned) =>
													onQuickActionPinnedChange(plugin.id, isPinned)
												}
												onPress={() => selectPlugin(plugin)}
												plugin={plugin}
											/>
										))}
									</Section>
								))}
							</List>
						</VStack>
					)}
				</Group>
			</BottomSheet>
		</Host>
	);
}

function ToolRow({
	plugin,
	onPress,
	isPinned,
	onPinnedChange,
}: {
	plugin: DevToolsPlugin;
	onPress: () => void;
	isPinned: boolean;
	onPinnedChange: (isPinned: boolean) => void;
}) {
	const row = (
		<Button onPress={onPress} testID={`devtools-tool-row-${plugin.id}`}>
			<HStack spacing={12}>
				<Image
					color="#FFFFFF"
					modifiers={[
						frame({ width: 30, height: 30 }),
						backgroundOverlay({ color: chipColor(plugin) }),
						clipShape('roundedRectangle'),
					]}
					size={16}
					systemName={plugin.systemImage}
				/>
				<UIText modifiers={[foregroundStyle(PlatformColor('labelColor'))]}>
					{plugin.title}
				</UIText>
				<Spacer />
				<Image
					color={PlatformColor('tertiaryLabelColor')}
					modifiers={[fixedSize()]}
					size={13}
					systemName={
						plugin.kind === 'action' ? 'arrow.up.forward' : 'chevron.right'
					}
				/>
			</HStack>
		</Button>
	);
	if (!hasPillQuickAction(plugin)) return row;
	return (
		<ContextMenu>
			<ContextMenu.Items>
				<Button
					label={isPinned ? 'Remove from Pill' : 'Pin to Pill'}
					onPress={() => onPinnedChange(!isPinned)}
					systemImage={isPinned ? 'pin.slash' : 'pin'}
				/>
			</ContextMenu.Items>
			<ContextMenu.Trigger>{row}</ContextMenu.Trigger>
		</ContextMenu>
	);
}

function HomeStatusRowContent({ row }: { row: DevToolsHomeStatusRow }) {
	return (
		<LabeledContent
			label={
				<UIText modifiers={[foregroundStyle(PlatformColor('labelColor'))]}>
					{row.label}
				</UIText>
			}
		>
			<HStack spacing={8}>
				{row.badge ? (
					<UIText
						modifiers={[
							font({ size: 12, weight: 'semibold' }),
							foregroundStyle(BADGE_TONES[row.badge.tone ?? 'info']),
						]}
					>
						{row.badge.label}
					</UIText>
				) : null}
				<UIText>{row.value}</UIText>
			</HStack>
		</LabeledContent>
	);
}

const styles = StyleSheet.create({
	androidBackdrop: {
		backgroundColor: '#00000066',
		flex: 1,
		justifyContent: 'flex-end',
	},
	androidBadge: {
		fontSize: 11,
		fontWeight: '700',
	},
	androidFooter: {
		color: colors.secondaryLabel,
		fontSize: 12,
		paddingBottom: 6,
		paddingHorizontal: 16,
	},
	androidDragIndicator: {
		alignSelf: 'center',
		backgroundColor: colors.secondaryLabel,
		borderRadius: 2,
		height: 4,
		marginBottom: 4,
		marginTop: 8,
		opacity: 0.55,
		width: 36,
	},
	androidHeader: {
		alignItems: 'center',
		flexDirection: 'row',
		gap: 12,
		minHeight: 56,
		paddingHorizontal: 4,
	},
	androidHeaderControl: {
		alignItems: 'center',
		backgroundColor: colors.fill,
		borderRadius: 22,
		height: 44,
		justifyContent: 'center',
		width: 44,
	},
	androidList: {
		flex: 1,
	},
	androidSearch: {
		alignItems: 'center',
		backgroundColor: colors.groupedFill,
		borderColor: colors.separator,
		borderRadius: 24,
		borderWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		gap: 8,
		marginBottom: 10,
		paddingHorizontal: 14,
	},
	androidSearchInput: {
		color: colors.label,
		flex: 1,
		fontSize: 16,
		height: 48,
	},
	androidSheet: {
		backgroundColor: colors.background,
		borderTopLeftRadius: 28,
		borderTopRightRadius: 28,
		overflow: 'hidden',
		paddingBottom: 8,
		paddingHorizontal: 12,
	},
	androidStatusGroup: {
		backgroundColor: colors.card,
		borderRadius: 12,
		marginBottom: 8,
		overflow: 'hidden',
	},
	androidStatusLabel: {
		color: colors.label,
		fontSize: 14,
		fontWeight: '500',
	},
	androidStatusRow: {
		alignItems: 'center',
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		justifyContent: 'space-between',
		minHeight: 44,
		paddingHorizontal: 14,
	},
	androidStatusValue: {
		color: colors.secondaryLabel,
		flexShrink: 1,
		fontSize: 13,
	},
	androidStatusValueWrap: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		gap: 8,
		justifyContent: 'flex-end',
		marginLeft: 12,
	},
	androidTitle: {
		color: colors.label,
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
	},
	host: {
		height: 1,
		width: 1,
	},
	panel: {
		flex: 1,
	},
});
