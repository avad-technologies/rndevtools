import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import {
	Gesture,
	GestureDetector,
	RectButton,
} from 'react-native-gesture-handler';
import Animated, {
	ReduceMotion,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import type {
	DevToolsActionServices,
	DevToolsPluginWithPillQuickAction,
	DevToolsPosition,
} from '../types';
import { colors } from './panel-ui';
import { PillQuickActionMenu } from './pill-quick-action-menu';
import { SystemIcon } from './system-icon';

const BASE_WIDTH = 58;
const QUICK_ACTION_WIDTH = 38;
const HEIGHT = 48;
const EDGE_MARGIN = 10;

type MiniPillProps = {
	label: string;
	onRestore: () => void;
	initialPosition?: DevToolsPosition;
	onPositionChange?: (position: DevToolsPosition) => void;
	bottomObstructionInset?: number;
	quickActionPlugins?: readonly DevToolsPluginWithPillQuickAction[];
	actions: DevToolsActionServices;
	onQuickActionPinnedChange: (pluginId: string, isPinned: boolean) => void;
	onOpenPlugin?: (pluginId: string) => void;
};

function clamp(value: number, minimum: number, maximum: number): number {
	'worklet';
	return Math.min(Math.max(value, minimum), maximum);
}

export function MiniPill({
	label,
	onRestore,
	initialPosition,
	onPositionChange,
	bottomObstructionInset = 0,
	quickActionPlugins = [],
	actions,
	onQuickActionPinnedChange,
	onOpenPlugin,
}: MiniPillProps) {
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const pillWidth = Math.min(
		BASE_WIDTH + QUICK_ACTION_WIDTH * quickActionPlugins.length,
		Math.max(120, width - EDGE_MARGIN * 2),
	);
	const minimumX = EDGE_MARGIN;
	const maximumX = Math.max(minimumX, width - pillWidth - EDGE_MARGIN);
	const minimumY = insets.top + EDGE_MARGIN;
	const maximumY = Math.max(
		minimumY,
		height - HEIGHT - insets.bottom - bottomObstructionInset - EDGE_MARGIN,
	);
	const resolvedX = clamp(initialPosition?.x ?? maximumX, minimumX, maximumX);
	const resolvedY = clamp(
		initialPosition?.y ?? Math.max(minimumY, maximumY - 72),
		minimumY,
		maximumY,
	);
	const translateX = useSharedValue(resolvedX);
	const translateY = useSharedValue(resolvedY);
	const startX = useSharedValue(resolvedX);
	const startY = useSharedValue(resolvedY);
	const committedPosition = useRef<DevToolsPosition | null>(null);
	const commitPosition = useCallback(
		(x: number, y: number) => {
			committedPosition.current = { x, y };
			onPositionChange?.({ x, y });
		},
		[onPositionChange],
	);

	useEffect(() => {
		const committed = committedPosition.current;
		committedPosition.current = null;
		// The host echoing the position a drag just committed must not restart
		// the pill there: that write cancels the running snap spring.
		if (committed?.x === resolvedX && committed.y === resolvedY) return;
		translateX.value = resolvedX;
		translateY.value = resolvedY;
		startX.value = resolvedX;
		startY.value = resolvedY;
	}, [resolvedX, resolvedY, startX, startY, translateX, translateY]);

	const dragGesture = useMemo(
		() =>
			Gesture.Pan()
				.minDistance(5)
				.onBegin(() => {
					startX.value = translateX.value;
					startY.value = translateY.value;
				})
				.onUpdate((event) => {
					translateX.value = clamp(
						startX.value + event.translationX,
						minimumX,
						maximumX,
					);
					translateY.value = clamp(
						startY.value + event.translationY,
						minimumY,
						maximumY,
					);
				})
				.onEnd(() => {
					const snapX =
						translateX.value + pillWidth / 2 < width / 2 ? minimumX : maximumX;
					const finalY = translateY.value;
					translateX.value = withSpring(snapX, {
						dampingRatio: 0.88,
						duration: 260,
						reduceMotion: ReduceMotion.System,
					});
					scheduleOnRN(commitPosition, snapX, finalY);
				}),
		[
			commitPosition,
			maximumX,
			maximumY,
			minimumY,
			pillWidth,
			startX,
			startY,
			translateX,
			translateY,
			width,
		],
	);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
		],
	}));

	return (
		<GestureDetector gesture={dragGesture}>
			<Animated.View
				style={[styles.positioner, { width: pillWidth }, animatedStyle]}
			>
				<View style={styles.pill}>
					<RectButton
						accessibilityHint="Restores the developer tools"
						accessibilityLabel={label}
						accessibilityRole="button"
						onPress={onRestore}
						style={styles.restoreArea}
						testID="devtools-pill-restore"
					>
						<View style={styles.iconSurface}>
							<SystemIcon
								color={colors.blue}
								systemName="wrench.and.screwdriver.fill"
								size={15}
							/>
						</View>
					</RectButton>
					{quickActionPlugins.map((plugin) => (
						<PillQuickActionMenu
							actions={actions}
							key={plugin.id}
							onOpenPanel={
								onOpenPlugin ? () => onOpenPlugin(plugin.id) : undefined
							}
							onUnpin={() => onQuickActionPinnedChange(plugin.id, false)}
							plugin={plugin}
						/>
					))}
				</View>
			</Animated.View>
		</GestureDetector>
	);
}

const styles = StyleSheet.create({
	positioner: {
		height: HEIGHT,
		left: 0,
		position: 'absolute',
		shadowColor: colors.shadow,
		shadowOffset: { width: 0, height: 7 },
		shadowOpacity: 0.22,
		shadowRadius: 18,
		top: 0,
		zIndex: 10_002,
	},
	pill: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: HEIGHT / 2,
		borderWidth: StyleSheet.hairlineWidth,
		flex: 1,
		flexDirection: 'row',
		overflow: 'hidden',
		paddingLeft: 5,
		paddingRight: 5,
	},
	restoreArea: {
		alignItems: 'center',
		flexDirection: 'row',
		height: '100%',
		justifyContent: 'center',
		width: 48,
	},
	// Tinted glyph on a system fill, matching the sheet header's controls.
	iconSurface: {
		alignItems: 'center',
		backgroundColor: colors.fill,
		borderRadius: 17,
		height: 34,
		justifyContent: 'center',
		width: 34,
	},
});
