import {
	Button,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { listStyle } from '@expo/ui/swift-ui/modifiers';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import {
	isSensitiveDiagnosticKey,
	sanitizeDiagnosticValue,
} from '../core/redact';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type { DevToolsPanelPlugin, DevToolsSystemImage } from '../types';
import {
	assertEnvironmentRules,
	type EnvironmentSection,
	type EnvironmentValidationResult,
	type EnvironmentValueRule,
	environmentSectionEntries,
	summarizeEnvironmentHealth,
	validateEnvironmentValues as validateTypedEnvironmentValues,
} from './environment-model';

const MAX_ENVIRONMENT_RENDERED_VALUE_BYTES = 16 * 1024;

export function formatEnvironmentValue(value: unknown): string {
	if (value === undefined || value === null || value === '') return 'Not set';
	const sanitized = sanitizeDiagnosticValue(value);
	if (typeof sanitized === 'string') {
		return truncateText(sanitized, MAX_ENVIRONMENT_RENDERED_VALUE_BYTES).text;
	}
	if (typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}
	return serializeValue(sanitized, MAX_ENVIRONMENT_RENDERED_VALUE_BYTES).text;
}

function formatEnvironmentEntry(key: string, value: unknown): string {
	return isSensitiveDiagnosticKey(key)
		? '[REDACTED]'
		: formatEnvironmentValue(value);
}

export type EnvironmentPluginOptions = {
	values?: Readonly<Record<string, unknown>>;
	sections?: ReadonlyArray<EnvironmentSection>;
	rules?: readonly EnvironmentValueRule[];
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	tint?: string;
};

/**
 * Collapsed-row summary. Deliberately short: a serialized expected value would
 * be truncated to nothing useful in a disclosure label, so both values are
 * rendered as rows inside the expansion instead.
 */
function validationLabel(result: EnvironmentValidationResult): string {
	if (result.status === 'valid') return 'Valid';
	if (result.status === 'missing') return 'Missing';
	if (result.status === 'typeMismatch') {
		return `Expected ${result.expectedType}, found ${result.actualType}`;
	}
	return 'Unexpected value';
}

function formatEnvironmentKey(key: string): string {
	return key
		.replace(/^EXPO_PUBLIC_/, '')
		.split(/[_\-.]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0)}${part.slice(1).toLowerCase()}`)
		.join(' ');
}

export function createEnvironmentPlugin({
	values = {},
	sections,
	rules = [],
	title = 'Environment',
	id = 'environment',
	description = 'Declared build and runtime values',
	section,
	systemImage = 'gearshape.2.fill',
	tint = '#34C759',
}: EnvironmentPluginOptions): DevToolsPanelPlugin {
	const declaredSections =
		sections && sections.length > 0
			? sections
			: [{ title: 'Application manifest', values }];
	if (!Array.isArray(declaredSections) || declaredSections.length > 50) {
		throw new Error('Environment diagnostics support at most 50 sections.');
	}
	if (!Array.isArray(rules) || rules.length > 500) {
		throw new Error('Environment diagnostics support at most 500 rules.');
	}
	const sectionTitles = new Set<string>();
	for (const declaredSection of declaredSections) {
		if (
			!declaredSection ||
			typeof declaredSection !== 'object' ||
			typeof declaredSection.title !== 'string' ||
			!declaredSection.title.trim() ||
			declaredSection.title.length > 4 * 1024
		) {
			throw new Error('Environment section titles must be 1–4096 characters.');
		}
		if (
			!declaredSection.values ||
			typeof declaredSection.values !== 'object' ||
			Array.isArray(declaredSection.values)
		) {
			throw new Error('Environment section values must be an object.');
		}
		environmentSectionEntries(declaredSection, true);
		if (sectionTitles.has(declaredSection.title)) {
			throw new Error(
				`Duplicate environment section title: ${declaredSection.title}`,
			);
		}
		sectionTitles.add(declaredSection.title);
	}
	assertEnvironmentRules(declaredSections, rules);

	function EnvironmentPanel({ onBack }: { onBack: () => void }) {
		const validationResults = validateTypedEnvironmentValues(
			declaredSections,
			rules,
		);
		const failing = validationResults.filter(
			(result) => result.status !== 'valid',
		);
		const health = summarizeEnvironmentHealth(validationResults);
		const exportValue = sanitizeDiagnosticValue(
			Object.fromEntries(
				declaredSections.map((declared) => [declared.title, declared.values]),
			),
		);
		const shareManifest = () => {
			shareDiagnosticContent({
				message: serializeValue(exportValue, 512 * 1024).text,
				title,
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Share manifest"
						onPress={shareManifest}
						systemImage="square.and.arrow.up"
						testID="devtools-environment-share"
					/>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							{validationResults.length > 0 ? (
								<Section>
									<Label
										color={
											failing.length > 0
												? PlatformColor('systemOrangeColor')
												: PlatformColor('systemGreenColor')
										}
										systemImage={
											failing.length > 0
												? 'exclamationmark.triangle.fill'
												: 'checkmark.circle.fill'
										}
										title={
											failing.length > 0
												? `${failing.length} of ${validationResults.length} checks failing`
												: `${validationResults.length} of ${validationResults.length} checks passing`
										}
									/>
									<LabeledContent label="Health score">
										<UIText>{health.score}%</UIText>
									</LabeledContent>
									{failing.map((result) => (
										<DisclosureGroup
											key={`${result.section ?? '*'}:${result.key}`}
											label={`${formatEnvironmentKey(result.key)} — ${validationLabel(result)}`}
										>
											{result.description ? (
												<UIText>{result.description}</UIText>
											) : null}
											{Object.hasOwn(result, 'expectedValue') ? (
												<LabeledContent label="Expected">
													<UIText>
														{formatEnvironmentEntry(
															result.key,
															result.expectedValue,
														)}
													</UIText>
												</LabeledContent>
											) : null}
											<LabeledContent label="Actual">
												<UIText>
													{formatEnvironmentEntry(
														result.key,
														result.actualValue,
													)}
												</UIText>
											</LabeledContent>
										</DisclosureGroup>
									))}
								</Section>
							) : null}
							{declaredSections.map((declared) => {
								const entries = [...environmentSectionEntries(declared)].sort(
									([left], [right]) => left.localeCompare(right),
								);
								return (
									<Section key={declared.title} title={declared.title}>
										{entries.map(([key, value]) => (
											<LabeledContent
												key={key}
												label={formatEnvironmentKey(key)}
											>
												<UIText>{formatEnvironmentEntry(key, value)}</UIText>
											</LabeledContent>
										))}
									</Section>
								);
							})}
							<Section footer={<UIText>Fixed at build time.</UIText>}>
								<Button label="Share manifest…" onPress={shareManifest} />
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						{validationResults.length > 0 ? (
							<AndroidPanelSection title="Health">
								<AndroidPanelRow
									label="Health score"
									value={`${health.score}%`}
								/>
								<AndroidPanelRow
									label={
										failing.length > 0
											? `${failing.length} checks failing`
											: 'All checks passing'
									}
									tone={failing.length > 0 ? 'warning' : 'success'}
								/>
								{failing.map((result) => (
									<AndroidPanelRow
										key={`${result.section ?? '*'}:${result.key}`}
										label={formatEnvironmentKey(result.key)}
										detail={result.description}
										tone="warning"
										value={validationLabel(result)}
									/>
								))}
							</AndroidPanelSection>
						) : null}
						{declaredSections.map((declared) => (
							<AndroidPanelSection key={declared.title} title={declared.title}>
								{[...environmentSectionEntries(declared)]
									.sort(([left], [right]) => left.localeCompare(right))
									.map(([key, value]) => (
										<AndroidPanelRow
											key={key}
											label={formatEnvironmentKey(key)}
											value={formatEnvironmentEntry(key, value)}
										/>
									))}
							</AndroidPanelSection>
						))}
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	return {
		id,
		title,
		description,
		systemImage,
		tint,
		section,
		Panel: EnvironmentPanel,
	};
}
