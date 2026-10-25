package app

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/command"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
	"github.com/adalloul0928/rndevtools-cli/internal/setup"
)

const setupUsage = `Usage: rndevtools setup [flags]

Installs rndevtools into the coding agents on this Mac so they use RN Devtools
for Simulators instead of raw simctl:

  * symlinks this CLI into ~/.local/bin
  * registers the MCP server (rndevtools mcp) with Claude Code (~/.claude.json),
    Codex (~/.codex/config.toml), Cursor (~/.cursor/mcp.json), and Kiro
    (~/.kiro/settings/mcp.json)
  * installs the rndevtools-lanes and rndevtools-supabase skills where each
    agent discovers skills
  * adds hooks for Claude Code (~/.claude/settings.json) and Codex
    (~/.codex/hooks.json): PreToolUse redirects simctl boot/shutdown/openurl/
    install/launch/io and hand-started Metro to rndevtools and, while local
    Supabase is turned on in RN Devtools, keeps hand-run supabase commands
    native and off other agents' stacks; SessionEnd releases the session's
    lanes, claims, and stacks. Codex runs new hooks only after you trust them
    once with /hooks
  * with --project, also installs the skills into that repository and adds an
    "iOS Simulators" block to its AGENTS.md, plus a "Local Supabase"
    paragraph when the project has supabase/config.toml

Everything is idempotent and additive; unknown configuration is preserved.
Finishes with the doctor check so a mis-registered path shows up now.

Flags:
  --agents claude,codex,cursor,kiro  Agents to configure (default: Claude and
                                     Codex, plus Cursor/Kiro when installed).
  --project <dir>                    Repository to receive the skills and the
                                     AGENTS.md block.
  --dry-run                          Print the plan; change nothing.
  --no-link                          Do not touch ~/.local/bin.
  --no-hook                          Do not install the agent hooks.
  --executable <path>                Register this binary instead of the
                                     running one (for packaged installs).
`

func runSetup(config Config) int {
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	agents := flags.String("agents", "", "")
	project := flags.String("project", "", "")
	dryRun := flags.Bool("dry-run", false, "")
	noLink := flags.Bool("no-link", false, "")
	noHook := flags.Bool("no-hook", false, "")
	executable := flags.String("executable", "", "")
	help := flags.Bool("help", false, "")
	if err := flags.Parse(config.Arguments[1:]); err != nil || flags.NArg() > 0 {
		if err == flag.ErrHelp || *help {
			fmt.Fprint(config.Stdout, setupUsage)
			return ExitSuccess
		}
		writeLocalError(config.Stderr, "invalid_arguments", "unrecognised setup flags", false, "Run rndevtools setup --help.", "")
		return ExitUsage
	}
	if *help {
		fmt.Fprint(config.Stdout, setupUsage)
		return ExitSuccess
	}
	options := setup.Options{SkipLink: *noLink, SkipHook: *noHook}
	if *agents != "" {
		for _, name := range strings.Split(*agents, ",") {
			options.Agents = append(options.Agents, setup.Agent(strings.TrimSpace(name)))
		}
	}
	if *project != "" {
		absolute, err := filepath.Abs(*project)
		if err != nil {
			writeLocalError(config.Stderr, "invalid_arguments", err.Error(), false, "", "")
			return ExitUsage
		}
		options.Project = absolute
	}
	resolved := *executable
	if resolved == "" {
		path, err := os.Executable()
		if err != nil {
			writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", "")
			return ExitInternal
		}
		if real, err := filepath.EvalSymlinks(path); err == nil {
			path = real
		}
		resolved = path
	}
	options.Executable = resolved

	var report setup.Report
	var err error
	if *dryRun {
		report, err = setup.Plan(options)
	} else {
		report, err = setup.Apply(options)
	}
	if err != nil {
		writeLocalError(config.Stderr, "setup_failed", err.Error(), false, "", "")
		return ExitInternal
	}
	health := setupDoctor(config)
	writeJSON(config.Stdout, map[string]any{
		"dryRun":              *dryRun,
		"executable":          report.Executable,
		"changes":             report.Changes,
		"agentsBlock":         report.AgentsBlock,
		"codexHooksNeedTrust": report.CodexHooksNeedTrust,
		"doctor":              health,
	})
	return ExitSuccess
}

// setupDoctor runs the doctor command and reports its outcome, so a user
// sees immediately whether the desktop app is running and reachable.
func setupDoctor(config Config) map[string]any {
	socketPath := config.SocketPath
	if socketPath == "" {
		resolved, err := client.DefaultSocketPath()
		if err != nil {
			return map[string]any{"ok": false, "message": err.Error()}
		}
		socketPath = resolved
	}
	localClient, err := client.New(socketPath, client.DefaultTimeout)
	if err != nil {
		return map[string]any{"ok": false, "message": err.Error()}
	}
	requestID, err := protocol.NewRequestID("cli-")
	if err != nil {
		return map[string]any{"ok": false, "message": err.Error()}
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       requestID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil {
		return map[string]any{
			"ok":       false,
			"message":  "RN Devtools is not reachable: " + err.Error(),
			"recovery": "Start the RN Devtools app. Agents will get desktop_unavailable until it is running.",
		}
	}
	if !response.OK {
		return map[string]any{"ok": false, "message": response.Error.Message}
	}
	return map[string]any{"ok": true, "result": response.Result}
}

// runHook dispatches `rndevtools hook <event>`, the entry point the installed
// agent hooks call. Decisions are communicated the way each agent expects:
// Claude Code reads exit status 2 as "block" and shows stderr to the model.
// Only a block decision exits 2; nothing else here may, or a hook this build
// cannot run would refuse every Bash call.
func runHook(config Config) int {
	event := ""
	if len(config.Arguments) >= 2 {
		event = config.Arguments[1]
	}
	switch event {
	case "pre-tool-use", "claude-pre-tool-use":
		// Claude Code and Codex send the same payload and read the same verdict.
		decision := setup.EvaluateClaudePreToolUse(config.Stdin)
		if decision.Block {
			fmt.Fprintln(config.Stderr, decision.Reason)
			return 2
		}
		return ExitSuccess
	case "session-end":
		return runSessionEndHook(config)
	case "--help", "help":
		fmt.Fprint(config.Stdout, hookUsage)
		return ExitSuccess
	default:
		// An event from a newer setup, or none: say so where a person can see
		// it, keep stdout empty for the agent, and let the call run.
		if event != "" {
			fmt.Fprintf(config.Stderr, "rndevtools hook: unknown event %q; rerun rndevtools setup so the installed hooks match this build.\n\n", event)
		}
		fmt.Fprint(config.Stderr, hookUsage)
		return ExitSuccess
	}
}

const hookUsage = `Usage: rndevtools hook <event>

Entry points for the agent hooks that setup installs. Each reads the agent's
JSON payload on stdin.

  pre-tool-use   Exit 2 (block, reason on stderr) when a Bash command drives a
                 Simulator around RN Devtools: simctl boot/shutdown/openurl/
                 install/launch/io and friends, or a hand-started Metro.
                 While local Supabase is turned on in RN Devtools (steering.json
                 in the agent socket directory says so), it also blocks
                 commands that reach other agents' stacks (stop --all, a stop
                 by id or of another worktree, stack destroy, pkill postgres,
                 status --env into a .env file), keeps hand-started stacks
                 native (start without --runtime native, db start), and in a
                 worktree RN Devtools runs, redirects start and stop to
                 rndevtools supabase. Anything it cannot read runs.
  session-end    Release everything the ending session holds: stop its lanes,
                 drop its claims, release its stacks. Devices return to the
                 pool at once instead of after the grace period.

Any other event exits 0 with a note on stderr: only a block exits 2.
`

// maxSessionCwdLength matches the desktop's absolute-path bound.
const maxSessionCwdLength = 1024

// sessionEndReleaseCommand is release --all, plus the ending session's working
// directory when the payload carries an absolute one. The desktop uses it to
// release what the session holds under an MCP identity shared with other
// sessions (Codex over MCP), matching those holds by directory.
func sessionEndReleaseCommand(cwd string) json.RawMessage {
	command := struct {
		Kind       string `json:"kind"`
		All        bool   `json:"all"`
		SessionCwd string `json:"sessionCwd,omitempty"`
	}{Kind: "release", All: true}
	if filepath.IsAbs(cwd) && len(cwd) <= maxSessionCwdLength && !strings.ContainsRune(cwd, 0) {
		command.SessionCwd = filepath.Clean(cwd)
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return json.RawMessage(`{"kind":"release","all":true}`)
	}
	return encoded
}

// runSessionEndHook releases the ending session's lanes and claims. The
// session id comes from the payload (both agents send one); the environment
// variables are a fallback. Nothing is fatal here: a hook that fails loudly on
// exit helps nobody, so problems go to stderr and the exit status stays 0.
func runSessionEndHook(config Config) int {
	payload := setup.ReadSessionEnd(config.Stdin)
	getenv := config.lookup()
	agent := command.AgentFromEnvironment(getenv)
	if payload.SessionID != "" {
		kind := "other"
		if agent != nil {
			kind, _ = agent["kind"].(string)
		} else if getenv("CLAUDE_CODE_ENTRYPOINT") != "" || getenv("CLAUDE_PROJECT_DIR") != "" {
			kind = "claude"
		} else if getenv("CODEX_HOME") != "" || getenv("CODEX_SANDBOX") != "" {
			kind = "codex"
		}
		agent = map[string]any{"kind": kind, "sessionId": payload.SessionID}
	}
	if agent == nil {
		fmt.Fprintln(config.Stderr, "rndevtools hook session-end: no session id in the payload or environment; nothing to release")
		return ExitSuccess
	}
	socketPath := config.SocketPath
	if socketPath == "" {
		resolved, err := client.DefaultSocketPath()
		if err != nil {
			fmt.Fprintln(config.Stderr, "rndevtools hook session-end:", err)
			return ExitSuccess
		}
		socketPath = resolved
	}
	// Two seconds leaves headroom inside Codex's three-second SessionEnd cap.
	localClient, err := client.New(socketPath, 2*time.Second)
	if err != nil {
		fmt.Fprintln(config.Stderr, "rndevtools hook session-end:", err)
		return ExitSuccess
	}
	requestID, err := protocol.NewRequestID("cli-")
	if err != nil {
		return ExitSuccess
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       requestID,
		Command:  sessionEndReleaseCommand(payload.Cwd),
		Agent:    agent,
	})
	if err != nil {
		// The desktop is not running: there is nothing holding a lane either.
		return ExitSuccess
	}
	if !response.OK && response.Error != nil {
		fmt.Fprintln(config.Stderr, "rndevtools hook session-end:", response.Error.Message)
	}
	return ExitSuccess
}
