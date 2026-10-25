import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeHostVersionDrift } from './native-host-version.mjs';
import { verifyVendoredSimSlim } from './verify-vendored-simslim.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const goPackages = [
	{
		directory: resolve(desktopDirectory, 'native', 'rndevtools-sim-helper'),
		modules: [
			'github.com/adalloul0928/rndevtools-sim-helper',
			'github.com/mobai-app/simslim v0.12.2',
		],
		name: 'simulator helper',
		vendored: true,
	},
	{
		directory: resolve(desktopDirectory, 'native', 'rndevtools-cli'),
		modules: ['github.com/adalloul0928/rndevtools-cli'],
		name: 'local agent CLI',
		vendored: false,
	},
];
const swiftPackage = resolve(
	desktopDirectory,
	'native',
	'rndevtools-native-host'
);
const selection = parseSelection(process.argv.slice(2));

// Electron trusts the Swift host only when its handshake reports the manifest's
// appVersion, which comes from package.json. This needs no toolchain, so it
// runs for every selection, including the `--go` run in CI's secret-free job.
const versionDrift = nativeHostVersionDrift(desktopDirectory);
if (versionDrift) fail(versionDrift);

if (selection.go) {
	verifyVendoredSimSlim(goPackages[0].directory);
	const toolEnvironment = {
		...allowlistedCheckEnvironment(),
		GOENV: 'off',
		GOEXPERIMENT: '',
		GOFLAGS: '',
		GOPROXY: 'off',
		GOTOOLCHAIN: 'local',
		GOWORK: 'off',
	};
	requireCommand('go', ['version'], toolEnvironment);
	requireCommand('govulncheck', ['-version'], toolEnvironment);
	for (const goPackage of goPackages) {
		const environment = {
			...allowlistedCheckEnvironment(),
			GOENV: 'off',
			GOEXPERIMENT: '',
			GOFLAGS: goPackage.vendored ? '-mod=vendor' : '-mod=readonly',
			GOAMD64: 'v1',
			GOARM64: 'v8.0',
			GOPROXY: 'off',
			GOTOOLCHAIN: 'local',
			GOWORK: 'off',
		};
		const formatting = capture(
			'gofmt',
			['-l', '.'],
			goPackage.directory,
			toolEnvironment
		);
		if (formatting.trim()) {
			fail(`Go files need formatting in ${goPackage.name}:\n${formatting}`);
		}
		run('go', ['vet', './...'], goPackage.directory, environment);
		run('go', ['test', '-race', './...'], goPackage.directory, environment);
		// GOPROXY=off and GOFLAGS=-mod=vendor make govulncheck analyze the exact
		// checked-in package implementation compiled into the helper.
		run('govulncheck', ['./...'], goPackage.directory, environment);
		const modules = goPackage.vendored
			? declaredVendoredModules(goPackage.directory, environment)
			: capture('go', ['list', '-m', 'all'], goPackage.directory, environment)
					.trim()
					.split('\n');
		if (
			modules.length !== goPackage.modules.length ||
			modules.some((module, index) => module !== goPackage.modules[index])
		) {
			fail(
				`The ${goPackage.name} module graph drifted. Found modules:\n${modules.join('\n')}`
			);
		}
	}
}

if (selection.swift) {
	if (process.platform !== 'darwin') {
		fail('Swift native-host checks require macOS.');
	}
	requireCommand('swift', ['--version'], allowlistedCheckEnvironment());
	const swiftEnvironment = allowlistedCheckEnvironment();
	run(
		'swift',
		[
			'format',
			'lint',
			'--strict',
			'--recursive',
			'Package.swift',
			'Sources',
			'Tests',
		],
		swiftPackage,
		swiftEnvironment
	);
	run(
		'swift',
		['test', '--package-path', swiftPackage],
		desktopDirectory,
		swiftEnvironment
	);
}

function parseSelection(arguments_) {
	if (arguments_.length === 0) {
		return { go: true, swift: true };
	}
	if (arguments_.length === 1 && arguments_[0] === '--go') {
		return { go: true, swift: false };
	}
	if (arguments_.length === 1 && arguments_[0] === '--swift') {
		return { go: false, swift: true };
	}
	fail(`Unknown check options: ${arguments_.join(' ')}`);
}

function requireCommand(command, arguments_, env) {
	const result = spawnSync(command, arguments_, {
		cwd: desktopDirectory,
		encoding: 'utf8',
		env,
	});
	if (result.error?.code === 'ENOENT') {
		fail(
			`${command} is required for native-helper checks but is not installed.`
		);
	}
	if (result.status !== 0) {
		fail(`${command} is present but could not run successfully.`);
	}
}

function run(command, arguments_, cwd, env) {
	const result = spawnSync(command, arguments_, { cwd, env, stdio: 'inherit' });
	if (result.error) {
		fail(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(`${command} exited with status ${result.status}.`);
	}
}

function capture(command, arguments_, cwd, env) {
	const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', env });
	if (result.error?.code === 'ENOENT') {
		fail(
			`${command} is required for native-helper checks but is not installed.`
		);
	}
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		fail(`${command} exited with status ${result.status}.`);
	}
	return result.stdout;
}

function allowlistedCheckEnvironment() {
	const environment = {};
	for (const name of [
		'DEVELOPER_DIR',
		'HOME',
		'LANG',
		'LC_ALL',
		'PATH',
		'SDKROOT',
		'TMPDIR',
	]) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}

function declaredVendoredModules(directory, environment) {
	// Modern Go intentionally rejects `go list -m all` in vendor mode. Read the
	// main identity and the checked-in go.mod declarations without resolving the
	// network; vendor/modules.txt is independently covered by the byte manifest.
	const mainModule = capture(
		'go',
		['list', '-m'],
		directory,
		environment
	).trim();
	const moduleFile = JSON.parse(
		capture('go', ['mod', 'edit', '-json'], directory, environment)
	);
	if (
		(moduleFile.Replace?.length ?? 0) !== 0 ||
		(moduleFile.Exclude?.length ?? 0) !== 0 ||
		(moduleFile.Retract?.length ?? 0) !== 0
	) {
		fail(
			'The vendored simulator helper cannot use replace, exclude, or retract rules.'
		);
	}
	return [
		mainModule,
		...(moduleFile.Require ?? []).map(
			(requirement) =>
				`${requirement.Path} ${requirement.Version}${requirement.Indirect ? ' // indirect' : ''}`
		),
	];
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
