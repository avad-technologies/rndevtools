import { describe, expect, it } from 'vitest';
import {
	allocateLanePort,
	DEFAULT_LANE_ENVIRONMENTS,
	findLaneConflict,
	type Lane,
	laneDeepLink,
	laneDevClientLaunchUrl,
	laneHealth,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneSchema,
	laneSlimSummary,
	laneStateSchema,
} from './lane-protocol';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const OTHER_UDID = 'FFFFFFFF-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

function lane(overrides: Partial<Lane> = {}): Lane {
	return {
		id: 'lane-11111111-2222-4333-8444-555555555555',
		worktreePath: '/Users/dev/app-feature-a',
		branch: 'feature/a',
		simulatorUdid: UDID,
		environment: 'development',
		port: 8_100,
		metroPid: 4_242,
		metro: 'ready',
		logPath: '/Users/dev/Library/Logs/lane.log',
		bundleIdentifier: 'com.example.app',
		scheme: 'exampleapp',
		startedAt: 1_700_000_000_000,
		...overrides,
	};
}

describe('lane protocol schemas', () => {
	it('accepts a complete lane and rejects product-identity drift', () => {
		expect(laneSchema.parse(lane())).toEqual(lane());
		expect(
			laneSchema.safeParse({ ...lane(), bundleIdentifier: 'not valid!' })
				.success
		).toBe(false);
		expect(
			laneSchema.safeParse({ ...lane(), worktreePath: 'relative/path' }).success
		).toBe(false);
		expect(laneSchema.safeParse({ ...lane(), port: 80 }).success).toBe(false);
	});

	it('ships non-overlapping default environment ranges', () => {
		const ranges = DEFAULT_LANE_ENVIRONMENTS.map((env) => env.portRange);
		for (let index = 1; index < ranges.length; index += 1) {
			expect(ranges[index]?.[0]).toBeGreaterThan(ranges[index - 1]?.[1] ?? 0);
		}
	});

	it('defaults lane.start to development with launch enabled', () => {
		const parsed = laneOperationSchema.parse({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app',
			simulatorUdid: UDID,
		});
		expect(parsed).toMatchObject({ environment: 'development', launch: true });
	});

	it('rejects unknown operation fields and bad environment ids', () => {
		expect(
			laneOperationSchema.safeParse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: UDID,
				shell: 'rm -rf /',
			}).success
		).toBe(false);
		expect(
			laneOperationSchema.safeParse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: UDID,
				environment: 'Production Env',
			}).success
		).toBe(false);
	});

	it('validates a lane state snapshot end to end', () => {
		const state = laneStateSchema.parse({
			revision: 1,
			updatedAt: 1,
			environments: DEFAULT_LANE_ENVIRONMENTS,
			lanes: [lane()],
			worktrees: [
				{
					path: '/Users/dev/app-feature-a',
					branch: 'feature/a',
					repositoryRoot: '/Users/dev/app',
					dirty: false,
					laneId: lane().id,
				},
			],
			repositories: ['/Users/dev/app'],
		});
		expect(state.lanes).toHaveLength(1);
	});
});

describe('lane backends on the wire', () => {
	const backend = {
		policy: 'auto',
		status: 'ready',
		stackId: '64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f',
		apiUrl: 'http://127.0.0.1:21734',
		appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
		warnings: ['shared-default-keys'],
	};
	const emptyState = {
		revision: 1,
		updatedAt: 1,
		environments: DEFAULT_LANE_ENVIRONMENTS,
		lanes: [],
		worktrees: [],
		repositories: [],
	};

	it('lets lane.start ask for a backend policy, and leaves an omitted one to the desktop', () => {
		const start = {
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app',
		};
		for (const policy of ['auto', 'off', 'required'] as const) {
			expect(
				laneOperationSchema.parse({ ...start, backend: policy })
			).toMatchObject({ backend: policy });
		}
		expect(laneOperationSchema.parse(start)).not.toHaveProperty('backend');
		expect(
			laneOperationSchema.safeParse({ ...start, backend: 'docker' }).success
		).toBe(false);
		// Only a start names a backend.
		expect(
			laneOperationSchema.safeParse({
				actionId: 'op-2',
				kind: 'lane.launch',
				laneId: lane().id,
				backend: 'auto',
			}).success
		).toBe(false);
	});

	it("carries a lane's backend in the state and receipts, never in a stored lane", () => {
		const withBackend = { ...lane(), backend };
		// lanes.json validates with laneSchema, which refuses the field.
		expect(laneSchema.safeParse(withBackend).success).toBe(false);
		expect(
			laneStateSchema.parse({ ...emptyState, lanes: [withBackend] }).lanes[0]
				?.backend
		).toEqual(backend);
		const receipt = laneOperationReceiptSchema.parse({
			actionId: 'op-1',
			kind: 'lane.start',
			completed: true,
			lane: withBackend,
			backend,
		});
		expect(receipt.backend).toEqual(backend);
		expect(receipt.lane?.backend).toEqual(backend);
		// Names and loopback URLs only: no values, no key, no remote URL.
		for (const smuggled of [
			{ ...backend, apiUrl: 'https://example.com' },
			{ ...backend, publishableKey: 'sb_publishable_example' },
			{ ...backend, appEnvNames: ['expo-public-url'] },
		]) {
			expect(
				laneStateSchema.safeParse({
					...emptyState,
					lanes: [{ ...lane(), backend: smuggled }],
				}).success
			).toBe(false);
		}
	});

	it('keeps the backend policy on a parked device request', () => {
		const state = laneStateSchema.parse({
			...emptyState,
			deviceRequests: [
				{
					id: 'device-request-1',
					status: 'pending',
					requestedAt: 1,
					updatedAt: 1,
					message: 'All 2 available Simulators are in use.',
					worktreePath: '/Users/dev/app-feature-c',
					branch: 'feature-c',
					environment: 'development',
					launch: true,
					backend: 'required',
				},
			],
		});
		expect(state.deviceRequests[0]?.backend).toBe('required');
	});
});

describe('laneDevClientLaunchUrl', () => {
	it('builds the SDK 57 legacy launch form with automation parameters', () => {
		const url = laneDevClientLaunchUrl('exampleapp', 8_123);
		expect(url).toBe(
			'exampleapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8123&disableOnboarding=1&disableAutoLaunch=1'
		);
	});
});

describe('laneDeepLink', () => {
	it('prefixes bare paths with the lane scheme and passes URLs through', () => {
		expect(laneDeepLink({ scheme: 'exampleapp' }, '/checkout')).toBe(
			'exampleapp://checkout'
		);
		expect(
			laneDeepLink({ scheme: 'exampleapp' }, 'https://example.com/x')
		).toBe('https://example.com/x');
	});

	it('refuses a bare path when the lane has no scheme', () => {
		expect(() => laneDeepLink({}, 'checkout')).toThrow(/no URL scheme/);
	});
});

describe('laneSlimSummary', () => {
	it('describes every slim status for rows and CLI output', () => {
		expect(laneSlimSummary(undefined)).toBeUndefined();
		const at = { profileId: 'rndevtools-development', updatedAt: 1 };
		expect(laneSlimSummary({ ...at, status: 'applied' })).toEqual({
			label: 'slim: rndevtools-development',
			tone: 'success',
		});
		expect(laneSlimSummary({ ...at, status: 'applying' })).toEqual({
			label: 'slimming: rndevtools-development',
			tone: 'warning',
		});
		expect(laneSlimSummary({ ...at, status: 'failed' })?.tone).toBe('danger');
		expect(laneSlimSummary({ ...at, status: 'skipped' })?.tone).toBe('muted');
	});

	it('accepts lane.start with a slim profile and has no separate approval operation', () => {
		expect(
			laneOperationSchema.parse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
				slimProfileId: 'rndevtools-development',
			})
		).toMatchObject({ slimProfileId: 'rndevtools-development', launch: true });
		expect(() =>
			laneOperationSchema.parse({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
				slimProfileId: '../escape',
			})
		).toThrow();
		// A start may leave the Simulator to the desktop.
		expect(
			laneOperationSchema.parse({
				actionId: 'op-3',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app',
			})
		).not.toHaveProperty('simulatorUdid');
		// Settling a parked start names the request and, for use/clone, a device.
		expect(
			laneOperationSchema.parse({
				actionId: 'op-4',
				kind: 'lane.provide-device',
				requestId: 'device-request-1',
				decision: 'clone',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
			})
		).toMatchObject({ decision: 'clone' });
		// Slimming is applied by the desktop during lane start, gated on the
		// SimSlim setting, compatibility, and who holds the device; there is no
		// approve/dismiss operation to carry over the wire.
		expect(() =>
			laneOperationSchema.parse({
				actionId: 'op-2',
				kind: 'lane.slim',
				laneId: 'lane-11111111-2222-4333-8444-555555555555',
				decision: 'approve',
			})
		).toThrow();
	});
});

describe('laneHealth', () => {
	it('maps metro status to a label and tone', () => {
		expect(laneHealth({ metro: 'ready' })).toEqual({
			label: 'ready',
			tone: 'success',
		});
		expect(laneHealth({ metro: 'starting' }).tone).toBe('warning');
		expect(laneHealth({ metro: 'stopped' }).tone).toBe('danger');
	});
});

describe('allocateLanePort', () => {
	const environment =
		DEFAULT_LANE_ENVIRONMENTS[0] as (typeof DEFAULT_LANE_ENVIRONMENTS)[number];

	it('skips ports leased by live lanes and ports that fail the bind probe', async () => {
		const busy = new Set([8_101]);
		const port = await allocateLanePort({
			environment,
			lanes: [lane({ port: 8_100, metro: 'ready' })],
			isPortFree: async (candidate) => !busy.has(candidate),
		});
		expect(port).toBe(8_102);
	});

	it('reuses a port whose lane Metro has stopped', async () => {
		const port = await allocateLanePort({
			environment,
			lanes: [lane({ port: 8_100, metro: 'stopped' })],
			isPortFree: async () => true,
		});
		expect(port).toBe(8_100);
	});

	it('honours a free preferred port inside the range and rejects others', async () => {
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				preferredPort: 8_150,
			})
		).resolves.toBe(8_150);
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				preferredPort: 9_000,
			})
		).rejects.toThrow(/outside/);
		await expect(
			allocateLanePort({
				environment,
				lanes: [lane({ port: 8_150 })],
				isPortFree: async () => true,
				preferredPort: 8_150,
			})
		).rejects.toThrow(/already in use/);
	});

	it('fails when the range is exhausted', async () => {
		await expect(
			allocateLanePort({
				environment: { id: 'tiny', portRange: [8_100, 8_101] },
				lanes: [],
				isPortFree: async () => false,
			})
		).rejects.toThrow(/No free Metro port/);
	});

	it('skips a port another start claimed and claims the one it returns', async () => {
		const claimed = new Set([8_100]);
		const claim = (port: number) => {
			if (claimed.has(port)) return false;
			claimed.add(port);
			return true;
		};
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				claim,
			})
		).resolves.toBe(8_101);
		expect(claimed).toEqual(new Set([8_100, 8_101]));
		await expect(
			allocateLanePort({
				environment,
				lanes: [],
				isPortFree: async () => true,
				preferredPort: 8_100,
				claim,
			})
		).rejects.toThrow(/already in use/);
	});

	it('never hands two concurrent starts the same port', async () => {
		// Both bind probes pass before either start has a Metro on the port;
		// the claim after each probe is what keeps them apart.
		const claimed = new Set<number>();
		const claim = (port: number) => {
			if (claimed.has(port)) return false;
			claimed.add(port);
			return true;
		};
		const ports = await Promise.all(
			[0, 1, 2].map(() =>
				allocateLanePort({
					environment,
					lanes: [],
					isPortFree: async () => true,
					claim,
				})
			)
		);
		expect(new Set(ports).size).toBe(3);
	});
});

describe('findLaneConflict', () => {
	it('refuses to steal a worktree or a simulator from a live lane', () => {
		const existing = [lane()];
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-a',
				simulatorUdid: OTHER_UDID,
			})
		).toMatch(/already has lane/);
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-b',
				simulatorUdid: UDID.toLowerCase(),
			})
		).toMatch(/already assigned/);
		expect(
			findLaneConflict(existing, {
				worktreePath: '/Users/dev/app-feature-b',
				simulatorUdid: OTHER_UDID,
			})
		).toBeUndefined();
	});

	it('treats what an in-flight start reserved like a lane', () => {
		const reservations = [
			{ appDirectory: '/Users/dev/app-feature-c', simulatorUdid: UDID },
		];
		expect(
			findLaneConflict(
				[],
				{ worktreePath: '/Users/dev/app-feature-c', simulatorUdid: OTHER_UDID },
				reservations
			)
		).toMatch(/app-feature-c already has a lane starting/);
		expect(
			findLaneConflict(
				[],
				{
					worktreePath: '/Users/dev/app-feature-b',
					simulatorUdid: UDID.toLowerCase(),
				},
				reservations
			)
		).toMatch(/already assigned to a lane starting for/);
		// A reservation that has not chosen a Simulator yet holds only its app.
		expect(
			findLaneConflict(
				[],
				{ worktreePath: '/Users/dev/app-feature-b', simulatorUdid: UDID },
				[{ appDirectory: '/Users/dev/app-feature-c' }]
			)
		).toBeUndefined();
	});
});
