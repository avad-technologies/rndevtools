import { spawn, spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const packageManifest = JSON.parse(
	readFileSync(join(desktopDirectory, 'package.json'), 'utf8')
);
const appPath = resolve(
	process.argv[2] ??
		join(
			desktopDirectory,
			'release',
			`mac-${process.arch}`,
			`${packageManifest.productName}.app`
		)
);
const executablePath = join(
	appPath,
	'Contents',
	'MacOS',
	packageManifest.productName
);
const diagnosticDirectory = join(
	homedir(),
	'Library',
	'Logs',
	'DiagnosticReports'
);
const productUserDataDirectory = join(
	homedir(),
	'Library',
	'Application Support',
	packageManifest.productName
);
const outputLimit = 32 * 1024;

if (process.platform !== 'darwin') {
	fail('Packaged cold-start verification requires macOS.');
}
if (process.argv.length > 3) {
	fail('Usage: node verify-packaged-cold-start.mjs [application.app]');
}
const appStats = lstatSync(appPath);
if (!appStats.isDirectory() || appStats.isSymbolicLink()) {
	fail(`Packaged application is not a regular bundle: ${appPath}`);
}
const existingProcesses = productProcesses();
if (existingProcesses.length > 0) {
	fail(
		`Cold-start verification requires no existing ${packageManifest.productName} process. Found: ${existingProcesses.map(({ pid }) => pid).join(', ')}`
	);
}

const crashReportsBefore = crashReportSnapshot();
const child = spawn(executablePath, [], {
	cwd: desktopDirectory,
	env: process.env,
	stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
	stdout = appendBounded(stdout, chunk);
});
child.stderr.on('data', (chunk) => {
	stderr = appendBounded(stderr, chunk);
});
const exitPromise = new Promise((resolveExit, rejectExit) => {
	child.once('error', rejectExit);
	child.once('exit', (code, signal) => resolveExit({ code, signal }));
});

let renderer;
let failure;
try {
	renderer = await waitForRenderer(child, exitPromise, 20_000);
	await delay(3_000);
	if (!isRunning(child.pid)) {
		throw new Error(
			'Packaged application exited during the cold-start stability window.'
		);
	}
	const liveRenderer = appProcesses().find(
		(process_) =>
			process_.pid === renderer.pid &&
			process_.command.includes('--type=renderer')
	);
	if (!liveRenderer) {
		throw new Error(
			'Renderer health marker disappeared during the stability window.'
		);
	}
} catch (error) {
	failure = error;
} finally {
	if (isRunning(child.pid)) {
		child.kill('SIGTERM');
		const exited = await Promise.race([
			exitPromise.then(() => true),
			delay(5_000).then(() => false),
		]);
		if (!exited && isRunning(child.pid)) {
			child.kill('SIGKILL');
			await exitPromise;
		}
	}
}

await delay(2_000);
const newCrashReports = changedCrashReports(crashReportsBefore);
if (newCrashReports.length > 0) {
	failure = new Error(
		`Cold start produced a new diagnostic report: ${newCrashReports.join(', ')}`,
		{ cause: failure }
	);
}
if (failure) {
	const exit = await Promise.race([
		exitPromise,
		Promise.resolve({ code: null, signal: null }),
	]);
	process.stderr.write(
		`${failure instanceof Error ? failure.stack : String(failure)}\n` +
			`exit=${JSON.stringify(exit)}\nstdout:\n${stdout}\nstderr:\n${stderr}\n`
	);
	process.exit(1);
}

process.stdout.write(
	`Cold start stayed healthy with main PID ${child.pid} and renderer PID ${renderer.pid}.\n`
);

async function waitForRenderer(process_, processExit, timeoutMilliseconds) {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		const rendererProcess = appProcesses().find(
			(candidate) =>
				candidate.ppid === process_.pid &&
				candidate.command.includes('--type=renderer')
		);
		if (rendererProcess) {
			return rendererProcess;
		}
		const exit = await Promise.race([
			processExit.then((result) => ({ exited: true, result })),
			delay(250).then(() => ({ exited: false })),
		]);
		if (exit.exited) {
			throw new Error(
				`Packaged application exited before renderer health: ${JSON.stringify(exit.result)}`
			);
		}
	}
	throw new Error(
		`Renderer health marker did not appear within ${timeoutMilliseconds}ms.`
	);
}

function appProcesses() {
	return runningProcesses().filter(({ command }) =>
		command.includes(`${appPath}/Contents/`)
	);
}

function productProcesses() {
	const bundledProcessMarker = `/${packageManifest.productName}.app/Contents/`;
	const userDataMarker = `--user-data-dir=${productUserDataDirectory}`;
	return runningProcesses().filter(
		({ command }) =>
			command.includes(bundledProcessMarker) || command.includes(userDataMarker)
	);
}

function runningProcesses() {
	const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		fail(`Could not inspect running processes: ${result.stderr.trim()}`);
	}
	return result.stdout
		.split('\n')
		.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
		.filter(Boolean)
		.map((match) => ({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			command: match[3],
		}));
}

function crashReportSnapshot() {
	if (!existsSync(diagnosticDirectory)) {
		return new Map();
	}
	return new Map(
		readdirSync(diagnosticDirectory)
			.filter(
				(file) =>
					file.startsWith(`${packageManifest.productName}-`) &&
					file.endsWith('.ips')
			)
			.map((file) => [file, statSync(join(diagnosticDirectory, file)).mtimeMs])
	);
}

function changedCrashReports(previous) {
	return [...crashReportSnapshot()].flatMap(([file, modifiedAt]) =>
		previous.get(file) === modifiedAt ? [] : [join(diagnosticDirectory, file)]
	);
}

function isRunning(pid) {
	if (!pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === 'ESRCH') {
			return false;
		}
		throw error;
	}
}

function appendBounded(current, chunk) {
	return `${current}${chunk}`.slice(-outputLimit);
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
