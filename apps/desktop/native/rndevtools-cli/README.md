# RN Devtools local CLI

`rndevtools` is a first-party, standard-library-only macOS CLI for local
agents and scripts. It never opens a TCP socket, discovers a network endpoint,
invokes a shell, accepts a socket override, or removes a stale socket.

The production binary resolves the current OS account and connects only to:

```text
~/Library/Application Support/RN Devtools/agent/rndevtools.sock
```

Before connecting it requires both a real private parent directory and a real
Unix socket owned by the current user, with no group or other permissions on
either. Each connection writes one UTF-8 JSON line no larger than 256 KiB,
half-closes, and reads one JSON line no larger than 512 KiB. Both sides use the
exact protocol string `rndevtools/1`. While a command runs, the desktop writes
a space about once a second ahead of its answer: after the half-close a write
is the only way it can tell that the CLI hung up (a cancelled MCP call, a
deadline, a killed process), and when the write fails it aborts the request's
handler and answers nothing. That stops the waiting, not work already handed
to a desktop job: a `native --operation install` still installs, and a
slimming `apply`, `undo`, or `restore` still changes the Simulator.
`jobs --operation list` shows such a job and `jobs --operation cancel`
cancels it. JSON allows that leading whitespace, and it counts toward the
512 KiB.

## Envelope

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","command":{"kind":"doctor"}}
```

The response is either:

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":true,"result":{}}
```

or:

```json
{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","ok":false,"error":{"code":"desktop_unavailable","message":"...","retryable":true,"recovery":"..."}}
```

## Commands and input

Commands are `doctor`, `simulators`, `apps`, `screen`, `elements`, `act`,
`wait`, `capture`, `record`, `network`, `recipe`, `jobs`, `slimming`, `lane`,
`supabase`, `native`, `agents`, `claim`, `release`, and `input`. Run `rndevtools <command> --help` for structured flags. An optional JSON
command object may be piped on standard input; flags may add different fields,
but redefining a stdin field is rejected. `doctor` and `agents` take no fields
and never read standard input, so a pipe left open cannot hang them. `slimming` exposes the read-only
`status`, `preview`, `doctor`, and `verify` operations and the mutating `apply`,
`undo`, and `restore`; mutations run only while SimSlim is enabled in RN
Devtools, only on Simulators the calling session holds or that nobody holds
(`device_held` otherwise), and only on runtime/profile combinations SimSlim has
verified or the user approved once in the app. `lane --operation up --slim
<profile>` applies a profile in the lane's own boot→slim→Metro→launch sequence
under the same gates. `lane --operation up` needs only `--worktree`: without
`--udid` the desktop picks a free iPhone, and when none is free it returns a
`deviceRequest` that the user settles in the Lanes panel (use an existing
Simulator, clone one, or dismiss) while the agent polls `lane --operation ls`. `act` is limited to the desktop service's explicit
unattended-action allowlist.

## MCP server

`rndevtools mcp` serves the same commands to coding agents as a Model Context
Protocol server over stdio (JSON-RPC 2.0, one message per line, protocol
revision 2025-06-18). It is the recommended way for Claude Code, Codex,
Cursor, and Kiro to reach RN Devtools: MCP tools are always in the model's
tool list with a typed schema, so the agent picks `lane` over raw `simctl` the
same way it picks `Read` over `cat`, without first deciding that a skill
applies. `rndevtools setup` registers it with each agent.

Every command is one tool of the same name. Input schemas are generated from
the CLI's own flag table (`command.Describe`), and every call is assembled and
validated by `command.Build`, the same code path the flag parser uses, then
sent on the same socket with the same agent attribution, so the desktop sees
one kind of peer. Tool descriptions carry the workflow guidance a skill would
(when to use `lane`, how `input` coordinates work, what to call first), and the
`initialize` response's `instructions` carry the rule against driving
Simulators with `xcrun simctl` directly. Argument errors come back as tool
errors (`isError: true`) with the desktop's recovery text so the model can
correct the call; only malformed JSON-RPC is a protocol error. Calls run
concurrently, so a long `wait` or `lane up` never holds up a ping or another
call, and at most four of a session's calls are with the desktop at once.
`notifications/cancelled` stops the call it names, which gets no response:
its socket closes, and the desktop aborts the handler at its next liveness
probe, within about a second. A cancel stops the wait, not a job the call
already started on the desktop: a `native` install or a slimming `apply`,
`undo`, or `restore` runs to the end unless `jobs --operation cancel` cancels
it. For two seconds after the cancel, the time the desktop needs to notice,
the call still counts toward the four and stays ahead of later calls on its
Simulator. After that the MCP server stops ordering later calls behind it, but
the desktop still makes one change to a Simulator at a time, so a later install
or slimming change on that Simulator waits for that job. A call that names a
Simulator starts only after the earlier calls that change that Simulator, so a
tap and the screenshot after it keep their order.

`capture` returns the screenshot as an image content block alongside the JSON,
so the model can look at the device. Read-only resources:
`rndevtools://simulators`, `rndevtools://lanes`, `rndevtools://supabase`
(`supabase --operation ls`), `rndevtools://agents` (JSON), and the template
`rndevtools://screen/{udid}` (a fresh JPEG). The `supabase` tool is listed
right after `lane`; its description says when a worktree's local Supabase
applies, what `up` returns, and the self-start fallback, and the `initialize`
instructions repeat the rules against hand-run stack commands. Attribution comes
from the session variables the MCP server inherits. Claude Code passes
`CLAUDE_CODE_SESSION_ID` to the servers it spawns. Codex does not pass
`CODEX_THREAD_ID`, so Codex calls over MCP fall back to an identity built from
the MCP client's name (`mcp-<client>`), which every Codex session shares. The
desktop treats that identity as synthetic: such a session's lanes and claims
are matched by its working directory instead, and its session-end hook sends
that directory (`release.sessionCwd`) so they are released at once.

## Setup for coding agents

`rndevtools setup` is the one-time step that makes agents on this Mac reach
for RN Devtools instead of raw `simctl`. It is idempotent and additive:
existing configuration is read, merged, and written back through a temporary
file and rename; unknown keys are preserved; files setup did not create are
never deleted. A configuration file that is a symlink (stow, chezmoi,
home-manager) is edited through the link, which survives; a link that dangles
or points into a directory you cannot write is reported as `skip` and left
alone. `--dry-run` prints the plan without changing anything, and the
same action is available in the desktop app's Settings as "Set up coding
agents".

| Step | Where | Notes |
| --- | --- | --- |
| Symlink the verified CLI | `~/.local/bin/rndevtools` | Re-pointed when the app moves; a foreign file there is left alone and reported. `--no-link` skips it. |
| Register the MCP server | Claude Code `~/.claude.json`, Codex `~/.codex/config.toml`, Cursor `~/.cursor/mcp.json`, Kiro `~/.kiro/settings/mcp.json` | Entry is `{command: <cli>, args: ["mcp"]}`. Claude and Codex are always configured; Cursor and Kiro only when their directory exists, or when named in `--agents`. Kiro gets the tools the MCP server marks read-only in `autoApprove`; tools that drive a device, cancel a job, or slim a Simulator still prompt. Codex's TOML is edited textually and setup owns only the `[mcp_servers.rndevtools]` table. |
| Install the skills | `~/.claude/skills`, `~/.agents/skills` (Codex), `~/.kiro/skills` | Every `skills/*/SKILL.md` is embedded in the binary (`rndevtools-lanes` and `rndevtools-supabase`), so the installed copies always match the CLI. With `--project <dir>` they go into that repository's `.claude/skills` and `.agents/skills` instead. |
| Agent hooks | Claude Code `~/.claude/settings.json` → `hooks`, Codex `~/.codex/hooks.json` | Two hooks, same for both agents because they send the same payload and read the same verdict. `PreToolUse` (`rndevtools hook pre-tool-use`) exits 2 (block, with the reason shown to the model) for `simctl boot`, `shutdown`, `erase`, `delete`, `openurl`, `install`, `uninstall`, `launch`, `terminate`, `io`, `privacy`, `push`, `keychain`, `status_bar`, `spawn`, `addmedia`, `clone`, and for hand-started Metro (`expo start`, `react-native start`); `simctl list` and other read-only verbs pass, and anything unparseable passes, because a hook that fails closed would lock the model out of Bash. While local Supabase is turned on in RN Devtools it also applies the [Supabase steering rules](#supabase-steering). `SessionEnd` (`rndevtools hook session-end`) releases everything the ending session holds (`release --all`) so its Simulators return to the pool at once rather than after the 10-minute grace; it never fails the agent's exit and finishes in milliseconds, inside Codex's 3-second cap. How it tells a steered command from a mention of one is described under [Simulator and Metro steering](#simulator-and-metro-steering): a match on each command's text is the baseline, the scripts a command hands on to be run are followed, and one excuse covers a mention on a line that looks as if it can only read and print text. Both agents run a hook command through a shell, so setup single-quotes the executable when its path needs it (a packaged install lives under `RN Devtools.app`). A rerun replaces only the hooks setup wrote (`<path>/rndevtools hook <event>`); other tools' hooks, and hooks you add to the same entry, stay. An event the installed build does not know exits 0 with a note on stderr, never 2. Codex runs new or changed hooks only after the user trusts them once with `/hooks`; setup says so in its report. Cursor has no hook mechanism, so for it the AGENTS.md block is the only guard. `--no-hook` skips both. |
| AGENTS.md block | `<project>/AGENTS.md` with `--project` | A short "iOS Simulators" section between `<!-- rndevtools:start -->` / `<!-- rndevtools:end -->` markers, replaced in place on rerun when the file has exactly one start-marker line and, after it, one end-marker line (a marker quoted inside other text does not count); markers that do not pair up are reported as `skip` and the file is left alone. When the project has `supabase/config.toml`, a "Local Supabase" paragraph follows, worded for when RN Devtools is not managing a worktree: use the `supabase` tool or `lane up` when it is, otherwise start the stack with the project's runner (from its lockfile) and `--runtime native`. The report also returns the block for manual installs. |

Setup finishes with the `doctor` check, so a mis-registered path or a desktop
that is not running shows up immediately rather than in the agent's first
failed tool call.

### Simulator and Metro steering

The `PreToolUse` hook is a convenience guard for cooperative agents, not a
security control: it steers an agent that would boot a shared Simulator or
start Metro on the shared port toward the lane and native tools, which lease
ports and Simulators so that parallel agents do not collide. It fails open.
It declines a Bash line when any of these holds:

1. **The text rule** matches, and the excuse below does not apply. The source
   text of one of the line's commands, as written, quoted or not, names a
   steered `simctl` verb (`[xcrun] simctl boot`, and the other verbs in the
   table above) or a hand-started Metro (`expo start` or `react-native start`,
   alone or behind `npx`, `yarn`, `pnpm [exec]`, `bun`, or `bunx`). This is the
   original rule, kept as the baseline. It needs no knowledge of the shell
   constructs around the text, so it declines a steered command that is piped
   through filters into a shell (`echo '…' | sed … | bash`), set as a trap
   (`trap '…' EXIT`), run by `sh -c '…' _ args`, or read by `source <(…)`, a
   script saved by one command and run by another, and a shell the hook has
   never heard of. A command's text is its source with a placeholder for each
   `$(…)` body (a command of its own) and nothing for a here-document body,
   except that the shell runs the `$(…)` and backtick substitutions in the
   body of a here-document whose delimiter has no quoting (`<<EOF`), so those
   are commands of their own as well, and joins the lines of such a body at a
   backslash and a newline before it looks for the delimiter (`EOF\` and an
   empty line ends it), as the hook does. A quoted delimiter (`<<'EOF'`,
   `<<"EOF"`, `<<\EOF`) leaves the body as text. The `rndevtools` command is
   exempt, because its arguments may name these commands. A line the hook
   cannot read to its end (a quote, a `$(`, or a `(` that never closes) is
   matched as written, here-document bodies, comments, and `rndevtools`
   arguments included, because a shell may call it a syntax error and zsh
   carries on with the lines after it.
2. **The word rules** match. They read each command's words, with quoting
   removed, so they find a command that quoting hides from the text
   (`ex''po start`), and they follow the scripts a command hands on to be run,
   each judged as a line of its own by the text rule with its excuse, the word
   rules, and the Supabase rules, up to four levels deep. The Simulator rules
   and the Supabase rules each follow up to 256 KiB of scripts in a call (past
   that a set of rules stops following scripts, and only the text and the
   words of the line itself are judged). A call also has a budget of 262,144
   words (and one more for each command) for reading what groups print, which
   the line, the scripts it hands on, and both sets of rules share, and
   `simctl` is searched for its subcommand among its first eight arguments:
   the hook has five seconds, and a line of a million bytes made to repeat
   either would take longer. The text rule reads no here-document body, apart
   from the substitutions above; the word rules read the bodies that a shell
   reads. What they follow:
   - `eval`'s arguments, and the `-c` string of a shell (`bash`, `sh`, `zsh`,
     `dash`, `ksh`, `mksh`, `ash`, `fish`, `csh`, `tcsh`), also when another
     command runs the shell (`timeout`, `nice`, `xargs`, `find -exec`,
     `sudo -u`, `docker exec`). A shell given `-n` or `-o noexec` only parses
     its script and runs none of it.
   - What a shell reads on standard input when it is the command, run directly
     or through a launcher (`sudo`, `doas`, `env`, `command`, `exec`,
     `builtin`, `time`, `nohup`, `timeout`, `nice`, `caffeinate`, `stdbuf`,
     `arch`, `script`, `sandbox-exec`, `taskpolicy`, and a few more): a
     here-string, a here-document, or the text `echo` or `printf` pipes in
     (their arguments, with `printf`'s format not applied), also through `cat`,
     `tee`, or a `( … )` or `{ …; }` group piped straight in. Standard input
     belongs to the command, so `grep sh <<< …` reads text.
   - A script file that the same line writes, by a redirection, `tee`, or a
     here-document, and then runs as `sh run.sh`, `source run.sh`,
     `. run.sh`, or `./run.sh`. Its text is judged once, however often the
     line runs it; a script the line follows has files of its own, so an
     `s.sh` it writes is not the `s.sh` of the line around it. A file is
     read from its last 64 writes (the write that replaced it and the
     appends after it), and the files of a line from 16,384 writes in all,
     a script the line follows counting as a line of its own; the writes
     before those are not read, so a file appended to more often than that
     is judged without its first lines.
   - What `xargs` hands a shell: its `-c` string with each input line filled
     in as one quoted word (or the input line itself, when the string is the
     replacement alone, as in `xargs -I{} sh -c '{}'`), or each item of
     `xargs -0 sh -c`.
   - The command strings of `env -S`, `script -c`, `npx -c`,
     `npm exec --call`, `pnpm exec -c`, `yarn exec`, and `bun exec`; every
     argument of `concurrently`, `watch`, `nodemon`, `watchexec`, `entr`,
     `parallel`, and `su`; the shell command and keys of the `tmux` commands
     that take them (`new-session`, `new-window`, `split-window`,
     `respawn-pane`, `respawn-window`, `run-shell`, `if-shell`, `pipe-pane`,
     `display-popup`, `send-keys`, their short names, and `tmux -c`; the rest,
     such as `rename-window`, only handle text), in each command of a list
     joined by `;` or `\;` (`tmux select-pane -t 1 \; send-keys '…' Enter`);
     and `osascript`'s `do shell script`, `do script`, and `write text`.
   - What a lone `$(echo …)` prints, in the place of any of these.
3. **The Supabase rules** decline it (see [Supabase steering](#supabase-steering)).

**The one excuse.** The text rule's match is excused when the line looks as if
it can only read and print text, so a commit message, a PR body, a search
pattern, or a note that names a steered command passes. The excuse is a
heuristic for the lines agents normally write, and a conservative one. The
hook's splitter is not a shell, and the excuse does not count on the two
reading a line alike. It takes all of these; a line that fails one of them
keeps the text rule's verdict, and only these conditions turn the excuse off:

- The line holds none of the constructs where a splitter and a shell are most
  likely to part. In the line as written, a here-document body or a comment
  included, there is no backslash (an escape, a line continuation) but those
  inside single quotes on a command line, where it is an ordinary character
  (`printf '%s\n'`, `grep 'a\|b'`); a backslash in a here-document body or a
  comment is not exempt, between single quotes or not; no `$` and no backtick
  (in a quote or not), which leaves out expansions, ANSI-C quotes such as
  `$'it\'s'`, and substitutions nested deeper than the splitter follows (16
  levels); and no `((` (arithmetic, where a `<<` is a shift and not a
  here-document). In the words of its commands there is no unquoted `*`, `?`,
  or `[` (a glob can turn a file made on the line into an option, and `[`, the
  `test` command, is not excused either), no unquoted brace expansion (`git
  {-c,x} log`), and no brace after the command (zsh's `if true { cmd }`). And
  the scan ended outside any quote, `$( )` body, and `( )` group (bash calls a
  `(` that never closes a syntax error, and zsh reads a pattern that swallows
  the lines after it), and no `<( )` body was too deep to split.
- Every command of the line, those in `( )` groups and `<( )` bodies included,
  is one of these, and none sets a variable (a `NAME=value` prefix, also after
  `env` or `sudo`; `printf -v`; `test -v` and `[ -v`):
  - `echo`, `printf`, `cat`, `grep`, `egrep`, `fgrep`, `rg`, `head`, `tail`,
    `wc`, `sort`, `uniq`, `cut`, `tr`, `nl`, `jq`, `ls`, `pwd`, `cd`, `mkdir`,
    `touch`, `test`, `[`, `true`, `false`, `sleep`, `date`, `basename`,
    `dirname`, `realpath`, `which`, `type`, and `command -v` or `-V`;
  - `git` for `add`, `commit`, `log`, `show`, `diff`, `status`, `tag`,
    `stash`, `push`, `fetch`, `branch`, `checkout`, `switch`, `restore`, `rm`,
    `mv`, `grep`, `blame`, `describe`, `rev-parse`, and `ls-files`;
  - `gh` for `pr`, `issue`, `release`, `api`, `label`, and `search`, and for
    `repo view` and `repo list` (the other `gh repo` commands clone, create,
    edit, or delete);
  - `rndevtools`, also by its path (`~/.local/bin/rndevtools`), the one
    command named by a path that counts;
  - any of these behind `nice`, `nohup`, `time`, `timeout`, `gtimeout`,
    `sudo`, or `env`, which only run their operand (not `sudo -s`, `-i`, or
    `-l`, and not `env -S`); the keywords `if`, `then`, `else`, `elif`,
    `fi`, `while`, `until`, `do`, `done`, `!`, and the braces of a group
    before a command are looked through.
- The options of `git`, `gh`, `rg`, and `sort` are ones the excuse can name.
  A short option counts when each of its letters is listed (every letter for
  `git` but `c` and `O`, which name a program to run; for `gh` but `e` and
  `w`, which open an editor and a browser; for `rg` but `z`). A long option
  counts when it is spelled in full and listed in the source
  (`internal/setup/hook_options.go`), because `sort` and most `git` commands
  (`fetch`, `push`, `commit`, `grep`, …) accept any unique prefix of a long
  option (`--upl` for `--upload-pack`, `--comp` for `--compress-program`), so
  an abbreviation, or an option off the list such as `rg --pre`, ends the
  excuse. Every word of every command is read, a quoted `>` included, and a
  word that starts with a dash is read wherever it stands, after a `--` too,
  because an option that takes a value swallows the `--` (`rg -e -- --pre=sh`,
  `git push -o -- --receive-pack=…`). Nothing counts for `gh` after `--` (`gh
  repo clone … -- -c core.sshCommand=…` hands the rest to `git`).
- `git` and `gh` are on the line only when no command of it writes a file,
  because git runs hook files: a redirection other than to `/dev/null` or to
  a copy of a descriptor such as `2>&1`, `sort -o` (also after a `--`), a
  second operand of `uniq`, and any `--output` all write one.

Everything else is off the list: every shell, `eval`, `source`, `exec`,
`trap`, `export`, `alias`, `set`, `xargs`, `find`, `sed`, `awk`, interpreters,
`tmux`, `watch`, `parallel`, `script`, `tee`, any other command named by a
path (`/usr/bin/git`) or by an expansion, and any command the hook does not
know. A mixed line, such as a commit message plus `pnpm test`, or a note
written to a file and then committed, keeps the text rule's verdict. A script
that the word rules follow is a line of its own, so it gets the excuse on its
own terms, and that has a cost. The first version of the hook never read a
here-document body, so it passed whatever script a here-document fed to a
shell (`bash <<'EOF'`, `cat <<'EOF' | xargs -I% bash -c '…'`). The hook now
follows that script, and one that holds a mention beside a backslash outside
single quotes (`echo "Run npx expo start\n" >> notes.md`, `printf "%s\n" …`) or
an unquoted `*`, `?`, or `[` is declined. The same script with the format or
the pattern in single quotes (`printf '%s\n'`) is not.

Meeting these conditions does not prove that nothing else can run. There is
no data-flow analysis: the excuse does not know what the user's own git
configuration, aliases, hooks, or environment run, nor every option of every
version of the programs it lists. It is a heuristic for the lines agents
normally write, and the conditions above are the only things that turn it off.
Evading it on purpose is out of scope, as it is for a command assembled at run
time (see below), because the hook is a guard for cooperative agents and fails
open.

**Not recognized.** A command assembled at run time from variables
(`CMD=…; $CMD`), from command output (`$(cat start.txt)`, a download), or from
an encoding (`base64 -d | sh`); a file that another program or an earlier call
wrote (a script saved in a previous call and run now); a file the line writes
and then feeds to a shell by `<`, `cat run.sh |`, or `$(cat run.sh)`; a
here-document piped through a filter other than `cat` or `tee` into a shell, or
a `( … )` group followed by a redirection piped into one; a here-document
whose delimiter is not a plain name (`<<E-O-F`, or one with an escaped blank,
`<<E\ F`), which the hook reads as commands rather than as input, so that a
line of the body that ends in a backslash joins the line after it; code in
another language that builds the command at run time (`node -e
"spawnSync('npx', ['expo', 'start'])"`); a command in the lines after a `<<`
that the shell reads as a shift in arithmetic or as part of a parameter
expansion, and the splitter as the start of a here-document (`(( x << y ))`,
`${<<EOF … }`); and scripts past the limits above (four levels, 256 KiB, and
the writes of a script file). The text rule still declines most of these when
their text is in a command it reads (`echo '…' > run.sh; bash < run.sh`,
`ssh host '…'`, `node -e "execSync('…')"`). Of the lines that the splitter
takes for the body of such a `<<` it reads only the `$(…)` and backtick
substitutions of a body whose delimiter has no quoting, which are commands of
their own as in any `<<EOF`, and none of the rest, whatever it holds; a line
with `(( x << y ))` or `${<<EOF … }` is declined only through a mention in a
command it does read, and the excuse never covers that, because a line with
`((` or `$` gets no excuse.

## Lanes

`lane` runs one git worktree on one Simulator with its own leased Metro port,
so several branches and coding agents can work in parallel:

```bash
rndevtools lane --operation up --worktree "$PWD"                 # pick a free Simulator, boot, lease a port, start Metro, launch
rndevtools lane --operation up --worktree "$PWD" --udid <UDID>   # or name the Simulator yourself
rndevtools lane --operation ls                                   # lanes, environments, discovered worktrees
rndevtools lane --operation launch --worktree "$PWD" --url checkout
rndevtools lane --operation log --lane-id <lane-id>
rndevtools lane --operation down --worktree "$PWD"
```

`up` requires `--worktree`. Without `--udid` the desktop picks a free iPhone
(nobody's lane, nobody's claim), booted ones first; when none is free it parks
a device request for the user and `lane ls` reports how it was settled.
`down`, `launch`, and `log` take exactly one of `--lane-id` or `--worktree`. Lane creation fails rather than
stealing a worktree, Simulator, or port another lane owns. The CLI attaches
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` (or `RNDEVTOOLS_AGENT_SESSION_ID`)
to `up` and `launch` so the desktop can show which agent holds a lane. The
agent skill in [`internal/setup/skills/rndevtools-lanes`](internal/setup/skills/rndevtools-lanes/SKILL.md)
teaches Claude Code and Codex the workflow; copy it into `.claude/skills` or
`.codex/skills`. On the command line a relative `--worktree` (for example
`--worktree .`) resolves against the current directory, for `lane`,
`supabase`, and `native`; stdin JSON and MCP tool calls must send absolute
paths, because neither shares the caller's directory.

`lane --operation up --backend auto|off|required` decides the worktree's local
Supabase. `auto`, the default for the `development` environment, starts the
worktree's own stack when RN Devtools manages its Supabase project and hands
Metro the stack's URL and publishable key, and never fails the lane; `required`
fails the lane when the stack cannot start; `off` skips it. Without the flag
the desktop applies the environment's default. The receipt's `lane.backend`
reports `ready`, `starting` (the app launches once the stack is ready),
`skipped`, `shadowed`, `refused`, or `failed`, with the reason. A `starting`
backend usually carries a `jobId` (follow it with `wait --condition job`); one
queued behind RN Devtools' own automatic start has none, and `lane up` again,
which is idempotent, picks it up a few seconds later.

`doctor` returns a bounded `connectedSessions` list. Use a returned `deviceId`
with `screen`, `elements`, `act`, `wait`, or `network` when an older mobile
protocol has not reported its Simulator UDID.

The CLI prints one compact JSON response. Exit codes are stable:

- `0`: success
- `2`: invalid arguments
- `3`: desktop app unavailable or stale/unsafe socket
- `4`: deadline exceeded
- `5`: transport or response-protocol failure
- `6`: typed server rejection
- `7`: internal CLI failure

## Local Supabase

`supabase` gives a git worktree its own local Supabase stack, run by RN
Devtools on Supabase's native runtime and bound to 127.0.0.1, while the user
has turned the feature on in RN Devtools › Supabase:

```bash
rndevtools supabase --operation up --worktree "$PWD"            # create or resume; waits up to --wait-ms (default 30000, max 45000)
rndevtools supabase --operation ls                              # every stack on this Mac, with lanes and holders
rndevtools supabase --operation status --worktree "$PWD"        # services and health
rndevtools supabase --operation env --worktree "$PWD"           # API/REST/Functions/Mailpit URLs, publishable and anon keys
rndevtools supabase --operation log --stack-id 64616c83 --service auth --service gateway --tail 100 --since 10m
rndevtools supabase --operation reset --worktree "$PWD" --seed=false
rndevtools supabase --operation destroy --worktree "$PWD" --note "obsolete branch"
rndevtools supabase --operation down --worktree "$PWD"
```

| Flag | Field | Rules |
| --- | --- | --- |
| `--operation` | `operation` | `up`, `down`, `ls`, `status`, `env`, `reset`, `log`, or `destroy`. Required. |
| `--worktree` | `worktreePath` | Absolute path, 2..1024 bytes, no control characters. |
| `--stack-id` | `stackId` | 8..64 lowercase hex; a unique prefix of an id from `ls`. |
| `--wait-ms` | `waitMs` | `up` only; integer 0..45000. |
| `--seed` | `seed` | `reset` only; boolean (`--seed=false` resets to the migrations only). |
| `--service` | `services` | `log` only; repeatable (or comma-separated), 1..16 distinct names: a service kind (`database`, `rest`, `auth`, `realtime`, `storage`, `imgproxy`, `functions`, `studio`, `pgmeta`, `mail`, `analytics`, `pooler`), `gateway`, or a lowercase instance UUID. |
| `--tail` | `tail` | `log` only; integer 1..1000. |
| `--since` | `since` | `log` only; `start`, a duration such as `10m` or `1h30m`, or an ISO-8601 time; at most 64 characters. |
| `--note` | `note` | `destroy`, or a `reset` that becomes a request; at most 240 characters (UTF-16 units). |

`ls` takes no target; every other operation takes exactly one of `--worktree`
or `--stack-id`, and each option belongs only to the operation listed. The
CLI validates all of this before connecting (exit 2), and the desktop
validates it again. The agent's identity rides on the request envelope only:
the command carries no agent field, and the desktop records the hold from the
envelope. Results are JSON: `up` returns the stack (ports, never URLs), the
app variable names Metro gets, whether Metro restarted, the CLI to run from
the worktree (`cli.run`, `cli.workdir`), `next`, warnings, and a `jobId` when
the stack is still starting (follow it with `wait --condition job`; a start
queued behind RN Devtools' own automatic one has none, and `up` again picks it
up a few seconds later); only `env`
returns URLs and the publishable and anon keys, and no result ever carries a
secret key, the service-role key, or the database URL. `destroy` never deletes
anything: it files a request the user settles in RN Devtools, as does a
`reset` of a stack another session holds.

Socket deadlines sit past the desktop's own budgets, so a slow call still ends
in the desktop's typed answer rather than a CLI timeout: `up` waits
`wait-ms` + 15 s (45 s by default), `reset` 75 s, and every other operation
45 s; `--request-timeout-ms` overrides them. Exit codes are the usual ones: a
refusal such as `supabase_disabled` (the feature is off, or RN Devtools does
not manage that worktree) is a typed rejection (exit 6) whose `recovery` names
the next step, usually starting the stack yourself with `<runner> start
--runtime native`; a desktop that is not running is exit 3.

### Supabase steering

The desktop writes `steering.json` next to the agent socket
(`~/Library/Application Support/RN Devtools/agent/steering.json`, 0600 in the
0700 directory) while local Supabase is turned on, refreshes it every minute,
and removes it when the feature is turned off:

```json
{"version":1,"writtenAt":1760000000000,"desktopPid":12345,"supabase":{"enabled":true,"roots":[{"worktreeRoot":"/abs/wt","projectRoot":"/abs/wt","mode":"managed","branchContext":"refs/heads/feat-a","stackReady":true,"runner":"pnpm exec supabase"}]}}
```

The PreToolUse hook reads it, only for Bash lines that run `supabase` or kill
processes, with the socket's checks: a real directory and a regular file
(neither a symlink), owned by the current user, writable by nobody else, at
most 64 KiB, and exactly this v1 shape. A missing or invalid file, or
`enabled: false`, means no Supabase rule applies. Each command of a line is
judged on its own: runners are stripped (`npx`, `pnpm exec`/`dlx`, `yarn
[dlx]`, `bunx`, `bun x`, `npm exec`, a path binary, `supabase@<version>`),
`cd`, `pnpm -C`, `--workdir`, and `SUPABASE_WORKDIR` move the directory a
command runs in, and the scripts a command hands on are followed as for the
Simulator rules (the list, and the limits of four levels and 256 KiB of
scripts, which the Supabase rules count apart from the Simulator rules', are
under [Simulator and Metro steering](#simulator-and-metro-steering)), each
judged as a line of its own from the directory it runs in. These rules read
words and have no text rule behind them, so a supabase or kill command
assembled at run time, kept in a file another program or an earlier call
wrote, or held by a script the hook does not follow, is not recognized.
Here-document bodies that no shell reads (a commit message, a file written
with `cat <<'EOF'`) are input rather than commands, except for the
substitutions the shell expands in a body whose delimiter has no quoting;
`--help` always passes, a command that runs `rndevtools` itself is exempt, and
anything the hook cannot read or place runs. A rule that reads the commands
chained or piped around one (a native start before `db schema declarative
sync`, the pipeline into `xargs kill`, the `tee` after `status --env`) reads
at most 32 of them, and a directory built by `cd` longer than 4,096 bytes is
unknown. A supabase or kill command that a launcher runs directly
is judged only behind `sudo`, `env`, `command`, `exec`, `time`, or `nohup`
without option values: `timeout 60 supabase stop --all` and `sudo -u me
pkill postgres` are not.

- **Always, while enabled:** `stop --all`; a stop by `--stack-id` or
  `--project-id`, or with a `--workdir` outside the current worktree;
  `stack destroy`; `pkill`/`killall` of stack processes (postgres, postgrest,
  gotrue, auth, realtime, edge-runtime, supabase, and friends), `kill` of what
  `pgrep` finds, and `pg_ctl stop`; and `status --env` (or `-o env`)
  redirected or teed into a `.env*` file.
- **Managed mode**, when the file is at most 3 minutes old, the desktop
  accepts a connection on its socket within 200 ms, and the command runs
  inside a managed root whose Supabase project it would use: `start`, `stop`,
  `dev`, `stack`/`local` `start|stop|restart|prepare`, `db start`, any
  `--runtime`, and downloaded or out-of-tree CLI builds are redirected to
  `rndevtools supabase` (or the root's own runner), and `db diff`, `db pull`,
  `migration squash`, and local declarative schema commands wait until the
  branch's stack is ready.
- **Fallback mode**, otherwise, in projects that opted into the stack backend
  (the segment's or the hook's `SUPABASE_EXPERIMENTAL_STACK`, else
  `supabase/config.json`, else `[experimental] stack = true` in
  `supabase/config.toml`): `start`, `stack start`, and `stack prepare` need
  `--runtime native` (the reason gives the corrected command), `db start` is
  blocked, and local declarative schema commands must follow a native start
  in the same `&&` chain.

The hook is advisory (Codex needs `/hooks` trust, Cursor has no hooks); the
desktop's own native stacks and exposure checks are the real controls.

## Provenance

The implementation is first-party RN Devtools code. It uses only the Go
1.27 standard library and contains no SimSlim source or catalog data. Go runtime
and standard-library attribution is reproduced in
`apps/desktop/THIRD_PARTY_NOTICES.md`. See `PROVENANCE.md` for the full source,
dependency, build, and release record.
