// A "leak" is any path that bypasses RN Devtools for what it manages.
// - Simulators: mutating simctl verbs, a hand-started Metro, or a third-party
//   driver (idb, axe, cliclick, maestro) the agent found on the machine.
//   Read-only inspection (`simctl list`, `simctl spawn … launchctl print`,
//   `idb ui describe-all`) is not a leak: orienting is fine, driving is the
//   problem.
// - Local Supabase: starting, stopping, or destroying a stack by hand
//   (`supabase start`, `stack stop`, `db start`, …), any non-native runtime,
//   `stop --all`, or killing a stack's processes. The worktree's own data
//   commands (`supabase migration up --local`, `db reset --local`,
//   `gen types --local`) are expected and are not leaks.
const SUPABASE_RUNNER = String.raw`(?:^|\s)(?:(?:npx|bunx|pnpx)\s+|(?:pnpm|npm|bun)\s+(?:exec|dlx|x)\s+|yarn\s+(?:dlx\s+)?)?(?:\S*\/)?supabase(?:@\S+)?\s+`;
const SUPABASE_LIFECYCLE = new RegExp(
	`${SUPABASE_RUNNER}(?:start|stop|(?:stack|local)\\s+(?:start|stop|restart|destroy|prepare)|db\\s+start)\\b`
);
const SUPABASE_RUNTIME = /\bsupabase\b.*--runtime(?:=|\s+)(?:auto|docker|podman)\b/;
const SUPABASE_STOP_ALL = /\bsupabase\b.*\bstop\b.*--all\b/;
const SUPABASE_KILL =
	/\b(?:pkill|killall)\b.*\b(?:postgres|postgrest|gotrue|realtime|edge-runtime|supabase)\b/;

export function isLeak(command) {
	// Split on shell separators so `rndevtools input …; xcrun simctl boot …`
	// is judged per segment and an rndevtools call never shields a leak.
	return command
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.some((segment) => {
			if (/\brndevtools\b/.test(segment)) return false;
			if (/\bsimctl\s+(boot|shutdown|openurl|install|launch|io|erase|delete|terminate|push|privacy|clone|addmedia|keychain|status_bar)\b/.test(segment)) return true;
			if (/\bsimctl\s+spawn\b/.test(segment) && !/\blaunchctl\s+(print|list)\b/.test(segment)) return true;
			if (/\b(expo|react-native)\s+start\b/.test(segment)) return true;
			if (/(^|\s)(idb|axe|cliclick|maestro)\s+(ui\s+)?(tap|swipe|button|text|input|key|launch|open|boot|shutdown|install|focus|type|press|click|run|record|screenshot)\b/.test(segment)) return true;
			if (SUPABASE_LIFECYCLE.test(segment)) return true;
			if (SUPABASE_RUNTIME.test(segment)) return true;
			if (SUPABASE_STOP_ALL.test(segment)) return true;
			if (SUPABASE_KILL.test(segment)) return true;
			return false;
		});
}
