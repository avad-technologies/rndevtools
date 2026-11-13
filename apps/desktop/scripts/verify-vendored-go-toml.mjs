import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	collectRegularFiles,
	parseChecksumManifest,
	relativeFromHelper,
	sha256,
} from './verify-vendored-simslim.mjs';

// The agent CLI builds with -mod=vendor, and in vendor mode Go never checks the
// vendored bytes against go.sum. These anchors bind the compiled go-toml source
// to the reviewed v2.4.3 snapshot; see the CLI's PROVENANCE.md.
const GO_TOML_MODULE = 'github.com/pelletier/go-toml/v2';
const GO_TOML_VERSION = 'v2.4.3';
const GO_TOML_VENDORED_MANIFEST_SHA256 =
	'872699e4c0171d7b15f4ca859be4f26c2981a8941a204b8f1b17947717ccd44f';

const EXPECTED_MODULE_FILE = `module github.com/adalloul0928/rndevtools-cli

go 1.27.0

require github.com/pelletier/go-toml/v2 v2.4.3
`;
const EXPECTED_MODULE_SUMS = `github.com/pelletier/go-toml/v2 v2.4.3 h1:GTRvJQutkOSftxIFD5xw9aepkYNuPWmVJpffdDPYVpY=
github.com/pelletier/go-toml/v2 v2.4.3/go.mod h1:2gIqNv+qfxSVS7cM2xJQKtLSTLUE9V8t9Stt+h56mCY=
`;
const EXPECTED_VENDOR_MODULES = `# github.com/pelletier/go-toml/v2 v2.4.3
## explicit; go 1.21.0
github.com/pelletier/go-toml/v2
github.com/pelletier/go-toml/v2/internal/parserbridge
github.com/pelletier/go-toml/v2/internal/tracker
github.com/pelletier/go-toml/v2/unstable
`;

export function verifyVendoredGoToml(cliDirectory) {
	const resolvedCli = resolve(cliDirectory);
	const checksumBytes = readFileSync(
		resolve(resolvedCli, 'VENDORED_SOURCE_SHA256SUMS')
	);
	const manifestDigest = sha256(checksumBytes);
	if (manifestDigest !== GO_TOML_VENDORED_MANIFEST_SHA256) {
		throw new Error(
			`Vendored go-toml checksum manifest is not the reviewed ${GO_TOML_VERSION} manifest.`
		);
	}
	const expected = parseChecksumManifest(
		checksumBytes.toString('utf8'),
		/^([a-f0-9]{64}) {2}(vendor\/[A-Za-z0-9_./-]+)$/,
		'vendored go-toml'
	);

	// Exact coverage also rejects an added file, which Go would compile into the
	// package, so every manifest path below is a regular file inside vendor/.
	const actualFiles = collectRegularFiles(
		resolve(resolvedCli, 'vendor'),
		'go-toml'
	)
		.map((filePath) => relativeFromHelper(resolvedCli, filePath, 'go-toml'))
		.sort();
	const expectedFiles = [...expected.keys()].sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error(
			`Vendored go-toml file coverage drifted.\nExpected:\n${expectedFiles.join('\n')}\nActual:\n${actualFiles.join('\n')}`
		);
	}
	for (const [relativePath, digest] of expected) {
		if (sha256(readFileSync(resolve(resolvedCli, relativePath))) !== digest) {
			throw new Error(
				`Vendored go-toml source checksum mismatch: ${relativePath}`
			);
		}
	}

	if (
		readFileSync(resolve(resolvedCli, 'go.mod'), 'utf8') !==
		EXPECTED_MODULE_FILE
	) {
		throw new Error(
			`Agent CLI go.mod must contain only the pinned go-toml ${GO_TOML_VERSION} dependency.`
		);
	}
	if (
		readFileSync(resolve(resolvedCli, 'go.sum'), 'utf8') !==
		EXPECTED_MODULE_SUMS
	) {
		throw new Error(
			`Agent CLI go.sum must record only the pinned go-toml ${GO_TOML_VERSION} checksums.`
		);
	}
	if (
		readFileSync(resolve(resolvedCli, 'vendor', 'modules.txt'), 'utf8') !==
		EXPECTED_VENDOR_MODULES
	) {
		throw new Error(
			'Vendored go-toml module metadata does not match the pinned module graph.'
		);
	}

	return {
		module: GO_TOML_MODULE,
		version: GO_TOML_VERSION,
		vendoredSourceManifestSha256: manifestDigest,
		files: expectedFiles.length,
	};
}
