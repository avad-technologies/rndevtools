// Runs the desktop's agent socket in-process under Electron for the duration of
// an experiment, logging every request the router receives to a JSONL file.
// This is the measurement side: adoption is scored at the socket, not from the
// agent's transcript.
//
// Usage (from apps/desktop, after esbuild has produced dist/main/experiment-entry.js):
//   cp experiments/agent-discovery/desktop-fixture.mjs /tmp/exp-fixture.mjs
//   npx electron --in-process-gpu --disable-gpu --disable-gpu-compositing \
//     /tmp/exp-fixture.mjs <logPath> <readyPath> <stopPath>
// (Electron must be given a path outside the package so it does not treat the
// package.json as the app to launch.)
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Electron keeps its own switches in process.argv, so take the trailing three.
const [logPath, readyPath, stopPath] = process.argv.slice(-3);
const SOCK = path.join(os.homedir(), 'Library', 'Application Support', 'RN Devtools', 'agent', 'rndevtools.sock');
fs.rmSync(readyPath, { force: true });
fs.rmSync(stopPath, { force: true });
fs.writeFileSync(logPath, '');
const log = (entry) => fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
setTimeout(() => { log({ event: 'timeout' }); app.exit(2); }, 6 * 60 * 60 * 1000);

(async () => {
	try {
		await app.whenReady();
		const mod = await import(path.resolve('dist/main/experiment-entry.js'));
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnd-experiment-'));
		const coordinator = new mod.SimulatorMutationCoordinator();
		const nativeHost = new mod.NativeHostClient({ resourceDirectory: path.resolve('build/native/mac-arm64'), appVersion: '0.1.0' });
		const simulator = new mod.SimulatorService({ captureStore: new mod.SimulatorCaptureStore(path.join(root, 'captures')), mutationCoordinator: coordinator, nativeHostProvider: nativeHost });
		await simulator.start();
		await simulator.refresh();
		const lanes = new mod.LaneService({ store: new mod.LaneStore(path.join(root, 'lanes')), simulator, mutationCoordinator: coordinator });
		await lanes.start?.();
		const agents = new mod.AgentService({
			directory: path.join(root, 'agents'),
			lanes: () => lanes.getState().lanes.map((lane) => ({ id: lane.id, simulatorUdid: lane.simulatorUdid, worktreePath: lane.worktreePath, agent: lane.agent, metro: lane.metro, startedAt: lane.startedAt })),
		});
		await agents.start();
		const broker = { getState: () => ({ protocolVersion: 2, broker: { status: 'stopped' }, devices: [], sessions: [], diagnostics: [] }), dispatchAction: async () => ({ ok: false, error: 'n/a' }) };
		const slimming = { getState: () => ({}), refresh: async () => ({ revision: 0, updatedAt: 0, setting: { experimentalMutationsEnabled: false }, helper: { status: 'unavailable', readOnlyAvailable: false }, categories: [], profiles: [], simulators: [], statusBySimulator: {}, previewBySimulator: {}, doctorBySimulator: {}, jobs: [], checkpointBySimulator: {}, operationsBySimulator: {} }), runAction: () => ({ accepted: false }), cancelJob: () => false, subscribe: () => () => {} };
		const inner = mod.createAgentCommandRouter({ broker, simulator, slimming, lanes, agents, nativePlan: mod.runNativePlan, simulatorInput: (input, signal) => nativeHost.sendSimulatorInput(input, signal) });
		const handler = async (command, context) => {
			const started = Date.now();
			const base = { event: 'request', at: started, kind: command.kind, operation: command.operation ?? command.input?.kind ?? null, agent: context.agent ?? null, requestId: context.requestId };
			try {
				const result = await inner(command, context);
				log({ ...base, ok: true, ms: Date.now() - started });
				return result;
			} catch (error) {
				log({ ...base, ok: false, ms: Date.now() - started, code: error?.code ?? 'unknown', message: String(error?.message ?? error).slice(0, 200) });
				throw error;
			}
		};
		const service = new mod.AgentCliService({ socketPath: SOCK, handler });
		await service.start();
		log({ event: 'ready', socket: SOCK });
		fs.writeFileSync(readyPath, '1');
		while (!fs.existsSync(stopPath)) await new Promise((resolve) => setTimeout(resolve, 1000));
		await service.stop();
		await agents.stop?.();
		await lanes.stop?.();
		await simulator.stop();
		fs.rmSync(root, { recursive: true, force: true });
		log({ event: 'stopped' });
	} catch (error) {
		log({ event: 'error', message: String(error?.stack ?? error) });
	}
	app.exit(0);
})();
