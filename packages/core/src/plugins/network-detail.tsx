import {
	Button,
	DisclosureGroup,
	Host,
	LabeledContent,
	List,
	Section,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	font,
	foregroundStyle,
	listStyle,
	textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type { DevToolsActionServices } from '../types';
import {
	formatNetworkBytes,
	type NetworkEvent,
	parseNetworkUrl,
} from './network-capture';

import {
	buildCurlCommand,
	detailStatusText,
	formatNetworkClock,
	formatNetworkDuration,
	MAX_BODY_PREVIEW_BYTES,
	MUTATING_METHODS,
	type NetworkStatusTone,
	networkEventLabel,
	networkReplayBlockReason,
	networkRequestPath,
	networkStatusPresentation,
	prettyNetworkBody,
	responseBodySummaryText,
} from './network-presentation';

export function statusColor(tone: NetworkStatusTone) {
	if (tone === 'success') return PlatformColor('systemGreenColor');
	if (tone === 'danger') return PlatformColor('systemRedColor');
	if (tone === 'warning') return PlatformColor('systemOrangeColor');
	return PlatformColor('systemBlueColor');
}

const monoSmall = () => font({ design: 'monospaced', size: 12 });
export const secondarySmall = () => [
	font({ size: 13 }),
	foregroundStyle(PlatformColor('secondaryLabelColor')),
];

function HeaderRows({
	entries,
}: {
	entries: ReadonlyArray<readonly [string, string]>;
}) {
	return (
		<>
			{entries.map(([name, value]) => (
				<LabeledContent key={name} label={name}>
					<UIText modifiers={[monoSmall()]}>{value}</UIText>
				</LabeledContent>
			))}
		</>
	);
}

export function NetworkEventDetail({
	actions,
	captureReplaySession,
	event,
	listTitle,
	maxBodyBytes,
	onBack,
	pluginId,
	replayEnabled,
}: {
	actions: DevToolsActionServices;
	captureReplaySession: () => () => Readonly<{
		init: RequestInit;
		url: string;
	}>;
	event: NetworkEvent;
	listTitle: string;
	maxBodyBytes: number;
	onBack: () => void;
	pluginId: string;
	replayEnabled: boolean;
}) {
	const { label } = networkEventLabel(event);
	const status = networkStatusPresentation(event);
	const path = networkRequestPath(event.url);
	const requestHeaderEntries = Object.entries(event.requestHeaders);
	const responseHeaderEntries = Object.entries(event.responseHeaders ?? {});
	const replayBlockReason = replayEnabled
		? networkReplayBlockReason(event)
		: 'Request replay is disabled by this host.';
	const timingRows: readonly (readonly [string, number])[] = (
		[
			['Synthetic latency', event.timing?.latencyDelayMs],
			['Synthetic upload', event.timing?.uploadDelayMs],
			['Transport / response', event.timing?.transportMs],
			['Synthetic download', event.timing?.downloadDelayMs],
			['Total', event.timing?.totalMs],
		] as const
	).flatMap(([label, milliseconds]) =>
		milliseconds === undefined ? [] : [[label, milliseconds] as const],
	);
	// Pretty-printing can chew through 256 KB bodies; cache per event so live
	// capture ticks don't re-parse while the detail is open.
	const requestBody = useMemo(
		() =>
			event.requestBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.requestBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const responseBody = useMemo(
		() =>
			event.responseBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.responseBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const requestBodySummary =
		event.requestBody === undefined
			? event.bodyCaptureEnabled === false
				? 'Not captured'
				: 'Empty'
			: formatNetworkBytes(event.requestSizeBytes);
	const shareEvent = () => {
		shareDiagnosticContent({
			title: `${event.method} ${path}`,
			message: serializeValue(event, 512 * 1024).text,
		});
	};
	// expo-clipboard is not a dependency; the share sheet's Copy action is the
	// sanctioned way to get text onto the pasteboard from here.
	const copyCurl = () => {
		shareDiagnosticContent({ message: buildCurlCommand(event) });
	};
	const resendRequest = () => {
		if (replayBlockReason) return;
		let resolveReplayRequest: () => Readonly<{
			init: RequestInit;
			url: string;
		}>;
		try {
			resolveReplayRequest = captureReplaySession();
		} catch {
			return;
		}
		const confirmationMethod = event.method;
		const confirmationHost = parseNetworkUrl(event.url).host;
		void actions.run({
			pluginId,
			label: 'Re-send request',
			confirmation: {
				title: 'Re-send this request?',
				message: `A real ${confirmationMethod} goes to ${confirmationHost}. The request has no detected redaction placeholders, but the response can still differ from the captured one.`,
				confirmLabel: 'Re-send',
				destructive: MUTATING_METHODS.has(confirmationMethod),
			},
			action: async () => {
				const replayRequest = resolveReplayRequest();
				// The instrumented global fetch captures the replay as a new event.
				await globalThis.fetch(replayRequest.url, replayRequest.init);
			},
		});
	};

	return (
		<PanelShell
			backLabel={listTitle}
			onBack={onBack}
			title={`${event.method} ${label}`}
			trailing={
				<NavIconButton
					accessibilityLabel="Share request"
					onPress={shareEvent}
					systemImage="square.and.arrow.up"
					testID="devtools-network-share"
				/>
			}
		>
			{Platform.OS === 'ios' ? (
				<Host style={{ flex: 1 }}>
					<List modifiers={[listStyle('insetGrouped')]}>
						<Section title="Overview">
							<LabeledContent label="Status">
								<UIText
									modifiers={[
										font({ design: 'monospaced', weight: 'semibold' }),
										foregroundStyle(statusColor(status.tone)),
									]}
								>
									{detailStatusText(event)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Duration">
								<UIText>
									{event.state === 'pending'
										? 'Pending'
										: formatNetworkDuration(event.durationMs)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Started">
								<UIText>{formatNetworkClock(event.startedAt)}</UIText>
							</LabeledContent>
							<LabeledContent label="Size">
								<UIText>{`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}</UIText>
							</LabeledContent>
							<LabeledContent label="Source">
								<UIText>{event.source}</UIText>
							</LabeledContent>
							<LabeledContent label="Profile">
								<UIText>{event.simulationProfileId ?? 'none'}</UIText>
							</LabeledContent>
							<LabeledContent label="Cache evidence">
								<UIText>{event.cacheStatus ?? 'unknown'}</UIText>
							</LabeledContent>
							{event.correlationId ? (
								<LabeledContent label="Correlation ID">
									<UIText modifiers={[monoSmall()]}>
										{event.correlationId}
									</UIText>
								</LabeledContent>
							) : null}
							{event.error ? (
								<LabeledContent label="Error">
									<UIText
										modifiers={[
											foregroundStyle(PlatformColor('systemRedColor')),
										]}
									>
										{event.error}
									</UIText>
								</LabeledContent>
							) : null}
						</Section>
						{timingRows.length > 0 ? (
							<Section
								footer={
									<UIText>
										Transport / response combines native connection and server
										work because fetch does not expose DNS, connect, TLS, or
										TTFB phases.
									</UIText>
								}
								title="Timing"
							>
								{timingRows.map(([label, milliseconds]) => (
									<LabeledContent key={label} label={label}>
										<UIText>{formatNetworkDuration(milliseconds)}</UIText>
									</LabeledContent>
								))}
							</Section>
						) : null}
						<Section title="Request">
							<VStack alignment="leading" spacing={3}>
								<UIText modifiers={secondarySmall()}>URL</UIText>
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{path}
								</UIText>
							</VStack>
							<DisclosureGroup
								label={`Headers (${requestHeaderEntries.length})`}
							>
								<HeaderRows entries={requestHeaderEntries} />
							</DisclosureGroup>
							<LabeledContent label="Body">
								<UIText>{requestBodySummary}</UIText>
							</LabeledContent>
							{requestBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{requestBody}
								</UIText>
							) : null}
						</Section>
						<Section
							footer={
								<UIText>
									{`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are omitted rather than retained.`}
								</UIText>
							}
							title="Response"
						>
							{responseHeaderEntries.length > 0 ? (
								<DisclosureGroup
									label={`Headers (${responseHeaderEntries.length})`}
								>
									<HeaderRows entries={responseHeaderEntries} />
								</DisclosureGroup>
							) : null}
							<LabeledContent label="Body">
								<UIText>{responseBodySummaryText(event)}</UIText>
							</LabeledContent>
							{responseBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{responseBody}
								</UIText>
							) : null}
						</Section>
						<Section>
							<Button
								label="Copy as cURL"
								onPress={copyCurl}
								testID="devtools-network-copy-curl"
							/>
							{replayBlockReason ? (
								<UIText modifiers={secondarySmall()}>
									{`Re-send unavailable: ${replayBlockReason}`}
								</UIText>
							) : (
								<Button
									label="Re-send request"
									onPress={resendRequest}
									testID="devtools-network-resend"
								/>
							)}
							<Button
								label="Share…"
								onPress={shareEvent}
								testID="devtools-network-share-action"
							/>
						</Section>
					</List>
				</Host>
			) : (
				<AndroidPanelScroll>
					<AndroidPanelSection title="Overview">
						<AndroidPanelRow label="Status" value={detailStatusText(event)} />
						<AndroidPanelRow
							label="Duration"
							value={
								event.state === 'pending'
									? 'Pending'
									: formatNetworkDuration(event.durationMs)
							}
						/>
						<AndroidPanelRow
							label="Started"
							value={formatNetworkClock(event.startedAt)}
						/>
						<AndroidPanelRow
							label="Size"
							value={`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}
						/>
						<AndroidPanelRow label="Source" value={event.source} />
						<AndroidPanelRow
							label="Profile"
							value={event.simulationProfileId ?? 'none'}
						/>
						<AndroidPanelRow
							label="Cache evidence"
							value={event.cacheStatus ?? 'unknown'}
						/>
						{event.correlationId ? (
							<AndroidPanelTextBlock
								label="Correlation ID"
								value={event.correlationId}
							/>
						) : null}
						{event.error ? (
							<AndroidPanelTextBlock
								label="Error"
								tone="danger"
								value={event.error}
							/>
						) : null}
					</AndroidPanelSection>
					{timingRows.length > 0 ? (
						<AndroidPanelSection
							footer="Transport / response combines native connection and server work because fetch does not expose DNS, connect, TLS, or TTFB phases."
							title="Timing"
						>
							{timingRows.map(([label, milliseconds]) => (
								<AndroidPanelRow
									key={label}
									label={label}
									value={formatNetworkDuration(milliseconds)}
								/>
							))}
						</AndroidPanelSection>
					) : null}
					<AndroidPanelSection title="Request">
						<AndroidPanelTextBlock label="URL" value={path} />
						<AndroidPanelRow
							label="Headers"
							value={String(requestHeaderEntries.length)}
						/>
						{requestHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow label="Body" value={requestBodySummary} />
						{requestBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={requestBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection
						title="Response"
						footer={`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are omitted rather than retained.`}
					>
						<AndroidPanelRow
							label="Headers"
							value={String(responseHeaderEntries.length)}
						/>
						{responseHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow
							label="Body"
							value={responseBodySummaryText(event)}
						/>
						{responseBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={responseBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection title="Actions">
						<AndroidPanelRow label="Copy as cURL" onPress={copyCurl} />
						{replayBlockReason ? (
							<AndroidPanelTextBlock
								label="Re-send unavailable"
								value={replayBlockReason}
							/>
						) : (
							<AndroidPanelRow
								label="Re-send request"
								onPress={resendRequest}
							/>
						)}
						<AndroidPanelRow label="Share…" onPress={shareEvent} />
					</AndroidPanelSection>
				</AndroidPanelScroll>
			)}
		</PanelShell>
	);
}
