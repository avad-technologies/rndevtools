import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CAPTURE_COMPOSITION_FIELDS,
	parseCaptureCompositionFields,
} from './capture-composition-model';

describe('capture composition model', () => {
	it('builds the bounded App Store design recipe', () => {
		expect(
			parseCaptureCompositionFields(DEFAULT_CAPTURE_COMPOSITION_FIELDS)
		).toEqual(
			expect.objectContaining({
				name: 'Designed-Capture',
				recipe: expect.objectContaining({
					outputFormat: 'png',
					canvas: expect.objectContaining({
						size: { mode: 'pixels', width: 1_290, height: 2_796 },
					}),
					layout: expect.objectContaining({ bezel: 'rndevtools-generic-v1' }),
				}),
			})
		);
	});

	it('requires one comparison capture and rejects invalid numeric fields', () => {
		expect(
			parseCaptureCompositionFields({
				...DEFAULT_CAPTURE_COMPOSITION_FIELDS,
				comparisonMode: 'difference',
			})
		).toBeNull();
		expect(
			parseCaptureCompositionFields({
				...DEFAULT_CAPTURE_COMPOSITION_FIELDS,
				padding: 'not-a-number',
			})
		).toBeNull();
	});

	it('does not allow transparent JPEG output', () => {
		expect(
			parseCaptureCompositionFields({
				...DEFAULT_CAPTURE_COMPOSITION_FIELDS,
				outputFormat: 'jpeg',
				backgroundKind: 'transparent',
			})
		).toBeNull();
	});
});
