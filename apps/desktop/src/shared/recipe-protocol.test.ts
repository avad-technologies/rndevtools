import { describe, expect, it } from 'vitest';
import {
	RNDEVTOOLS_RECIPE_FORMAT_VERSION,
	recipeDefinitionSchema,
	recipeEvidenceManifestSchema,
	recipeRunRequestSchema,
} from './recipe-protocol';

const UDID = '11111111-2222-3333-4444-555555555555';

function recipe(overrides: Record<string, unknown> = {}) {
	return {
		formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
		id: 'smoke-test',
		name: 'Smoke test',
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		steps: [
			{ id: 'boot', kind: 'simulator', action: { operation: 'device.boot' } },
		],
		teardown: [],
		...overrides,
	};
}

describe('recipe protocol', () => {
	it('accepts a versioned bounded recipe and applies safe defaults', () => {
		expect(recipeDefinitionSchema.parse(recipe())).toMatchObject({
			formatVersion: 1,
			defaultConcurrency: 2,
			steps: [{ kind: 'simulator' }],
		});
	});

	it('caps recipes at 100 total unique steps and targets at 20 exact UDIDs', () => {
		const steps = Array.from({ length: 100 }, (_, index) => ({
			id: `step-${index}`,
			kind: 'wait',
			durationMs: 0,
		}));
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps,
					teardown: [{ id: 'extra', kind: 'wait', durationMs: 0 }],
				})
			).success
		).toBe(false);
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps: [
						{ id: 'same', kind: 'wait', durationMs: 0 },
						{ id: 'same', kind: 'wait', durationMs: 0 },
					],
				})
			).success
		).toBe(false);
		expect(
			recipeRunRequestSchema.safeParse({
				actionId: 'run',
				recipeId: 'smoke-test',
				targetUdids: Array.from(
					{ length: 21 },
					(_, index) =>
						`11111111-2222-3333-4444-${index.toString().padStart(12, '0')}`
				),
			}).success
		).toBe(false);
		expect(
			recipeRunRequestSchema.safeParse({
				actionId: 'run',
				recipeId: 'smoke-test',
				targetUdids: [UDID, UDID.toLowerCase()],
			}).success
		).toBe(false);
	});

	it('rejects unsafe URLs, oversized fixtures, and unknown action fields', () => {
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps: [
						{
							id: 'url',
							kind: 'simulator',
							action: { operation: 'url.open', url: 'javascript:alert(1)' },
						},
					],
				})
			).success
		).toBe(false);
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps: [
						{
							id: 'camera',
							kind: 'camera',
							operation: 'set',
							fixture: {
								fixtureKind: 'still',
								mimeType: 'image/png',
								dataBase64: 'A'.repeat(512 * 1024 + 1),
								width: 1,
								height: 1,
							},
						},
					],
				})
			).success
		).toBe(false);
		expect(
			recipeRunRequestSchema.safeParse({
				actionId: 'run',
				recipeId: 'smoke-test',
				targetUdids: [UDID],
				runApproved: true,
			}).success
		).toBe(false);
	});

	it('strictly models advanced simulator controls without file-dialog actions', () => {
		const parsed = recipeDefinitionSchema.parse(
			recipe({
				steps: [
					{
						id: 'launch',
						kind: 'simulator',
						action: {
							operation: 'app.launch',
							bundleIdentifier: 'com.example.app',
							locale: 'en_US',
							languages: ['en-US'],
							timeZone: 'America/Los_Angeles',
							slowAnimations: true,
						},
					},
					{
						id: 'route',
						kind: 'simulator',
						action: {
							operation: 'location.start',
							waypoints: [
								{ latitude: 1, longitude: 2 },
								{ latitude: 3, longitude: 4 },
							],
							intervalSeconds: 1,
						},
					},
					{
						id: 'privacy',
						kind: 'simulator',
						action: {
							operation: 'privacy.update',
							privacyOperation: 'reset',
							service: 'all',
							bundleIdentifier: 'com.example.app',
						},
					},
					{
						id: 'contrast',
						kind: 'simulator',
						action: {
							operation: 'ui.update',
							setting: 'increase_contrast',
							value: 'enabled',
						},
					},
					{
						id: 'status',
						kind: 'simulator',
						action: {
							operation: 'statusBar.override',
							overrides: { batteryLevel: 42 },
						},
					},
					{
						id: 'pasteboard',
						kind: 'simulator',
						action: {
							operation: 'pasteboard.sync',
							direction: 'host-to-simulator',
						},
					},
				],
			})
		);
		expect(parsed.steps).toHaveLength(6);
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps: [
						{
							id: 'privacy',
							kind: 'simulator',
							action: {
								operation: 'privacy.update',
								privacyOperation: 'grant',
								service: 'camera',
							},
						},
					],
				})
			).success
		).toBe(false);
		expect(
			recipeDefinitionSchema.safeParse(
				recipe({
					steps: [
						{
							id: 'file-dialog',
							kind: 'simulator',
							action: { operation: 'location.importGpx' },
						},
					],
				})
			).success
		).toBe(false);
	});

	it('keeps evidence manifests opaque and rejects raw path additions', () => {
		const evidence = {
			format: 'rndevtools-evidence-bundle',
			formatVersion: 1,
			id: 'evidence-12345678-1234-4123-8123-123456789abc',
			runId: 'recipe-run-12345678-1234-4123-8123-123456789abc',
			recipe: { id: 'smoke-test', name: 'Smoke test', revision: 1 },
			createdAt: 1,
			status: 'running',
			targets: [
				{
					udid: UDID,
					status: 'running',
					cleanupStatus: 'not-started',
					captureIds: [],
					diagnosticCorrelationIds: [],
				},
			],
			timeline: [],
			captureIds: [],
			diagnosticCorrelationIds: [],
		};
		expect(recipeEvidenceManifestSchema.parse(evidence)).toEqual(evidence);
		expect(
			recipeEvidenceManifestSchema.safeParse({
				...evidence,
				bundlePath: '/private/user/evidence',
			}).success
		).toBe(false);
	});
});
