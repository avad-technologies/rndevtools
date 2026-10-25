package setup

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// HookDecision is what a PreToolUse hook tells Claude Code.
type HookDecision struct {
	// Block is true when the tool call must not run. Claude Code maps this to
	// exit status 2 and shows Reason to the model.
	Block  bool
	Reason string
}

// steeredVerbs are the simctl subcommands that mutate a Simulator or launch
// into it, and the rndevtools operation that replaces each. Observing verbs
// (list, getenv, get_app_container, diagnose, help) stay allowed: an agent
// orienting itself is not the problem; two agents booting the same device is.
var steeredVerbs = map[string]string{
	"boot":       "`lane` (operation up) boots the Simulator the lane needs, or ask the user which device to use",
	"shutdown":   "`lane` (operation down) stops a lane; leave other agents' Simulators running",
	"erase":      "RN Devtools owns device state; ask the user before erasing a Simulator",
	"delete":     "RN Devtools owns device state; ask the user before deleting a Simulator",
	"openurl":    "`lane` (operation launch, url) opens deep links through the lane's scheme",
	"install":    "`native` (operation install) installs the cached dev client; `native` plan tells you whether a build is needed",
	"uninstall":  "ask the user before removing apps from a managed Simulator",
	"launch":     "`lane` (operation launch) opens the dev client against the lane's Metro",
	"terminate":  "`lane` (operation down) stops the lane; use `input` button home to leave an app",
	"io":         "`capture` takes screenshots and `record` records video through RN Devtools",
	"privacy":    "RN Devtools' permissions panel grants and resets privacy permissions",
	"push":       "ask the user; push payloads are not part of the agent surface",
	"keychain":   "ask the user before touching a Simulator keychain",
	"status_bar": "ask the user before overriding the status bar on a shared device",
	"spawn":      "RN Devtools does not expose arbitrary processes on a Simulator",
	"addmedia":   "ask the user before adding media to a shared Simulator",
	"clone":      "RN Devtools' slimming and lanes manage device copies; ask the user",
}

// shellCall is one Bash tool call as the steering rules see it.
type shellCall struct {
	command string
	// cwd is the session's working directory from the payload, "" when it
	// has none. The simctl and Metro rules do not need it; the Supabase rules
	// start from it to place each command in a worktree.
	cwd string
}

// EvaluateClaudePreToolUse reads Claude Code's PreToolUse JSON and decides
// whether the Bash command should run. Any input that is not a Bash call, or
// that cannot be parsed, is allowed: a hook that fails must fail open, since
// exit status 2 on a parse error would lock the model out of Bash entirely.
func EvaluateClaudePreToolUse(input io.Reader) HookDecision {
	call, ok := readPreToolUse(input)
	if !ok {
		return HookDecision{}
	}
	return evaluateShellCall(call)
}

// readPreToolUse parses a PreToolUse payload; ok is false unless it is a
// Bash call. Claude Code and Codex send the same shape.
func readPreToolUse(input io.Reader) (shellCall, bool) {
	var payload struct {
		ToolName  string `json:"tool_name"`
		Cwd       string `json:"cwd"`
		ToolInput struct {
			Command string `json:"command"`
		} `json:"tool_input"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&payload); err != nil {
		return shellCall{}, false
	}
	if payload.ToolName != "Bash" {
		return shellCall{}, false
	}
	return shellCall{command: payload.ToolInput.Command, cwd: payload.Cwd}, true
}

func evaluateShellCall(call shellCall) HookDecision {
	return evaluateShellCallWith(call, defaultSupabaseEnvironment())
}

// evaluateShellCallWith judges each command of the line on its own, so a
// harmless first command cannot carry a steered one past the rules: first the
// Simulator and Metro rules, then the Supabase rules, which read steering.json
// only when the line runs supabase or kills processes. The line is declined
// when the word rules find a steered command, when the text rule matches and
// is not excused, or when the Supabase rules decline it.
func evaluateShellCallWith(call shellCall, environment supabaseEnvironment) (decision HookDecision) {
	defer func() {
		// A rule that breaks fails open, like a payload the hook cannot read:
		// exit status 2 from a crash would lock the model out of Bash.
		if recover() != nil {
			decision = HookDecision{}
		}
	}()
	line := parseShellLine(call.command)
	if decision := judgeSimulatorRules(line, 0, &scriptLedger{}); decision.Block {
		return decision
	}
	rules := supabaseRules{environment: environment}
	return rules.judge(line, call.cwd)
}

// judgeSimulatorRules checks command text, parsed words, and nested scripts.
// Parsing words catches quoted executable names; script traversal is bounded
// by maxNestedScripts and maxFollowedScriptBytes.
func judgeSimulatorRules(line shellLine, nesting int, ledger *scriptLedger) HookDecision {
	if decision := judgeText(line); decision.Block {
		return decision
	}
	for index, segment := range line.segments {
		// With nothing left after its launchers, a segment may still run a
		// command string of theirs (env -S'cmd').
		if _, words := segment.commandWords(); len(words) > 0 {
			switch program := baseName(words[0]); {
			case program == "rndevtools":
				// RN Devtools' own CLI may mention Metro or simctl in its arguments (a
				// claim note, a deep link) without running them. Only that command is
				// exempt; substitutions inside it are segments of their own.
				continue
			case shellPrograms[program] || program == "eval":
				// The rest is the shell's own: options, script, and parameters.
			default:
				if decision := evaluateWords(words); decision.Block {
					return decision
				}
			}
		}
		if nesting >= maxNestedScripts || ledger.exhausted() {
			continue
		}
		for _, script := range handedScripts(line, index) {
			if !ledger.follow(script, "", nesting) {
				continue
			}
			if decision := judgeSimulatorRules(line.parseScript(script.text), nesting+1, ledger); decision.Block {
				return decision
			}
		}
	}
	return HookDecision{}
}

// evaluateWords finds a steered simctl verb or a Metro start among one
// command's words: run directly, by path, or by a command that runs another
// (xcrun simctl, xargs xcrun simctl, npx expo, timeout 60 npx expo).
func evaluateWords(words []string) HookDecision {
	for index, word := range words {
		switch commandName(word) {
		case "simctl":
			verb := simctlVerb(words[index+1:])
			if replacement, steered := steeredVerbs[verb]; steered {
				return simctlDecision(verb, replacement)
			}
		case "expo", "react-native":
			if firstOperand(words[index+1:]) == "start" {
				return metroDecision()
			}
		}
	}
	return HookDecision{}
}

func simctlDecision(verb string, replacement string) HookDecision {
	return HookDecision{
		Block: true,
		Reason: fmt.Sprintf(
			"Blocked `simctl %s`: Simulators on this Mac are managed by RN Devtools and shared with other agents. Use the rndevtools MCP tools or CLI instead: %s. `simctl list` and other read-only verbs are still allowed.",
			verb, replacement),
	}
}

func metroDecision() HookDecision {
	return HookDecision{
		Block:  true,
		Reason: "Blocked starting Metro by hand: port 8081 is shared with other agents. Use the rndevtools `lane` tool (operation up, with this worktree's absolute path) and RN Devtools will start Metro on a leased port and open the dev client against it.",
	}
}

// commandName is the program a word names: its basename, without a version a
// package runner pins (expo@latest).
func commandName(word string) string {
	name := baseName(word)
	if at := strings.IndexByte(name, '@'); at > 0 {
		name = name[:at]
	}
	return name
}

// maxSimctlOptions bounds how many arguments after simctl are read for its
// subcommand: it takes a few global options before it, and a line of 1 MiB
// can chain tens of thousands of simctl words, each of which would read all
// the ones after it.
const maxSimctlOptions = 8

// simctlVerb is the subcommand among simctl's arguments, after its global
// options (`simctl [--set <path>] [--profiles <path>] <subcommand>`).
func simctlVerb(arguments []string) string {
	for index := 0; index < len(arguments) && index < maxSimctlOptions; index++ {
		switch argument := arguments[index]; {
		case argument == "--set" || argument == "--profiles":
			index++
		case strings.HasPrefix(argument, "-"):
		default:
			return argument
		}
	}
	return ""
}

// firstOperand is the first argument that is not an option.
func firstOperand(arguments []string) string {
	for _, argument := range arguments {
		if !strings.HasPrefix(argument, "-") {
			return argument
		}
	}
	return ""
}

// SessionEndPayload is what both agents send a SessionEnd hook on stdin. The
// session id names whose lanes and claims to release; cwd, the session's
// working directory, lets the desktop also release what that session holds
// under an MCP identity it shares with other sessions.
type SessionEndPayload struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
}

// ReadSessionEnd parses a SessionEnd payload. Unparseable input yields an
// empty id; the caller then falls back to the session variables in its
// environment, and releases nothing if those are absent too.
func ReadSessionEnd(input io.Reader) SessionEndPayload {
	var payload SessionEndPayload
	_ = json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&payload)
	return payload
}
