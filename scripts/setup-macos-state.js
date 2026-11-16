// Loaded by macOS osascript. The data helpers also run in the installer tests.

const activeBackendStates = new Set(['starting', 'ready', 'shadowed']);

function compareVersions(left, right) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
	const a = match.exec(left);
	const b = match.exec(right);
	if (!a || !b) throw new Error('Expected a three-part RN Devtools version.');
	for (let index = 1; index <= 3; index++) {
		const difference = Number(a[index]) - Number(b[index]);
		if (difference) return Math.sign(difference);
	}
	if (!a[4] || !b[4]) return Number(!a[4]) - Number(!b[4]);
	const leftTerms = a[4].split('.');
	const rightTerms = b[4].split('.');
	for (
		let index = 0;
		index < Math.min(leftTerms.length, rightTerms.length);
		index++
	) {
		const leftTerm = leftTerms[index];
		const rightTerm = rightTerms[index];
		if (leftTerm === rightTerm) continue;
		const leftIsNumber = /^\d+$/.test(leftTerm);
		const rightIsNumber = /^\d+$/.test(rightTerm);
		if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
		if (leftIsNumber) return Math.sign(Number(leftTerm) - Number(rightTerm));
		return leftTerm < rightTerm ? -1 : 1;
	}
	return Math.sign(leftTerms.length - rightTerms.length);
}

function laneList(receipt) {
	if (!receipt.ok || !Array.isArray(receipt.result?.lanes)) {
		throw new Error('RN Devtools did not return a lane inventory.');
	}
	return receipt.result;
}

function agentOf(lane) {
	return lane.agent
		? { kind: lane.agent.kind, sessionId: lane.agent.sessionId }
		: undefined;
}

function snapshotLanes(receipt) {
	const state = laneList(receipt);
	return {
		lanes: state.lanes
			.filter((lane) => lane.metro === 'ready' || lane.metro === 'starting')
			.map((lane) => {
				const backend = activeBackendStates.has(lane.backend?.status)
					? lane.backend
					: undefined;
				return {
					id: lane.id,
					worktreePath: lane.worktreePath,
					appPath: lane.appPath ?? lane.worktreePath,
					branch:
						state.worktrees?.find((tree) => tree.path === lane.worktreePath)
							?.branch ?? lane.branch,
					simulatorUdid: lane.simulatorUdid,
					port: lane.port,
					environment: lane.environment,
					agent: agentOf(lane),
					launch:
						Boolean(lane.scheme) &&
						(lane.lastLaunchedAt !== undefined ||
							lane.backend?.launch === 'deferred'),
					backendPolicy: lane.backendPolicy ?? lane.backend?.policy,
					stackId: backend?.stackId,
					apiUrl: backend?.apiUrl,
					shadowed: backend?.status === 'shadowed',
				};
			}),
	};
}

function laneRecoveryStatus(saved, receipt, inventory) {
	const state = laneList(receipt);
	const lane = state.lanes.find(({ id }) => id === saved.id);
	if (!lane) throw new Error(`Lane ${saved.id} is missing.`);
	if (
		lane.worktreePath !== saved.worktreePath ||
		(lane.appPath ?? lane.worktreePath) !== saved.appPath ||
		lane.simulatorUdid !== saved.simulatorUdid ||
		lane.port !== saved.port ||
		lane.environment !== saved.environment ||
		lane.agent?.kind !== saved.agent?.kind ||
		lane.agent?.sessionId !== saved.agent?.sessionId ||
		(lane.backendPolicy ?? lane.backend?.policy) !== saved.backendPolicy
	) {
		throw new Error(`Lane ${saved.id} changed its lease or configuration.`);
	}
	const branch = state.worktrees?.find(
		(tree) => tree.path === saved.worktreePath,
	)?.branch;
	if ((branch ?? lane.branch) !== saved.branch) {
		throw new Error(`Lane ${saved.id} changed branches.`);
	}
	if (
		saved.stackId &&
		lane.backend?.stackId &&
		lane.backend.stackId !== saved.stackId
	) {
		throw new Error(
			`Lane ${saved.id} now points at a different Supabase stack.`,
		);
	}
	if (
		saved.apiUrl &&
		lane.backend?.apiUrl &&
		lane.backend.apiUrl !== saved.apiUrl
	) {
		throw new Error(`Lane ${saved.id} now uses a different Supabase API URL.`);
	}
	const backendReady =
		!saved.stackId ||
		(lane.backend?.stackId === saved.stackId &&
			(lane.backend.status === 'ready' ||
				(saved.shadowed && lane.backend.status === 'shadowed')) &&
			(!saved.apiUrl || lane.backend.apiUrl === saved.apiUrl));
	if (!inventory.ok || !Array.isArray(inventory.result?.devices)) {
		throw new Error('RN Devtools did not return a Simulator inventory.');
	}
	const booted = inventory.result.devices.some(
		(device) =>
			device.udid === saved.simulatorUdid && device.state === 'booted',
	);
	const launchReady =
		!saved.launch ||
		(lane.lastLaunchedAt >= lane.startedAt &&
			lane.backend?.launch !== 'deferred');
	return booted && lane.metro === 'ready' && backendReady && launchReady
		? 'ready'
		: 'pending';
}

function laneRecoveryCommand(lane) {
	return {
		operation: 'up',
		worktreePath: lane.appPath,
		udid: lane.simulatorUdid,
		preferredPort: lane.port,
		environment: lane.environment,
		launch: lane.launch,
		agent: lane.agent,
		backend: lane.backendPolicy,
	};
}

function readJSON(file) {
	const contents = $.NSString.stringWithContentsOfFileEncodingError(
		file,
		$.NSUTF8StringEncoding,
		null,
	);
	return JSON.parse(ObjC.unwrap(contents));
}

function desktopProcess(action, bundleId, bundlePath) {
	ObjC.import('AppKit');
	const resolved = ObjC.unwrap(
		$.NSURL.fileURLWithPath(bundlePath).URLByResolvingSymlinksInPath.path,
	);
	const apps =
		$.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
	let target;
	for (let index = 0; index < apps.count; index++) {
		const app = apps.objectAtIndex(index);
		if (app.terminated) continue;
		const path = ObjC.unwrap(app.bundleURL.URLByResolvingSymlinksInPath.path);
		if (path !== resolved)
			throw new Error(`Another RN Devtools app is running at ${path}.`);
		target = app;
	}
	if (!target) return 'stopped';
	if (action === 'status') return 'running';
	const pid = target.processIdentifier;
	if (!target.terminate && !target.terminated) {
		throw new Error('macOS declined to quit RN Devtools.');
	}
	return String(pid);
}

function run([operation, first, second, third, fourth]) {
	if (operation === 'compare') return String(compareVersions(first, second));
	if (operation === 'status' || operation === 'quit') {
		return desktopProcess(operation, first, second);
	}
	ObjC.import('Foundation');
	const input = readJSON(first);
	if (operation === 'snapshot') return JSON.stringify(snapshotLanes(input));
	const lane = input.lanes[Number(second)];
	if (operation === 'request') return JSON.stringify(laneRecoveryCommand(lane));
	if (operation === 'lane-status')
		return laneRecoveryStatus(lane, readJSON(third), readJSON(fourth));
	throw new Error('Unknown installer state operation.');
}

if (typeof module !== 'undefined') {
	module.exports = {
		compareVersions,
		snapshotLanes,
		laneRecoveryCommand,
		laneRecoveryStatus,
		run,
	};
}
