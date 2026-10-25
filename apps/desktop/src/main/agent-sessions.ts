import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
	type AgentSession,
	agentSessionSchema,
	CODEX_ACTIVE_WINDOW_MS,
} from '../shared/agent-protocol';

/**
 * Finds live coding-agent sessions from the agents' own local state. Nothing
 * is installed into the agents; this reads what they already write.
 *
 * Claude Code keeps one JSON file per session under `~/.claude/sessions`,
 * including the PID. Files outlive their process, so only a live PID counts.
 *
 * Codex keeps threads in a SQLite database (`~/.codex/state_N.sqlite`). Its
 * desktop threads share one app-server process, so there is no PID to check;
 * a thread updated in the last 30 minutes is treated as live. The database is
 * opened read-only through `node:sqlite`, which Electron's Node provides; if
 * it does not, Codex discovery reports unavailable rather than failing.
 */

export type SessionDiscoveryResult = {
	sessions: AgentSession[];
	claude: 'ok' | 'unavailable';
	codex: 'ok' | 'unavailable';
	error?: string;
};

export type SessionDiscoveryOptions = {
	homeDirectory?: string;
	codexHome?: string;
	isProcessRunning?: (pid: number) => boolean;
	now?: () => number;
	/** Injected in tests; defaults to `node:sqlite` when present. */
	openCodexDatabase?: (file: string) => CodexDatabase | undefined;
};

type CodexThreadRow = {
	id: string;
	cwd: string | null;
	title: string | null;
	name: string | null;
	created_at_ms: number | null;
	updated_at_ms: number | null;
};

export type CodexDatabase = {
	threads: (since: number) => CodexThreadRow[];
	close: () => void;
};

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function finiteMs(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

async function claudeSessions(
	homeDirectory: string,
	isProcessRunning: (pid: number) => boolean
): Promise<{ sessions: AgentSession[]; available: boolean }> {
	const directory = path.join(homeDirectory, '.claude', 'sessions');
	let files: string[];
	try {
		files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
	} catch {
		return { sessions: [], available: false };
	}
	const sessions: AgentSession[] = [];
	for (const file of files.slice(0, 500)) {
		try {
			const raw = await readFile(path.join(directory, file), 'utf8');
			if (raw.length > 64 * 1024) continue;
			const entry = JSON.parse(raw) as Record<string, unknown>;
			const pid = finiteMs(entry.pid);
			if (
				typeof entry.sessionId !== 'string' ||
				pid === undefined ||
				!Number.isInteger(pid) ||
				!isProcessRunning(pid)
			) {
				continue;
			}
			const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
			const parsed = agentSessionSchema.safeParse({
				kind: 'claude',
				sessionId: entry.sessionId,
				title:
					(typeof entry.name === 'string' && entry.name) ||
					(cwd ? path.basename(cwd) : entry.sessionId.slice(0, 8)),
				...(cwd ? { cwd } : {}),
				...(typeof entry.status === 'string' ? { status: entry.status } : {}),
				pid,
				...(finiteMs(entry.startedAt) !== undefined
					? { startedAt: finiteMs(entry.startedAt) }
					: {}),
				...(finiteMs(entry.updatedAt) !== undefined
					? { updatedAt: finiteMs(entry.updatedAt) }
					: {}),
			});
			if (parsed.success) sessions.push(parsed.data);
		} catch {
			// A registry file being rewritten is skipped until the next poll.
		}
	}
	return { sessions, available: true };
}

function defaultOpenCodexDatabase(file: string): CodexDatabase | undefined {
	let sqlite: {
		DatabaseSync: new (
			file: string,
			options: { readOnly: boolean }
		) => {
			prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
			close: () => void;
		};
	};
	try {
		// Not every Node has node:sqlite; resolve at call time and degrade.
		// `process.execPath` is a valid anchor for createRequire in both the CJS
		// main bundle and ESM harnesses, unlike `__filename`.
		sqlite = createRequire(process.execPath)('node:sqlite');
	} catch {
		return undefined;
	}
	const database = new sqlite.DatabaseSync(file, { readOnly: true });
	return {
		threads: (since) =>
			database
				.prepare(
					`SELECT id, cwd, title, name, created_at_ms, updated_at_ms
					   FROM threads
					  WHERE archived = 0 AND updated_at_ms >= ?
					  ORDER BY updated_at_ms DESC
					  LIMIT 50`
				)
				.all(since) as CodexThreadRow[],
		close: () => database.close(),
	};
}

async function codexSessions(
	codexHome: string,
	now: number,
	open: (file: string) => CodexDatabase | undefined
): Promise<{ sessions: AgentSession[]; available: boolean }> {
	let databases: string[];
	try {
		databases = (await readdir(codexHome))
			.filter((file) => /^state_\d+\.sqlite$/.test(file))
			.sort(
				(left, right) =>
					Number(right.match(/\d+/)?.[0] ?? 0) -
					Number(left.match(/\d+/)?.[0] ?? 0)
			);
	} catch {
		return { sessions: [], available: false };
	}
	const newest = databases[0];
	if (!newest) return { sessions: [], available: false };
	let database: CodexDatabase | undefined;
	try {
		database = open(path.join(codexHome, newest));
		if (!database) return { sessions: [], available: false };
		const sessions: AgentSession[] = [];
		for (const row of database.threads(now - CODEX_ACTIVE_WINDOW_MS)) {
			const parsed = agentSessionSchema.safeParse({
				kind: 'codex',
				sessionId: row.id,
				title:
					row.name ||
					row.title ||
					(row.cwd ? path.basename(row.cwd) : row.id.slice(0, 8)),
				...(row.cwd ? { cwd: row.cwd } : {}),
				status: 'recent',
				...(finiteMs(row.created_at_ms) !== undefined
					? { startedAt: finiteMs(row.created_at_ms) }
					: {}),
				...(finiteMs(row.updated_at_ms) !== undefined
					? { updatedAt: finiteMs(row.updated_at_ms) }
					: {}),
			});
			if (parsed.success) sessions.push(parsed.data);
		}
		return { sessions, available: true };
	} catch {
		return { sessions: [], available: false };
	} finally {
		database?.close();
	}
}

export async function discoverAgentSessions({
	homeDirectory = os.homedir(),
	codexHome = process.env.CODEX_HOME || path.join(homeDirectory, '.codex'),
	isProcessRunning = processAlive,
	now = Date.now,
	openCodexDatabase = defaultOpenCodexDatabase,
}: SessionDiscoveryOptions = {}): Promise<SessionDiscoveryResult> {
	const [claude, codex] = await Promise.all([
		claudeSessions(homeDirectory, isProcessRunning),
		codexSessions(codexHome, now(), openCodexDatabase),
	]);
	return {
		sessions: [...claude.sessions, ...codex.sessions],
		claude: claude.available ? 'ok' : 'unavailable',
		codex: codex.available ? 'ok' : 'unavailable',
	};
}
