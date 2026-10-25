import { describe, expect, it } from 'vitest';
import type { LaneView } from '../../shared/lane-protocol';
import type { EnvironmentEntry } from '../../shared/protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../../shared/supabase-demo-data';
import {
	type LaneBackendSummary,
	type SupabaseState,
	supabaseTrafficSignature,
} from '../../shared/supabase-protocol';
import type { SupabaseTrafficEntry } from '../../shared/supabase-traffic';
import {
	type AppTrafficInputs,
	appTrafficBanner,
	appTrafficExpectation,
	appTrafficHealth,
	appTrafficTarget,
	appTrafficView,
	environmentSupabaseChecks,
	networkTargetBadge,
	networkTargetFilter,
	networkTargetKey,
	networkTargetOrigin,
	stackAppTrafficRow,
} from './app-traffic-model';

const ids = SUPABASE_DEMO_IDS;
const base = createSupabaseDemoState();
// Main publishes one API port per stack; the demo's running stacks.
const demo: SupabaseState = {
	...base,
	trafficSignature: supabaseTrafficSignature([
		{ port: 21_734, stackId: ids.featCheckout },
		{ port: 24_410, stackId: ids.featPayments },
		{ port: 22_990, stackId: ids.main },
	]),
};
const off: SupabaseState = {
	...demo,
	feature: { ...demo.feature, enabled: false },
};

const ready: LaneBackendSummary = {
	policy: 'auto',
	status: 'ready',
	stackId: ids.featCheckout,
	apiUrl: 'http://127.0.0.1:21734',
	appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
	warnings: [],
};

const lane: Pick<LaneView, 'id' | 'backend'> = {
	id: ids.laneCheckout,
	backend: ready,
};

let sequence = 0;
function request(url: string): SupabaseTrafficEntry {
	sequence += 1;
	const parsed = new URL(url);
	return {
		at: sequence,
		url,
		host: parsed.host,
		path: `${parsed.pathname}${parsed.search}`,
	};
}

function inputs(overrides: Partial<AppTrafficInputs> = {}): AppTrafficInputs {
	return {
		device: { info: { simulatorUdid: ids.simulatorCheckout } },
		entries: [],
		lane,
		state: demo,
		...overrides,
	};
}

const toPayments = Array.from({ length: 12 }, () =>
	request('http://127.0.0.1:24410/rest/v1/orders?select=*')
);
const toLane = [
	request('http://127.0.0.1:21734/rest/v1/notes?select=id'),
	request('http://127.0.0.1:21734/auth/v1/user'),
];

describe('appTrafficExpectation', () => {
	it('expects the lane stack, by summary or by the stack that lists the lane', () => {
		expect(appTrafficExpectation(lane, demo)).toMatchObject({
			expects: true,
			stackId: ids.featCheckout,
			port: 21_734,
		});
		expect(
			appTrafficExpectation({ id: ids.laneCheckout, backend: undefined }, demo)
		).toMatchObject({ expects: true, stackId: ids.featCheckout });
		expect(appTrafficExpectation(undefined, demo)).toEqual({ expects: false });
		expect(
			appTrafficExpectation(
				{
					id: 'lane-00000000-0000-4000-8000-000000000000',
					backend: {
						policy: 'off',
						status: 'skipped',
						reason: 'off',
						appEnvNames: [],
						warnings: [],
					},
				},
				demo
			)
		).toEqual({ expects: false });
	});
});

describe('the connected banner', () => {
	it('names the other stack, the lane stack and the share of requests', () => {
		const view = appTrafficView(
			inputs({ entries: [...toPayments, ...toLane] })
		);
		expect(view.classification.verdict).toBe('other-stack');
		const banner = appTrafficBanner(view, 'ExampleApp');
		expect(banner).toEqual({
			text: "ExampleApp talks to the stack for feat-payments (:24410), not its lane's stack (:21734): 12 of 14 requests.",
			tone: 'warning',
			announcement: 'App traffic: other stack · feat-payments (:24410).',
			stackId: ids.featPayments,
			filter: {
				key: `stack:${ids.featPayments}`,
				label: 'origin 127.0.0.1:24410',
			},
		});
	});

	it('is red for the Docker-era port and words a split', () => {
		const legacy = appTrafficView(
			inputs({ entries: [request('http://localhost:54321/rest/v1/items')] })
		);
		expect(appTrafficBanner(legacy, 'ExampleApp')).toMatchObject({
			tone: 'danger',
			stackId: ids.featCheckout,
			filter: { key: 'local:54321', label: 'origin 127.0.0.1:54321' },
		});
		const split = appTrafficView(
			inputs({
				entries: [
					...toLane,
					request('https://abcd1234.supabase.co/rest/v1/items'),
					request('https://abcd1234.supabase.co/rest/v1/items'),
				],
			})
		);
		expect(split.classification.verdict).toBe('mixed');
		expect(appTrafficBanner(split, 'ExampleApp')?.text).toBe(
			"ExampleApp's traffic is split across 2 backends; the largest gets 2 of 4 requests."
		);
	});

	it('never shows without evidence, a link, a lane backend, or the feature', () => {
		const banner = (overrides: Partial<AppTrafficInputs>) =>
			appTrafficBanner(appTrafficView(inputs(overrides)), 'ExampleApp');
		expect(banner({ entries: toLane })).toBeUndefined();
		expect(banner({ entries: [] })).toBeUndefined();
		expect(
			banner({ entries: toPayments, device: { info: {} } })
		).toBeUndefined();
		expect(banner({ entries: toPayments, lane: undefined })).toBeUndefined();
		expect(banner({ entries: toPayments, state: off })).toBeUndefined();
		expect(
			appTrafficView(inputs({ entries: toPayments, state: off })).classification
				.total
		).toBe(0);
	});
});

describe('Network target badges and the backend filter', () => {
	const view = appTrafficView(inputs({ entries: [...toPayments, ...toLane] }));
	const target = (url: string) => {
		const found = appTrafficTarget(request(url), demo.trafficSignature, {
			enabled: view.enabled,
			expectedStackId: view.expectedStack?.id,
		});
		if (!found) throw new Error(`No target for ${url}`);
		return found;
	};

	it('badges this lane’s stack, other stacks, hosted and legacy traffic', () => {
		expect(
			networkTargetBadge(target('http://127.0.0.1:21734/rest/v1/notes'), view)
		).toEqual({
			label: 'lane stack',
			tone: 'success',
			detail: "This lane's stack (:21734)",
		});
		expect(
			networkTargetBadge(target('http://127.0.0.1:24410/rest/v1/orders'), view)
		).toEqual({
			label: 'feat-payments stack',
			tone: 'warning',
			detail:
				"The stack for feat-payments (:24410), not this lane's stack (:21734)",
		});
		expect(
			networkTargetBadge(
				target('https://abcd1234.supabase.co/storage/v1/object/public/a.png'),
				view
			)
		).toMatchObject({ label: 'hosted abcd1234', tone: 'warning' });
		expect(
			networkTargetBadge(target('http://127.0.0.1:54321/rest/v1/x'), view)
		).toMatchObject({ label: 'legacy :54321', tone: 'danger' });
		expect(
			appTrafficTarget(
				request('https://api.example.com/v1/catalog'),
				demo.trafficSignature,
				{ enabled: true, expectedStackId: ids.featCheckout }
			)
		).toBeUndefined();
	});

	it('stays neutral without a lane stack to compare with', () => {
		const loose = appTrafficView(inputs({ lane: undefined }));
		const found = appTrafficTarget(
			request('http://127.0.0.1:24410/rest/v1/orders'),
			demo.trafficSignature,
			{ enabled: loose.enabled }
		);
		if (!found) throw new Error('expected a target');
		expect(networkTargetBadge(found, loose)).toEqual({
			label: 'feat-payments stack',
			tone: 'default',
			detail: 'The stack for feat-payments (:24410)',
		});
		expect(
			appTrafficTarget(
				request('http://127.0.0.1:24410/rest/v1/orders'),
				off.trafficSignature,
				{ enabled: appTrafficView(inputs({ state: off })).enabled }
			)
		).toBeUndefined();
	});

	it('keys and labels one backend for the origin chip', () => {
		const stack = target('http://localhost:24410/rest/v1/orders');
		expect(networkTargetKey(stack)).toBe(`stack:${ids.featPayments}`);
		expect(networkTargetOrigin(stack)).toBe('127.0.0.1:24410');
		const hosted = target('https://abcd1234.supabase.co/rest/v1/items');
		expect(networkTargetFilter(hosted)).toEqual({
			key: 'host:abcd1234.supabase.co',
			label: 'origin abcd1234.supabase.co',
		});
	});
});

describe('the Diagnostics Local Supabase card', () => {
	it('reports the verdict against the lane stack, never OK without traffic', () => {
		expect(
			appTrafficHealth(appTrafficView(inputs({ entries: toLane })))
		).toEqual({
			value: 'uses this stack',
			detail: 'Lane stack feat-checkout :21734 · 2 of 2 requests',
			tone: 'success',
		});
		expect(appTrafficHealth(appTrafficView(inputs()))).toMatchObject({
			value: 'No app traffic seen',
			tone: 'default',
		});
		expect(
			appTrafficHealth(
				appTrafficView(inputs({ entries: [...toPayments, ...toLane] }))
			)
		).toMatchObject({
			value: 'other stack · feat-payments (:24410)',
			tone: 'warning',
		});
	});

	it('explains a missing link, lane or lane backend', () => {
		expect(
			appTrafficHealth(appTrafficView(inputs({ device: { info: {} } }))).value
		).toBe('App not linked');
		expect(
			appTrafficHealth(appTrafficView(inputs({ lane: undefined }))).value
		).toBe('No lane');
		expect(
			appTrafficHealth(
				appTrafficView(
					inputs({
						lane: {
							id: 'lane-00000000-0000-4000-8000-000000000000',
							backend: {
								policy: 'off',
								status: 'skipped',
								reason: 'off',
								appEnvNames: [],
								warnings: [],
							},
						},
					})
				)
			).value
		).toBe('No lane backend');
	});
});

describe('the Environment check', () => {
	function entry(
		key: string,
		valueText: string,
		status: EnvironmentEntry['status'] = 'valid'
	): EnvironmentEntry {
		return { id: `env-${key}`, section: 'Backend', key, valueText, status };
	}

	it('matches by value, treating local http as expected for the lane stack', () => {
		const view = appTrafficView(inputs());
		const checks = environmentSupabaseChecks(
			[
				entry('SOME_NAME', 'http://127.0.0.1:21734', 'valueMismatch'),
				entry('EXPO_PUBLIC_SUPABASE_URL', 'https://api.example.com'),
				entry('EXPO_PUBLIC_SUPABASE_ANON_KEY', '[REDACTED]'),
			],
			view,
			demo
		);
		expect(checks).toEqual([
			{
				id: 'env-SOME_NAME',
				key: 'SOME_NAME',
				origin: 'http://127.0.0.1:21734',
				status: 'matches',
				tone: 'success',
				text: "Matches this lane's stack (:21734).",
				note: "Local http is expected for a lane's stack; the app's URL rule only accepts https.",
			},
		]);
	});

	it('flags another stack, a hosted project and the legacy port', () => {
		const view = appTrafficView(inputs());
		const checks = environmentSupabaseChecks(
			[
				entry('A', 'http://localhost:24410/'),
				entry('B', 'https://abcd1234.supabase.co'),
				entry('C', 'http://127.0.0.1:54321'),
			],
			view,
			demo
		);
		expect(
			checks.map((check) => [check.status, check.tone, check.text])
		).toEqual([
			[
				'feat-payments stack',
				'warning',
				"Points at the stack for feat-payments (:24410), not this lane's stack (:21734).",
			],
			[
				'hosted abcd1234',
				'warning',
				"Points at the hosted project abcd1234, not this lane's stack (:21734).",
			],
			[
				'legacy :54321',
				'danger',
				'Points at the Docker-era default port :54321; a Docker stack there listens on your network.',
			],
		]);
		expect(checks[0]?.origin).toBe('http://localhost:24410');
		expect(
			environmentSupabaseChecks(
				[entry('A', 'http://127.0.0.1:21734')],
				appTrafficView(inputs({ state: off })),
				off
			)
		).toEqual([]);
	});
});

describe('stackAppTrafficRow', () => {
	const checkout = demo.stacks.find((stack) => stack.id === ids.featCheckout);
	const payments = demo.stacks.find((stack) => stack.id === ids.featPayments);
	const app = (
		network: readonly SupabaseTrafficEntry[],
		status: 'online' | 'offline' | 'simulated' = 'online'
	) => ({
		info: { id: 'device-1', simulatorUdid: ids.simulatorCheckout },
		status,
		tools: { network },
	});
	const context = {
		devices: [app(toLane)],
		laneForSimulator: () => lane,
		state: demo,
		now: 60_000,
	};

	it("classifies the app on a lane's Simulator against that stack", () => {
		if (!checkout) throw new Error('the demo has a checkout stack');
		const row = stackAppTrafficRow(checkout, context);
		expect(row).toMatchObject({
			deviceId: 'device-1',
			tone: 'success',
			filter: { key: `stack:${ids.featCheckout}` },
		});
		expect(row?.text).toMatch(/^uses this stack · 2 requests · \d+ s ago$/);
		const elsewhere = stackAppTrafficRow(checkout, {
			...context,
			devices: [app([...toPayments, ...toLane])],
		});
		expect(elsewhere).toMatchObject({
			tone: 'warning',
			filter: { key: `stack:${ids.featPayments}` },
		});
		expect(elsewhere?.text).toMatch(
			/^other stack · .+ \(:24410\) · 14 requests/
		);
	});

	it('says so before any traffic, without a filter', () => {
		if (!checkout) throw new Error('the demo has a checkout stack');
		const row = stackAppTrafficRow(checkout, {
			...context,
			devices: [app([])],
		});
		expect(row).toEqual({
			deviceId: 'device-1',
			text: 'no app traffic seen',
			tone: 'default',
		});
	});

	it('shows nothing without a connected app on its lanes, or while off', () => {
		if (!checkout || !payments) throw new Error('the demo has both stacks');
		expect(
			stackAppTrafficRow(checkout, {
				...context,
				devices: [app(toLane, 'offline')],
			})
		).toBeUndefined();
		// The app's lane uses another stack.
		expect(stackAppTrafficRow(payments, context)).toBeUndefined();
		expect(
			stackAppTrafficRow(checkout, { ...context, state: off })
		).toBeUndefined();
	});
});
