/**
 * What the desktop's children must not inherit from the agent session the
 * desktop itself may have been started from (`pnpm dev` in an agent's shell,
 * say). An agent harness exports its variables into every process it starts,
 * and the desktop would hand them on to each lane's Metro, and through it to
 * app.config.js, the Babel workers and whatever Metro spawns, to the native
 * plan's Node, which evaluates app.config.js too, and to the rndevtools CLI
 * the desktop runs for agent setup and its checks. They carry that session's
 * identity, which the rndevtools CLI reads to act as that session, and its
 * control channels and their tokens. That session is whichever one launched
 * the desktop, never a lane's own agent nor the operator, and none of it is
 * the app's.
 */

/**
 * The exact names an agent session is identified or reached by: the generic
 * AI_AGENT marker, Claude Code's (the Claude Agent SDK runs Claude Code),
 * Codex's, and the rndevtools CLI's own session override. A failure handoff
 * strips these from the agent CLI it opens, too.
 */
export const AGENT_SESSION_ENV_NAMES: readonly string[] = Object.freeze([
	'AI_AGENT',
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_MESSAGING_SOCKET',
	'CLAUDE_CODE_MESSAGING_TOKEN',
	'CLAUDE_PID',
	'DEBUG_CLAUDE_AGENT_SDK',
	'CODEX_THREAD_ID',
	'RNDEVTOOLS_AGENT_SESSION_ID',
]);

/**
 * The namespaces Claude Code, the Claude Agent SDK and Codex keep their
 * variables in: session state, sandbox switches, settings, credentials and
 * configuration directories, none of which a lane's Metro or the native plan
 * needs. A prefix matches only at the start of a name, case-sensitively, so
 * ordinary variables such as DEBUG, HOME or AWS_PROFILE pass, and so do
 * provider credentials such as OPENAI_API_KEY, which may serve the app.
 */
const AGENT_HARNESS_ENV_PREFIXES: readonly string[] = Object.freeze([
	'CLAUDE_',
	'CODEX_',
]);

/** Whether `name` is an agent harness's variable that no child inherits. */
export function isAgentHarnessVariable(name: string): boolean {
	return (
		AGENT_SESSION_ENV_NAMES.includes(name) ||
		AGENT_HARNESS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
	);
}

/**
 * The desktop's own list of more variables its children must not inherit,
 * for a harness the lists above do not know: comma-separated exact names and
 * NAME_PREFIX* patterns, such as `EXAMPLE_AGENT_*,EXAMPLE_TOKEN`.
 */
const CHILD_ENV_STRIP = 'RNDEVTOOLS_CHILD_ENV_STRIP';
const MAX_CHILD_ENV_STRIP_LENGTH = 4_096;
const MAX_CHILD_ENV_STRIP_ENTRIES = 64;
/** A variable name, or a name prefix followed by one `*`. */
const CHILD_ENV_STRIP_ENTRY = /^([A-Za-z_][A-Za-z0-9_]{0,127})(\*?)$/;

/**
 * The desktop's RNDEVTOOLS_CHILD_ENV_STRIP read as exact names and prefixes,
 * or why it cannot be: over its bounds, or with an entry that is neither a
 * name nor a pattern. The reason names an entry by its place between the
 * commas, empty places counted, and never echoes it.
 */
function readChildEnvironmentStrip(
	desktopEnvironment: NodeJS.ProcessEnv
): { names: ReadonlySet<string>; prefixes: readonly string[] } | string {
	const list = desktopEnvironment[CHILD_ENV_STRIP] ?? '';
	if (list.length > MAX_CHILD_ENV_STRIP_LENGTH) {
		return `${CHILD_ENV_STRIP} is longer than ${MAX_CHILD_ENV_STRIP_LENGTH} characters. Shorten it and restart RN Devtools.`;
	}
	const fields = list.split(',').map((field) => field.trim());
	if (fields.filter(Boolean).length > MAX_CHILD_ENV_STRIP_ENTRIES) {
		return `${CHILD_ENV_STRIP} lists more than ${MAX_CHILD_ENV_STRIP_ENTRIES} entries. Shorten it and restart RN Devtools.`;
	}
	const names = new Set<string>();
	const prefixes: string[] = [];
	for (const [index, entry] of fields.entries()) {
		if (!entry) continue;
		const match = CHILD_ENV_STRIP_ENTRY.exec(entry);
		if (!match?.[1]) {
			return `${CHILD_ENV_STRIP} entry ${index + 1} is not a variable name or a NAME_PREFIX* pattern. Separate entries with commas, fix it, and restart RN Devtools.`;
		}
		if (match[2]) prefixes.push(match[1]);
		else names.add(match[1]);
	}
	return { names, prefixes };
}

/**
 * Why no child could start with the desktop's environment as it is (a
 * malformed RNDEVTOOLS_CHILD_ENV_STRIP), or undefined when one can. For a
 * caller that must know before it stops something the child would replace.
 */
export function childEnvironmentStripProblem(
	desktopEnvironment: NodeJS.ProcessEnv
): string | undefined {
	const strip = readChildEnvironmentStrip(desktopEnvironment);
	return typeof strip === 'string' ? strip : undefined;
}

/**
 * Whether a lane's Metro or the native plan's Node must not inherit the
 * desktop's variable `name`: an agent harness's, or one the desktop's
 * RNDEVTOOLS_CHILD_ENV_STRIP names. Read from the desktop's environment before
 * a child starts. A list over its bounds, or with an entry that is neither a
 * name nor a pattern, throws instead of letting through what it was meant to
 * strip; the error names the entry by position and never echoes it.
 */
export function childEnvironmentStrip(
	desktopEnvironment: NodeJS.ProcessEnv
): (name: string) => boolean {
	const strip = readChildEnvironmentStrip(desktopEnvironment);
	if (typeof strip === 'string') throw new Error(strip);
	const { names, prefixes } = strip;
	return (name) =>
		isAgentHarnessVariable(name) ||
		names.has(name) ||
		prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * The environment a child gets that otherwise inherits the desktop's as it
 * is: the rndevtools CLI the desktop runs, and the login shell it asks for
 * PATH. Everything stays (PATH, HOME, LANG, TMPDIR and the rest, which such
 * a child needs as the user has them) but what childEnvironmentStrip names,
 * and it throws as that does.
 */
export function inheritedChildEnvironment(
	desktopEnvironment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
	const stripped = childEnvironmentStrip(desktopEnvironment);
	const kept: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(desktopEnvironment)) {
		if (value !== undefined && !stripped(name)) kept[name] = value;
	}
	return kept;
}
