import { describe, expect, it } from 'vitest';
import { createSupabaseDemoState } from '../../../shared/supabase-demo-data';
import {
	capabilityGuidance,
	capabilityOnboardingAction,
	capabilityReadiness,
	localSupabaseReadiness,
	persistentCaptureProviderStatus,
} from './settings-panel';

describe('Simulator Settings capability guidance', () => {
	it('shows concrete permission guidance without claiming an unavailable action', () => {
		expect(
			capabilityGuidance(
				{
					status: 'unavailable',
					unavailableGuidance:
						'Grant access in macOS System Settings > Privacy & Security, then restart it.',
				},
				true
			)
		).toBe(
			'Grant access in macOS System Settings > Privacy & Security, then restart it.'
		);
	});

	it('gives visible desktop and discovery recovery steps', () => {
		const capability = {
			status: 'checking' as const,
			unavailableGuidance: 'Install the required capability.',
		};
		expect(capabilityGuidance(capability, false)).toContain(
			'installed desktop app'
		);
		expect(capabilityGuidance(capability, true)).toContain('still running');
	});

	it('directs available integrations to their feature-owned workspace', () => {
		expect(
			capabilityGuidance(
				{
					status: 'available',
					unavailableGuidance: 'Not used while available.',
				},
				true
			)
		).toContain('feature-owned workspace');
	});

	it('maps only supported main-owned onboarding operations', () => {
		expect(capabilityOnboardingAction('xcode')).toMatchObject({
			operation: { kind: 'toolchain.selectXcode' },
		});
		expect(capabilityOnboardingAction('screen-recording')).toMatchObject({
			operation: {
				kind: 'privacy.openSettings',
				permission: 'screen_recording',
			},
		});
		expect(capabilityOnboardingAction('audio-capture')).toMatchObject({
			operation: { kind: 'privacy.openSettings', permission: 'microphone' },
		});
		expect(capabilityOnboardingAction('agent-cli')).toMatchObject({
			label: 'Reveal CLI',
			operation: { kind: 'agentCli.reveal' },
		});
		expect(capabilityOnboardingAction('physical-devices')).toBeNull();
	});

	it('does not call API or hardware probes ready before a persistent provider exists', () => {
		expect(persistentCaptureProviderStatus(false, true)).toBe('unavailable');
		expect(persistentCaptureProviderStatus(undefined, true)).toBe(
			'unavailable'
		);
		expect(persistentCaptureProviderStatus(true, false)).toBe('unavailable');
		expect(persistentCaptureProviderStatus(true, true)).toBe('available');
	});
});

describe('capability readiness pills', () => {
	it('keeps the Settings words on the shared readiness statuses', () => {
		expect(
			capabilityReadiness({ status: 'available', required: true })
		).toEqual({ status: 'ready', label: 'Ready' });
		expect(capabilityReadiness({ status: 'checking', required: true })).toEqual(
			{ status: 'checking', label: 'Checking' }
		);
		expect(
			capabilityReadiness({ status: 'unavailable', required: true })
		).toEqual({ status: 'needs-fix', label: 'Needs setup' });
		expect(
			capabilityReadiness({ status: 'unavailable', required: false })
		).toEqual({ status: 'optional', label: 'Not available' });
	});
});

describe('global Local Supabase row', () => {
	it('shows the platform verdict and the switch, never as a requirement', () => {
		const off = createSupabaseDemoState({ variant: 'off' });
		expect(localSupabaseReadiness(off, true)).toEqual({
			status: 'optional',
			label: 'Off',
			detail:
				'This Mac can run it (Apple silicon · macOS 15.1). Off means off: nothing runs or polls.',
		});
		expect(
			localSupabaseReadiness(
				createSupabaseDemoState({ variant: 'unsupported' }),
				true
			)
		).toEqual({
			status: 'optional',
			label: 'Not available',
			detail:
				'Native Supabase needs Apple silicon and macOS 14 or later. This Mac: Intel · macOS 13.6.',
		});
		expect(localSupabaseReadiness(off, false)).toMatchObject({
			status: 'optional',
			label: 'Not available',
		});
	});

	it('reads On with the running count, or Needs setup with nothing ready', () => {
		const on = createSupabaseDemoState();
		expect(localSupabaseReadiness(on, true)).toMatchObject({
			status: 'ready',
			label: 'On · 3 running',
		});
		const idle = {
			...on,
			capacity: { ...on.capacity, running: 0 },
		};
		expect(localSupabaseReadiness(idle, true)).toMatchObject({
			status: 'check',
			label: 'Needs setup',
		});
		expect(
			localSupabaseReadiness({ ...idle, repositories: [] }, true)
		).toMatchObject({ status: 'ready', label: 'On' });
		expect(
			localSupabaseReadiness(
				{
					...createSupabaseDemoState({ variant: 'off' }),
					feature: { enabled: false, policyHealth: 'quarantined' },
				},
				true
			)
		).toMatchObject({ status: 'check', label: 'Off' });
	});
});
