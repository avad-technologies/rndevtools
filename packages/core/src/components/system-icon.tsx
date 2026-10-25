import {
	type IconName,
	Host as UniversalHost,
	Icon as UniversalIcon,
} from '@expo/ui';
import { Host, Image } from '@expo/ui/swift-ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon';
import CloudIcon from '@hugeicons/core-free-icons/CloudIcon';
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon';
import DatabaseIcon from '@hugeicons/core-free-icons/DatabaseIcon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon';
import HardDriveIcon from '@hugeicons/core-free-icons/HardDriveIcon';
import HourglassIcon from '@hugeicons/core-free-icons/HourglassIcon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon';
import LinkSquare02Icon from '@hugeicons/core-free-icons/LinkSquare02Icon';
import Location01Icon from '@hugeicons/core-free-icons/Location01Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import PauseIcon from '@hugeicons/core-free-icons/PauseIcon';
import PinIcon from '@hugeicons/core-free-icons/PinIcon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Shield01Icon from '@hugeicons/core-free-icons/Shield01Icon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import Timer01Icon from '@hugeicons/core-free-icons/Timer01Icon';
import ToolsIcon from '@hugeicons/core-free-icons/ToolsIcon';
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon';
import UserIcon from '@hugeicons/core-free-icons/UserIcon';
import Wifi01Icon from '@hugeicons/core-free-icons/Wifi01Icon';
import { HugeiconsIcon } from '@hugeicons/react-native';
import { type ColorValue, Platform, PlatformColor, View } from 'react-native';
import type { DevToolsSystemImage } from '../types';

type SystemIconProps = {
	systemName: DevToolsSystemImage;
	size?: number;
	color?: ColorValue;
};

const materialIcons = {
	back: UniversalIcon.select({
		ios: 'chevron.left',
		android: import('@expo/material-symbols/chevron_left.xml'),
	}),
	build: UniversalIcon.select({
		ios: 'wrench.and.screwdriver.fill',
		android: import('@expo/material-symbols/build.xml'),
	}),
	check: UniversalIcon.select({
		ios: 'checkmark',
		android: import('@expo/material-symbols/check.xml'),
	}),
	close: UniversalIcon.select({
		ios: 'xmark',
		android: import('@expo/material-symbols/close.xml'),
	}),
	cloud: UniversalIcon.select({
		ios: 'icloud',
		android: import('@expo/material-symbols/cloud.xml'),
	}),
	database: UniversalIcon.select({
		ios: 'externaldrive.fill',
		android: import('@expo/material-symbols/database.xml'),
	}),
	delete: UniversalIcon.select({
		ios: 'trash',
		android: import('@expo/material-symbols/delete.xml'),
	}),
	edit: UniversalIcon.select({
		ios: 'pencil',
		android: import('@expo/material-symbols/edit.xml'),
	}),
	forward: UniversalIcon.select({
		ios: 'chevron.right',
		android: import('@expo/material-symbols/chevron_right.xml'),
	}),
	group: UniversalIcon.select({
		ios: 'person.2.fill',
		android: import('@expo/material-symbols/groups.xml'),
	}),
	hourglass: UniversalIcon.select({
		ios: 'hourglass',
		android: import('@expo/material-symbols/hourglass_empty.xml'),
	}),
	info: UniversalIcon.select({
		ios: 'info.circle',
		android: import('@expo/material-symbols/info.xml'),
	}),
	link: UniversalIcon.select({
		ios: 'link',
		android: import('@expo/material-symbols/link.xml'),
	}),
	location: UniversalIcon.select({
		ios: 'location.fill',
		android: import('@expo/material-symbols/location_on.xml'),
	}),
	message: UniversalIcon.select({
		ios: 'text.bubble.fill',
		android: import('@expo/material-symbols/chat.xml'),
	}),
	more: UniversalIcon.select({
		ios: 'ellipsis.circle',
		android: import('@expo/material-symbols/more_vert.xml'),
	}),
	network: UniversalIcon.select({
		ios: 'network',
		android: import('@expo/material-symbols/network_check.xml'),
	}),
	open: UniversalIcon.select({
		ios: 'arrow.up.forward',
		android: import('@expo/material-symbols/open_in_new.xml'),
	}),
	pause: UniversalIcon.select({
		ios: 'pause.fill',
		android: import('@expo/material-symbols/pause.xml'),
	}),
	person: UniversalIcon.select({
		ios: 'person.crop.circle',
		android: import('@expo/material-symbols/person.xml'),
	}),
	pin: UniversalIcon.select({
		ios: 'pin',
		android: import('@expo/material-symbols/pin.xml'),
	}),
	play: UniversalIcon.select({
		ios: 'play.fill',
		android: import('@expo/material-symbols/play_arrow.xml'),
	}),
	refresh: UniversalIcon.select({
		ios: 'arrow.clockwise',
		android: import('@expo/material-symbols/refresh.xml'),
	}),
	search: UniversalIcon.select({
		ios: 'magnifyingglass',
		android: import('@expo/material-symbols/search.xml'),
	}),
	settings: UniversalIcon.select({
		ios: 'gearshape.2.fill',
		android: import('@expo/material-symbols/settings.xml'),
	}),
	shield: UniversalIcon.select({
		ios: 'lock.shield',
		android: import('@expo/material-symbols/shield_lock.xml'),
	}),
	storage: UniversalIcon.select({
		ios: 'externaldrive.fill',
		android: import('@expo/material-symbols/storage.xml'),
	}),
	timer: UniversalIcon.select({
		ios: 'timer',
		android: import('@expo/material-symbols/timer.xml'),
	}),
	warning: UniversalIcon.select({
		ios: 'exclamationmark.triangle.fill',
		android: import('@expo/material-symbols/warning.xml'),
	}),
	window: UniversalIcon.select({
		ios: 'macwindow',
		android: import('@expo/material-symbols/window.xml'),
	}),
} as const satisfies Record<string, IconName>;

function iconKeyForSystemImage(
	systemName: DevToolsSystemImage,
): keyof typeof materialIcons {
	if (systemName === 'chevron.left') return 'back';
	if (systemName === 'chevron.right') return 'forward';
	if (systemName === 'xmark' || systemName.startsWith('xmark.')) return 'close';
	if (systemName.includes('checkmark')) return 'check';
	if (systemName.includes('trash')) return 'delete';
	if (systemName.includes('pencil')) return 'edit';
	if (systemName.includes('magnifyingglass')) return 'search';
	if (systemName.includes('person.2')) return 'group';
	if (systemName.includes('person')) return 'person';
	if (systemName.includes('bubble')) return 'message';
	if (systemName.includes('network') || systemName.includes('wifi'))
		return 'network';
	if (systemName.includes('externaldrive') || systemName.includes('storage'))
		return 'storage';
	if (systemName.includes('stack') || systemName.includes('database'))
		return 'database';
	if (systemName.includes('gear')) return 'settings';
	if (systemName.includes('shield') || systemName.includes('lock'))
		return 'shield';
	if (systemName.includes('timer') || systemName.includes('clock'))
		return 'timer';
	if (systemName.includes('hourglass')) return 'hourglass';
	if (systemName.includes('location')) return 'location';
	if (systemName.includes('link')) return 'link';
	if (systemName.includes('pause')) return 'pause';
	if (systemName.includes('play')) return 'play';
	if (
		systemName.includes('clockwise') ||
		systemName.includes('counterclockwise') ||
		systemName.includes('circlepath')
	)
		return 'refresh';
	if (systemName.includes('exclamationmark')) return 'warning';
	if (systemName.includes('info')) return 'info';
	if (systemName.includes('pin')) return 'pin';
	if (
		systemName.includes('arrow.up') ||
		systemName.includes('square.and.arrow.up')
	)
		return 'open';
	if (systemName.includes('window')) return 'window';
	if (systemName.includes('ellipsis')) return 'more';
	if (systemName.includes('icloud') || systemName.includes('cloud'))
		return 'cloud';
	return 'build';
}

export function universalIconForSystemImage(
	systemName: DevToolsSystemImage,
): IconName {
	return materialIcons[iconKeyForSystemImage(systemName)];
}

// Content icons use Hugeicons; NavIconButton keeps native platform symbols.
const contentIcons = {
	build: ToolsIcon,
	check: Tick02Icon,
	cloud: CloudIcon,
	database: DatabaseIcon,
	delete: Delete02Icon,
	edit: Edit02Icon,
	forward: ArrowRight01Icon,
	group: UserGroupIcon,
	hourglass: HourglassIcon,
	info: InformationCircleIcon,
	link: Link01Icon,
	location: Location01Icon,
	message: BubbleChatIcon,
	more: MoreHorizontalIcon,
	network: Wifi01Icon,
	open: LinkSquare02Icon,
	pause: PauseIcon,
	person: UserIcon,
	pin: PinIcon,
	play: PlayIcon,
	refresh: RefreshIcon,
	search: Search01Icon,
	settings: Settings01Icon,
	shield: Shield01Icon,
	storage: HardDriveIcon,
	timer: Timer01Icon,
	warning: Alert02Icon,
	window: ComputerIcon,
} as const;

export function SystemIcon({
	systemName,
	size = 20,
	color = Platform.OS === 'ios' ? PlatformColor('systemBlueColor') : '#6750A4',
}: SystemIconProps) {
	const key = iconKeyForSystemImage(systemName);
	if (key === 'back' || key === 'close') {
		if (Platform.OS !== 'ios') {
			return (
				<View pointerEvents="none" style={{ height: size, width: size }}>
					<UniversalHost matchContents style={{ flex: 1 }}>
						<UniversalIcon
							color={color}
							name={universalIconForSystemImage(systemName)}
							size={size}
							testID={`system-icon-${systemName}`}
						/>
					</UniversalHost>
				</View>
			);
		}
		return (
			<View pointerEvents="none" style={{ height: size, width: size }}>
				<Host style={{ flex: 1 }}>
					<Image
						color={color}
						modifiers={[frame({ width: size, height: size })]}
						size={size}
						systemName={systemName}
					/>
				</Host>
			</View>
		);
	}
	return (
		<View pointerEvents="none" style={{ height: size, width: size }}>
			<HugeiconsIcon
				icon={contentIcons[key]}
				color={color}
				size={size}
				testID={`system-icon-${systemName}`}
			/>
		</View>
	);
}
