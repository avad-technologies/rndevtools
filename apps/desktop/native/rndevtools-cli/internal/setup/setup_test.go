package setup

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/adalloul0928/rndevtools-cli/internal/mcp"
)

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("%s: %v\n%s", path, err, raw)
	}
	return document
}

func write(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func actions(report Report) map[string]string {
	out := map[string]string{}
	for _, change := range report.Changes {
		out[filepath.Base(filepath.Dir(change.Path))+"/"+filepath.Base(change.Path)] = change.Action
	}
	return out
}

func TestApplyInstallsEverythingAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	executable := filepath.Join(home, "RN Devtools.app", "rndevtools")
	write(t, executable, "#!/bin/sh\n")
	// Pre-existing configuration that must survive untouched.
	write(t, filepath.Join(home, ".claude.json"), `{"mcpServers":{"other":{"command":"other"}},"theme":"dark"}`)
	write(t, filepath.Join(home, ".claude", "settings.json"), `{"model":"opus","hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"say done"}]}]}}`)
	write(t, filepath.Join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.other.env]\nX = \"1\"\n")
	if err := os.MkdirAll(filepath.Join(home, ".kiro", "settings"), 0o755); err != nil {
		t.Fatal(err)
	}

	first, err := Apply(Options{Home: home, Executable: executable})
	if err != nil {
		t.Fatal(err)
	}
	got := actions(first)
	for key, want := range map[string]string{
		"bin/rndevtools": "create",
		home[len(filepath.Dir(home))+1:] + "/.claude.json": "update",
		".claude/settings.json":                            "update",
		".codex/config.toml":                               "update",
		".codex/hooks.json":                                "create",
		"settings/mcp.json":                                "create",
		"skills/rndevtools-lanes":                          "create",
	} {
		if got[key] != want {
			t.Fatalf("%s: action %q, want %q (all: %v)", key, got[key], want, got)
		}
	}
	if _, ok := got[".cursor/mcp.json"]; ok {
		t.Fatal("Cursor must not be configured when ~/.cursor does not exist")
	}

	claude := readJSON(t, filepath.Join(home, ".claude.json"))
	if claude["theme"] != "dark" {
		t.Fatal("unrelated Claude settings were lost")
	}
	servers := claude["mcpServers"].(map[string]any)
	if _, ok := servers["other"]; !ok {
		t.Fatal("other MCP server was lost")
	}
	entry := servers["rndevtools"].(map[string]any)
	if entry["command"] != executable || entry["args"].([]any)[0] != "mcp" || entry["type"] != "stdio" {
		t.Fatalf("claude entry: %v", entry)
	}

	settings := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	if settings["model"] != "opus" {
		t.Fatal("unrelated Claude settings.json keys were lost")
	}
	hooks := settings["hooks"].(map[string]any)
	if len(hooks["Stop"].([]any)) != 1 {
		t.Fatal("existing Stop hook was lost")
	}
	pre := hooks["PreToolUse"].([]any)
	if len(pre) != 1 || pre[0].(map[string]any)["matcher"] != "Bash" {
		t.Fatalf("PreToolUse hook: %v", pre)
	}
	if !strings.Contains(pre[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string), "hook pre-tool-use") {
		t.Fatalf("hook command: %v", pre[0])
	}
	end := hooks["SessionEnd"].([]any)
	if len(end) != 1 || !strings.Contains(end[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string), "hook session-end") {
		t.Fatalf("SessionEnd hook: %v", end)
	}
	if end[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)["timeout"] != float64(3) {
		t.Fatalf("SessionEnd must fit Codex's 3 s cap: %v", end[0])
	}

	// Codex gets the same two hooks in its own file, and setup says they need trusting.
	codexHooks := readJSON(t, filepath.Join(home, ".codex", "hooks.json"))["hooks"].(map[string]any)
	if len(codexHooks["PreToolUse"].([]any)) != 1 || len(codexHooks["SessionEnd"].([]any)) != 1 {
		t.Fatalf("codex hooks: %v", codexHooks)
	}
	if !first.CodexHooksNeedTrust {
		t.Fatal("setup must report that Codex hooks need trusting")
	}
	for _, change := range first.Changes {
		if strings.HasSuffix(change.Path, ".codex/hooks.json") && !strings.Contains(change.Detail, "/hooks") {
			t.Fatalf("codex hook change must mention /hooks: %+v", change)
		}
	}

	codex, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if !strings.Contains(string(codex), "model = \"gpt-5\"") || !strings.Contains(string(codex), "[mcp_servers.other.env]\nX = \"1\"") {
		t.Fatalf("codex config lost content:\n%s", codex)
	}
	if !strings.Contains(string(codex), "[mcp_servers.rndevtools]\ncommand = \""+executable+"\"\nargs = [\"mcp\"]\ntool_timeout_sec = 240\n") {
		t.Fatalf("codex config lacks rndevtools block with the raised tool timeout:\n%s", codex)
	}

	kiro := readJSON(t, filepath.Join(home, ".kiro", "settings", "mcp.json"))
	kiroEntry := kiro["mcpServers"].(map[string]any)["rndevtools"].(map[string]any)
	if kiroEntry["disabled"] != false || len(kiroEntry["autoApprove"].([]any)) == 0 {
		t.Fatalf("kiro entry: %v", kiroEntry)
	}
	// Kiro runs exactly the tools the server marks read-only without asking;
	// jobs (cancel) and slimming (apply, undo, restore) change state.
	approved := kiroEntry["autoApprove"].([]any)
	if want := mcp.ReadOnlyTools(); len(approved) != len(want) {
		t.Fatalf("autoApprove %v, want the read-only tools %v", approved, want)
	}
	for index, name := range mcp.ReadOnlyTools() {
		if approved[index] != name {
			t.Fatalf("autoApprove %v, want the read-only tools", approved)
		}
	}
	for _, tool := range approved {
		switch tool {
		case "input", "lane", "jobs", "slimming", "act", "release", "supabase":
			t.Fatalf("%v changes state and must not be auto-approved", tool)
		}
	}

	link, err := os.Readlink(filepath.Join(home, ".local", "bin", "rndevtools"))
	if err != nil || link != executable {
		t.Fatalf("symlink: %q %v", link, err)
	}
	for _, directory := range []string{".claude", ".agents", ".kiro"} {
		for _, name := range []string{"rndevtools-lanes", "rndevtools-supabase"} {
			skill, err := os.ReadFile(filepath.Join(home, directory, "skills", name, "SKILL.md"))
			if err != nil || !strings.Contains(string(skill), "name: "+name+"\n") {
				t.Fatalf("%s %s skill: %v", directory, name, err)
			}
		}
	}
	for _, change := range first.Changes {
		if strings.HasSuffix(change.Path, filepath.Join(".claude", "settings.json")) && !strings.Contains(change.Detail, "local Supabase") {
			t.Fatalf("the hook change must say what the Supabase rules do: %+v", change)
		}
	}

	second, err := Apply(Options{Home: home, Executable: executable})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range second.Changes {
		if change.Action != "unchanged" {
			t.Fatalf("second apply changed %s (%s: %s)", change.Path, change.Action, change.Detail)
		}
	}
	if second.CodexHooksNeedTrust {
		t.Fatal("unchanged hooks need no new trust")
	}
}

func TestApplyRepointsAndRefusesForeignFiles(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, "old", "rndevtools")
	current := filepath.Join(home, "new", "rndevtools")
	write(t, old, "")
	write(t, current, "")
	if _, err := Apply(Options{Home: home, Executable: old, Agents: []Agent{AgentClaude}, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	report, err := Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "update" || !strings.Contains(report.Changes[0].Detail, old) {
		t.Fatalf("link change: %+v", report.Changes[0])
	}
	link, _ := os.Readlink(filepath.Join(home, ".local", "bin", "rndevtools"))
	if link != current {
		t.Fatalf("symlink not repointed: %s", link)
	}
	servers := readJSON(t, filepath.Join(home, ".claude.json"))["mcpServers"].(map[string]any)
	if servers["rndevtools"].(map[string]any)["command"] != current {
		t.Fatal("MCP registration not repointed")
	}

	// A real file in the way is left alone and reported.
	if err := os.Remove(filepath.Join(home, ".local", "bin", "rndevtools")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, ".local", "bin", "rndevtools"), "someone else's")
	report, err = Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "skip" {
		t.Fatalf("foreign file: %+v", report.Changes[0])
	}
	content, _ := os.ReadFile(filepath.Join(home, ".local", "bin", "rndevtools"))
	if string(content) != "someone else's" {
		t.Fatal("foreign file was overwritten")
	}
}

func TestInvalidJSONIsSkippedNotClobbered(t *testing.T) {
	home := t.TempDir()
	executable := filepath.Join(home, "rndevtools")
	write(t, executable, "")
	write(t, filepath.Join(home, ".claude.json"), "{not json")
	report, err := Apply(Options{Home: home, Executable: executable, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "skip" {
		t.Fatalf("expected skip for invalid JSON: %+v", report.Changes[0])
	}
	content, _ := os.ReadFile(filepath.Join(home, ".claude.json"))
	if string(content) != "{not json" {
		t.Fatal("invalid file was rewritten")
	}
}

func TestCodexBlockIsReplacedInPlace(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".codex", "config.toml")
	write(t, path, "[mcp_servers.rndevtools]\ncommand = \"/stale/rndevtools\"\nargs = [\"mcp\"]\n\n[mcp_servers.rndevtools.env]\nA = \"b\"\n\n[other]\nkeep = true\n")
	report, err := Apply(Options{Home: home, Executable: "/fresh/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Changes[0].Action != "update" {
		t.Fatalf("%+v", report.Changes[0])
	}
	content, _ := os.ReadFile(path)
	text := string(content)
	if strings.Contains(text, "/stale/") || strings.Contains(text, "A = \"b\"") {
		t.Fatalf("stale rndevtools tables survived:\n%s", text)
	}
	if !strings.Contains(text, "[other]\nkeep = true") || strings.Count(text, "[mcp_servers.rndevtools]") != 1 {
		t.Fatalf("unexpected codex config:\n%s", text)
	}
	if strings.Count(text, "tool_timeout_sec = 240") != 1 {
		t.Fatalf("an upgraded block must carry the raised tool timeout once:\n%s", text)
	}
	// A block written before the timeout existed counts as stale and is
	// upgraded; a current one is left alone.
	again, err := Apply(Options{Home: home, Executable: "/fresh/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if again.Changes[0].Action != "unchanged" {
		t.Fatalf("a current block must be unchanged: %+v", again.Changes[0])
	}
}

func TestProjectModeInstallsSkillAndAgentsBlock(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	write(t, filepath.Join(project, "AGENTS.md"), "# My app\n\nExisting guidance.\n")
	report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude, AgentCodex}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{".claude", ".agents"} {
		if _, err := os.Stat(filepath.Join(project, directory, "skills", "rndevtools-lanes", "SKILL.md")); err != nil {
			t.Fatalf("%s project skill missing: %v", directory, err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills")); err == nil {
		t.Fatal("project mode must not install user-level skills")
	}
	agents, _ := os.ReadFile(filepath.Join(project, "AGENTS.md"))
	text := string(agents)
	if !strings.HasPrefix(text, "# My app\n\nExisting guidance.\n\n<!-- rndevtools:start -->") || !strings.Contains(text, "Never run `xcrun simctl boot`") {
		t.Fatalf("AGENTS.md:\n%s", text)
	}
	if !strings.Contains(report.AgentsBlock, "rndevtools:start") {
		t.Fatal("report must carry the block for manual installs")
	}

	// Editing the block later replaces between the markers rather than appending twice.
	write(t, filepath.Join(project, "AGENTS.md"), strings.Replace(text, "Never run", "NEVER EVER run", 1))
	if _, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	agents, _ = os.ReadFile(filepath.Join(project, "AGENTS.md"))
	if strings.Count(string(agents), "rndevtools:start") != 1 || strings.Contains(string(agents), "NEVER EVER") {
		t.Fatalf("block not replaced in place:\n%s", agents)
	}
}

func TestEveryEmbeddedSkillIsInstalled(t *testing.T) {
	names := skillNames()
	if len(names) != 2 || names[0] != "rndevtools-lanes" || names[1] != "rndevtools-supabase" {
		t.Fatalf("embedded skills: %v", names)
	}
	for _, name := range names {
		content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		text := string(content)
		if !strings.HasPrefix(text, "---\nname: "+name+"\ndescription: >\n") {
			t.Fatalf("%s: front matter must name the skill and describe it", name)
		}
	}
	supabase, _ := skillFiles.ReadFile("skills/rndevtools-supabase/SKILL.md")
	for _, phrase := range []string{
		"Supabase", "local database", "Postgres", "migration", "seed", "reset", "Studio", "logs",
		`rndevtools supabase --operation up --worktree "$PWD"`, "lane up", "--local",
		"--runtime native", "release --all", "Create or switch to your git branch first",
		"Never start or stop Supabase by hand while RN Devtools manages",
	} {
		if !strings.Contains(string(supabase), phrase) {
			t.Fatalf("the Supabase skill lacks %q", phrase)
		}
	}
	lanes, _ := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	for _, phrase := range []string{"--backend auto|off|required", "Never start Supabase by hand for a lane"} {
		if !strings.Contains(string(lanes), phrase) {
			t.Fatalf("the lanes skill lacks %q", phrase)
		}
	}
	// A hold gates what the desktop checks it for, not act or network, and
	// never a session's own recording.
	flat := strings.Join(strings.Fields(string(lanes)), " ")
	if strings.Contains(flat, "only the holder may boot, drive") || !strings.Contains(flat, "`act` and `network` are not gated") {
		t.Fatal("the lanes skill must say what a hold gates and that act and network are not")
	}
	if !strings.Contains(flat, "except for a recording you started yourself") ||
		!strings.Contains(flat, "`record --operation stop` or `jobs --operation cancel` always works on it") {
		t.Fatal("the lanes skill must say a session can always stop or cancel its own recording")
	}

	home := t.TempDir()
	report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true, SkipHook: true})
	if err != nil {
		t.Fatal(err)
	}
	installed := 0
	for _, change := range report.Changes {
		if strings.Contains(change.Path, filepath.Join(".agents", "skills")) {
			installed++
			if change.Action != "create" || !strings.Contains(change.Detail, filepath.Base(change.Path)) {
				t.Fatalf("skill change: %+v", change)
			}
		}
	}
	if installed != len(names) {
		t.Fatalf("%d of %d skills installed", installed, len(names))
	}
}

func TestAgentTextsAgreeOnAStartingBackendWithoutAJobId(t *testing.T) {
	// A Supabase start queued behind RN Devtools' own automatic start has no
	// jobId, so there is nothing to wait for. Every text that sends an agent to
	// wait for the jobId says the same about the start without one: wait a few
	// seconds and call up again.
	flat := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	skill := func(name string) string {
		content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		return flat(string(content))
	}
	tools := map[string]string{}
	for _, tool := range mcp.Tools() {
		tools[tool.Name] = flat(tool.Description)
	}
	for _, row := range []struct{ text, name, phrase string }{
		{skill("rndevtools-lanes"), "the lanes skill", "has none: wait a few seconds, then call `lane up` again"},
		{skill("rndevtools-supabase"), "the supabase skill", "has no `jobId`: wait a few seconds, then call `up` again"},
		{tools["lane"], "the lane tool", "without one call lane up again in a few seconds"},
		{tools["supabase"], "the supabase tool", "without one (the start is queued behind RN Devtools' own automatic start) call up again in a few seconds"},
	} {
		if !strings.Contains(row.text, row.phrase) {
			t.Errorf("%s lacks %q", row.name, row.phrase)
		}
	}
}

func TestAgentsBlockAddsLocalSupabaseOnlyForSupabaseProjects(t *testing.T) {
	home := t.TempDir()
	plain := filepath.Join(home, "plain")
	write(t, filepath.Join(plain, "AGENTS.md"), "# Plain\n")
	if _, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: plain, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true}); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(filepath.Join(plain, "AGENTS.md"))
	if strings.Contains(string(text), "Local Supabase") || !strings.Contains(string(text), "## iOS Simulators") {
		t.Fatalf("a project without supabase/config.toml gets the Simulator block only:\n%s", text)
	}
	if strings.Contains(AgentsBlock(""), "Local Supabase") {
		t.Fatal("the block for manual installs has no project, so no Supabase paragraph")
	}

	for lockfile, runner := range map[string]string{
		"pnpm-lock.yaml":    "pnpm exec supabase",
		"yarn.lock":         "yarn supabase",
		"bun.lock":          "bunx supabase",
		"package-lock.json": "npx supabase",
		"":                  "npx supabase",
	} {
		project := filepath.Join(home, "app-"+strings.ReplaceAll(lockfile, ".", "-"))
		write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
		if lockfile != "" {
			write(t, filepath.Join(project, lockfile), "")
		}
		report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true})
		if err != nil {
			t.Fatal(err)
		}
		agents, _ := os.ReadFile(filepath.Join(project, "AGENTS.md"))
		block := string(agents)
		for _, phrase := range []string{"## iOS Simulators", "## Local Supabase", "`" + runner + " start --runtime native`", "`supabase stop --all`", "`supabase status --env`", "`lane up`"} {
			if !strings.Contains(block, phrase) {
				t.Fatalf("%s: AGENTS.md lacks %q:\n%s", lockfile, phrase, block)
			}
		}
		if report.AgentsBlock != block {
			t.Fatalf("%s: the report must carry the block it wrote", lockfile)
		}
		if strings.Count(block, "<!-- rndevtools:start -->") != 1 || !strings.HasSuffix(block, "<!-- rndevtools:end -->\n") {
			t.Fatalf("%s: the paragraph belongs inside the markers:\n%s", lockfile, block)
		}
	}
}

func TestPlanWritesNothing(t *testing.T) {
	home := t.TempDir()
	report, err := Plan(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude, AgentCodex, AgentKiro}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Changes) == 0 {
		t.Fatal("plan must list changes")
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 0 {
		t.Fatalf("plan wrote files: %v", entries)
	}
}

// hookCommandOf is the command of the first hook in an event's last entry,
// which is where setup appends its own.
func hookCommandOf(t *testing.T, document map[string]any, event string) string {
	t.Helper()
	entries := document["hooks"].(map[string]any)[event].([]any)
	return entries[len(entries)-1].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
}

func TestHookCommandsRunFromAPackagedPathWithSpacesAndQuotes(t *testing.T) {
	home := t.TempDir()
	// A packaged install lives under "RN Devtools.app"; a copy may sit in a
	// folder whose name has an apostrophe.
	executable := filepath.Join(home, "Dev's Apps", "RN Devtools.app", "Contents", "Resources", "native", "rndevtools")
	write(t, executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$RNDEVTOOLS_TEST_ARGV\"\n")
	if err := os.Chmod(executable, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(Options{Home: home, Executable: executable, Agents: []Agent{AgentClaude, AgentCodex}, SkipLink: true}); err != nil {
		t.Fatal(err)
	}
	argv := filepath.Join(home, "argv.txt")
	// Claude Code runs a hook command with sh -c; Codex with $SHELL -lc.
	shells := [][]string{{"/bin/sh", "-c"}, {"/bin/bash", "--noprofile", "--norc", "-c"}, {"/bin/zsh", "-f", "-c"}}
	for _, file := range []string{filepath.Join(home, ".claude", "settings.json"), filepath.Join(home, ".codex", "hooks.json")} {
		document := readJSON(t, file)
		for event, want := range map[string]string{"PreToolUse": "hook\npre-tool-use\n", "SessionEnd": "hook\nsession-end\n"} {
			command := hookCommandOf(t, document, event)
			for _, shell := range shells {
				if _, err := os.Stat(shell[0]); err != nil {
					continue
				}
				write(t, argv, "")
				run := exec.Command(shell[0], append(shell[1:], command)...)
				run.Env = []string{"PATH=/usr/bin:/bin", "RNDEVTOOLS_TEST_ARGV=" + argv}
				if output, err := run.CombinedOutput(); err != nil {
					t.Fatalf("%s %q: %v\n%s", shell[0], command, err, output)
				}
				if got, _ := os.ReadFile(argv); string(got) != want {
					t.Fatalf("%s %q ran the CLI with %q, want %q", shell[0], command, got, want)
				}
			}
		}
	}
	// A path that needs no quotes keeps its plain form, so dev installs see
	// no churn (and Codex no new /hooks trust).
	if got := hookCommand("/Users/example/build/rndevtools", "pre-tool-use"); got != "/Users/example/build/rndevtools hook pre-tool-use" {
		t.Fatalf("plain path quoted: %q", got)
	}
}

func TestSetupReplacesTheUnquotedHooksEarlierBuildsWrote(t *testing.T) {
	home := t.TempDir()
	executable := "/Applications/RN Devtools.app/Contents/Resources/native/rndevtools"
	// What builds before quoting wrote for a packaged install: the shell split
	// it at the space, so it never ran.
	write(t, filepath.Join(home, ".claude", "settings.json"), `{"hooks":{`+
		`"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"`+executable+` hook pre-tool-use","timeout":5}]}],`+
		`"SessionEnd":[{"hooks":[{"type":"command","command":"`+executable+` hook session-end","timeout":3}]}]}}`)
	report, err := Apply(Options{Home: home, Executable: executable, Agents: []Agent{AgentClaude}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := actions(report)[".claude/settings.json"]; got != "update" {
		t.Fatalf("settings.json action %q", got)
	}
	document := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	for event, suffix := range map[string]string{"PreToolUse": " hook pre-tool-use", "SessionEnd": " hook session-end"} {
		entries := document["hooks"].(map[string]any)[event].([]any)
		if len(entries) != 1 {
			t.Fatalf("%s: the unquoted hook must be replaced, not kept beside the new one: %v", event, entries)
		}
		if command := hookCommandOf(t, document, event); command != "'"+executable+"'"+suffix {
			t.Fatalf("%s command %q", event, command)
		}
	}
}

func TestSetupKeepsOtherToolsHooksAndHooksBesideOurs(t *testing.T) {
	home := t.TempDir()
	old := "/Users/example/old/rndevtools"
	current := "/Users/example/new/rndevtools"
	other := `{"type":"command","command":"/opt/othertool/bin/othertool hook pre-tool-use"}`
	audit := `{"type":"command","command":"/Users/example/bin/audit-bash.sh"}`
	write(t, filepath.Join(home, ".claude", "settings.json"), `{"hooks":{`+
		`"PreToolUse":[{"matcher":"Bash","hooks":[`+other+`]},`+
		`{"matcher":"Bash","hooks":[{"type":"command","command":"`+old+` hook pre-tool-use","timeout":5},`+audit+`]}],`+
		`"SessionEnd":[{"hooks":[{"type":"command","command":"/opt/othertool/bin/othertool hook session-end"}]}]}}`)
	if _, err := Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipLink: true}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	text := string(raw)
	for _, kept := range []string{"/opt/othertool/bin/othertool hook pre-tool-use", "/opt/othertool/bin/othertool hook session-end", "/Users/example/bin/audit-bash.sh"} {
		if !strings.Contains(text, kept) {
			t.Fatalf("%s was dropped:\n%s", kept, text)
		}
	}
	if strings.Contains(text, old) {
		t.Fatalf("the old rndevtools hook survived:\n%s", text)
	}
	document := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	pre := document["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(pre) != 3 {
		t.Fatalf("want the other tool's entry, the audit entry, and ours: %v", pre)
	}
	beside := pre[1].(map[string]any)
	if beside["matcher"] != "Bash" || len(beside["hooks"].([]any)) != 1 {
		t.Fatalf("the entry the user shared with ours keeps its matcher and the audit hook only: %v", beside)
	}
	if command := hookCommandOf(t, document, "PreToolUse"); command != current+" hook pre-tool-use" {
		t.Fatalf("our hook: %q", command)
	}
	again, err := Apply(Options{Home: home, Executable: current, Agents: []Agent{AgentClaude}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := actions(again)[".claude/settings.json"]; got != "unchanged" {
		t.Fatalf("a second run must leave the hooks alone, got %q", got)
	}
}

func TestMalformedHookFilesAreLeftNotPanickedOn(t *testing.T) {
	home := t.TempDir()
	settings := filepath.Join(home, ".claude", "settings.json")
	write(t, settings, `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":["echo hi",null,1]}],"SessionEnd":[{"hooks":[null]},"stray"]}}`)
	if _, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude}, SkipLink: true}); err != nil {
		t.Fatal(err)
	}
	document := readJSON(t, settings)
	pre := document["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(pre) != 2 || len(pre[0].(map[string]any)["hooks"].([]any)) != 3 {
		t.Fatalf("the malformed entry stays as it was, and ours is added: %v", pre)
	}
	if end := document["hooks"].(map[string]any)["SessionEnd"].([]any); len(end) != 3 || end[1] != "stray" {
		t.Fatalf("SessionEnd: %v", end)
	}
	// A file that is JSON null is not a settings object: skipped, untouched.
	write(t, settings, "null\n")
	write(t, filepath.Join(home, ".claude.json"), "null")
	report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range report.Changes {
		if strings.HasSuffix(change.Path, ".claude.json") || strings.HasSuffix(change.Path, "settings.json") {
			if change.Action != "skip" {
				t.Fatalf("%s: %+v", change.Path, change)
			}
		}
	}
	if raw, _ := os.ReadFile(settings); string(raw) != "null\n" {
		t.Fatalf("a skipped file must not be rewritten: %q", raw)
	}
}

func TestSymlinkedConfigFilesAreEditedThroughTheLink(t *testing.T) {
	home := t.TempDir()
	dotfiles := filepath.Join(home, "dotfiles")
	write(t, filepath.Join(dotfiles, "claude-settings.json"), `{"model":"opus"}`)
	write(t, filepath.Join(dotfiles, "claude.json"), `{"theme":"dark"}`)
	write(t, filepath.Join(dotfiles, "codex", "config.toml"), "model = \"gpt-5\"\n")
	links := map[string]string{
		filepath.Join(home, ".claude", "settings.json"): filepath.Join(dotfiles, "claude-settings.json"),
		filepath.Join(home, ".claude.json"):             filepath.Join(dotfiles, "claude.json"),
		// A relative link, as stow makes them.
		filepath.Join(home, ".codex", "config.toml"): filepath.Join("..", "dotfiles", "codex", "config.toml"),
	}
	for link, target := range links {
		if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	project := filepath.Join(home, "repo")
	write(t, filepath.Join(project, "CLAUDE.md"), "# Repo\n")
	if err := os.Symlink("CLAUDE.md", filepath.Join(project, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	options := Options{Home: home, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude, AgentCodex}, Project: project, SkipLink: true}
	if _, err := Apply(options); err != nil {
		t.Fatal(err)
	}
	for link, target := range links {
		if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s is no longer a symlink", link)
		}
		if now, _ := os.Readlink(link); now != target {
			t.Fatalf("%s now points at %s", link, now)
		}
	}
	if !strings.Contains(string(mustRead(t, filepath.Join(dotfiles, "claude-settings.json"))), "hook pre-tool-use") ||
		!strings.Contains(string(mustRead(t, filepath.Join(dotfiles, "claude.json"))), `"rndevtools"`) ||
		!strings.Contains(string(mustRead(t, filepath.Join(dotfiles, "codex", "config.toml"))), "[mcp_servers.rndevtools]") {
		t.Fatal("the edits must land in the files the links point at")
	}
	if !strings.Contains(string(mustRead(t, filepath.Join(project, "CLAUDE.md"))), "<!-- rndevtools:start -->") {
		t.Fatal("AGENTS.md -> CLAUDE.md must put the block in CLAUDE.md")
	}
	again, err := Apply(options)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range again.Changes {
		if change.Action != "unchanged" {
			t.Fatalf("second apply changed %s (%s: %s)", change.Path, change.Action, change.Detail)
		}
	}

	// A dangling link, and one into a directory nobody may write, are left
	// alone and reported.
	other := t.TempDir()
	dangling := filepath.Join(other, ".claude.json")
	if err := os.Symlink(filepath.Join(other, "missing.json"), dangling); err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(other, "store")
	write(t, filepath.Join(store, "settings.json"), `{}`)
	if err := os.MkdirAll(filepath.Join(other, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(store, "settings.json"), filepath.Join(other, ".claude", "settings.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(store, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(store, 0o755) })
	report, err := Apply(Options{Home: other, Executable: "/x/rndevtools", Agents: []Agent{AgentClaude}, SkipLink: true})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Change{}
	for _, change := range report.Changes {
		got[filepath.Base(change.Path)] = change
	}
	if change := got[".claude.json"]; change.Action != "skip" || !strings.Contains(change.Detail, "does not exist") {
		t.Fatalf("dangling link: %+v", change)
	}
	if target, _ := os.Readlink(dangling); target != filepath.Join(other, "missing.json") {
		t.Fatal("the dangling link was replaced")
	}
	if os.Geteuid() != 0 {
		if change := got["settings.json"]; change.Action != "skip" || !strings.Contains(change.Detail, "cannot write") {
			t.Fatalf("read-only link target: %+v", change)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAgentsBlockReplacesOnlyOnePairedBlock(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	apply := func() Report {
		t.Helper()
		report, err := Apply(Options{Home: home, Executable: "/x/rndevtools", Project: project, Agents: []Agent{AgentClaude}, SkipLink: true, SkipHook: true})
		if err != nil {
			t.Fatal(err)
		}
		return report
	}
	agentsMD := filepath.Join(project, "AGENTS.md")
	// A team documents the block and quotes its start marker in prose.
	prose := "Setup adds a block that starts with `<!-- rndevtools:start -->`.\n"
	rules := "## Important team rules\n\nNever push to main.\n"
	write(t, agentsMD, "# Team\n\n"+prose+"\n"+rules)
	apply()
	// The block changes once the repo gains a Supabase project.
	write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	apply()
	text := string(mustRead(t, agentsMD))
	if !strings.Contains(text, prose) || !strings.Contains(text, rules) || !strings.Contains(text, "## Local Supabase") {
		t.Fatalf("the team's text must survive a block update:\n%s", text)
	}
	if strings.Count(text, "\n<!-- rndevtools:start -->\n") != 1 || strings.Count(text, "<!-- rndevtools:end -->") != 1 {
		t.Fatalf("one block, replaced in place:\n%s", text)
	}

	// Markers that do not pair up are not guessed at.
	for name, content := range map[string]string{
		"lost end marker":  "# Team\n\n<!-- rndevtools:start -->\n## iOS Simulators\nold\n\n## Release checklist\n\nTag it.\n",
		"two blocks":       "<!-- rndevtools:start -->\na\n<!-- rndevtools:end -->\n\n<!-- rndevtools:start -->\nb\n<!-- rndevtools:end -->\n",
		"end before start": "<!-- rndevtools:end -->\n\n<!-- rndevtools:start -->\n",
	} {
		write(t, agentsMD, content)
		var change Change
		for _, candidate := range apply().Changes {
			if candidate.Path == agentsMD {
				change = candidate
			}
		}
		if change.Action != "skip" || !strings.Contains(change.Detail, "do not pair up") {
			t.Fatalf("%s: %+v", name, change)
		}
		if got := string(mustRead(t, agentsMD)); got != content {
			t.Fatalf("%s: a skipped AGENTS.md must not be rewritten:\n%s", name, got)
		}
	}
}

func TestCodexTableLastInTheFileWithoutAFinalNewline(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".codex", "config.toml")
	for name, content := range map[string]string{
		"last key":        "model = \"x\"\n\n[mcp_servers.rndevtools]\ncommand = \"/old\"\nargs = [\"mcp\"]",
		"header only":     "model = \"x\"\n\n[mcp_servers.rndevtools]",
		"env table":       "[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.rndevtools]\ncommand = \"/old\"\n\n[mcp_servers.rndevtools.env]\nFOO = \"bar\"",
		"no table at all": "model = \"x\"",
	} {
		write(t, path, content)
		if _, err := Apply(Options{Home: home, Executable: "/fresh/rndevtools", Agents: []Agent{AgentCodex}, SkipLink: true, SkipHook: true}); err != nil {
			t.Fatal(err)
		}
		text := string(mustRead(t, path))
		before, _, found := strings.Cut(text, "[mcp_servers.rndevtools]")
		if !found || strings.Count(text, "[mcp_servers.rndevtools") != 1 {
			t.Fatalf("%s: want exactly our one table:\n%s", name, text)
		}
		if strings.Contains(before, "args") || strings.Contains(before, "FOO") || strings.Contains(text, "/old") {
			t.Fatalf("%s: the old table left keys behind:\n%s", name, text)
		}
		if !strings.HasSuffix(text, "command = \"/fresh/rndevtools\"\nargs = [\"mcp\"]\ntool_timeout_sec = 240\n") {
			t.Fatalf("%s: block:\n%s", name, text)
		}
	}
}

func TestTomlStringUsesTomlEscapes(t *testing.T) {
	for value, want := range map[string]string{
		"/Applications/RN Devtools.app/rndevtools": `"/Applications/RN Devtools.app/rndevtools"`,
		`/a "b" \c`:       `"/a \"b\" \\c"`,
		"/bell\a/del\x7f": `"/bell\u0007/del\u007F"`,
		"/tab\t/é":        `"/tab\t/é"`,
	} {
		if got := tomlString(value); got != want {
			t.Errorf("tomlString(%q) = %s, want %s", value, got, want)
		}
	}
}
