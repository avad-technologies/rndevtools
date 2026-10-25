import {
	type CaptureCompositionRecipe,
	captureCompositionRecipeSchema,
} from '../../shared/simulator-protocol';

export const CAPTURE_CANVAS_PRESETS = {
	'app-store-portrait': {
		label: 'App Store portrait',
		width: 1_290,
		height: 2_796,
	},
	'story-portrait': { label: 'Story portrait', width: 1_080, height: 1_920 },
	landscape: { label: 'Landscape 16:9', width: 1_920, height: 1_080 },
	square: { label: 'Square', width: 2_048, height: 2_048 },
} as const;

type CaptureCanvasPresetId = keyof typeof CAPTURE_CANVAS_PRESETS;
export type CaptureCompositionFields = {
	enabled: boolean;
	name: string;
	outputFormat: 'png' | 'jpeg';
	jpegQuality: string;
	canvasPreset: CaptureCanvasPresetId;
	backgroundKind: 'transparent' | 'solid' | 'linear_gradient';
	backgroundStart: string;
	backgroundEnd: string;
	gradientDirection:
		| 'top_to_bottom'
		| 'left_to_right'
		| 'top_left_to_bottom_right';
	padding: string;
	contentMode: 'fit' | 'fill';
	rotation: '0' | '90' | '180' | '270';
	cornerRadius: string;
	bezel: boolean;
	shadow: boolean;
	metadataEnabled: boolean;
	metadataText: string;
	metadataPlacement: 'top' | 'bottom';
	comparisonMode: 'none' | 'side_by_side' | 'opacity' | 'difference';
	comparisonAmount: string;
	secondaryCaptureId: string;
};

export const DEFAULT_CAPTURE_COMPOSITION_FIELDS: CaptureCompositionFields = {
	enabled: false,
	name: 'Designed-Capture',
	outputFormat: 'png',
	jpegQuality: '90',
	canvasPreset: 'app-store-portrait',
	backgroundKind: 'linear_gradient',
	backgroundStart: '#000000',
	backgroundEnd: '#191919',
	gradientDirection: 'top_to_bottom',
	padding: '140',
	contentMode: 'fit',
	rotation: '0',
	cornerRadius: '64',
	bezel: true,
	shadow: true,
	metadataEnabled: false,
	metadataText: 'App Development',
	metadataPlacement: 'bottom',
	comparisonMode: 'none',
	comparisonAmount: '50',
	secondaryCaptureId: '',
};

export type ParsedCaptureComposition = {
	name: string | undefined;
	secondaryCaptureId: string | undefined;
	recipe: CaptureCompositionRecipe;
};

export function parseCaptureCompositionFields(
	fields: CaptureCompositionFields
): ParsedCaptureComposition | null {
	const preset = CAPTURE_CANVAS_PRESETS[fields.canvasPreset];
	const padding = Number(fields.padding);
	const cornerRadius = Number(fields.cornerRadius);
	const quality = Number(fields.jpegQuality);
	const comparisonAmount = Number(fields.comparisonAmount);
	const background =
		fields.backgroundKind === 'transparent'
			? { kind: 'transparent' as const }
			: fields.backgroundKind === 'solid'
				? { kind: 'solid' as const, color: fields.backgroundStart }
				: {
						kind: 'linear_gradient' as const,
						startColor: fields.backgroundStart,
						endColor: fields.backgroundEnd,
						direction: fields.gradientDirection,
					};
	const comparison =
		fields.comparisonMode === 'side_by_side'
			? { mode: 'side_by_side' as const, gap: comparisonAmount }
			: fields.comparisonMode === 'opacity'
				? {
						mode: 'opacity' as const,
						secondaryOpacityBasisPoints: comparisonAmount * 100,
					}
				: fields.comparisonMode === 'difference'
					? { mode: 'difference' as const }
					: undefined;
	const parsed = captureCompositionRecipeSchema.safeParse({
		outputFormat: fields.outputFormat,
		...(fields.outputFormat === 'jpeg' ? { jpegQuality: quality } : {}),
		canvas: {
			size: { mode: 'pixels', width: preset.width, height: preset.height },
			background,
		},
		layout: {
			padding: {
				top: padding,
				right: padding,
				bottom: padding,
				left: padding,
			},
			contentMode: fields.contentMode,
			rotation: Number(fields.rotation),
			cornerRadius,
			bezel: fields.bezel ? 'rndevtools-generic-v1' : 'none',
			...(fields.shadow
				? {
						shadow: {
							color: '#00000080',
							blurRadius: 48,
							offsetX: 0,
							offsetY: 24,
						},
					}
				: {}),
		},
		...(fields.metadataEnabled
			? {
					metadata: {
						text: fields.metadataText,
						placement: fields.metadataPlacement,
						textColor: '#FFFFFFFF',
						backgroundColor: '#00000099',
						fontSize: 28,
						padding: 20,
					},
				}
			: {}),
		...(comparison ? { comparison } : {}),
	});
	if (!parsed.success) return null;
	const needsSecondary = fields.comparisonMode !== 'none';
	if (needsSecondary !== Boolean(fields.secondaryCaptureId)) return null;
	return {
		name: fields.name.trim() || undefined,
		secondaryCaptureId: needsSecondary ? fields.secondaryCaptureId : undefined,
		recipe: parsed.data,
	};
}

export function captureCompositionAspectRatio(
	fields: CaptureCompositionFields
): number {
	const preset = CAPTURE_CANVAS_PRESETS[fields.canvasPreset];
	return preset.width / preset.height;
}
