import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureUsers = new Set([
	'example',
	'example%20user',
	'dev',
	'developer',
	'me',
	'another',
	'runner',
	'user',
]);

function exampleHost(hostname) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		host === 'localhost' ||
		host === '::1' ||
		/^127(?:\.\d{1,3}){3}$/.test(host) ||
		/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(host) ||
		[
			'example.com',
			'example.org',
			'example.net',
			'example',
			'test',
			'invalid',
		].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
	);
}

function realCredentialUrl(value) {
	try {
		const url = new URL(value);
		if (!/^[a-z0-9.:[\]-]+$/i.test(url.hostname)) return false;
		return Boolean(url.username && url.password && !exampleHost(url.hostname));
	} catch {
		return false;
	}
}

function signedJwt(value) {
	const [header, payload, signature] = value.split('.');
	if (/example|placeholder|redacted|^x+$/i.test(signature)) return false;
	try {
		const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
		const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		return (
			typeof h.alg === 'string' &&
			h.alg !== 'none' &&
			p !== null &&
			typeof p === 'object' &&
			!Array.isArray(p) &&
			signature.length >= 32
		);
	} catch {
		return false;
	}
}

const rules = [
	{
		code: 'private-key',
		pattern:
			/-----BEGIN ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]{64,})-----END \1-----/g,
	},
	{
		code: 'provider-token',
		pattern:
			/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{30,}|sk_live_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{20,})\b/g,
	},
	{
		code: 'cloud-access-key',
		pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	},
	{
		code: 'credential-url',
		pattern:
			/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:'"`<>]+:[^\s/@'"`<>]+@[^\s'"`<>]+/gi,
		accept: realCredentialUrl,
	},
	{
		code: 'signed-jwt',
		pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}\b/g,
		accept: signedJwt,
	},
	{
		code: 'personal-home-path',
		pattern:
			/(?:(?<![\w/-])|(?<=file:\/\/))(?:\/Users\/|\/home\/)([^/\s'"`<>]+)/g,
		accept: (_value, match) =>
			!match[1].startsWith('${') && !fixtureUsers.has(match[1].split('\\')[0]),
	},
	{
		code: 'personal-home-path',
		pattern: /\b[A-Za-z]:\\Users\\([^\\\s'"`<>]+)/g,
		accept: (_value, match) => !fixtureUsers.has(match[1]),
	},
	{
		code: 'internal-host',
		pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi,
		accept: (value) => {
			try {
				return /\.(?:corp|internal|localdomain)$/i.test(
					new URL(value).hostname,
				);
			} catch {
				return false;
			}
		},
	},
];

/** Findings contain locations and rule names; matched credentials are never returned. */
export function scanPublicContent(files, options = {}) {
	const findings = [];
	const denyTerms = options.denyTerms ?? [];
	for (const { path: filePath, content } of files) {
		for (const { code, pattern, accept } of rules) {
			for (const match of content.matchAll(pattern)) {
				if (accept && !accept(match[0], match)) continue;
				findings.push({
					path: filePath,
					line: content.slice(0, match.index).split('\n').length,
					code,
				});
			}
		}
		for (const term of denyTerms) {
			if (typeof term !== 'string' || term.length === 0) continue;
			const foldedContent = content.toLowerCase();
			const foldedTerm = term.toLowerCase();
			let offset = foldedContent.indexOf(foldedTerm);
			while (offset >= 0) {
				findings.push({
					path: filePath,
					line: content.slice(0, offset).split('\n').length,
					code: 'private-term',
				});
				offset = foldedContent.indexOf(foldedTerm, offset + term.length);
			}
		}
	}
	return findings;
}

export async function checkRepository(root, options = {}) {
	const names = execFileSync(
		'git',
		['ls-files', '-co', '--exclude-standard', '-z'],
		{
			cwd: root,
			encoding: 'utf8',
		},
	)
		.split('\0')
		.filter(Boolean);
	const files = [];
	for (const name of [...new Set(names)].sort()) {
		const absolute = path.join(root, name);
		try {
			const stat = await lstat(absolute);
			if (!stat.isFile()) continue;
			const bytes = await readFile(absolute);
			files.push({ path: name, content: bytes.toString('utf8') });
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	return {
		checkedFiles: files.length,
		findings: scanPublicContent(files, options),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const denyTerms = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] !== '--deny-term' || !args[i + 1]) {
			throw new Error(
				'Usage: node scripts/check-public-content.mjs [--deny-term TERM]',
			);
		}
		denyTerms.push(args[++i]);
	}
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const result = await checkRepository(root, { denyTerms });
	for (const finding of result.findings) {
		console.error(`${finding.path}:${finding.line}: ${finding.code}`);
	}
	if (result.findings.length > 0) {
		console.error(
			`Public-content check failed: ${result.findings.length} finding(s); matched values omitted.`,
		);
		process.exitCode = 1;
	} else {
		console.log(`Public-content check passed (${result.checkedFiles} files).`);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
