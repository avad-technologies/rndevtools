import {
	Button,
	ContentUnavailableView,
	Host,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { foregroundStyle, listStyle } from '@expo/ui/swift-ui/modifiers';
import { Component, type ErrorInfo } from 'react';
import { Platform, PlatformColor } from 'react-native';
import { diagnosticErrorText } from '../core/redact';
import { truncateText } from '../core/serialize';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from './android-panel-ui';
import { PanelShell } from './panel-shell';

type PluginPanelRendererProps = {
	plugin: DevToolsPanelPlugin;
	panelProps: DevToolsPanelProps;
	onError?: (error: unknown, pluginId: string) => void;
};

type BoundaryProps = PluginPanelRendererProps;

type BoundaryState = {
	error: Error | null;
	retryKey: number;
};

class PluginPanelBoundary extends Component<BoundaryProps, BoundaryState> {
	state: BoundaryState = { error: null, retryKey: 0 };

	static getDerivedStateFromError(
		error: unknown,
	): Pick<BoundaryState, 'error'> {
		const message = truncateText(diagnosticErrorText(error), 8 * 1024).text;
		return {
			error: new Error(message || 'Unknown panel error'),
		};
	}

	componentDidCatch(error: Error, _info: ErrorInfo): void {
		try {
			this.props.onError?.(error, this.props.plugin.id);
		} catch {
			// Error reporting must not escape the panel isolation boundary.
		}
	}

	retry = (): void => {
		this.setState((state) => ({
			error: null,
			retryKey: state.retryKey + 1,
		}));
	};

	render() {
		const { error, retryKey } = this.state;
		const { panelProps, plugin } = this.props;
		if (error) {
			return (
				<PanelShell onBack={panelProps.onBack} title={plugin.title}>
					{Platform.OS === 'ios' ? (
						<Host style={{ flex: 1 }}>
							<List modifiers={[listStyle('insetGrouped')]}>
								<Section>
									<ContentUnavailableView
										description="The collector is still isolated. Retry the panel or return to the tool list."
										systemImage="exclamationmark.triangle.fill"
										title="This tool could not render"
									/>
								</Section>
								<Section title="Technical detail">
									<UIText
										modifiers={[
											foregroundStyle(PlatformColor('systemRedColor')),
										]}
									>
										{error.message}
									</UIText>
								</Section>
								<Section>
									<Button label="Retry" onPress={this.retry} />
									<Button label="Return to tools" onPress={panelProps.onBack} />
								</Section>
							</List>
						</Host>
					) : (
						<AndroidPanelScroll>
							<AndroidPanelSection
								footer="The collector is still isolated. Retry the panel or return to the tool list."
								title="This tool could not render"
							>
								<AndroidPanelTextBlock
									label="Technical detail"
									tone="danger"
									value={error.message}
								/>
							</AndroidPanelSection>
							<AndroidPanelSection title="Actions">
								<AndroidPanelRow label="Retry" onPress={this.retry} />
								<AndroidPanelRow
									label="Return to tools"
									onPress={panelProps.onBack}
								/>
							</AndroidPanelSection>
						</AndroidPanelScroll>
					)}
				</PanelShell>
			);
		}

		return <plugin.Panel key={retryKey} {...panelProps} />;
	}
}

export function PluginPanelRenderer(props: PluginPanelRendererProps) {
	return <PluginPanelBoundary key={props.plugin.id} {...props} />;
}
