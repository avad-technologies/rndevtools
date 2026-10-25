import { describe, expect, it } from 'vitest';
import { createSupabaseDemoState } from '../../../shared/supabase-demo-data';
import {
	SUPABASE_POLICY_DEFAULTS,
	SUPABASE_POLICY_ERRORS,
	supabasePolicyPatchSchema,
} from '../../../shared/supabase-protocol';
import {
	supabaseCliReadiness,
	supabaseLaneDefaults,
	supabasePolicyFormState,
} from './supabase-settings-view';

const policy = SUPABASE_POLICY_DEFAULTS;
const environments = ['development', 'staging', 'production'];

describe('supabasePolicyFormState', () => {
	it('reads main’s policy until a field is edited, with nothing to apply', () => {
		const form = supabasePolicyFormState(policy, {}, environments);
		expect(form.values).toMatchObject({
			maxRunning: '12',
			unheldStopDelaySeconds: '60',
			retentionDays: '14',
			excludeAnalytics: true,
			excludePooler: false,
			stopContainerStacksOnce: true,
			branchSwitch: 'follow',
		});
		expect(form.values.laneDefaults).toEqual(policy.laneDefaults);
		expect(form).toMatchObject({ changes: 0, errors: {}, patch: {} });
		expect(form.parsed).toBeUndefined();
	});

	it('builds the smallest valid patch from the edited fields', () => {
		const form = supabasePolicyFormState(
			policy,
			{
				maxRunning: '10',
				unheldStopDelaySeconds: '120',
				retentionDays: '14',
				excludePooler: true,
				branchSwitch: 'warn',
			},
			environments
		);
		expect(form.patch).toEqual({
			maxRunning: 10,
			unheldStopDelayMs: 120_000,
			exclude: ['studio', 'analytics', 'pooler'],
			branchSwitch: 'warn',
		});
		expect(form.changes).toBe(4);
		expect(form.errors).toEqual({});
		expect(supabasePolicyPatchSchema.parse(form.parsed)).toEqual(form.patch);
	});

	it('reports field errors in the shared Settings copy', () => {
		const form = supabasePolicyFormState(
			policy,
			{
				maxRunning: 'twelve',
				unheldStopDelaySeconds: '4000',
				retentionDays: '1.5',
				appEnv: [
					{ name: 'NODE_ENV', source: 'API_URL' },
					{ name: 'EXPO_PUBLIC_URL', source: 'API_URL' },
					{ name: 'EXPO_PUBLIC_URL', source: 'REST_URL' },
				],
			},
			environments
		);
		expect(form.errors).toMatchObject({
			maxRunning: SUPABASE_POLICY_ERRORS.maxRunning,
			unheldStopDelayMs: SUPABASE_POLICY_ERRORS.unheldStopDelayMs,
			retentionDays: SUPABASE_POLICY_ERRORS.retentionDays,
			'appEnv.0': SUPABASE_POLICY_ERRORS.appEnvReserved,
			'appEnv.2': SUPABASE_POLICY_ERRORS.appEnvDuplicate,
		});
		expect(form.parsed).toBeUndefined();
	});

	it('changes a lane default and keeps Studio out of the form', () => {
		const form = supabasePolicyFormState(
			policy,
			{
				laneDefaults: [
					{ environmentId: 'development', backend: 'auto' },
					{ environmentId: 'staging', backend: 'auto' },
					{ environmentId: 'production', backend: 'off' },
				],
				excludeAnalytics: false,
			},
			environments
		);
		expect(form.patch).toEqual({
			exclude: ['studio'],
			laneDefaults: [
				{ environmentId: 'development', backend: 'auto' },
				{ environmentId: 'staging', backend: 'auto' },
				{ environmentId: 'production', backend: 'off' },
			],
		});
		const unchanged = supabasePolicyFormState(
			policy,
			{ laneDefaults: policy.laneDefaults, appEnv: policy.appEnv },
			environments
		);
		expect(unchanged.changes).toBe(0);
	});
});

describe('supabaseLaneDefaults', () => {
	it('lists every Lanes environment, defaulting unlisted ones to Off', () => {
		expect(supabaseLaneDefaults(policy, [...environments, 'qa'])).toEqual([
			...policy.laneDefaults,
			{ environmentId: 'qa', backend: 'off' },
		]);
	});
});

describe('supabaseCliReadiness', () => {
	it('counts verified and unverified CLIs across tracked repositories', () => {
		expect(supabaseCliReadiness(createSupabaseDemoState())).toEqual({
			text: '1 verified, 1 not',
			status: 'needs-fix',
		});
		expect(supabaseCliReadiness({ repositories: [] })).toEqual({
			text: 'No tracked repository has a Supabase CLI yet.',
			status: 'optional',
		});
	});
});
