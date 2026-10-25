import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	ChevronDown,
	Frame,
	Layers3,
	LoaderCircle,
	Sparkles,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { InfoPopover } from '@/components/ui';
import type { SimulatorCapture } from '../../shared/simulator-protocol';
import {
	CAPTURE_CANVAS_PRESETS,
	type CaptureCompositionFields,
	captureCompositionAspectRatio,
	parseCaptureCompositionFields,
} from '../simulator/capture-composition-model';

export function CaptureCompositionPreview({
	fields,
	primaryUrl,
	secondaryUrl,
}: {
	fields: CaptureCompositionFields;
	primaryUrl: string;
	secondaryUrl?: string;
}) {
	const preset = CAPTURE_CANVAS_PRESETS[fields.canvasPreset];
	const padding = Number(fields.padding);
	const paddingPercent = Number.isFinite(padding)
		? Math.min(
				28,
				Math.max(0, (padding / Math.max(preset.width, preset.height)) * 100)
			)
		: 0;
	const background =
		fields.backgroundKind === 'transparent'
			? 'repeating-conic-gradient(#171717 0 25%, #0d0d0d 0 50%) 50% / 12px 12px'
			: fields.backgroundKind === 'solid'
				? fields.backgroundStart
				: `linear-gradient(${gradientAngle(fields.gradientDirection)}, ${fields.backgroundStart}, ${fields.backgroundEnd})`;
	const imageStyle: CSSProperties = {
		objectFit: fields.contentMode === 'fit' ? 'contain' : 'cover',
		transform: `rotate(${fields.rotation}deg)`,
	};
	const frameStyle: CSSProperties = {
		borderRadius: `${Math.min(18, Math.max(0, Number(fields.cornerRadius) / 8))}px`,
		boxShadow: fields.shadow ? '0 14px 32px rgb(0 0 0 / 55%)' : 'none',
	};
	const images =
		fields.comparisonMode === 'side_by_side' && secondaryUrl ? (
			<div className="sim-composition-comparison is-side-by-side">
				<PreviewFrame
					bezel={fields.bezel}
					frameStyle={frameStyle}
					imageStyle={imageStyle}
					url={primaryUrl}
				/>
				<PreviewFrame
					bezel={fields.bezel}
					frameStyle={frameStyle}
					imageStyle={imageStyle}
					url={secondaryUrl}
				/>
			</div>
		) : (
			<div className="sim-composition-comparison">
				<PreviewFrame
					bezel={fields.bezel}
					frameStyle={frameStyle}
					imageStyle={imageStyle}
					url={primaryUrl}
				/>
				{secondaryUrl && fields.comparisonMode !== 'none' ? (
					<img
						alt="Comparison capture preview"
						className={`sim-composition-overlay is-${fields.comparisonMode}`}
						src={secondaryUrl}
						style={{
							...imageStyle,
							opacity:
								fields.comparisonMode === 'opacity'
									? Math.min(
											1,
											Math.max(0, Number(fields.comparisonAmount) / 100)
										)
									: 1,
						}}
					/>
				) : null}
			</div>
		);
	return (
		<div
			className="sim-composition-preview"
			style={{ aspectRatio: captureCompositionAspectRatio(fields), background }}
		>
			<div
				className="sim-composition-content"
				style={{ padding: `${paddingPercent}%` }}
			>
				{images}
			</div>
			{fields.metadataEnabled && fields.metadataText ? (
				<div
					className={`sim-composition-metadata is-${fields.metadataPlacement}`}
				>
					<span>{fields.metadataText}</span>
				</div>
			) : null}
		</div>
	);
}

function PreviewFrame({
	url,
	bezel,
	frameStyle,
	imageStyle,
}: {
	url: string;
	bezel: boolean;
	frameStyle: CSSProperties;
	imageStyle: CSSProperties;
}) {
	return (
		<div
			className={`sim-composition-frame ${bezel ? 'has-bezel' : ''}`}
			style={frameStyle}
		>
			<img
				alt="Primary capture composition preview"
				src={url}
				style={imageStyle}
			/>
		</div>
	);
}

function gradientAngle(
	direction: CaptureCompositionFields['gradientDirection']
): string {
	if (direction === 'left_to_right') return '90deg';
	if (direction === 'top_left_to_bottom_right') return '135deg';
	return '180deg';
}

export function CaptureCompositionEditor({
	fields,
	onChange,
	primaryCapture,
	screenshots,
	nativeAvailable,
	isRendering,
	onRender,
}: {
	fields: CaptureCompositionFields;
	onChange: (fields: CaptureCompositionFields) => void;
	primaryCapture: SimulatorCapture | null;
	screenshots: SimulatorCapture[];
	nativeAvailable: boolean;
	isRendering: boolean;
	onRender: () => void;
}) {
	const update = <Key extends keyof CaptureCompositionFields>(
		key: Key,
		value: CaptureCompositionFields[Key]
	) => onChange({ ...fields, [key]: value });
	const parsed = parseCaptureCompositionFields(fields);
	const canEdit = primaryCapture?.kind === 'screenshot' && nativeAvailable;
	const comparisonScreenshots = screenshots.filter(
		(capture) => capture.id !== primaryCapture?.id
	);

	return (
		<section className="sim-capture-inspector-section sim-composition-editor">
			<header>
				<div>
					<h2>Edit screenshot</h2>
				</div>
				<InfoPopover label="Screenshot editing">
					Add a frame, background, or comparison image. Save a new capture to
					keep your original screenshot.
				</InfoPopover>
			</header>
			<Switch
				isDisabled={!canEdit}
				isSelected={fields.enabled && canEdit}
				size="sm"
				onChange={(enabled) => update('enabled', enabled)}
			>
				<Switch.Content>
					<span className="sim-setting-icon">
						<Sparkles className="h-3.5 w-3.5" />
					</span>
					<span className="sim-switch-copy">
						<strong>Enable editing</strong>
					</span>
				</Switch.Content>
				<Switch.Control>
					<Switch.Thumb />
				</Switch.Control>
			</Switch>
			{canEdit && fields.enabled ? (
				<div className="sim-composition-fields">
					<div className="sim-field">
						<span>Output name</span>
						<Input
							aria-label="Designed capture name"
							maxLength={128}
							value={fields.name}
							onChange={(event) => update('name', event.currentTarget.value)}
						/>
					</div>
					<CompositionSelect
						label="Canvas preset"
						value={fields.canvasPreset}
						onChange={(value) =>
							update(
								'canvasPreset',
								value as CaptureCompositionFields['canvasPreset']
							)
						}
						options={Object.entries(CAPTURE_CANVAS_PRESETS).map(
							([value, preset]) => ({
								value,
								label: `${preset.label} · ${preset.width}×${preset.height}`,
							})
						)}
					/>
					<div className="sim-composition-grid">
						<CompositionSelect
							label="Format"
							value={fields.outputFormat}
							onChange={(value) =>
								update('outputFormat', value as 'png' | 'jpeg')
							}
							options={[
								{ value: 'png', label: 'PNG' },
								{ value: 'jpeg', label: 'JPEG' },
							]}
						/>
						<CompositionSelect
							label="Background"
							value={fields.backgroundKind}
							onChange={(value) =>
								update(
									'backgroundKind',
									value as CaptureCompositionFields['backgroundKind']
								)
							}
							options={[
								{ value: 'transparent', label: 'Transparent' },
								{ value: 'solid', label: 'Solid' },
								{ value: 'linear_gradient', label: 'Gradient' },
							]}
						/>
					</div>
					<div className="sim-composition-grid">
						<CompositionInput
							label="Start color"
							value={fields.backgroundStart}
							onChange={(value) => update('backgroundStart', value)}
						/>
						<CompositionInput
							isDisabled={fields.backgroundKind !== 'linear_gradient'}
							label="End color"
							value={fields.backgroundEnd}
							onChange={(value) => update('backgroundEnd', value)}
						/>
					</div>
					<div className="sim-composition-grid">
						<CompositionInput
							label="Padding"
							type="number"
							value={fields.padding}
							onChange={(value) => update('padding', value)}
						/>
						<CompositionInput
							label="Corner radius"
							type="number"
							value={fields.cornerRadius}
							onChange={(value) => update('cornerRadius', value)}
						/>
					</div>
					<div className="sim-composition-grid">
						<CompositionSelect
							label="Fit"
							value={fields.contentMode}
							onChange={(value) =>
								update('contentMode', value as 'fit' | 'fill')
							}
							options={[
								{ value: 'fit', label: 'Fit' },
								{ value: 'fill', label: 'Fill' },
							]}
						/>
						<CompositionSelect
							label="Rotation"
							value={fields.rotation}
							onChange={(value) =>
								update(
									'rotation',
									value as CaptureCompositionFields['rotation']
								)
							}
							options={['0', '90', '180', '270'].map((value) => ({
								value,
								label: `${value}°`,
							}))}
						/>
					</div>
					<div className="sim-composition-switches">
						<CompactSwitch
							icon={<Frame className="h-3.5 w-3.5" />}
							isSelected={fields.bezel}
							label="Device frame"
							onChange={(selected) => update('bezel', selected)}
						/>
						<CompactSwitch
							icon={<Sparkles className="h-3.5 w-3.5" />}
							isSelected={fields.shadow}
							label="Shadow"
							onChange={(selected) => update('shadow', selected)}
						/>
						<CompactSwitch
							icon={<Layers3 className="h-3.5 w-3.5" />}
							isSelected={fields.metadataEnabled}
							label="Metadata"
							onChange={(selected) => update('metadataEnabled', selected)}
						/>
					</div>
					{fields.metadataEnabled ? (
						<CompositionInput
							label="Metadata text"
							value={fields.metadataText}
							onChange={(value) => update('metadataText', value)}
						/>
					) : null}
					<CompositionSelect
						label="Comparison"
						value={fields.comparisonMode}
						onChange={(value) =>
							onChange({
								...fields,
								comparisonMode:
									value as CaptureCompositionFields['comparisonMode'],
								...(value === 'none' ? { secondaryCaptureId: '' } : {}),
							})
						}
						options={[
							{ value: 'none', label: 'None' },
							{ value: 'side_by_side', label: 'Side by side' },
							{ value: 'opacity', label: 'Opacity overlay' },
							{ value: 'difference', label: 'Absolute difference' },
						]}
					/>
					{fields.comparisonMode !== 'none' ? (
						<CompositionSelect
							label="Comparison capture"
							value={fields.secondaryCaptureId}
							onChange={(value) => update('secondaryCaptureId', value)}
							options={[
								{ value: '', label: 'Select a screenshot' },
								...comparisonScreenshots.map((capture) => ({
									value: capture.id,
									label: capture.name,
								})),
							]}
						/>
					) : null}
					<Button
						fullWidth
						isDisabled={!parsed || isRendering}
						size="sm"
						variant="primary"
						onPress={onRender}
					>
						{isRendering ? (
							<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Sparkles className="h-3.5 w-3.5" />
						)}
						{isRendering ? 'Saving…' : 'Save edited copy'}
					</Button>
					{parsed ? null : (
						<p className="sim-field-error" role="alert">
							Check the color, numeric, metadata, and comparison fields. JPEG
							requires an opaque background.
						</p>
					)}
				</div>
			) : !canEdit ? (
				<p className="sim-inline-note">
					{!nativeAvailable
						? 'The signed native compositor is unavailable in this desktop build.'
						: 'Select a PNG or JPEG screenshot to edit.'}
				</p>
			) : null}
		</section>
	);
}

function CompositionSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
}) {
	return (
		<div className="sim-field">
			<span>{label}</span>
			<NativeSelect fullWidth>
				<NativeSelect.Trigger
					aria-label={label}
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
				>
					{options.map((option) => (
						<NativeSelect.Option key={option.value} value={option.value}>
							{option.label}
						</NativeSelect.Option>
					))}
					<NativeSelect.Indicator>
						<ChevronDown className="h-3 w-3" />
					</NativeSelect.Indicator>
				</NativeSelect.Trigger>
			</NativeSelect>
		</div>
	);
}

function CompositionInput({
	label,
	value,
	type = 'text',
	isDisabled = false,
	onChange,
}: {
	label: string;
	value: string;
	type?: 'number' | 'text';
	isDisabled?: boolean;
	onChange: (value: string) => void;
}) {
	return (
		<div className="sim-field">
			<span>{label}</span>
			<Input
				aria-label={label}
				disabled={isDisabled}
				type={type}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
		</div>
	);
}

function CompactSwitch({
	icon,
	label,
	isSelected,
	onChange,
}: {
	icon: React.ReactNode;
	label: string;
	isSelected: boolean;
	onChange: (selected: boolean) => void;
}) {
	return (
		<Switch isSelected={isSelected} size="sm" onChange={onChange}>
			<Switch.Content>
				<span className="sim-setting-icon">{icon}</span>
				<span className="sim-switch-copy">
					<strong>{label}</strong>
				</span>
			</Switch.Content>
			<Switch.Control>
				<Switch.Thumb />
			</Switch.Control>
		</Switch>
	);
}
