import { MenuView } from '@expo/ui/community/menu';
import {
	Divider,
	Host,
	Image,
	Menu,
	Button as NativeMenuButton,
} from '@expo/ui/swift-ui';
import { accessibilityLabel, frame } from '@expo/ui/swift-ui/modifiers';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { resolvePillQuickActionOptions } from '../core/plugins';
import type {
	DevToolsActionServices,
	DevToolsPillQuickAction,
	DevToolsPillQuickActionOption,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { colors } from './panel-ui';
import { SystemIcon } from './system-icon';

const SLOT_WIDTH = 38;
const SLOT_HEIGHT = 48;

type PillQuickActionMenuProps = {
	plugin: DevToolsPluginWithPillQuickAction;
	actions: DevToolsActionServices;
	onUnpin: () => void;
	onOpenPanel?: () => void;
};

type QuickActionSnapshot = {
	options: readonly DevToolsPillQuickActionOption[];
	selectedOptionId: string | null;
	isHighlighted: boolean;
};

function readQuickActionSnapshot(
	quickAction: DevToolsPillQuickAction,
): QuickActionSnapshot {
	const options = resolvePillQuickActionOptions(quickAction.options);
	let selectedOptionId: string | null = null;
	let isHighlighted = false;
	try {
		const selected = quickAction.getSelectedOptionId?.();
		if (
			typeof selected === 'string' &&
			options.some((option) => option.id === selected)
		) {
			selectedOptionId = selected;
		}
	} catch {
		// Faulty extension state cannot take down the persistent pill.
	}
	try {
		isHighlighted = quickAction.getIsHighlighted?.() === true;
	} catch {
		// Use the unhighlighted fallback when the extension getter fails.
	}
	return { options, selectedOptionId, isHighlighted };
}

export function PillQuickActionMenu({
	plugin,
	actions,
	onUnpin,
	onOpenPanel,
}: PillQuickActionMenuProps) {
	const { pillQuickAction } = plugin;
	const [snapshot, setSnapshot] = useState(() =>
		readQuickActionSnapshot(pillQuickAction),
	);
	useEffect(() => {
		let active = true;
		const refresh = () => {
			if (active) setSnapshot(readQuickActionSnapshot(pillQuickAction));
		};
		refresh();
		let unsubscribe: unknown;
		try {
			unsubscribe = pillQuickAction.subscribe?.(refresh);
		} catch {
			unsubscribe = undefined;
		}
		return () => {
			active = false;
			if (typeof unsubscribe === 'function') {
				try {
					unsubscribe();
				} catch {
					// Continue unmounting even when extension cleanup fails.
				}
			}
		};
	}, [pillQuickAction]);
	const { isHighlighted, options, selectedOptionId } = snapshot;

	if (Platform.OS !== 'ios') {
		const openPanelId = '__open-panel';
		const unpinId = '__unpin';
		return (
			<View
				style={styles.container}
				testID={`devtools-pill-quick-action-${plugin.id}`}
			>
				<MenuView
					actions={[
						...options.map((option) => ({
							id: option.id,
							state:
								option.id === selectedOptionId ? ('on' as const) : undefined,
							title: option.label,
						})),
						...(onOpenPanel
							? [
									{
										id: openPanelId,
										title: `Open ${pillQuickAction.openPanelLabel ?? plugin.title}…`,
									},
								]
							: []),
						{ id: unpinId, title: 'Remove from Pill' },
					]}
					onPressAction={(event) => {
						const actionId = event.nativeEvent.event;
						if (actionId === openPanelId) {
							onOpenPanel?.();
							return;
						}
						if (actionId === unpinId) {
							onUnpin();
							return;
						}
						const option = options.find(
							(candidate) => candidate.id === actionId,
						);
						if (!option) return;
						void actions.run({
							pluginId: plugin.id,
							label: option.label,
							confirmation: option.confirmation,
							action: option.action,
						});
					}}
				>
					<View
						accessible
						accessibilityLabel={`${plugin.title} quick actions`}
						style={styles.androidTrigger}
					>
						<SystemIcon
							color={isHighlighted ? colors.orange : colors.blue}
							size={17}
							systemName={pillQuickAction.systemImage ?? plugin.systemImage}
						/>
					</View>
				</MenuView>
				{isHighlighted ? <View style={styles.dot} /> : null}
			</View>
		);
	}

	return (
		<View
			style={styles.container}
			testID={`devtools-pill-quick-action-${plugin.id}`}
		>
			<Host style={styles.host}>
				<Menu
					label={
						<Image
							color={isHighlighted ? colors.orange : colors.blue}
							modifiers={[
								frame({ width: SLOT_WIDTH, height: SLOT_HEIGHT }),
								accessibilityLabel(`${plugin.title} quick actions`),
							]}
							size={17}
							systemName={pillQuickAction.systemImage ?? plugin.systemImage}
						/>
					}
				>
					{options.map((option) => (
						<NativeMenuButton
							key={option.id}
							label={option.label}
							onPress={() => {
								void actions.run({
									pluginId: plugin.id,
									label: option.label,
									confirmation: option.confirmation,
									action: option.action,
								});
							}}
							systemImage={
								option.id === selectedOptionId
									? 'checkmark'
									: option.systemImage
							}
						/>
					))}
					<Divider />
					{onOpenPanel ? (
						<NativeMenuButton
							label={`Open ${pillQuickAction.openPanelLabel ?? plugin.title}…`}
							onPress={onOpenPanel}
							systemImage="arrow.up.forward.app"
						/>
					) : null}
					<NativeMenuButton
						label="Remove from Pill"
						onPress={onUnpin}
						systemImage="minus.circle"
					/>
				</Menu>
			</Host>
			{isHighlighted ? <View style={styles.dot} /> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	androidTrigger: {
		alignItems: 'center',
		height: SLOT_HEIGHT,
		justifyContent: 'center',
		width: SLOT_WIDTH,
	},
	container: {
		borderLeftColor: colors.separator,
		borderLeftWidth: StyleSheet.hairlineWidth,
		height: SLOT_HEIGHT,
		width: SLOT_WIDTH,
	},
	host: {
		flex: 1,
	},
	dot: {
		backgroundColor: colors.orange,
		borderColor: colors.card,
		borderRadius: 5,
		borderWidth: 1.5,
		height: 10,
		position: 'absolute',
		right: 3,
		top: 5,
		width: 10,
	},
});
