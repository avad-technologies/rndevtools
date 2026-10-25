#!/usr/bin/env node
// Skill-vs-MCP discovery experiment.
//
// Question: when a developer asks a coding agent to do Simulator work, which
// integration makes the agent actually use RN Devtools instead of raw simctl?
//
// Design
//   conditions  none | skill | mcp | both       (what the agent is given)
//   agents      claude | codex                  (headless: `claude -p`, `codex exec`)
//   prompts     experiments/agent-discovery/prompts.json
//   isolation   each run gets a fresh fake HOME (and CODEX_HOME) holding exactly
//               the condition's files, so the operator's real configuration
//               never leaks in. Claude also runs with --strict-mcp-config and
//               --setting-sources user.
//   measurement adoption at the desktop socket (desktop-fixture.mjs logs every
//               request with attribution); Bash leakage from a PreToolUse hook
//               that allows everything but records every command. The
//               blocking simctl hook is deliberately NOT installed in any
//               condition: we are measuring discovery, not enforcement.
//
// Usage: node run.mjs --out results/<name> [--agents claude,codex]
//          [--conditions none,skill,mcp,both] [--prompts p1,p2] [--repeat N]
//          [--max-turns 12] [--timeout-s 360] [--dry-run]
import childProcess, { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isLeak } from './leak-rule.mjs';

const execFileAsync = promisify(execFile);

// The CLI reads a JSON command object from stdin whenever stdin is not a TTY and
// waits for EOF. Node gives children a pipe by default, so stdin is closed here
// explicitly; otherwise every CLI call from the harness hangs until its timeout.
function runCli(argv, { timeout = 30_000, env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cli, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => { clearTimeout(timer); reject(error); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else reject(Object.assign(new Error(`rndevtools ${argv[0]} exited ${code}`), { stdout, stderr }));
		});
	});
}
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..', '..');
const cli = path.join(desktop, 'build', 'native', 'mac-arm64', 'rndevtools');
// Every skill setup embeds: the lanes skill, and the local Supabase skill the
// database prompts exercise.
const skillsRoot = path.join(desktop, 'native', 'rndevtools-cli', 'internal', 'setup', 'skills');
const skillNames = ['rndevtools-lanes', 'rndevtools-supabase'];
let cachedAws;
const UDID = process.env.RNDEVTOOLS_EXPERIMENT_UDID ?? '727CE7B2-CCBA-47A5-8803-1D61DCEBCF44';

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out ?? path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
const agents = (args.agents ?? 'claude,codex').split(',');
const conditions = (args.conditions ?? 'none,skill,mcp,both').split(',');
const repeat = Number(args.repeat ?? 1);
const maxTurns = Number(args['max-turns'] ?? 12);
const runTimeoutMs = Number(args['timeout-s'] ?? 360) * 1000;
const prompts = JSON.parse(fs.readFileSync(path.join(here, 'prompts.json'), 'utf8')).filter((p) => !args.prompts || args.prompts.split(',').includes(p.id));
fs.mkdirSync(outDir, { recursive: true });

// A throwaway worktree the prompts refer to. It looks like an Expo app so the
// agent has something plausible to "run"; no dev client is installed, which is
// one of the recovery scenarios. Each run gets its own copy at a fresh path so a
// lane or claim one run leaves behind cannot shape the next run's behaviour.
let fixtureRepo = '';
async function createFixtureRepo(id) {
	const repo = path.join(outDir, 'fixtures', id, 'fixture-app');
	fs.mkdirSync(repo, { recursive: true });
	fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '0.0.1', main: 'index.js', scripts: { start: 'expo start' }, dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-native': '0.81.0' } }, null, 2));
	fs.writeFileSync(path.join(repo, 'app.json'), JSON.stringify({ expo: { name: 'Fixture', slug: 'fixture', scheme: 'fixture', ios: { bundleIdentifier: 'com.example.fixture' } } }, null, 2));
	fs.writeFileSync(path.join(repo, 'App.js'), "export default function App() { return null; }\n");
	fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture app\n\nA React Native (Expo) app used for experiments.\n');
	const git = (argv) => execFileAsync('git', ['-c', 'user.email=x@example.com', '-c', 'user.name=x', ...argv], { cwd: repo }).catch(() => {});
	await git(['init', '-q']);
	await git(['add', '-A']);
	await git(['commit', '-qm', 'fixture']);
	return repo;
}

const runs = [];
for (let iteration = 0; iteration < repeat; iteration++) {
	for (const prompt of prompts) {
		for (const condition of shuffle(conditions)) {
			for (const agent of agents) {
				runs.push({ iteration, prompt, condition, agent });
			}
		}
	}
}
console.log(`${runs.length} runs → ${outDir}`);
if (args['dry-run']) {
	for (const run of runs) console.log(`  ${run.agent} ${run.condition} ${run.prompt.id}`);
	process.exit(0);
}

// The desktop fixture (desktop-fixture.mjs) writes every socket request here.
const requestLog = process.env.RNDEVTOOLS_EXPERIMENT_REQUEST_LOG ?? '/tmp/exp-requests.jsonl';
if (!fs.existsSync(requestLog)) {
	console.error(`desktop fixture log ${requestLog} not found; start desktop-fixture.mjs first`);
	process.exit(1);
}
const results = [];
for (const [index, run] of runs.entries()) {
	const id = `${run.agent}-${run.condition}-${run.prompt.id}-${run.iteration}`;
	process.stdout.write(`[${index + 1}/${runs.length}] ${id} … `);
	fixtureRepo = await createFixtureRepo(id);
	const result = await executeRun(run, id);
	results.push(result);
	if (!(await fixtureAlive())) {
		console.log('\nFATAL: the desktop fixture is no longer answering; later runs would measure a dead socket. Stopping.');
		fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
		fs.writeFileSync(path.join(outDir, 'summary.md'), summarize(results));
		process.exit(2);
	}
	fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
	console.log(`${result.adopted ? 'ADOPTED' : 'no-adopt'} leak=${result.leakedCommands.length} tools=${result.rndevtoolsRequests.length} ${result.seconds}s${result.error ? ` ERROR=${result.error}` : ''}`);
	await resetSimulator();
}
fs.writeFileSync(path.join(outDir, 'summary.md'), summarize(results));
console.log(fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'));

async function executeRun(run, id) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `rnd-exp-${run.agent}-${run.condition}-`));
	const bashLog = path.join(outDir, `${id}.bash.jsonl`);
	fs.writeFileSync(bashLog, '');
	const sessionId = `exp-${id}`.slice(0, 120);
	const started = Date.now();
	const requestOffset = fs.existsSync(requestLog) ? fs.statSync(requestLog).size : 0;
	let transcript = '';
	let error;
	try {
		if (run.agent === 'claude') {
			transcript = await runClaude(run, home, bashLog, sessionId);
		} else {
			transcript = await runCodex(run, home, bashLog, sessionId);
		}
	} catch (failure) {
		error = String(failure?.message ?? failure).slice(0, 300);
		transcript = String(failure?.stdout ?? '') + String(failure?.stderr ?? '');
	}
	fs.writeFileSync(path.join(outDir, `${id}.transcript.txt`), transcript);
	const requests = readJsonl(requestLog, requestOffset).filter((entry) => entry.event === 'request');
	const viaMcp = requests.filter((entry) => String(entry.requestId).startsWith('mcp-')).length;
	const viaCli = requests.filter((entry) => String(entry.requestId).startsWith('cli-')).length;
	const bash = readJsonl(bashLog);
	const simctlCommands = bash.map((entry) => entry.command).filter(isLeak);
	const cliCommands = bash.map((entry) => entry.command).filter((command) => /\brndevtools\b/.test(command));
	fs.rmSync(home, { recursive: true, force: true });
	return {
		id, agent: run.agent, condition: run.condition, prompt: run.prompt.id, iteration: run.iteration,
		seconds: Math.round((Date.now() - started) / 1000),
		adopted: requests.length > 0,
		rndevtoolsRequests: requests.map((entry) => `${entry.kind}${entry.operation ? `:${entry.operation}` : ''}${entry.ok ? '' : `!${entry.code}`}`),
		viaMcp,
		viaCli,
		cliCommands,
		leakedCommands: simctlCommands,
		bashCommands: bash.length,
		error,
	};
}

// MARK: - Claude Code

async function runClaude(run, home, bashLog, sessionId) {
	const claudeDir = path.join(home, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });
	// Carry the operator's authentication (and only that) into the isolated
	// HOME: Claude here may run on Bedrock with a credential-export command.
	const operatorSettings = readJSON(path.join(os.homedir(), '.claude', 'settings.json'));
	const auth = {};
	for (const key of ['env', 'apiKeyHelper']) {
		if (operatorSettings[key] !== undefined) auth[key] = operatorSettings[key];
	}
	// A credential-export helper needs the operator's real HOME, so resolve it
	// here once and hand the agent plain AWS variables instead.
	const awsEnv = await resolveAwsCredentials(operatorSettings.awsCredentialExport);
	const settings = {
		...auth,
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${path.join(here, 'record-bash-hook.mjs')} ${bashLog}`, timeout: 10 }] }] },
		permissions: { allow: ['Bash', 'Read', 'Glob', 'Grep', 'mcp__rndevtools'] },
	};
	fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
	const operatorState = readJSON(path.join(os.homedir(), '.claude.json'));
	fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: {}, ...(operatorState.oauthAccount ? { oauthAccount: operatorState.oauthAccount } : {}), ...(operatorState.userID ? { userID: operatorState.userID } : {}) }, null, 2));
	if (run.condition === 'skill' || run.condition === 'both') {
		installSkill(path.join(claudeDir, 'skills'));
	}
	const mcpConfig = path.join(home, 'mcp.json');
	fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: run.condition === 'mcp' || run.condition === 'both' ? { rndevtools: { type: 'stdio', command: cli, args: ['mcp'] } } : {} }, null, 2));
	// The prompt goes first: --add-dir and --settings are variadic and would
	// otherwise swallow a trailing positional.
	const argv = ['-p', renderPrompt(run.prompt), '--output-format', 'json', '--max-turns', String(maxTurns), '--permission-mode', 'bypassPermissions', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', mcpConfig, '--settings', path.join(claudeDir, 'settings.json'), '--add-dir', fixtureRepo];
	if (process.env.RNDEVTOOLS_EXPERIMENT_MODEL) argv.push('--model', process.env.RNDEVTOOLS_EXPERIMENT_MODEL);
	return await spawnCapture(process.env.RNDEVTOOLS_EXPERIMENT_CLAUDE ?? resolveBinary('claude'), argv, { cwd: fixtureRepo, env: { ...cleanEnvironment(), ...awsEnv, HOME: home, CLAUDE_CODE_SESSION_ID: sessionId }, timeoutMs: runTimeoutMs });
}

async function resolveAwsCredentials(exportCommand, key = 'claude') {
	if (!exportCommand) return {};
	cachedAws ??= {};
	const cached = cachedAws[key];
	if (cached && cached.expires > Date.now() + 5 * 60 * 1000) return cached.env;
	const { stdout } = await execFileAsync('sh', ['-c', exportCommand], { maxBuffer: 1024 * 1024 });
	const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
	const parsed = JSON.parse(line);
	const credentials = parsed.Credentials ?? parsed;
	const env = { AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken };
	cachedAws[key] = { env, expires: credentials.Expiration ? Date.parse(credentials.Expiration) : Date.now() + 30 * 60 * 1000 };
	return env;
}

// MARK: - Codex

async function runCodex(run, home, bashLog, sessionId) {
	const codexHome = path.join(home, '.codex');
	fs.mkdirSync(codexHome, { recursive: true });
	// Codex has no PreToolUse hook; Bash leakage is read from its JSON event
	// stream instead (see spawnCapture's codex branch below).
	// Mirror only the operator's model/provider wiring (not their MCP servers,
	// skills, or projects). Credentials are resolved by the harness and passed
	// as AWS_* variables because the credential-export helper needs the real HOME.
	const operatorToml = fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')) ? fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8') : '';
	const provider = (operatorToml.match(/^model_provider\s*=\s*"([^"]+)"/m) ?? [])[1];
	const model = process.env.RNDEVTOOLS_EXPERIMENT_CODEX_MODEL ?? (operatorToml.match(/^model\s*=\s*"([^"]+)"/m) ?? [])[1];
	const region = (operatorToml.match(/region\s*=\s*"([^"]+)"/m) ?? [])[1];
	const exportBlock = operatorToml.match(/\[model_providers\.[^.\]]+\.aws\.credential_export\]\ncommand = "([^"]+)"\nargs = \[([^\]]*)\]/);
	let config = `model_reasoning_effort = "medium"\nforced_login_method = "api"\ncheck_for_update_on_startup = false\n`;
	if (provider) config += `model_provider = ${JSON.stringify(provider)}\n`;
	if (model) config += `model = ${JSON.stringify(model)}\n`;
	config += `\n[skills]\nmax_context_tokens = 10000\n\n[shell_environment_policy]\ninherit = "all"\n\n[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n\n`;
	if (provider && region) config += `[model_providers.${provider}.aws]\nregion = ${JSON.stringify(region)}\n\n`;
	const codexAws = exportBlock ? await resolveAwsCredentials(`${JSON.stringify(exportBlock[1])} ${exportBlock[2].split(',').map((part) => part.trim().replace(/^"|"$/g, '')).join(' ')}`, 'codex') : {};
	if (run.condition === 'mcp' || run.condition === 'both') {
		config += `[mcp_servers.rndevtools]\ncommand = ${JSON.stringify(cli)}\nargs = ["mcp"]\n`;
	}
	fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
	// Share the operator's login so headless runs are authenticated, but never
	// their configuration.
	for (const name of ['auth.json']) {
		const source = path.join(os.homedir(), '.codex', name);
		if (fs.existsSync(source)) fs.copyFileSync(source, path.join(codexHome, name));
	}
	if (run.condition === 'skill' || run.condition === 'both') {
		installSkill(path.join(home, '.agents', 'skills'));
	}
	const argv = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', fixtureRepo, renderPrompt(run.prompt)];
	if (process.env.RNDEVTOOLS_EXPERIMENT_CODEX_MODEL) argv.splice(1, 0, '-m', process.env.RNDEVTOOLS_EXPERIMENT_CODEX_MODEL);
	let output;
	try {
		output = await spawnCapture(process.env.RNDEVTOOLS_EXPERIMENT_CODEX ?? resolveBinary('codex'), argv, { cwd: fixtureRepo, env: { ...cleanEnvironment(), ...codexAws, ...(region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {}), HOME: home, CODEX_HOME: codexHome, CODEX_THREAD_ID: sessionId }, timeoutMs: runTimeoutMs });
	} catch (failure) {
		// A timed-out or failed run still has an event stream worth scoring;
		// extract its commands before rethrowing so leakage is never undercounted.
		recordCodexCommands(String(failure?.stdout ?? ''), bashLog);
		throw failure;
	}
	recordCodexCommands(output, bashLog);
	return output;
}

// Extract shell commands from Codex's event stream into the bash log so
// scoring is uniform across agents.
function recordCodexCommands(output, bashLog) {
	const seenItems = new Set();
	for (const line of output.split('\n')) {
		try {
			const event = JSON.parse(line);
			const item = event.item ?? event.msg ?? event;
			const command = item?.command ?? item?.parsed_cmd?.map?.((c) => c.cmd).join(' ') ?? null;
			const type = item?.type ?? event.type ?? '';
			// Codex emits item.started and item.completed for the same command; count it once.
			const itemId = item?.id ?? `${type}:${command}`;
			if (command && /command|exec|shell/i.test(type) && !seenItems.has(itemId)) {
				seenItems.add(itemId);
				fs.appendFileSync(bashLog, `${JSON.stringify({ command: Array.isArray(command) ? command.join(' ') : String(command) })}\n`);
			}
		} catch { /* not JSON */ }
	}
}

// MARK: - Helpers

function installSkill(skillsDirectory) {
	for (const name of skillNames) {
		const target = path.join(skillsDirectory, name);
		fs.mkdirSync(target, { recursive: true });
		fs.copyFileSync(path.join(skillsRoot, name, 'SKILL.md'), path.join(target, 'SKILL.md'));
	}
}

function renderPrompt(prompt) {
	return prompt.text.replaceAll('{UDID}', UDID).replaceAll('{WORKTREE}', fixtureRepo);
}

function cleanEnvironment() {
	// Keep PATH (with ~/.local/bin so `rndevtools` resolves when the agent is told about it by the skill) and auth.
	const keep = ['PATH', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'OPENAI_API_KEY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
	const env = {};
	for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
	env.PATH = `${path.join(os.homedir(), '.local', 'bin')}:${env.PATH ?? '/usr/bin:/bin'}`;
	return env;
}

function spawnCapture(command, argv, { cwd, env, timeoutMs }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => { clearTimeout(timer); reject(Object.assign(error, { stdout, stderr })); });
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			const output = `${stdout}\n--- stderr ---\n${stderr}`;
			if (signal) reject(Object.assign(new Error(`killed by ${signal} after ${timeoutMs}ms`), { stdout: output }));
			else if (code !== 0) reject(Object.assign(new Error(`exit ${code}`), { stdout: output }));
			else resolve(output);
		});
	});
}

async function resetSimulator() {
	// Return to the home screen and stop any lane the run started, so runs do not
	// inherit each other's state. Both go through the CLI, which only works if the
	// fixture is up; failures here are logged, not fatal.
	try {
		const { stdout } = await runCli(['lane', '--operation', 'ls'], { timeout: 20_000 });
		const lanes = JSON.parse(stdout).result?.lanes ?? [];
		for (const lane of lanes) {
			await runCli(['lane', '--operation', 'down', '--lane-id', lane.id], { timeout: 60_000 }).catch(() => {});
			if (lane.port) await killListener(lane.port);
		}
		await runCli(['input', '--udid', UDID, '--kind', 'button', '--button', 'home'], { timeout: 20_000 }).catch(() => {});
		await runCli(['release', '--udid', UDID], { timeout: 20_000, env: { ...process.env, RNDEVTOOLS_AGENT_SESSION_ID: 'harness' } }).catch(() => {});
	} catch { /* fixture not running or nothing to reset */ }
	for (const port of [8081, 8082, 8083, 8084, 8085, 8100, 8101, 8102, 8103]) {
		await killListener(port);
	}
}

// Kill only the process LISTENING on the port. A bare `lsof -ti tcp:PORT` also
// returns every process with a client connection to it, which once included the
// desktop fixture polling Metro's /status, and took the whole experiment down.
async function killListener(port) {
	await execFileAsync('sh', ['-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill 2>/dev/null; true`]).catch(() => {});
}

// The operator's shell may resolve a different build than a bare PATH lookup
// from Node (toolbox shims); prefer the one `which` finds in a login shell.
function resolveBinary(name) {
	// Toolbox shims need the operator's HOME, which the isolated run does not
	// have; use the newest real binary under the toolbox tools directory.
	const toolboxTool = { claude: 'claude-code', codex: 'codex' }[name];
	const toolDirectory = toolboxTool && path.join(os.homedir(), '.toolbox', 'tools', toolboxTool);
	if (toolDirectory && fs.existsSync(toolDirectory)) {
		const versions = fs.readdirSync(toolDirectory).filter((entry) => /^\d/.test(entry)).sort(compareVersions);
		for (const version of versions.reverse()) {
			for (const candidate of [path.join(toolDirectory, version, name), path.join(toolDirectory, version, 'bin', name)]) {
				if (fs.existsSync(candidate)) return candidate;
			}
		}
	}
	try {
		return execFileSyncText('/bin/zsh', ['-lc', `command -v ${name}`]).trim() || name;
	} catch { return name; }
}

function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const delta = (left[i] ?? 0) - (right[i] ?? 0);
		if (delta) return delta;
	}
	return 0;
}

function execFileSyncText(command, argv) {
	return childProcess.execFileSync(command, argv, { encoding: 'utf8' });
}

async function fixtureAlive() {
	try {
		const { stdout } = await runCli(['doctor'], { timeout: 15_000 });
		return JSON.parse(stdout).ok === true;
	} catch { return false; }
}

function readJSON(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function readJsonl(file, offset = 0) {
	if (!fs.existsSync(file)) return [];
	const content = fs.readFileSync(file, 'utf8').slice(offset);
	return content.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function shuffle(values) {
	const copy = [...values];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) { parsed[key] = next; i++; } else parsed[key] = true;
	}
	return parsed;
}

function summarize(results) {
	const groups = new Map();
	for (const result of results) {
		const key = `${result.agent}|${result.condition}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(result);
	}
	const rows = [...groups.entries()].sort().map(([key, items]) => {
		const [agent, condition] = key.split('|');
		const adopted = items.filter((item) => item.adopted).length;
		const leaked = items.filter((item) => item.leakedCommands.length > 0).length;
		const errors = items.filter((item) => item.error).length;
		const tools = items.reduce((sum, item) => sum + item.rndevtoolsRequests.length, 0);
		const mcp = items.reduce((sum, item) => sum + (item.viaMcp ?? 0), 0);
		const cliCalls = items.reduce((sum, item) => sum + (item.viaCli ?? 0), 0);
		const seconds = Math.round(items.reduce((sum, item) => sum + item.seconds, 0) / items.length);
		return `| ${agent} | ${condition} | ${items.length} | ${adopted} (${pct(adopted, items.length)}) | ${leaked} (${pct(leaked, items.length)}) | ${tools} (mcp ${mcp}, cli ${cliCalls}) | ${seconds}s | ${errors} |`;
	});
	const perPrompt = prompts.map((prompt) => {
		const cells = conditions.flatMap((condition) => agents.map((agent) => {
			const items = results.filter((r) => r.prompt === prompt.id && r.condition === condition && r.agent === agent);
			if (!items.length) return '–';
			return `${items.filter((i) => i.adopted).length}/${items.length}${items.some((i) => i.leakedCommands.length) ? ' ⚠' : ''}`;
		}));
		return `| ${prompt.id} | ${cells.join(' | ')} |`;
	});
	const header = conditions.flatMap((condition) => agents.map((agent) => `${agent}/${condition}`));
	return [
		'# Skill vs MCP discovery experiment', '',
		`Runs: ${results.length}. UDID ${UDID}. Adopted = at least one request reached the RN Devtools socket. Leaked = at least one mutating simctl / hand-started Metro command in Bash.`, '',
		'| agent | condition | runs | adopted | leaked | rndevtools calls | mean time | errors |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
		'## Per prompt (adopted/runs, ⚠ = leaked)', '',
		`| prompt | ${header.join(' | ')} |`, `| --- | ${header.map(() => '---').join(' | ')} |`, ...perPrompt, '',
	].join('\n');
}

function pct(part, whole) {
	return whole ? `${Math.round((100 * part) / whole)}%` : '–';
}
