import type { Image } from '@expo/ui/swift-ui';
import type { ComponentProps, ComponentType } from 'react';
import type { ColorValue } from 'react-native';

export type DevToolsPresentationMode = 'sheet' | 'window' | 'pill';

export type DevToolsPosition = {
	x: number;
	y: number;
};

export type DevToolsSize = {
	width: number;
	height: number;
};

export type DevToolsPersistenceStorage = {
	getItem: (key: string) => string | null | Promise<string | null>;
	setItem: (key: string, value: string) => void | Promise<void>;
};

export type DevToolsPersistenceOptions = {
	storage: DevToolsPersistenceStorage;
	key?: string;
};

export type DevToolsRuntimeErrorContext =
	| { kind: 'collector'; pluginId: string }
	| { kind: 'panel'; pluginId: string }
	| { kind: 'action'; pluginId: string }
	| { kind: 'persistence' };

export type DevToolsSystemImage = NonNullable<
	ComponentProps<typeof Image>['systemName']
>;

export type DevToolsActionConfirmation = {
	title: string;
	message?: string;
	confirmLabel?: string;
	destructive?: boolean;
};

export type DevToolsActionRequest = {
	pluginId: string;
	label: string;
	confirmation?: DevToolsActionConfirmation;
	action: () => unknown | Promise<unknown>;
};

export type DevToolsAuditEvent = {
	at: number;
	pluginId: string;
	label: string;
	status: 'cancelled' | 'failed' | 'started' | 'succeeded';
	error?: string;
};

export type DevToolsActionServices = {
	run: (request: DevToolsActionRequest) => Promise<boolean>;
};

export type DevToolsPillQuickActionOption = {
	id: string;
	label: string;
	systemImage?: DevToolsSystemImage;
	confirmation?: DevToolsActionConfirmation;
	action: () => unknown | Promise<unknown>;
};

export type DevToolsPillQuickAction = {
	systemImage?: DevToolsSystemImage;
	options:
		| readonly DevToolsPillQuickActionOption[]
		| (() => readonly DevToolsPillQuickActionOption[]);
	getSelectedOptionId?: () => string | null;
	/** Show the pill slot's attention dot (e.g. an override is active). */
	getIsHighlighted?: () => boolean;
	/** Adds an "Open <label>…" item that opens this plugin's full panel. */
	openPanelLabel?: string;
	subscribe?: (listener: () => void) => () => void;
};

export type DevToolsPanelProps = {
	onBack: () => void;
	onClose: () => void;
	presentationMode: DevToolsPresentationMode;
	/** Root-window inset forwarded across native sheet hosting boundaries. */
	safeAreaTop?: number;
	onPresentationModeChange: (mode: DevToolsPresentationMode) => void;
	actions: DevToolsActionServices;
};

export type DevToolsPluginMetadata = {
	id: string;
	title: string;
	description: string;
	systemImage: DevToolsSystemImage;
	/**
	 * Icon-chip color on the tools home; hosts theme their tools. Prefer a
	 * `PlatformColor` over a literal so the chip follows the system palette.
	 */
	tint?: ColorValue;
	section?: string;
	install?: () => () => void;
	pillQuickAction?: DevToolsPillQuickAction;
};

export type DevToolsPanelPlugin = DevToolsPluginMetadata & {
	kind?: 'panel';
	Panel: ComponentType<DevToolsPanelProps>;
};

export type DevToolsActionContext = {
	close: () => void;
	presentationMode: DevToolsPresentationMode;
	setPresentationMode: (mode: DevToolsPresentationMode) => void;
};

export type DevToolsActionPlugin = DevToolsPluginMetadata & {
	kind: 'action';
	confirmation?: DevToolsActionConfirmation;
	onPress: (context: DevToolsActionContext) => void | Promise<void>;
};

export type DevToolsPlugin = DevToolsPanelPlugin | DevToolsActionPlugin;

export type DevToolsPluginWithPillQuickAction = DevToolsPlugin & {
	pillQuickAction: DevToolsPillQuickAction;
};

export type DevToolsHomeStatusRow = {
	id: string;
	label: string;
	value: string;
	badge?: {
		label: string;
		tone?: 'info' | 'success' | 'warning' | 'danger';
	};
	/** Opens this plugin's panel when the row is tapped. */
	onPressPluginId?: string;
};

export type InternalToolsProps = {
	enabled: boolean;
	visible?: boolean;
	plugins: readonly DevToolsPlugin[];
	/** Glanceable rows pinned above the tool list (backend, build, data …). */
	homeStatus?: readonly DevToolsHomeStatusRow[];
	title?: string;
	launcherLabel?: string;
	pillLabel?: string;
	defaultPresentationMode?: DevToolsPresentationMode;
	presentationMode?: DevToolsPresentationMode;
	onPresentationModeChange?: (mode: DevToolsPresentationMode) => void;
	persistence?: DevToolsPersistenceOptions;
	bottomObstructionInset?: number;
	onError?: (error: unknown, context: DevToolsRuntimeErrorContext) => void;
	onAuditEvent?: (event: DevToolsAuditEvent) => void;
};

export type InternalToolsHandle = {
	open: () => void;
	close: () => void;
	openPlugin: (pluginId: string) => void;
	setPresentationMode: (mode: DevToolsPresentationMode) => void;
};
