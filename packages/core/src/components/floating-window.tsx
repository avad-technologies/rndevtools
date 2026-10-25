import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from 'react-native';
import {
	Gesture,
	GestureDetector,
	RectButton,
} from 'react-native-gesture-handler';
import Animated, {
	useAnimatedStyle,
	useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import type {
	DevToolsActionServices,
	DevToolsHomeStatusRow,
	DevToolsPanelPlugin,
	DevToolsPlugin,
	DevToolsPosition,
	DevToolsPresentationMode,
	DevToolsSize,
} from '../types';
import { colors } from './panel-ui';
import { PluginPanelRenderer } from './plugin-panel-renderer';
import { PresentationSwitcher } from './presentation-switcher';
import { SystemIcon } from './system-icon';
import { ToolList } from './tool-list';

const OUTER_MARGIN = 12;
const MINIMUM_WINDOW_WIDTH = 300;
const MINIMUM_WINDOW_HEIGHT = 360;
const RESIZE_STEP = 40;

type FloatingWindowProps = {
	title: string;
	plugins: readonly DevToolsPlugin[];
	selectedPlugin?: DevToolsPanelPlugin;
	onSelectPlugin: (plugin: DevToolsPlugin) => void;
	onBack: () => void;
	onClose: () => void;
	onPresentationModeChange: (mode: DevToolsPresentationMode) => void;
	initialPosition?: DevToolsPosition;
	initialSize?: DevToolsSize;
	onPositionChange?: (position: DevToolsPosition) => void;
	onSizeChange?: (size: DevToolsSize) => void;
	onPluginError?: (error: unknown, pluginId: string) => void;
	actions: DevToolsActionServices;
	pinnedPillQuickActionIds?: readonly string[];
	onQuickActionPinnedChange?: (pluginId: string, isPinned: boolean) => void;
	homeStatus?: readonly DevToolsHomeStatusRow[];
	onOpenPlugin?: (pluginId: string) => void;
};

function clamp(value: number, minimum: number, maximum: number): number {
	'worklet';
	return Math.min(Math.max(value, minimum), maximum);
}

export function FloatingWindow({
	title,
	plugins,
	selectedPlugin,
	onSelectPlugin,
	onBack,
	onClose,
	onPresentationModeChange,
	initialPosition,
	initialSize,
	onPositionChange,
	onSizeChange,
	onPluginError,
	actions,
	pinnedPillQuickActionIds = [],
	onQuickActionPinnedChange,
	homeStatus = [],
	onOpenPlugin,
}: FloatingWindowProps) {
	const [query, setQuery] = useState('');
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const availableWidth = Math.max(1, width - OUTER_MARGIN * 2);
	const availableHeight = Math.max(
		1,
		height - insets.top - insets.bottom - OUTER_MARGIN * 2,
	);
	const minimumWidth = Math.min(MINIMUM_WINDOW_WIDTH, availableWidth);
	const minimumHeight = Math.min(MINIMUM_WINDOW_HEIGHT, availableHeight);
	const resolvedWidth = clamp(
		initialSize?.width ?? Math.min(390, availableWidth),
		minimumWidth,
		availableWidth,
	);
	const resolvedHeight = clamp(
		initialSize?.height ?? Math.min(620, availableHeight),
		minimumHeight,
		availableHeight,
	);
	const maximumX = Math.max(OUTER_MARGIN, width - resolvedWidth - OUTER_MARGIN);
	const minimumY = insets.top + OUTER_MARGIN;
	const maximumY = Math.max(
		minimumY,
		height - resolvedHeight - insets.bottom - OUTER_MARGIN,
	);
	const resolvedX = clamp(
		initialPosition?.x ?? (width - resolvedWidth) / 2,
		OUTER_MARGIN,
		maximumX,
	);
	const resolvedY = clamp(
		initialPosition?.y ?? (height - resolvedHeight) / 2,
		minimumY,
		maximumY,
	);
	const translateX = useSharedValue(resolvedX);
	const translateY = useSharedValue(resolvedY);
	const windowWidth = useSharedValue(resolvedWidth);
	const windowHeight = useSharedValue(resolvedHeight);
	const startX = useSharedValue(resolvedX);
	const startY = useSharedValue(resolvedY);
	const startWidth = useSharedValue(resolvedWidth);
	const startHeight = useSharedValue(resolvedHeight);
	const commitPosition = useCallback(
		(x: number, y: number) => onPositionChange?.({ x, y }),
		[onPositionChange],
	);
	const commitSize = useCallback(
		(nextWidth: number, nextHeight: number) =>
			onSizeChange?.({ width: nextWidth, height: nextHeight }),
		[onSizeChange],
	);

	useEffect(() => {
		translateX.value = resolvedX;
		translateY.value = resolvedY;
		windowWidth.value = resolvedWidth;
		windowHeight.value = resolvedHeight;
		startX.value = resolvedX;
		startY.value = resolvedY;
		startWidth.value = resolvedWidth;
		startHeight.value = resolvedHeight;
	}, [
		resolvedHeight,
		resolvedWidth,
		resolvedX,
		resolvedY,
		startHeight,
		startWidth,
		startX,
		startY,
		translateX,
		translateY,
		windowHeight,
		windowWidth,
	]);

	const resizeBy = useCallback(
		(delta: number) => {
			const nextWidth = clamp(
				windowWidth.value + delta,
				minimumWidth,
				Math.max(minimumWidth, width - translateX.value - OUTER_MARGIN),
			);
			const nextHeight = clamp(
				windowHeight.value + delta,
				minimumHeight,
				Math.max(
					minimumHeight,
					height - translateY.value - insets.bottom - OUTER_MARGIN,
				),
			);
			windowWidth.value = nextWidth;
			windowHeight.value = nextHeight;
			commitSize(nextWidth, nextHeight);
		},
		[
			commitSize,
			height,
			insets.bottom,
			minimumHeight,
			minimumWidth,
			translateX,
			translateY,
			width,
			windowHeight,
			windowWidth,
		],
	);

	const dragGesture = useMemo(
		() =>
			Gesture.Pan()
				.minDistance(4)
				.onBegin(() => {
					startX.value = translateX.value;
					startY.value = translateY.value;
				})
				.onUpdate((event) => {
					translateX.value = clamp(
						startX.value + event.translationX,
						OUTER_MARGIN,
						Math.max(OUTER_MARGIN, width - windowWidth.value - OUTER_MARGIN),
					);
					translateY.value = clamp(
						startY.value + event.translationY,
						minimumY,
						Math.max(
							minimumY,
							height - windowHeight.value - insets.bottom - OUTER_MARGIN,
						),
					);
				})
				.onEnd(() => {
					scheduleOnRN(commitPosition, translateX.value, translateY.value);
				}),
		[
			commitPosition,
			height,
			insets.bottom,
			minimumY,
			startX,
			startY,
			translateX,
			translateY,
			width,
			windowHeight,
			windowWidth,
		],
	);

	const resizeGesture = useMemo(
		() =>
			Gesture.Pan()
				.minDistance(2)
				.onBegin(() => {
					startWidth.value = windowWidth.value;
					startHeight.value = windowHeight.value;
				})
				.onUpdate((event) => {
					windowWidth.value = clamp(
						startWidth.value + event.translationX,
						minimumWidth,
						Math.max(minimumWidth, width - translateX.value - OUTER_MARGIN),
					);
					windowHeight.value = clamp(
						startHeight.value + event.translationY,
						minimumHeight,
						Math.max(
							minimumHeight,
							height - translateY.value - insets.bottom - OUTER_MARGIN,
						),
					);
				})
				.onEnd(() => {
					scheduleOnRN(commitSize, windowWidth.value, windowHeight.value);
				}),
		[
			commitSize,
			height,
			insets.bottom,
			minimumHeight,
			minimumWidth,
			startHeight,
			startWidth,
			translateX,
			translateY,
			width,
			windowHeight,
			windowWidth,
		],
	);

	const animatedStyle = useAnimatedStyle(() => ({
		height: windowHeight.value,
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
		],
		width: windowWidth.value,
	}));

	const panelProps = {
		onBack,
		onClose,
		presentationMode: 'window' as const,
		safeAreaTop: insets.top,
		onPresentationModeChange,
		actions,
	};
	const normalizedQuery = query.trim().toLowerCase();
	const visiblePlugins = plugins.filter(
		(plugin) =>
			normalizedQuery.length === 0 ||
			plugin.title.toLowerCase().includes(normalizedQuery) ||
			plugin.description.toLowerCase().includes(normalizedQuery),
	);
	const selectPlugin = (plugin: DevToolsPlugin) => {
		setQuery('');
		onSelectPlugin(plugin);
	};

	return (
		<Animated.View style={[styles.positioner, animatedStyle]}>
			<View style={styles.window}>
				<View style={styles.header}>
					<GestureDetector gesture={dragGesture}>
						<Animated.View
							accessibilityHint="Drag to move the tools window"
							accessibilityLabel={title}
							style={styles.dragArea}
						>
							<View style={styles.headerCopy}>
								<Text numberOfLines={1} style={styles.headerTitle}>
									{title}
								</Text>
							</View>
						</Animated.View>
					</GestureDetector>
					<RectButton
						accessibilityLabel="Close developer tools"
						accessibilityRole="button"
						onPress={onClose}
						style={styles.closeButton}
					>
						<SystemIcon
							systemName="xmark"
							size={18}
							color={colors.secondaryLabel}
						/>
					</RectButton>
				</View>
				<View style={styles.switcher}>
					<PresentationSwitcher
						mode="window"
						onModeChange={onPresentationModeChange}
					/>
				</View>
				<View style={styles.content}>
					{selectedPlugin ? (
						<PluginPanelRenderer
							plugin={selectedPlugin}
							panelProps={panelProps}
							onError={onPluginError}
						/>
					) : (
						<View style={styles.home}>
							<View style={styles.search}>
								<SystemIcon
									color={colors.secondaryLabel}
									size={16}
									systemName="magnifyingglass"
								/>
								<TextInput
									autoCapitalize="none"
									autoCorrect={false}
									onChangeText={setQuery}
									placeholder="Search tools"
									placeholderTextColor={colors.secondaryLabel}
									style={styles.searchInput}
									value={query}
								/>
							</View>
							{homeStatus.length > 0 ? (
								<View style={styles.statusGroup}>
									{homeStatus.map((row) => {
										const content = (
											<>
												<Text style={styles.statusLabel}>{row.label}</Text>
												<View style={styles.statusValueWrap}>
													{row.badge ? (
														<Text style={styles.statusBadge}>
															{row.badge.label}
														</Text>
													) : null}
													<Text numberOfLines={1} style={styles.statusValue}>
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
												style={styles.statusRow}
											>
												{content}
											</Pressable>
										) : (
											<View key={row.id} style={styles.statusRow}>
												{content}
											</View>
										);
									})}
								</View>
							) : null}
							<View style={styles.toolList}>
								<ToolList
									onQuickActionPinnedChange={onQuickActionPinnedChange}
									onSelect={selectPlugin}
									pinnedPillQuickActionIds={pinnedPillQuickActionIds}
									plugins={visiblePlugins}
								/>
							</View>
						</View>
					)}
				</View>
				<GestureDetector gesture={resizeGesture}>
					<Animated.View
						accessibilityActions={[
							{ label: 'Make window larger', name: 'increment' },
							{ label: 'Make window smaller', name: 'decrement' },
						]}
						accessibilityHint="Drag diagonally to resize the tools window"
						accessibilityLabel="Resize developer tools window"
						accessibilityRole="adjustable"
						onAccessibilityAction={(event) =>
							resizeBy(
								event.nativeEvent.actionName === 'decrement'
									? -RESIZE_STEP
									: RESIZE_STEP,
							)
						}
						style={styles.resizeHandle}
						testID="devtools-window-resize-handle"
					>
						<View style={styles.resizeCurve} />
					</Animated.View>
				</GestureDetector>
			</View>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	positioner: {
		left: 0,
		position: 'absolute',
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 14 },
		shadowOpacity: 0.28,
		shadowRadius: 30,
		top: 0,
		zIndex: 10_001,
	},
	window: {
		backgroundColor: colors.background,
		borderColor: colors.separator,
		borderRadius: 22,
		borderWidth: StyleSheet.hairlineWidth,
		flex: 1,
		overflow: 'hidden',
	},
	header: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		height: 52,
		paddingLeft: 14,
		paddingRight: 4,
	},
	dragArea: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		height: '100%',
	},
	headerCopy: {
		flex: 1,
	},
	headerTitle: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '600',
	},
	closeButton: {
		alignItems: 'center',
		backgroundColor: colors.fill,
		borderRadius: 22,
		height: 44,
		justifyContent: 'center',
		width: 44,
	},
	switcher: {
		backgroundColor: colors.card,
		paddingBottom: 7,
		paddingHorizontal: 12,
	},
	content: {
		flex: 1,
	},
	home: {
		flex: 1,
	},
	search: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 11,
		borderWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		marginHorizontal: 12,
		marginTop: 10,
		paddingHorizontal: 10,
	},
	searchInput: {
		color: colors.label,
		flex: 1,
		fontSize: 14,
		height: 40,
		paddingHorizontal: 8,
	},
	statusGroup: {
		backgroundColor: colors.card,
		borderRadius: 11,
		marginHorizontal: 12,
		marginTop: 10,
		overflow: 'hidden',
	},
	statusRow: {
		alignItems: 'center',
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		gap: 8,
		minHeight: 36,
		paddingHorizontal: 11,
	},
	statusLabel: {
		color: colors.secondaryLabel,
		fontSize: 12,
	},
	statusValueWrap: {
		alignItems: 'center',
		flex: 1,
		flexDirection: 'row',
		gap: 6,
		justifyContent: 'flex-end',
	},
	statusBadge: {
		color: colors.orange,
		fontSize: 10,
		fontWeight: '700',
	},
	statusValue: {
		color: colors.label,
		fontSize: 12,
		maxWidth: '70%',
	},
	toolList: {
		flex: 1,
	},
	resizeHandle: {
		alignItems: 'flex-end',
		bottom: 0,
		height: 44,
		justifyContent: 'flex-end',
		paddingBottom: 8,
		paddingRight: 8,
		position: 'absolute',
		right: 0,
		width: 44,
		zIndex: 4,
	},
	resizeCurve: {
		borderBottomColor: colors.secondaryLabel,
		borderBottomRightRadius: 9,
		borderBottomWidth: 2,
		borderRightColor: colors.secondaryLabel,
		borderRightWidth: 2,
		height: 15,
		opacity: 0.65,
		width: 15,
	},
});
