import assert from 'node:assert/strict';
import test from 'node:test';
import installer from './setup-macos-state.js';

const {
	compareVersions,
	snapshotLanes,
	laneRecoveryCommand,
	laneRecoveryStatus: readStatus,
} = installer;

const lane = {
	id: 'lane-example',
	worktreePath: '/Users/example/project with spaces',
	appPath: '/Users/example/project with spaces/apps/mobile',
	branch: 'feature/example',
	simulatorUdid: 'C4534DDD-7F07-4EC9-AC50-EBA019A9D167',
	environment: 'staging',
	port: 8200,
	metro: 'ready',
	scheme: 'example',
	startedAt: 1,
	lastLaunchedAt: 1,
	agent: { kind: 'claude', sessionId: 'example', lastSeenAt: 1 },
	backendPolicy: 'required',
	backend: {
		status: 'ready',
		stackId: 'abcde123',
		apiUrl: 'http://127.0.0.1:20000',
	},
};

function receipt(lanes, branch = lane.branch) {
	return {
		ok: true,
		result: { lanes, worktrees: [{ path: lane.worktreePath, branch }] },
	};
}

function laneRecoveryStatus(saved, state, simulatorState = 'booted') {
	return readStatus(saved, state, {
		ok: true,
		result: {
			devices: [{ udid: lane.simulatorUdid, state: simulatorState }],
		},
	});
}

test('compares desktop releases numerically and orders prereleases', () => {
	assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
	assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
	assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
	assert.equal(compareVersions('0.2.2-beta.10', '0.2.2-beta.9'), 1);
	assert.equal(compareVersions('0.2.2-beta.10', '0.2.2'), -1);
	assert.throws(() => compareVersions('0.2.1', 'unknown'), /three-part/);
});

test('recovers the original app, lease, backend policy, and owner', () => {
	const { lanes } = snapshotLanes(
		receipt([lane, { ...lane, metro: 'stopped' }]),
	);
	assert.equal(lanes.length, 1);
	const saved = lanes[0];
	assert.deepEqual(laneRecoveryCommand(saved), {
		operation: 'up',
		worktreePath: lane.appPath,
		udid: lane.simulatorUdid,
		preferredPort: 8200,
		environment: 'staging',
		launch: true,
		backend: 'required',
		agent: { kind: 'claude', sessionId: 'example' },
	});
	assert.equal(laneRecoveryStatus(saved, receipt([lane])), 'ready');
	assert.equal(
		laneRecoveryStatus(saved, receipt([{ ...lane, startedAt: 2 }])),
		'pending',
	);
	assert.equal(
		laneRecoveryStatus(saved, receipt([lane]), 'shutdown'),
		'pending',
	);
	assert.equal(
		laneRecoveryStatus(saved, receipt([{ ...lane, metro: 'stopped' }])),
		'pending',
	);
	assert.equal(
		laneRecoveryStatus(saved, receipt([{ ...lane, backend: undefined }])),
		'pending',
	);
	assert.equal(
		laneRecoveryStatus(
			saved,
			receipt([{ ...lane, backend: { ...lane.backend, status: 'starting' } }]),
		),
		'pending',
	);
});

test('refuses changed lane assignments and Supabase endpoints', () => {
	const [saved] = snapshotLanes(receipt([lane])).lanes;
	for (const modified of [
		{ ...lane, port: 8201 },
		{ ...lane, simulatorUdid: '6D018A30-746E-4AD4-A8D8-66B0F678FF41' },
		{ ...lane, appPath: undefined },
		{ ...lane, agent: undefined },
	]) {
		assert.throws(
			() => laneRecoveryStatus(saved, receipt([modified])),
			/changed its lease/,
		);
	}
	assert.throws(() => laneRecoveryStatus(saved, receipt([])), /missing/);
	assert.throws(
		() => laneRecoveryStatus(saved, receipt([lane], 'main')),
		/changed branches/,
	);
	assert.throws(
		() =>
			laneRecoveryStatus(
				saved,
				receipt([
					{ ...lane, backend: { ...lane.backend, stackId: 'abcde456' } },
				]),
			),
		/different Supabase stack/,
	);
	assert.throws(
		() =>
			laneRecoveryStatus(
				saved,
				receipt([
					{
						...lane,
						backend: { ...lane.backend, apiUrl: 'http://127.0.0.1:21000' },
					},
				]),
			),
		/different Supabase API URL/,
	);
});

test('keeps unlaunched desktop-owned lanes unlaunched with their backend off', () => {
	const original = {
		...lane,
		appPath: undefined,
		agent: undefined,
		lastLaunchedAt: undefined,
		backendPolicy: 'off',
		backend: undefined,
	};
	const [saved] = snapshotLanes(receipt([original])).lanes;
	assert.deepEqual(laneRecoveryCommand(saved), {
		operation: 'up',
		worktreePath: lane.worktreePath,
		udid: lane.simulatorUdid,
		preferredPort: 8200,
		environment: 'staging',
		launch: false,
		backend: 'off',
		agent: undefined,
	});
	assert.equal(laneRecoveryStatus(saved, receipt([original])), 'ready');
});
