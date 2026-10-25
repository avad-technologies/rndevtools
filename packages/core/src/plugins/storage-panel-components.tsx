import {
	Button,
	DisclosureGroup,
	HStack,
	Label,
	Picker,
	Section,
	Spacer,
	TextField,
	Text as UIText,
	useNativeState,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	lineLimit,
	listRowBackground,
	pickerStyle,
	tag,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelSearch,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { formatBytes } from '../core/format';
import { sanitizeDiagnosticValue } from '../core/redact';
import { serializeValue } from '../core/serialize';
import type { DevToolsActionConfirmation, DevToolsSystemImage } from '../types';
import {
	type DevToolsStorageAdapter,
	isStorageEntryEditable,
	parseStorageDraft,
	type StorageAdapterSnapshot,
	type StorageChangeEvent,
	type StorageEntrySnapshot,
	type StorageValidationResult,
} from './storage-model';

/** Plain uppercased section header (SwiftUI headers strip interactivity). */
export function SectionInfoHeader({ title }: { title: string }) {
	return (
		<UIText
			modifiers={[
				font({ textStyle: 'footnote' }),
				foregroundStyle('secondary'),
			]}
		>
			{title.toUpperCase()}
		</UIText>
	);
}

export type StorageTab = 'stores' | 'activity';

export type RunStorageMutation = (
	label: string,
	mutation: () => void | Promise<void>,
	confirmation?: DevToolsActionConfirmation,
) => void;

export function describeValueLength(chars: number): string {
	if (chars >= 1024) return formatBytes(chars);
	return chars === 1 ? '1 char' : `${chars} chars`;
}

export function countStorageChars(adapter: StorageAdapterSnapshot): number {
	return adapter.entries.reduce(
		(sum, entry) => sum + (entry.value?.length ?? 0),
		0,
	);
}

export function pluralizeKeys(count: number): string {
	return count === 1 ? '1 key' : `${count} keys`;
}

function storageKeyPrefix(key: string): string {
	const separator = key.search(/[/.]/);
	return separator > 0 ? key.slice(0, separator) : 'other';
}

function storageKeyTail(key: string): string {
	const separator = key.search(/[/.]/);
	return separator > 0 ? key.slice(separator + 1) : key;
}

export type StorageKeyGroup = {
	prefix: string;
	entries: StorageEntrySnapshot[];
};

export function groupStorageEntries(
	entries: readonly StorageEntrySnapshot[],
): StorageKeyGroup[] {
	const groups = new Map<string, StorageEntrySnapshot[]>();
	for (const entry of entries) {
		const prefix = storageKeyPrefix(entry.key);
		const group = groups.get(prefix);
		if (group) group.push(entry);
		else groups.set(prefix, [entry]);
	}
	return [...groups.entries()].map(([prefix, grouped]) => ({
		prefix,
		entries: grouped,
	}));
}

export function describeStorageGroup(group: StorageKeyGroup): string {
	const chars = group.entries.reduce(
		(sum, entry) => sum + (entry.value?.length ?? 0),
		0,
	);
	const size = chars >= 1024 ? ` · ${formatBytes(chars)}` : '';
	return `${group.prefix} · ${pluralizeKeys(group.entries.length)}${size}`;
}

export function describeAdapterSnapshot(
	adapter: StorageAdapterSnapshot,
): string {
	if (adapter.error) return `Unavailable · ${adapter.error}`;
	const keyCount = adapter.truncated
		? `${adapter.entries.length} of ${adapter.totalKeyCount} keys`
		: pluralizeKeys(adapter.entries.length);
	const parts = [adapter.description, keyCount];
	if (adapter.keyDiscovery === 'registered') parts.push('registered keys only');
	if (adapter.truncated) parts.push('snapshot limited');
	if (adapter.sensitive) parts.push('values hidden');
	else {
		const chars = countStorageChars(adapter);
		if (chars > 0) parts.push(formatBytes(chars));
	}
	return parts.filter(Boolean).join(' · ');
}

export function describeStorageEntry(entry: StorageEntrySnapshot): string {
	if (entry.valueHidden) return 'Value protected';
	if (entry.readError) return `Read failed · ${entry.readError}`;
	if (entry.binary) return 'Binary value · editing disabled';
	if (entry.redacted) return 'Sensitive data redacted · editing disabled';
	const sized =
		entry.valueType === 'string' ||
		entry.valueType === 'object' ||
		entry.valueType === 'array';
	const size = sized
		? ` · ${describeValueLength(entry.value?.length ?? 0)}`
		: '';
	const truncated = entry.truncated ? ' · preview limited' : '';
	return `${entry.valueType ?? 'unknown'}${size}${truncated}`;
}

export function describeValidationIssue(
	result: StorageValidationResult,
): string {
	if (result.status === 'typeMismatch') {
		return `Expected ${result.expectedType}, found ${result.actualType ?? 'unknown'}`;
	}
	if (result.status === 'notCaptured') return 'Not checked · snapshot limited';
	return 'Missing';
}

const storageEventPresentation: Record<
	StorageChangeEvent['type'],
	{ verb: string; systemImage: DevToolsSystemImage; color: string }
> = {
	added: { verb: 'Added', systemImage: 'plus', color: 'systemGreenColor' },
	updated: { verb: 'Updated', systemImage: 'pencil', color: 'systemBlueColor' },
	removed: { verb: 'Deleted', systemImage: 'minus', color: 'systemRedColor' },
};

export function describeStorageEvent(event: StorageChangeEvent): string {
	const parts = [event.adapterTitle, new Date(event.at).toLocaleTimeString()];
	if (event.valueHidden) parts.push('value never read');
	else {
		const value = event.value ?? event.previousValue;
		if (value !== undefined) parts.push(describeValueLength(value.length));
	}
	return parts.join(' · ');
}

export function StorageTabPicker({
	selection,
	onChange,
}: {
	selection: StorageTab;
	onChange: (tab: StorageTab) => void;
}) {
	return (
		<Section>
			<Picker
				label="Storage view"
				modifiers={[pickerStyle('segmented'), listRowBackground('clear')]}
				onSelectionChange={onChange}
				selection={selection}
			>
				<UIText modifiers={[tag('stores')]}>Stores</UIText>
				<UIText modifiers={[tag('activity')]}>Activity</UIText>
			</Picker>
		</Section>
	);
}

/** Verb-tinted icon row shared by recent activity and the activity log. */
export function StorageEventLabel({
	event,
	detail,
}: {
	event: StorageChangeEvent;
	detail: string;
}) {
	const presentation = storageEventPresentation[event.type];
	return (
		<Label
			color={PlatformColor(presentation.color)}
			systemImage={presentation.systemImage}
		>
			<VStack alignment="leading" spacing={2}>
				<UIText>
					<UIText>{`${presentation.verb} `}</UIText>
					<UIText
						modifiers={[font({ design: 'monospaced', textStyle: 'footnote' })]}
					>
						{event.key}
					</UIText>
				</UIText>
				<UIText
					modifiers={[
						font({ textStyle: 'footnote' }),
						foregroundStyle('secondary'),
					]}
				>
					{detail}
				</UIText>
			</VStack>
		</Label>
	);
}

/** Activity row; updated events expand to a previous/current diff. */
export function ActivityEventRow({
	event,
	onBookmark,
	onUndo,
}: {
	event: StorageChangeEvent;
	onBookmark?: () => void;
	onUndo?: () => void;
}) {
	const row = (
		<StorageEventLabel detail={describeStorageEvent(event)} event={event} />
	);
	return (
		<DisclosureGroup>
			<DisclosureGroup.Label>{row}</DisclosureGroup.Label>
			{event.previousValue !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						foregroundStyle(PlatformColor('systemRedColor')),
						lineLimit(4),
					]}
				>
					{`- ${event.previousValue}`}
				</UIText>
			) : null}
			{event.value !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						foregroundStyle(PlatformColor('systemGreenColor')),
						lineLimit(4),
					]}
				>
					{`+ ${event.value}`}
				</UIText>
			) : null}
			{event.structuralDiff?.map((entry) => (
				<UIText key={`${entry.path}:${entry.kind}`}>
					{`${entry.kind} ${entry.path}`}
				</UIText>
			))}
			{onBookmark ? (
				<Button
					label={event.bookmarked ? 'Remove bookmark' : 'Bookmark change'}
					onPress={onBookmark}
				/>
			) : null}
			{event.undoAvailable && onUndo ? (
				<Button label="Undo change" onPress={onUndo} />
			) : null}
		</DisclosureGroup>
	);
}

/**
 * Expanded key detail: full key, value editor (when the entry is safely
 * editable), and destructive delete. Mounted only while expanded so the
 * draft reseeds from the snapshot on every expansion.
 */
function StorageEntryDetails({
	adapter,
	entry,
	runMutation,
}: {
	adapter: DevToolsStorageAdapter;
	entry: StorageEntrySnapshot;
	runMutation: RunStorageMutation;
}) {
	const [draft, setDraft] = useState(entry.value ?? '');
	const [revealed, setRevealed] = useState<string | null>(null);
	const draftSeed = useNativeState(entry.value ?? '');
	const canEdit = isStorageEntryEditable(adapter, entry);
	return (
		<>
			<UIText
				modifiers={[
					font({ design: 'monospaced', textStyle: 'footnote' }),
					foregroundStyle('secondary'),
				]}
			>
				{entry.key}
			</UIText>
			{entry.valueHidden ? (
				<>
					<UIText
						modifiers={[
							font({ textStyle: 'footnote' }),
							foregroundStyle('secondary'),
						]}
					>
						{entry.requiresAuthentication
							? 'This value requires local device authentication and is never captured.'
							: entry.revealable && adapter.revealValue
								? 'This store exposes key metadata only. Its values are never captured.'
								: 'This store exposes key metadata only. Its values are never read.'}
					</UIText>
					{revealed ? <UIText>{revealed}</UIText> : null}
					{entry.revealable && adapter.revealValue ? (
						<Button
							label={revealed ? 'Hide revealed value' : 'Reveal on this device'}
							onPress={() => {
								if (revealed) return setRevealed(null);
								runMutation(
									'Reveal protected storage value',
									async () => {
										const value = await adapter.revealValue?.(entry.key);
										setRevealed(
											serializeValue(sanitizeDiagnosticValue(value), 16 * 1024)
												.text,
										);
									},
									{
										title: 'Reveal protected value?',
										message: `${entry.key}\n\nThe value is shown only on this device and is never sent to the desktop app.`,
										confirmLabel: 'Reveal',
									},
								);
							}}
						/>
					) : null}
				</>
			) : canEdit ? (
				<TextField
					axis="vertical"
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						autocorrectionDisabled(),
						lineLimit(8),
					]}
					onTextChange={setDraft}
					placeholder="Value"
					text={draftSeed}
				/>
			) : entry.value !== undefined ? (
				<UIText
					modifiers={[
						font({ design: 'monospaced', textStyle: 'footnote' }),
						lineLimit(8),
					]}
				>
					{entry.value}
				</UIText>
			) : null}
			{canEdit ? (
				<Button
					label="Save"
					onPress={() => {
						runMutation('Save storage value', () => {
							const parsed = adapter.parseValue
								? adapter.parseValue(entry.key, draft, entry.valueType ?? '')
								: parseStorageDraft(draft, entry.valueType ?? '');
							return adapter.setValue?.(entry.key, parsed);
						});
					}}
				/>
			) : null}
			{adapter.removeValue && (adapter.capabilities?.deletable ?? true) ? (
				// biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA
				<Button
					label="Delete key"
					onPress={() =>
						runMutation(
							'Delete storage value',
							() => adapter.removeValue?.(entry.key),
							{
								title: 'Delete storage value?',
								message: entry.key,
								confirmLabel: 'Delete',
								destructive: true,
							},
						)
					}
					role="destructive"
				/>
			) : null}
		</>
	);
}

/** Key row in the store browser: mono tail, type · size, small-value badge. */
export function StorageEntryRow({
	adapter,
	entry,
	expanded,
	onExpandedChange,
	runMutation,
}: {
	adapter: DevToolsStorageAdapter;
	entry: StorageEntrySnapshot;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	runMutation: RunStorageMutation;
}) {
	const smallValue =
		!entry.valueHidden &&
		!entry.readError &&
		!entry.binary &&
		!entry.truncated &&
		entry.value !== undefined &&
		entry.value.length <= 24
			? entry.valueType === 'string'
				? `"${entry.value}"`
				: entry.value
			: undefined;
	return (
		<DisclosureGroup
			isExpanded={expanded}
			onIsExpandedChange={onExpandedChange}
		>
			<DisclosureGroup.Label>
				<HStack spacing={10}>
					<VStack alignment="leading" spacing={2}>
						<UIText
							modifiers={[
								font({ design: 'monospaced', textStyle: 'subheadline' }),
							]}
						>
							{storageKeyTail(entry.key)}
						</UIText>
						<UIText
							modifiers={[
								font({ textStyle: 'footnote' }),
								foregroundStyle('secondary'),
							]}
						>
							{describeStorageEntry(entry)}
						</UIText>
					</VStack>
					<Spacer />
					{smallValue !== undefined ? (
						<UIText
							modifiers={[
								font({ design: 'monospaced', textStyle: 'footnote' }),
								foregroundStyle('secondary'),
								lineLimit(1),
							]}
						>
							{smallValue}
						</UIText>
					) : null}
				</HStack>
			</DisclosureGroup.Label>
			{expanded ? (
				<StorageEntryDetails
					adapter={adapter}
					entry={entry}
					key={`details:${entry.value ?? ''}`}
					runMutation={runMutation}
				/>
			) : null}
		</DisclosureGroup>
	);
}

export function AndroidStorageEntryDetails({
	adapter,
	entry,
	runMutation,
}: {
	adapter: DevToolsStorageAdapter;
	entry: StorageEntrySnapshot;
	runMutation: RunStorageMutation;
}) {
	const [draft, setDraft] = useState(entry.value ?? '');
	const [revealed, setRevealed] = useState<string | null>(null);
	const canEdit = isStorageEntryEditable(adapter, entry);
	return (
		<>
			<AndroidPanelTextBlock label="Full key" value={entry.key} />
			{entry.valueHidden ? (
				<>
					<AndroidPanelRow
						detail={
							entry.requiresAuthentication
								? 'Requires local authentication'
								: 'Metadata only'
						}
						label="Value protected"
					/>
					{revealed ? (
						<AndroidPanelTextBlock label="Revealed locally" value={revealed} />
					) : null}
					{entry.revealable && adapter.revealValue ? (
						<AndroidPanelRow
							label={revealed ? 'Hide revealed value' : 'Reveal on this device'}
							onPress={() => {
								if (revealed) return setRevealed(null);
								runMutation(
									'Reveal protected storage value',
									async () => {
										const value = await adapter.revealValue?.(entry.key);
										setRevealed(
											serializeValue(sanitizeDiagnosticValue(value), 16 * 1024)
												.text,
										);
									},
									{
										title: 'Reveal protected value?',
										message: `${entry.key}\n\nThe value is shown only on this device and is never sent to the desktop app.`,
										confirmLabel: 'Reveal',
									},
								);
							}}
						/>
					) : null}
				</>
			) : canEdit ? (
				<AndroidPanelSearch
					onChangeText={setDraft}
					placeholder="Value"
					value={draft}
				/>
			) : entry.value !== undefined ? (
				<AndroidPanelTextBlock label="Value" value={entry.value} />
			) : null}
			{canEdit ? (
				<AndroidPanelRow
					label="Save value"
					onPress={() =>
						runMutation('Save storage value', () => {
							const parsed = adapter.parseValue
								? adapter.parseValue(entry.key, draft, entry.valueType ?? '')
								: parseStorageDraft(draft, entry.valueType ?? '');
							return adapter.setValue?.(entry.key, parsed);
						})
					}
				/>
			) : null}
			{adapter.removeValue && (adapter.capabilities?.deletable ?? true) ? (
				<AndroidPanelRow
					label="Delete key"
					onPress={() =>
						runMutation(
							'Delete storage value',
							() => adapter.removeValue?.(entry.key),
							{
								title: 'Delete storage value?',
								message: entry.key,
								confirmLabel: 'Delete',
								destructive: true,
							},
						)
					}
					tone="danger"
				/>
			) : null}
		</>
	);
}
