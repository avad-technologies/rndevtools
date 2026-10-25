/**
 * electron-vite bundles every runtime dependency into dist, and the package
 * allowlist excludes node_modules. Mark dependency handling complete so
 * electron-builder does not traverse the entire monorepo dependency graph.
 */

const { readFileSync } = require('node:fs');
const path = require('node:path');

module.exports = async function beforeBuild(context) {
	let notices;
	try {
		notices = readFileSync(
			path.join(context.appDir, 'dist', 'THIRD_PARTY_LICENSES.txt'),
			'utf8'
		);
	} catch {
		throw new Error(
			'Bundled license notices are missing. Run pnpm build first.'
		);
	}
	if (!notices.startsWith('RN Devtools — bundled third-party licenses\n')) {
		throw new Error(
			'Bundled license notices are invalid. Run pnpm build first.'
		);
	}
	return false;
};
