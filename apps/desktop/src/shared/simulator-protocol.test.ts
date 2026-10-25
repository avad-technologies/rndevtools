import { describe, expect, it } from 'vitest';
import {
	captureCompositionRecipeSchema,
	simulatorActionSchema,
	simulatorCaptureOperationSchema,
	simulatorCaptureRetentionPolicySchema,
	simulatorStateSchema,
} from './simulator-protocol';

const UDID = '11111111-2222-3333-4444-555555555555';

describe('simulator protocol', () => {
	it('accepts bounded, exact-UDID actions and applies safe defaults', () => {
		expect(
			simulatorActionSchema.parse({
				actionId: 'action-1',
				kind: 'capture.screenshot',
				udid: UDID,
			})
		).toMatchObject({ format: 'png', mask: 'alpha' });
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'action-2',
				kind: 'device.boot',
				udid: 'booted; rm -rf /',
			}).success
		).toBe(false);
	});

	it('rejects incompatible location and UI controls', () => {
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'location-1',
				kind: 'location.start',
				udid: UDID,
				waypoints: [
					{ latitude: 0, longitude: 0 },
					{ latitude: 1, longitude: 1 },
				],
				distanceMeters: 10,
				intervalSeconds: 1,
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'ui-1',
				kind: 'ui.update',
				udid: UDID,
				setting: 'appearance',
				value: 'accessibility-large',
			}).success
		).toBe(false);
	});

	it('requires strict action keys and privacy bundle identifiers', () => {
		for (const operation of ['grant', 'revoke', 'reset']) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: `privacy-${operation}`,
					kind: 'privacy.update',
					udid: UDID,
					operation,
					service: 'location',
				}).success
			).toBe(false);
		}
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'boot-1',
				kind: 'device.boot',
				udid: UDID,
				command: 'arbitrary',
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'trust-root',
				kind: 'keychain.addCertificate',
				udid: UDID,
				trustRoot: true,
				selectedPath: '/tmp/renderer-controlled.pem',
				certificateSha256: 'a'.repeat(64),
			}).success
		).toBe(false);
	});

	it('bounds disk cleanup to unique upstream allowlisted categories', () => {
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'disk-clean',
				kind: 'disk.cleanup',
				udid: UDID,
				categoryIds: ['caches', 'logs'],
			}).success
		).toBe(true);
		for (const categoryIds of [
			[],
			['caches', 'caches'],
			['required-siri-assets'],
			['../../Documents'],
		]) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: 'unsafe-disk-clean',
					kind: 'disk.cleanup',
					udid: UDID,
					categoryIds,
				}).success
			).toBe(false);
		}
	});

	it('bounds app launch overrides, container access, pasteboard sync, and GPX input', () => {
		expect(
			simulatorActionSchema.parse({
				actionId: 'launch-overrides',
				kind: 'app.launch',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				locale: 'en_US',
				languages: ['en', 'fr-CA'],
				timeZone: 'America/Los_Angeles',
				slowAnimations: true,
			})
		).toMatchObject({ arguments: [], terminateRunning: false });
		for (const invalid of [
			{ locale: '../../private/etc' },
			{ languages: ['en', '$(open /Applications)'] },
			{ timeZone: '../UTC' },
		]) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: 'invalid-launch',
					kind: 'app.launch',
					udid: UDID,
					bundleIdentifier: 'com.example.app',
					...invalid,
				}).success
			).toBe(false);
		}

		expect(
			simulatorActionSchema.safeParse({
				actionId: 'reveal-group',
				kind: 'app.revealContainer',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				container: 'app-group',
				appGroupIdentifier: 'group.com.example.app',
			}).success
		).toBe(true);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'reveal-missing-group',
				kind: 'app.revealContainer',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				container: 'app-group',
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'pasteboard',
				kind: 'pasteboard.sync',
				udid: UDID,
				direction: 'host-to-simulator',
			}).success
		).toBe(true);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'gpx',
				kind: 'location.importGpx',
				udid: UDID,
				speedMetersPerSecond: 1_001,
			}).success
		).toBe(false);
	});

	it('enforces the APNs UTF-8 byte limit and JSON aps envelope at IPC', () => {
		const multibytePayload = JSON.stringify({
			aps: { alert: '💪'.repeat(1_100) },
		});
		expect(multibytePayload.length).toBeLessThan(16 * 1024);
		expect(
			new TextEncoder().encode(multibytePayload).byteLength
		).toBeGreaterThan(4_096);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'push-multibyte',
				kind: 'push.send',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				payloadJson: multibytePayload,
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'push-missing-aps',
				kind: 'push.send',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				payloadJson: '{"message":"hello"}',
			}).success
		).toBe(false);
	});

	it('allows universal and custom deep links but rejects local or executable schemes', () => {
		for (const url of ['https://example.com/path', 'exampleapp://workout/1']) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: `url-${url}`,
					kind: 'url.open',
					udid: UDID,
					url,
				}).success
			).toBe(true);
		}
		for (const url of [
			'file:///private/etc/passwd',
			'javascript:alert(1)',
			'data:text/plain,hello',
		]) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: `unsafe-${url}`,
					kind: 'url.open',
					udid: UDID,
					url,
				}).success
			).toBe(false);
		}
	});

	it('requires HTTPS for the dedicated universal-link action', () => {
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'universal-https',
				kind: 'app.openUniversalLink',
				udid: UDID,
				url: 'https://example.com/items/1',
			}).success
		).toBe(true);
		for (const url of [
			'http://example.com/items/1',
			'exampleapp://workouts/1',
			'file:///private/etc/passwd',
		]) {
			expect(
				simulatorActionSchema.safeParse({
					actionId: 'universal-unsafe',
					kind: 'app.openUniversalLink',
					udid: UDID,
					url,
				}).success
			).toBe(false);
		}
	});

	it('validates renderer-bound state without accepting capture paths', () => {
		const state = {
			revision: 1,
			updatedAt: Date.now(),
			capability: {
				status: 'available',
				platform: 'darwin',
				licenseStatus: 'accepted',
				hostArchitecture: 'arm64',
				runtimeAvailability: { total: 0, available: 0 },
				features: {
					deviceManagement: true,
					apps: true,
					deepLinks: true,
					location: true,
					push: true,
					privacy: true,
					ui: true,
					statusBar: true,
					keychain: true,
					screenshot: true,
					video: true,
				},
			},
			runtimes: [],
			deviceTypes: [],
			devices: [],
			appsByDevice: {},
			diskByDevice: {},
			jobs: [],
			captures: [],
			metrics: { status: 'checking', byDevice: {} },
			native: {
				status: 'available',
				helperVersion: '0.1.0',
				permissionInspection: true,
				permissionPrompting: false,
				permissions: [],
			},
		};
		expect(simulatorStateSchema.parse(state)).toEqual(state);
		expect(
			simulatorStateSchema.safeParse({
				...state,
				captureDirectory: '/private/path',
			}).success
		).toBe(false);
	});

	it('accepts only exact opaque capture operations without renderer paths', () => {
		const captureId = 'capture-12345678-1234-4123-8123-123456789abc';
		expect(
			simulatorCaptureOperationSchema.safeParse({
				actionId: 'export',
				kind: 'capture.export',
				captureId,
			}).success
		).toBe(true);
		expect(
			simulatorCaptureOperationSchema.safeParse({
				actionId: 'export-path',
				kind: 'capture.export',
				captureId,
				destinationPath: '/private/arbitrary',
			}).success
		).toBe(false);
		expect(
			simulatorCaptureOperationSchema.safeParse({
				actionId: 'traversal',
				kind: 'capture.delete',
				captureId: '../../capture-secret',
			}).success
		).toBe(false);
	});

	it('bounds configurable capture retention', () => {
		expect(
			simulatorCaptureRetentionPolicySchema.safeParse({
				maxAgeDays: 30,
				maxTotalBytes: 10 * 1024 * 1024 * 1024,
			}).success
		).toBe(true);
		expect(
			simulatorCaptureRetentionPolicySchema.safeParse({
				maxAgeDays: 0,
				maxTotalBytes: Number.MAX_SAFE_INTEGER,
			}).success
		).toBe(false);
	});

	it('validates bounded Capture Design Studio recipes and comparison pairing', () => {
		const recipe = captureCompositionRecipeSchema.parse({
			outputFormat: 'png',
			canvas: {
				size: {
					mode: 'aspect',
					ratioWidth: 9,
					ratioHeight: 16,
					longEdge: 2_736,
				},
				background: {
					kind: 'linear_gradient',
					startColor: '#090909',
					endColor: '#202020FF',
					direction: 'top_to_bottom',
				},
			},
			layout: {
				padding: { top: 96, right: 96, bottom: 96, left: 96 },
				contentMode: 'fit',
				rotation: 0,
				cornerRadius: 72,
				bezel: 'rndevtools-generic-v1',
				shadow: { color: '#00000080', blurRadius: 48, offsetX: 0, offsetY: 24 },
			},
			metadata: {
				text: 'App Development\niPhone 17 Pro',
				placement: 'bottom',
				textColor: '#FFFFFFFF',
				backgroundColor: '#00000080',
				fontSize: 24,
				padding: 16,
			},
		});
		expect(recipe.outputFormat).toBe('png');
		expect(
			captureCompositionRecipeSchema.safeParse({
				...recipe,
				outputFormat: 'jpeg',
				canvas: { ...recipe.canvas, background: { kind: 'transparent' } },
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'compare-without-secondary',
				kind: 'capture.compose',
				udid: UDID,
				primaryCaptureId: 'capture-12345678-1234-4123-8123-123456789abc',
				recipe: { ...recipe, comparison: { mode: 'difference' } },
			}).success
		).toBe(false);
		expect(
			simulatorActionSchema.safeParse({
				actionId: 'compare-with-same-capture',
				kind: 'capture.compose',
				udid: UDID,
				primaryCaptureId: 'capture-12345678-1234-4123-8123-123456789abc',
				secondaryCaptureId: 'capture-12345678-1234-4123-8123-123456789abc',
				recipe: { ...recipe, comparison: { mode: 'difference' } },
			}).success
		).toBe(false);
	});
});
