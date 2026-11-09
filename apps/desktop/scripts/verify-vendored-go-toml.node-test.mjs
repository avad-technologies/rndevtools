import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyVendoredGoToml } from './verify-vendored-go-toml.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const sourceCli = path.join(desktopDirectory, 'native', 'rndevtools-cli');
const goToml = 'vendor/github.com/pelletier/go-toml/v2';
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

test('accepts only the anchored go-toml v2.4.3 tree', () => {
	assert.deepEqual(verifyVendoredGoToml(sourceCli), {
		module: 'github.com/pelletier/go-toml/v2',
		version: 'v2.4.3',
		vendoredSourceManifestSha256:
			'872699e4c0171d7b15f4ca859be4f26c2981a8941a204b8f1b17947717ccd44f',
		files: 37,
	});
});

test('rejects source tampering even when the checksum manifest is unchanged', () => {
	const cli = copyCli();
	append(path.join(cli, goToml, 'decode.go'), '\n// tampered\n');
	assert.throws(
		() => verifyVendoredGoToml(cli),
		/^Error: Vendored go-toml source checksum mismatch: vendor\/github\.com\/pelletier\/go-toml\/v2\/decode\.go$/
	);
});

test('rejects coordinated source and editable checksum-manifest tampering', () => {
	const cli = copyCli();
	append(path.join(cli, goToml, 'decode.go'), '\n// tampered\n');
	rehash(cli, `${goToml}/decode.go`);
	assert.throws(
		() => verifyVendoredGoToml(cli),
		/checksum manifest is not the reviewed v2\.4\.3 manifest/
	);
});

test('rejects vendor/modules.txt tampering with or without a regenerated manifest', () => {
	for (const regenerated of [false, true]) {
		const cli = copyCli();
		// Since Go 1.23, vendor mode imports only the packages modules.txt lists.
		append(
			path.join(cli, 'vendor/modules.txt'),
			'github.com/pelletier/go-toml/v2/internal/extra\n'
		);
		if (regenerated) rehash(cli, 'vendor/modules.txt');
		assert.throws(
			() => verifyVendoredGoToml(cli),
			regenerated
				? /checksum manifest is not the reviewed v2\.4\.3 manifest/
				: /Vendored go-toml source checksum mismatch: vendor\/modules\.txt$/
		);
	}
});

test('rejects an unlisted vendored file and a symbolic link', () => {
	const added = copyCli();
	// Go compiles every non-test file in a vendored package directory.
	writeFileSync(
		path.join(added, goToml, 'zz_init.go'),
		'package toml\n\nfunc init() {}\n'
	);
	assert.throws(
		() => verifyVendoredGoToml(added),
		/Vendored go-toml file coverage drifted/
	);

	const linked = copyCli();
	symlinkSync('decode.go', path.join(linked, goToml, 'decode_link.go'));
	assert.throws(
		() => verifyVendoredGoToml(linked),
		/^Error: Vendored go-toml source contains a symbolic link: .*\/decode_link\.go$/
	);
});

test('rejects go.mod and go.sum drift outside the vendored tree', () => {
	const replaced = copyCli();
	append(
		path.join(replaced, 'go.mod'),
		'\nreplace github.com/pelletier/go-toml/v2 => ./fork\n'
	);
	assert.throws(
		() => verifyVendoredGoToml(replaced),
		/go\.mod must contain only the pinned go-toml v2\.4\.3 dependency/
	);

	const resummed = copyCli();
	const sums = path.join(resummed, 'go.sum');
	writeFileSync(
		sums,
		readFileSync(sums, 'utf8').replace(
			/h1:GTRvJQut[A-Za-z0-9+/]+=/,
			`h1:${'A'.repeat(43)}=`
		)
	);
	assert.throws(
		() => verifyVendoredGoToml(resummed),
		/go\.sum must record only the pinned go-toml v2\.4\.3 checksums/
	);
});

test('the native check and build scripts refuse a tampered tree before starting any tool', () => {
	const desktop = copyDesktopGate();
	append(
		path.join(desktop, 'native', 'rndevtools-cli', goToml, 'decode.go'),
		'\n// tampered\n'
	);
	// With an empty PATH, go, gofmt, govulncheck, git and swift cannot start
	// even if a gate stops verifying first.
	const emptyPath = temporaryDirectory('rndevtools-empty-path-');
	for (const command of [
		['scripts/check-native-helpers.mjs', '--go'],
		['scripts/build-native-helpers.mjs'],
	]) {
		const result = spawnSync(process.execPath, command, {
			cwd: desktop,
			encoding: 'utf8',
			env: { PATH: emptyPath },
		});
		assert.equal(result.status, 1, command[0]);
		assert.match(
			result.stderr,
			/Vendored go-toml source checksum mismatch: vendor\/github\.com\/pelletier\/go-toml\/v2\/decode\.go/,
			command[0]
		);
	}
});

function copyCli() {
	const cli = path.join(
		temporaryDirectory('rndevtools-vendored-go-toml-'),
		'rndevtools-cli'
	);
	cpSync(sourceCli, cli, { recursive: true });
	return cli;
}

/** The inputs both gates read before they start a toolchain. */
function copyDesktopGate() {
	const desktop = path.join(
		temporaryDirectory('rndevtools-go-toml-gate-'),
		'desktop'
	);
	for (const entry of [
		'package.json',
		'scripts',
		'native/rndevtools-sim-helper',
		'native/rndevtools-cli',
		'native/rndevtools-native-host/Sources/RNDevtoolsNativeHost/HelperVersion.swift',
	]) {
		cpSync(path.join(desktopDirectory, entry), path.join(desktop, entry), {
			recursive: true,
		});
	}
	return desktop;
}

function temporaryDirectory(prefix) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function append(filePath, text) {
	writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${text}`);
}

/** Rewrites one entry of the editable manifest to match the edited file. */
function rehash(cli, relativePath) {
	const manifest = path.join(cli, 'VENDORED_SOURCE_SHA256SUMS');
	const digest = createHash('sha256')
		.update(readFileSync(path.join(cli, relativePath)))
		.digest('hex');
	const before = readFileSync(manifest, 'utf8');
	const after = before.replace(
		new RegExp(`^[a-f0-9]{64}(  ${relativePath.replaceAll('.', '\\.')})$`, 'm'),
		`${digest}$1`
	);
	assert.notEqual(after, before, `no manifest entry for ${relativePath}`);
	writeFileSync(manifest, after);
}
