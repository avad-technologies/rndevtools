import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopVersion } from './native-host-version.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const helperPath = resolve(
	process.argv[2] ??
		join(
			desktopDirectory,
			'build',
			'native',
			`mac-${process.arch}`,
			'rndevtools-native-host'
		)
);
const maximumRequestBytes = 64 * 1024;
const maximumResponseBytes = 256 * 1024;

if (process.platform !== 'darwin') {
	fail('Native-host capability verification requires macOS.');
}
if (process.argv.length > 3) {
	fail(
		'Usage: node verify-native-host-capabilities.mjs [rndevtools-native-host]'
	);
}

try {
	// Electron marks a host untrusted, disabling native permission state and
	// image composition, when its v2 or v3 handshake reports a version other
	// than the manifest's appVersion. The build writes that from package.json,
	// which is also the packaged app's version.
	const appVersion = desktopVersion();
	const stats = lstatSync(helperPath);
	assert.equal(stats.isFile(), true, 'native host must be a regular file');
	assert.equal(
		stats.isSymbolicLink(),
		false,
		'native host must not be a symlink'
	);
	assert.notEqual(stats.mode & 0o111, 0, 'native host must be executable');

	const legacyHandshake = invoke(1, 'legacy-handshake', 'handshake');
	assert.deepEqual(legacyHandshake.result.capabilities, {
		operations: ['handshake', 'permission_status'],
		permissionInspection: true,
		permissionPrompting: false,
		runtimeDownloads: false,
		simulatorMutation: false,
	});
	assertHelperVersion(legacyHandshake, appVersion);

	const currentHandshake = invoke(2, 'capability-handshake', 'handshake');
	assert.deepEqual(currentHandshake.result.capabilities.operations, [
		'handshake',
		'permission_status',
		'capability_status',
	]);
	assert.equal(currentHandshake.result.capabilities.capabilityInspection, true);
	assert.equal(currentHandshake.result.capabilities.liveCaptureSessions, false);
	assertHelperVersion(currentHandshake, appVersion);
	assertHelperVersion(
		invoke(3, 'composition-handshake', 'handshake'),
		appVersion
	);

	const { result } = invoke(2, 'capability-status', 'capability_status');
	assert.ok(['arm64', 'x86_64'].includes(result.architecture));
	assert.match(result.operatingSystemVersion, /^\d+\.\d+\.\d+$/);
	assert.equal(Number.isSafeInteger(result.checkedAtMilliseconds), true);
	assert.equal(result.checkedAtMilliseconds > 0, true);
	assert.deepEqual(
		result.screenCaptureKit.requestableFrameRates,
		[30, 60, 120]
	);
	assert.equal(result.screenCaptureKit.windowEnumerationPerformed, false);
	assert.equal(result.screenCaptureKit.contentPickerPresented, false);
	assert.equal(
		result.screenCaptureKit.persistentSessionOperationsExposed,
		false
	);
	assert.equal(result.avFoundation.permissionRequestsPerformed, false);
	assert.equal(result.accessibility.permissionPromptPerformed, false);
	assert.equal(result.buildInsights.requiresExplicitSourceRoots, true);
	assert.equal(result.buildInsights.sourceRootsInspected, false);
	assert.equal(result.buildInsights.xcodeProcessesLaunched, false);
	assert.equal(result.networkExtension.preferenceReadsPerformed, false);
	assert.equal(result.videoToolbox.framesEncoded, 0);
	assert.equal(
		result.videoToolbox.probeKind,
		'hardware_realtime_configuration_acceptance'
	);
	assert.deepEqual(
		result.videoToolbox.codecs.map(({ id }) => id),
		['h264', 'hevc']
	);
	for (const codec of result.videoToolbox.codecs) {
		assert.equal(
			codec.acceptedRealtimeConfigurationFrameRates.every((value) =>
				[30, 60, 120].includes(value)
			),
			true
		);
	}
	assert.deepEqual(result.safety, {
		contentEnumerated: false,
		externalStateMutations: false,
		networkPreferencesRead: false,
		permissionPrompts: false,
		persistentSessions: false,
	});

	process.stdout.write(
		`Verified native-host ${appVersion} protocols and read-only capability status at ${helperPath}.\n`
	);
} catch (error) {
	fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

function assertHelperVersion(handshake, appVersion) {
	assert.equal(
		handshake.result.helperVersion,
		appVersion,
		`protocol v${handshake.protocolVersion} handshake reports helperVersion ${handshake.result.helperVersion}, but the desktop app version is ${appVersion}`
	);
}

function invoke(protocolVersion, requestId, operation) {
	const input = `${JSON.stringify({
		protocolVersion,
		requestId,
		operation,
		payload: {},
	})}\n`;
	assert.ok(Buffer.byteLength(input) <= maximumRequestBytes);
	const execution = spawnSync(helperPath, [], {
		encoding: 'utf8',
		input,
		maxBuffer: maximumResponseBytes + 1,
		timeout: 15_000,
	});
	if (execution.error) {
		throw execution.error;
	}
	assert.equal(
		execution.signal,
		null,
		`${operation} was terminated by a signal`
	);
	assert.equal(execution.status, 0, `${operation} failed: ${execution.stderr}`);
	assert.equal(execution.stderr, '', `${operation} wrote unexpected stderr`);
	assert.ok(Buffer.byteLength(execution.stdout) <= maximumResponseBytes);
	assert.equal(
		execution.stdout.endsWith('\n'),
		true,
		`${operation} response lacks newline`
	);
	const lines = execution.stdout.split('\n');
	assert.equal(lines.length, 2, `${operation} must emit exactly one JSON line`);
	assert.equal(lines[1], '');
	const envelope = JSON.parse(lines[0]);
	assert.equal(envelope.protocolVersion, protocolVersion);
	assert.equal(envelope.requestId, requestId);
	assert.equal(envelope.ok, true);
	assert.ok(envelope.result && typeof envelope.result === 'object');
	return envelope;
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
