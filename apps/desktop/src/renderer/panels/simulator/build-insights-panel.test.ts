import { describe, expect, it } from 'vitest';
import {
	BUILD_INSIGHTS_FOUNDATION_COPY,
	buildClassificationPresentation,
} from './build-insights-panel';

describe('Build Insights bounded adapter presentation', () => {
	it('names the currently supported foundation and deferred metadata', () => {
		expect(BUILD_INSIGHTS_FOUNDATION_COPY).toContain(
			'xcresulttool get build-results'
		);
		expect(BUILD_INSIGHTS_FOUNDATION_COPY).toContain(
			'clean/incremental classification'
		);
		expect(BUILD_INSIGHTS_FOUNDATION_COPY).toContain(
			'Swift FSEvents live watching are deferred'
		);
	});

	it('does not infer clean or incremental when public results have no evidence', () => {
		expect(
			buildClassificationPresentation({
				classification: 'unknown',
				classificationConfidence: 'unknown',
			})
		).toEqual({
			title: 'Classification unavailable',
			subtitle: 'No clean vs incremental evidence in public build-results',
			confidence: 'not reported',
			label: 'Unknown',
			detail:
				"Apple's public build-results view does not expose unambiguous clean-versus-incremental evidence, so this adapter does not infer a classification.",
		});
	});

	it('still presents explicit evidence if a future adapter supplies it', () => {
		expect(
			buildClassificationPresentation({
				classification: 'incremental',
				classificationConfidence: 'confirmed',
			})
		).toMatchObject({
			title: 'Build classification',
			confidence: 'confirmed',
			label: 'incremental',
		});
	});
});
