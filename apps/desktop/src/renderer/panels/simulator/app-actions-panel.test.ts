import { describe, expect, it } from 'vitest';
import {
	buildSimulatorAction,
	defaultPreset,
	parseCustomCoordinate,
} from './app-actions-panel';

const UDID = '11111111-2222-3333-4444-555555555555';
const BUNDLE_ID = 'com.example.app';

function build(
	actionId: string,
	overrides: Partial<Parameters<typeof buildSimulatorAction>[0]> = {}
) {
	return buildSimulatorAction({
		actionId,
		targetUdid: UDID,
		bundleIdentifier: BUNDLE_ID,
		value: '',
		preset: 'apple-park',
		customLatitude: '',
		customLongitude: '',
		locale: '',
		languages: '',
		timeZone: '',
		slowAnimations: false,
		...overrides,
	});
}

describe('Simulator App Actions model', () => {
	it('builds typed localized launches and rejects malformed environment values', () => {
		expect(
			build('relaunch-app', {
				locale: 'fr_CA',
				languages: 'fr-CA, en',
				timeZone: 'America/Vancouver',
				slowAnimations: true,
			})
		).toEqual({
			kind: 'app.launch',
			udid: UDID,
			bundleIdentifier: BUNDLE_ID,
			terminateRunning: true,
			arguments: [],
			locale: 'fr_CA',
			languages: ['fr-CA', 'en'],
			timeZone: 'America/Vancouver',
			slowAnimations: true,
		});
		expect(build('launch-app', { timeZone: '../../private/etc' })).toBeNull();
		expect(build('launch-app', { languages: 'en, $(open App)' })).toBeNull();
	});

	it('keeps unsafe URLs and invalid APNs envelopes out of the action bridge', () => {
		expect(
			build('open-deep-link', { value: 'file:///private/etc/passwd' })
		).toBeNull();
		expect(
			build('open-universal-link', { value: 'https://example.com/items/1' })
		).toMatchObject({ kind: 'app.openUniversalLink' });
		expect(build('open-deep-link', { value: 'myapp://home' })).toMatchObject({
			kind: 'url.open',
		});
		expect(build('open-universal-link', { value: 'myapp://home' })).toBeNull();
		expect(
			build('open-universal-link', { value: 'http://example.com/items/1' })
		).toBeNull();
		expect(
			build('send-push-notification', { value: '{"message":"missing aps"}' })
		).toBeNull();
		expect(
			build('send-push-notification', {
				value: '{"aps":{"alert":"Ready"}}',
			})
		).toMatchObject({ kind: 'push.send', bundleIdentifier: BUNDLE_ID });
	});

	it('maps exact containers, pasteboards, routes, and confirmed reset operations', () => {
		expect(
			build('reveal-app-group', { value: 'group.com.example.app' })
		).toMatchObject({
			kind: 'app.revealContainer',
			container: 'app-group',
			appGroupIdentifier: 'group.com.example.app',
		});
		expect(build('pasteboard-from-simulator')).toMatchObject({
			kind: 'pasteboard.sync',
			direction: 'simulator-to-host',
		});
		expect(build('import-gpx-route')).toEqual({
			kind: 'location.importGpx',
			udid: UDID,
		});
		expect(build('reset-keychain')).toEqual({
			kind: 'keychain.reset',
			udid: UDID,
		});
		expect(build('reset-permission')).toMatchObject({
			kind: 'privacy.update',
			bundleIdentifier: BUNDLE_ID,
			operation: 'reset',
		});
		expect(
			build('reset-permission', { bundleIdentifier: undefined })
		).toBeNull();
	});

	it('uses explicit custom coordinates for fixed locations and route origins', () => {
		expect(
			build('set-location', {
				preset: 'custom',
				customLatitude: '48.85837',
				customLongitude: '2.294481',
			})
		).toEqual({
			kind: 'location.set',
			udid: UDID,
			latitude: 48.85837,
			longitude: 2.294481,
		});
		const route = build('simulate-route', {
			preset: 'custom',
			customLatitude: '90',
			customLongitude: '180',
		});
		expect(route).toMatchObject({
			kind: 'location.start',
			udid: UDID,
			waypoints: [
				{ latitude: 90, longitude: 180 },
				{ latitude: 89.996, longitude: 179.996 },
				{ latitude: 89.992, longitude: 179.992 },
			],
		});
	});

	it.each([
		['', '-122'],
		['37', ''],
		['91', '0'],
		['-91', '0'],
		['0', '181'],
		['0', '-181'],
		['Infinity', '0'],
		['0', 'not-a-coordinate'],
	])('rejects invalid custom coordinate %s, %s', (latitude, longitude) => {
		expect(parseCustomCoordinate(latitude, longitude)).toBeNull();
		expect(
			build('set-location', {
				preset: 'custom',
				customLatitude: latitude,
				customLongitude: longitude,
			})
		).toBeNull();
		expect(
			build('simulate-route', {
				preset: 'custom',
				customLatitude: latitude,
				customLongitude: longitude,
			})
		).toBeNull();
	});

	it('fails closed for an unknown location preset instead of falling back to Apple Park', () => {
		expect(build('set-location', { preset: 'future-location' })).toBeNull();
		expect(build('simulate-route', { preset: 'future-location' })).toBeNull();
	});

	it('uses configuration-specific defaults instead of leaking prior selections', () => {
		expect(defaultPreset('permission')).toBe('microphone');
		expect(defaultPreset('dynamic-type')).toBe('large');
		expect(defaultPreset('location')).toBe('apple-park');
	});
});
