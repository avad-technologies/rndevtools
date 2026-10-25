// Package setup installs the CLI, MCP configuration, skills, and steering hooks.
// Plan previews changes; Apply merges configuration atomically, preserves unknown
// keys and symlinks, and never deletes files it did not create.
package setup

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"syscall"

	"github.com/adalloul0928/rndevtools-cli/internal/mcp"
)

//go:embed skills/*/SKILL.md
var skillFiles embed.FS

// skillNames lists the embedded skills by directory name, sorted, so the
// installed copies always match this build.
func skillNames() []string {
	entries, err := fs.ReadDir(skillFiles, "skills")
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

// Agent identifies one coding agent whose configuration setup edits.
type Agent string

const (
	AgentClaude Agent = "claude"
	AgentCodex  Agent = "codex"
	AgentCursor Agent = "cursor"
	AgentKiro   Agent = "kiro"
)

// Options select what to install.
type Options struct {
	// Home is the user's home directory; defaults to os.UserHomeDir.
	Home string
	// Executable is the absolute path of the verified rndevtools binary the
	// symlink and the MCP registrations point at.
	Executable string
	// Agents to configure. Empty means every agent whose configuration
	// directory already exists (so setup never creates ~/.cursor on a Mac
	// without Cursor), plus Claude and Codex always.
	Agents []Agent
	// Project, when set, receives .agents/skills, .claude/skills, and an
	// AGENTS.md block instead of the user-level locations.
	Project string
	// SkipLink leaves PATH alone.
	SkipLink bool
	// SkipHook leaves Claude Code's hooks alone.
	SkipHook bool
}

// Change is one filesystem edit setup makes or would make.
type Change struct {
	Path   string `json:"path"`
	Action string `json:"action"` // create, update, unchanged, skip
	Detail string `json:"detail,omitempty"`
}

// Report is the outcome of Plan or Apply.
type Report struct {
	Executable string   `json:"executable"`
	Changes    []Change `json:"changes"`
	// AgentsBlock is the text to paste into a project's AGENTS.md or CLAUDE.md
	// when setup did not write one.
	AgentsBlock string `json:"agentsBlock"`
	// CodexHooksNeedTrust is set when setup wrote or changed Codex hooks, which
	// Codex will not run until the user reviews them with /hooks.
	CodexHooksNeedTrust bool `json:"codexHooksNeedTrust,omitempty"`
}

// Plan computes the edits without writing anything.
func Plan(options Options) (Report, error) {
	return run(options, false)
}

// Apply performs the edits.
func Apply(options Options) (Report, error) {
	return run(options, true)
}

func run(options Options, write bool) (Report, error) {
	if options.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Report{}, fmt.Errorf("resolve home directory: %w", err)
		}
		options.Home = home
	}
	if !filepath.IsAbs(options.Executable) {
		return Report{}, errors.New("the rndevtools executable path must be absolute")
	}
	agents := options.Agents
	if len(agents) == 0 {
		agents = detectAgents(options.Home)
	}
	report := Report{Executable: options.Executable, AgentsBlock: AgentsBlock(options.Project)}
	record := func(change Change, err error) error {
		if err != nil {
			return err
		}
		report.Changes = append(report.Changes, change)
		return nil
	}

	if !options.SkipLink {
		if err := record(linkExecutable(options, write)); err != nil {
			return report, err
		}
	}
	for _, agent := range agents {
		switch agent {
		case AgentClaude:
			if err := record(writeJSONServers(filepath.Join(options.Home, ".claude.json"), "mcpServers", options.Executable, nil, write)); err != nil {
				return report, err
			}
			if !options.SkipHook {
				if err := record(installHooks(filepath.Join(options.Home, ".claude", "settings.json"), options.Executable, write)); err != nil {
					return report, err
				}
			}
		case AgentCodex:
			if err := record(writeCodexServer(filepath.Join(options.Home, ".codex", "config.toml"), options.Executable, write)); err != nil {
				return report, err
			}
			if !options.SkipHook {
				// Codex requires the user to trust each new hook once via /hooks;
				// the report's Detail says so because setup cannot do it for them.
				change, err := installHooks(filepath.Join(options.Home, ".codex", "hooks.json"), options.Executable, write)
				if err != nil {
					return report, err
				}
				if change.Action == "create" || change.Action == "update" {
					change.Detail += ". Codex runs new hooks only after you trust them: open Codex and run /hooks"
					report.CodexHooksNeedTrust = true
				}
				report.Changes = append(report.Changes, change)
			}
		case AgentCursor:
			if err := record(writeJSONServers(filepath.Join(options.Home, ".cursor", "mcp.json"), "mcpServers", options.Executable, nil, write)); err != nil {
				return report, err
			}
		case AgentKiro:
			// Kiro runs the tools the MCP server marks read-only without asking, so
			// the two lists cannot drift; tools that change state still ask.
			extra := map[string]any{"disabled": false, "autoApprove": mcp.ReadOnlyTools()}
			if err := record(writeJSONServers(filepath.Join(options.Home, ".kiro", "settings", "mcp.json"), "mcpServers", options.Executable, extra, write)); err != nil {
				return report, err
			}
		default:
			return report, fmt.Errorf("unknown agent %q", agent)
		}
	}
	for _, directory := range skillDirectories(options, agents) {
		for _, name := range skillNames() {
			if err := record(installSkill(directory, name, write)); err != nil {
				return report, err
			}
		}
	}
	if options.Project != "" {
		if err := record(installAgentsBlock(options.Project, write)); err != nil {
			return report, err
		}
	}
	return report, nil
}

// detectAgents returns Claude and Codex unconditionally (their configuration
// lives in files setup can create) plus any other agent whose directory exists.
func detectAgents(home string) []Agent {
	agents := []Agent{AgentClaude, AgentCodex}
	if exists(filepath.Join(home, ".cursor")) {
		agents = append(agents, AgentCursor)
	}
	if exists(filepath.Join(home, ".kiro")) {
		agents = append(agents, AgentKiro)
	}
	return agents
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// MARK: - PATH

func linkExecutable(options Options, write bool) (Change, error) {
	directory := filepath.Join(options.Home, ".local", "bin")
	link := filepath.Join(directory, "rndevtools")
	change := Change{Path: link}
	if existing, err := os.Readlink(link); err == nil {
		if existing == options.Executable {
			change.Action = "unchanged"
			change.Detail = "symlink already points at this build"
			return change, nil
		}
		change.Action = "update"
		change.Detail = fmt.Sprintf("re-point symlink from %s", existing)
	} else if exists(link) {
		change.Action = "skip"
		change.Detail = "a file that is not a symlink is already installed there; remove it to let setup link the CLI"
		return change, nil
	} else {
		change.Action = "create"
		change.Detail = "symlink to the verified CLI (add ~/.local/bin to PATH if it is not already)"
	}
	if !write {
		return change, nil
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return change, err
	}
	temporary := link + ".tmp"
	_ = os.Remove(temporary)
	if err := os.Symlink(options.Executable, temporary); err != nil {
		return change, err
	}
	if err := os.Rename(temporary, link); err != nil {
		_ = os.Remove(temporary)
		return change, err
	}
	return change, nil
}

// MARK: - MCP registrations

func serverEntry(executable string, extra map[string]any) map[string]any {
	entry := map[string]any{
		"type":    "stdio",
		"command": executable,
		"args":    []any{"mcp"},
	}
	for key, value := range extra {
		entry[key] = value
	}
	return entry
}

func writeJSONServers(path string, key string, executable string, extra map[string]any, write bool) (Change, error) {
	change := Change{Path: path}
	document := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(bytes.TrimSpace(raw)) > 0 {
			// A bare null decodes to a nil map, which cannot take our entry.
			if err := json.Unmarshal(raw, &document); err != nil || document == nil {
				change.Action = "skip"
				change.Detail = "not valid JSON; fix it by hand, then rerun setup"
				return change, nil
			}
		}
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	servers, _ := document[key].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	wanted := serverEntry(executable, extra)
	if existing, ok := servers["rndevtools"]; ok && jsonEqual(existing, wanted) {
		change.Action = "unchanged"
		change.Detail = "rndevtools MCP server already registered"
		return change, nil
	}
	change.Detail = "register the rndevtools MCP server (" + executable + " mcp)"
	servers["rndevtools"] = wanted
	document[key] = servers
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return change, err
	}
	return commit(change, path, append(encoded, '\n'), 0o600, write)
}

func jsonEqual(a any, b any) bool {
	left, errA := json.Marshal(a)
	right, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(left, right)
}

var codexServerBlock = regexp.MustCompile(`(?ms)^\[mcp_servers\.rndevtools(?:\.[A-Za-z0-9_]+)?\]\n(?:[^\[\n][^\n]*\n|\n)*`)

// codexToolTimeoutSeconds raises Codex's per-call MCP timeout (60 s by
// default) to the CLI's lane budget, so a cold lane up or Supabase start over
// MCP is not cut off while the desktop is still working.
const codexToolTimeoutSeconds = 240

// writeCodexServer edits ~/.codex/config.toml textually: it owns only the
// `[mcp_servers.rndevtools]` table and leaves every other byte alone.
func writeCodexServer(path string, executable string, write bool) (Change, error) {
	change := Change{Path: path}
	block := fmt.Sprintf("[mcp_servers.rndevtools]\ncommand = %s\nargs = [\"mcp\"]\ntool_timeout_sec = %d\n", tomlString(executable), codexToolTimeoutSeconds)
	raw, err := os.ReadFile(path)
	var content string
	switch {
	case err == nil:
		content = string(raw)
		// codexServerBlock matches whole lines. Without a final newline the
		// table's last line would survive the strip as a stray key in
		// whatever table comes before ours.
		if content != "" && !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	stripped := codexServerBlock.ReplaceAllString(content, "")
	if stripped != content && strings.Contains(content, block) {
		change.Action = "unchanged"
		change.Detail = "rndevtools MCP server already registered"
		return change, nil
	}
	change.Detail = "register the rndevtools MCP server (" + executable + " mcp)"
	stripped = strings.TrimRight(stripped, "\n")
	if stripped != "" {
		stripped += "\n\n"
	}
	next := stripped + block
	return commit(change, path, []byte(next), 0o600, write)
}

// tomlString quotes value as a TOML basic string. Go's %q is close but not
// the same: it writes \a, \v, and \x escapes, which TOML does not accept.
func tomlString(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for _, character := range value {
		switch {
		case character == '"' || character == '\\':
			builder.WriteByte('\\')
			builder.WriteRune(character)
		case character == '\t':
			builder.WriteString(`\t`)
		case character == '\n':
			builder.WriteString(`\n`)
		case character == '\r':
			builder.WriteString(`\r`)
		case character < 0x20 || character == 0x7f:
			fmt.Fprintf(&builder, `\u%04X`, character)
		default:
			builder.WriteRune(character)
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

// MARK: - Agent hooks

// hookEvents are the `rndevtools hook` events setup has ever installed;
// claude-pre-tool-use is the name builds before Codex support wrote.
var hookEvents = []string{"pre-tool-use", "session-end", "claude-pre-tool-use"}

// hookCommand is the command line a hook runs. Both Claude Code and Codex
// send the same JSON on stdin (`tool_name`, `tool_input.command`,
// `session_id`) and read exit status 2 with stderr as "block", so one handler
// serves both. Both also hand the line to a shell, so the executable is
// quoted when it needs it: a packaged install lives under "RN Devtools.app",
// and an unquoted space would make the shell look for a program named "RN".
func hookCommand(executable string, event string) string {
	return quotePath(executable) + " hook " + event
}

// plainPath is a path that sh, bash, and zsh all read as one literal word.
var plainPath = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

func quotePath(path string) string {
	if plainPath.MatchString(path) {
		return path
	}
	return "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
}

// hookDocument returns the PreToolUse guard and SessionEnd release entries in
// the shape both agents' hook files use.
func hookDocument(executable string) (preToolUse map[string]any, sessionEnd map[string]any) {
	preToolUse = map[string]any{
		"matcher": "Bash",
		"hooks": []any{map[string]any{
			"type":    "command",
			"command": hookCommand(executable, "pre-tool-use"),
			"timeout": 5,
		}},
	}
	sessionEnd = map[string]any{
		"hooks": []any{map[string]any{
			"type":    "command",
			"command": hookCommand(executable, "session-end"),
			// Codex caps SessionEnd at 3 s; the release is one socket round trip.
			"timeout": 3,
		}},
	}
	return preToolUse, sessionEnd
}

// installHooks merges the two rndevtools hooks into a hooks document
// (Claude Code's ~/.claude/settings.json or Codex's ~/.codex/hooks.json). It
// replaces the hooks earlier setups wrote and leaves everything else alone:
// other tools' hooks, and hooks the user added to the same entry as ours.
func installHooks(path string, executable string, write bool) (Change, error) {
	change := Change{Path: path}
	document := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(bytes.TrimSpace(raw)) > 0 {
			// A bare null decodes to a nil map, which cannot take our hooks.
			if err := json.Unmarshal(raw, &document); err != nil || document == nil {
				change.Action = "skip"
				change.Detail = "not valid JSON; fix it by hand, then rerun setup"
				return change, nil
			}
		}
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	hooks, _ := document["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	preToolUse, sessionEnd := hookDocument(executable)
	changed := false
	for event, wanted := range map[string]map[string]any{"PreToolUse": preToolUse, "SessionEnd": sessionEnd} {
		entries, _ := hooks[event].([]any)
		kept, current, removed := withoutRndevtoolsHooks(entries, wanted, executable)
		if !current {
			kept = append(kept, wanted)
		}
		changed = changed || removed || !current
		hooks[event] = kept
	}
	if !changed {
		change.Action = "unchanged"
		change.Detail = "rndevtools hooks already installed"
		return change, nil
	}
	change.Detail = "add a PreToolUse hook that redirects simctl boot/shutdown/openurl/install/launch/io and hand-started Metro to rndevtools and, while local Supabase is turned on in RN Devtools, keeps hand-run supabase commands native and off other agents' stacks, and a SessionEnd hook that releases the session's lanes, claims, and stacks"
	document["hooks"] = hooks
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return change, err
	}
	return commit(change, path, append(encoded, '\n'), 0o600, write)
}

// withoutRndevtoolsHooks takes the hooks earlier setups wrote out of one
// event's entries. The first entry that already equals wanted stays
// (current). An entry that also holds other hooks keeps them, and anything
// that is not an entry with a hooks list is left exactly as it is.
func withoutRndevtoolsHooks(entries []any, wanted map[string]any, executable string) (kept []any, current bool, removed bool) {
	kept = make([]any, 0, len(entries)+1)
	for _, entry := range entries {
		object, isObject := entry.(map[string]any)
		hooks, isList := object["hooks"].([]any)
		if !isObject || !isList {
			kept = append(kept, entry)
			continue
		}
		if !current && jsonEqual(entry, wanted) {
			current = true
			kept = append(kept, entry)
			continue
		}
		others := make([]any, 0, len(hooks))
		for _, hook := range hooks {
			if !isRndevtoolsHook(hook, executable) {
				others = append(others, hook)
			}
		}
		switch {
		case len(others) == len(hooks):
			kept = append(kept, entry)
		case len(others) > 0:
			trimmed := make(map[string]any, len(object))
			for key, value := range object {
				trimmed[key] = value
			}
			trimmed["hooks"] = others
			kept = append(kept, trimmed)
			removed = true
		default:
			removed = true
		}
	}
	return kept, current, removed
}

// isRndevtoolsHook reports a hook object an earlier setup wrote: a command
// that runs `hook <event>` for one of hookEvents with an executable named
// rndevtools (or this one), quoted as this build writes it or raw as earlier
// builds did, even when the raw path had a space and never ran.
func isRndevtoolsHook(hook any, executable string) bool {
	object, ok := hook.(map[string]any)
	if !ok {
		return false
	}
	command, ok := object["command"].(string)
	if !ok {
		return false
	}
	for _, event := range hookEvents {
		raw, found := strings.CutSuffix(command, " hook "+event)
		if !found {
			continue
		}
		if filepath.IsAbs(raw) && !strings.ContainsAny(raw, ";&|\n") && isRndevtoolsExecutable(raw, executable) {
			return true
		}
		segments := splitShell(command)
		if len(segments) == 1 && len(segments[0].words) == 3 && isRndevtoolsExecutable(segments[0].words[0], executable) {
			return true
		}
	}
	return false
}

func isRndevtoolsExecutable(path string, executable string) bool {
	return path == executable || baseName(path) == "rndevtools"
}

// MARK: - Skill

func skillDirectories(options Options, agents []Agent) []string {
	var directories []string
	base := options.Home
	claude := filepath.Join(base, ".claude", "skills")
	agentsDirectory := filepath.Join(base, ".agents", "skills")
	if options.Project != "" {
		claude = filepath.Join(options.Project, ".claude", "skills")
		agentsDirectory = filepath.Join(options.Project, ".agents", "skills")
	}
	for _, agent := range agents {
		switch agent {
		case AgentClaude:
			directories = append(directories, claude)
		case AgentCodex:
			// Codex scans .agents/skills in the repository and $HOME/.agents/skills.
			directories = append(directories, agentsDirectory)
		case AgentKiro:
			if options.Project == "" {
				directories = append(directories, filepath.Join(base, ".kiro", "skills"))
			}
		}
	}
	sort.Strings(directories)
	return slices.Compact(directories)
}

func installSkill(skillsDirectory string, name string, write bool) (Change, error) {
	target := filepath.Join(skillsDirectory, name)
	change := Change{Path: target}
	content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
	if err != nil {
		return change, err
	}
	existing, err := os.ReadFile(filepath.Join(target, "SKILL.md"))
	switch {
	case err == nil && bytes.Equal(existing, content):
		change.Action = "unchanged"
		change.Detail = "skill already current"
		return change, nil
	case err == nil:
		change.Action = "update"
		change.Detail = "refresh SKILL.md to this build's version"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
		change.Detail = "install the " + name + " skill"
	default:
		return change, err
	}
	return commit(change, filepath.Join(target, "SKILL.md"), content, 0o644, write)
}

// MARK: - AGENTS.md

const (
	agentsBlockStart = "<!-- rndevtools:start -->"
	agentsBlockEnd   = "<!-- rndevtools:end -->"
)

// AgentsBlock is the project-instruction text for project ("" for none). It
// is short on purpose: the MCP tool descriptions and the skills carry the
// detail; this only has to make an agent reach for them. A project with
// supabase/config.toml also gets the Local Supabase paragraph, worded for
// when RN Devtools is not managing a worktree, since agents must then start
// their own stack the safe way.
func AgentsBlock(project string) string {
	block := agentsBlockStart + `
## iOS Simulators

Simulators on this Mac are managed by RN Devtools. Use the ` + "`rndevtools`" + ` MCP
tools (or the ` + "`rndevtools`" + ` CLI) for anything involving a Simulator: ` + "`lane up`" + ` runs
this worktree on its own Simulator with its own Metro port; ` + "`input`" + ` and
` + "`capture`" + ` drive and observe the device. Never run ` + "`xcrun simctl boot`" + `,
` + "`shutdown`" + `, ` + "`openurl`" + `, ` + "`install`" + `, ` + "`launch`" + `, or start Metro by hand: other
agents share these devices and the desktop app owns their ports and claims.
`
	if project != "" && isRegularFile(filepath.Join(project, "supabase", "config.toml")) {
		block += `
## Local Supabase

Each worktree gets its own local Supabase stack (native runtime, loopback
only). When RN Devtools manages this worktree, use the ` + "`rndevtools`" + ` ` + "`supabase`" + `
tool (operation up) or ` + "`lane up`" + `, which connects the app; otherwise start it
yourself from the worktree with ` + "`" + projectRunner(project) + ` start --runtime native` + "`" + `
(never without ` + "`--runtime native`" + `). Use ` + "`supabase … --local`" + ` for migrations,
` + "`db reset`" + `, and ` + "`gen types`" + `, against your local stack rather than a hosted
project unless the user asks. Never run ` + "`supabase stop --all`" + `,
` + "`supabase stack destroy`" + `, or ` + "`pkill postgres`" + `, and never write
` + "`supabase status --env`" + ` into a .env file.
`
	}
	return block + agentsBlockEnd + "\n"
}

// projectRunner is how the project runs its own pinned supabase CLI, from
// the lockfile its package manager wrote; npx when there is none.
func projectRunner(project string) string {
	for _, candidate := range []struct{ lockfile, runner string }{
		{"pnpm-lock.yaml", "pnpm exec supabase"},
		{"yarn.lock", "yarn supabase"},
		{"bun.lock", "bunx supabase"},
		{"bun.lockb", "bunx supabase"},
		{"package-lock.json", "npx supabase"},
	} {
		if isRegularFile(filepath.Join(project, candidate.lockfile)) {
			return candidate.runner
		}
	}
	return "npx supabase"
}

// agentsBlockSpan finds the block setup owns in content: a line that is the
// start marker and, after it, a line that is the end marker. A marker quoted
// inside other text is not a marker line. found is false when content has no
// marker line at all; ok is false when the marker lines do not pair up as
// one block (a second start, a start without its end), and then setup will
// not guess which text is its own.
func agentsBlockSpan(content string) (start int, end int, found bool, ok bool) {
	var starts, ends [][2]int
	for offset := 0; offset < len(content); {
		lineEnd, next := len(content), len(content)
		if index := strings.IndexByte(content[offset:], '\n'); index >= 0 {
			lineEnd, next = offset+index, offset+index+1
		}
		switch strings.TrimRight(content[offset:lineEnd], " \t\r") {
		case agentsBlockStart:
			starts = append(starts, [2]int{offset, next})
		case agentsBlockEnd:
			ends = append(ends, [2]int{offset, next})
		}
		offset = next
	}
	switch {
	case len(starts) == 0 && len(ends) == 0:
		return 0, 0, false, true
	case len(starts) == 1 && len(ends) == 1 && starts[0][0] < ends[0][0]:
		return starts[0][0], ends[0][1], true, true
	}
	return 0, 0, false, false
}

func installAgentsBlock(project string, write bool) (Change, error) {
	path := filepath.Join(project, "AGENTS.md")
	change := Change{Path: path}
	block := AgentsBlock(project)
	raw, err := os.ReadFile(path)
	var content string
	switch {
	case err == nil:
		content = string(raw)
		change.Action = "update"
	case errors.Is(err, fs.ErrNotExist):
		change.Action = "create"
	default:
		return change, err
	}
	if strings.Contains(content, block) {
		change.Action = "unchanged"
		change.Detail = "AGENTS.md block already current"
		return change, nil
	}
	start, end, found, ok := agentsBlockSpan(content)
	if !ok {
		change.Action = "skip"
		change.Detail = "its rndevtools markers do not pair up as one block (one start line, then one end line); fix them by hand, then rerun setup"
		return change, nil
	}
	change.Detail = "add the RN Devtools Simulator block between rndevtools markers"
	var next string
	if found {
		next = content[:start] + block + content[end:]
	} else {
		next = strings.TrimRight(content, "\n")
		if next != "" {
			next += "\n\n"
		}
		next += block
	}
	return commit(change, path, []byte(next), 0o644, write)
}

// MARK: - Files

// commit writes content to path for Apply and only reports the change for
// Plan. A path setup cannot write through (see writeTarget) becomes a skip
// that says why, in both.
func commit(change Change, path string, content []byte, mode os.FileMode, write bool) (Change, error) {
	target, reason := writeTarget(path)
	if reason != "" {
		change.Action = "skip"
		change.Detail = reason
		return change, nil
	}
	if !write {
		return change, nil
	}
	return change, writeFileAtomically(target, content, mode)
}

// writeAccess is W_OK for access(2).
const writeAccess = 0x2

// writeTarget is the file an edit of path lands in: path itself, or, when it
// is a symlink (stow, chezmoi, and home-manager make them), the file the link
// resolves to, so the link survives the rename. reason explains why setup
// leaves a link alone instead: it dangles, or it points into a directory
// this user cannot write, such as a read-only store.
func writeTarget(path string) (target string, reason string) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return path, ""
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", "a symlink to a file that does not exist; restore its target, then rerun setup"
	}
	if syscall.Access(filepath.Dir(resolved), writeAccess) != nil {
		return "", "a symlink into a directory you cannot write; add the rndevtools settings where that file is generated, then rerun setup"
	}
	return resolved, ""
}

func writeFileAtomically(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil {
		// Preserve the operator's existing permissions on files we only edit.
		mode = info.Mode().Perm()
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".rndevtools-setup-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	cleanup := func() { _ = os.Remove(name) }
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		cleanup()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, path); err != nil {
		cleanup()
		return err
	}
	return nil
}
