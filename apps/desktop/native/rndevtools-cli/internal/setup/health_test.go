package setup

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func healthFixture(t *testing.T) HealthOptions {
	t.Helper()
	home := t.TempDir()
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real
	}
	return HealthOptions{Home: home, Executable: filepath.Join(home, "RN Devtools.app", "rndevtools")}
}
func healthPut(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
func healthFinding(t *testing.T, options HealthOptions, client, rule string) HealthFinding {
	t.Helper()
	report, err := CheckAgents(options)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range report.Findings {
		if f.Client == client && f.Rule == rule {
			return f
		}
	}
	t.Fatalf("missing %s %s: %+v", client, rule, report.Findings)
	return HealthFinding{}
}
func healthRepair(t *testing.T, options HealthOptions, client, rule string) HealthPlan {
	t.Helper()
	f := healthFinding(t, options, client, rule)
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ApplyAgentFix(options, plan.ID); err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestAgentHealthFreshAndPostSetup(t *testing.T) {
	options := healthFixture(t)
	before, err := CheckAgents(options)
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range before.Clients {
		if client.Connection != "needs-setup" || client.Configuration != "attention" {
			t.Fatalf("fresh client marked ready: %+v", client)
		}
	}
	if _, err = Apply(Options{Home: options.Home, Executable: options.Executable, Agents: []Agent{AgentClaude, AgentCodex}, SkipLink: true}); err != nil {
		t.Fatal(err)
	}
	after, err := CheckAgents(options)
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range after.Clients {
		if client.Connection != "configured" || client.Hooks != "installed-unverified" {
			t.Fatalf("post-setup wrong: %+v", client)
		}
	}
	for _, client := range []string{"codex", "claude"} {
		healthRepair(t, options, client, "routing")
	}
	final, _ := CheckAgents(options)
	for _, client := range final.Clients {
		if client.Configuration != "checked" {
			t.Fatalf("not checked: %+v", final.Findings)
		}
	}
	if strings.Contains(strings.Join(final.Limitations, " "), "trust") == false {
		t.Fatal("must distinguish installation from trust")
	}
}

func TestAgentHealthCodexHookPolicyIsNotAnEventDocument(t *testing.T) {
	options := healthFixture(t)
	healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[hooks.notifications]\nenabled = true\n")
	report, _ := CheckAgents(options)
	ids := map[string]bool{}
	for _, f := range report.Findings {
		if f.Rule == "unsupported-config" || ids[f.ID] {
			t.Fatalf("invalid finding: %+v", f)
		}
		ids[f.ID] = true
	}
}

func TestAgentHealthReportsToolFiltersAndDisabledHooksWithoutChangingPolicy(t *testing.T) {
	options := healthFixture(t)
	healthPut(t, filepath.Join(options.Home, ".codex/config.toml"), "[mcp_servers.rndevtools]\ncommand='/example/rndevtools'\nargs=['mcp']\nenabled_tools=['doctor']\n")
	healthPut(t, filepath.Join(options.Home, ".claude/settings.json"), `{"disableAllHooks":true}`)
	for client, rule := range map[string]string{"codex": "tool-filter", "claude": "hooks-disabled"} {
		if f := healthFinding(t, options, client, rule); f.FixLabel != "" {
			t.Fatal("policy must not be changed by a repair")
		}
	}
}

func TestAgentHealthClaudeUsesCanonicalProjectIdentity(t *testing.T) {
	options := healthFixture(t)
	project := filepath.Join(options.Home, "real-project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	options.Project = filepath.Join(options.Home, "project-link")
	if err := os.Symlink(project, options.Project); err != nil {
		t.Fatal(err)
	}
	healthPut(t, filepath.Join(options.Home, ".claude.json"), `{"mcpServers":{"simview":{"command":"simview"}}}`)
	report, _ := CheckAgents(options)
	for _, f := range report.Findings {
		if f.Client == "claude" && strings.HasPrefix(f.Rule, "controller-") {
			plan, err := PlanAgentFix(options, f.ID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = ApplyAgentFix(options, plan.ID); err != nil {
				t.Fatal(err)
			}
			raw, _, _ := healthRead(filepath.Join(options.Home, ".claude.json"))
			doc, _ := healthDecode(raw, "json")
			disabled, _ := healthGet(doc, "projects", project, "disabledMcpServers")
			if !healthContains(disabled, "simview") {
				t.Fatal("disable did not target real cwd")
			}
			return
		}
	}
	t.Fatal("controller missing")
}

func TestAgentHealthProjectPluginOverrideAndUnsupportedShapes(t *testing.T) {
	options := healthFixture(t)
	options.Project = filepath.Join(options.Home, "project")
	file := filepath.Join(options.Home, ".codex", "config.toml")
	healthPut(t, file, "[plugins.simview]\nenabled=false\n[projects."+`"`+options.Project+`"`+"]\ntrust_level='trusted'\n")
	projectFile := filepath.Join(options.Project, ".codex", "config.toml")
	healthPut(t, projectFile, "[plugins.simview]\nenabled=true\n")
	f := healthFinding(t, options, "codex", "plugin-controller")
	if f.file != projectFile || f.Scope != "Selected project (Codex)" {
		t.Fatalf("wrong scope: %+v", f)
	}
	healthRepair(t, options, "codex", "plugin-controller")
	raw, _, _ := healthRead(projectFile)
	projectDoc, _ := healthDecode(raw, "toml")
	pluginEnabled, _ := healthGet(projectDoc, "plugins", "simview", "enabled")
	if pluginEnabled != false {
		t.Fatalf("project not disabled: %s", raw)
	}
	for _, content := range []string{"mcp_servers = 'invalid'", "[plugins]\nsimview='invalid'"} {
		healthPut(t, file, content)
		report, err := CheckAgents(options)
		if err != nil {
			t.Fatal(err)
		}
		for _, client := range report.Clients {
			if client.ID == "codex" && client.Configuration != "not-checked" {
				t.Fatal("invalid schema accepted")
			}
		}
		for _, finding := range report.Findings {
			if finding.Client == "codex" && finding.FixLabel != "" {
				t.Fatal("fix offered for invalid schema")
			}
		}
	}
}

func TestAgentHealthClaudeProjectMCPDisabledAndUnknownEnabledFlag(t *testing.T) {
	options := healthFixture(t)
	options.Project = filepath.Join(options.Home, "project")
	healthPut(t, filepath.Join(options.Project, ".mcp.json"), `{"mcpServers":{"simview":{"command":"simview","enabled":false}}}`)
	settingsFile := filepath.Join(options.Project, ".claude", "settings.local.json")
	healthPut(t, settingsFile, `{"disabledMcpjsonServers":["simview"]}`)
	report, _ := CheckAgents(options)
	for _, f := range report.Findings {
		if f.Client == "claude" && strings.HasPrefix(f.Rule, "controller") {
			t.Fatal("disabled project MCP reported enabled")
		}
	}
	healthPut(t, settingsFile, `{}`)
	report, _ = CheckAgents(options)
	found := false
	for _, f := range report.Findings {
		if f.Client == "claude" && strings.HasPrefix(f.Rule, "controller") {
			found = true
		}
	}
	if !found {
		t.Fatal("unsupported Claude enabled=false must not hide a controller")
	}
}

func TestAgentHealthControllerFixUndoBothClients(t *testing.T) {
	for _, client := range []string{"codex", "claude"} {
		t.Run(client, func(t *testing.T) {
			options := healthFixture(t)
			file := filepath.Join(options.Home, ".codex", "config.toml")
			original := "# keep my comments\nmodel = 'example-model'\n[plugins.\"simview@tools\"]\nenabled = true\n[plugins.\"simview@tools\".mcp_servers.simview.tools.tap]\napproval_mode = 'prompt'\n[mcp_servers.cloud.env]\nSECRET = 'sensitive-fixture'\n"
			if client == "claude" {
				file = filepath.Join(options.Home, ".claude", "settings.json")
				original = `{"enabledPlugins":{"simview@tools":true,"docs@tools":true},"env":{"SECRET":"sensitive-fixture"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo custom"}]}]}}`
			}
			healthPut(t, file, original)
			plan := healthRepair(t, options, client, "plugin-controller")
			raw, _, _ := healthRead(file)
			format := "toml"
			if client == "claude" {
				format = "json"
			}
			doc, err := healthDecode(raw, format)
			if err != nil {
				t.Fatal(err)
			}
			if client == "codex" {
				v, _ := healthGet(doc, "plugins", "simview@tools", "enabled")
				if v != false || !bytes.Contains(raw, []byte("# keep my comments")) {
					t.Fatal("toggle or comment preservation failed")
				}
			} else {
				v, _ := healthGet(doc, "enabledPlugins", "simview@tools")
				if v != false {
					t.Fatal("plugin still enabled")
				}
			}
			report, _ := CheckAgents(options)
			encoded, _ := json.Marshal(report)
			if bytes.Contains(encoded, []byte("sensitive-fixture")) {
				t.Fatal("secret disclosed")
			}
			if _, err = UndoAgentFix(options, plan.ID); err != nil {
				t.Fatal(err)
			}
			restored, _, _ := healthRead(file)
			if string(restored) != original {
				t.Fatal("undo did not restore exact original")
			}
			if _, err = UndoAgentFix(options, plan.ID); err == nil {
				t.Fatal("double undo must fail")
			}
		})
	}
}

func TestAgentHealthUndoPreservesLaterUnrelatedSettings(t *testing.T) {
	for _, client := range []string{"codex", "claude"} {
		t.Run(client, func(t *testing.T) {
			options := healthFixture(t)
			file := filepath.Join(options.Home, ".codex", "config.toml")
			format := "toml"
			original := "[plugins.\"simview@tools\"]\nenabled = true\n"
			if client == "claude" {
				file = filepath.Join(options.Home, ".claude", "settings.json")
				format = "json"
				original = `{"enabledPlugins":{"simview@tools":true}}`
			}
			healthPut(t, file, original)
			plan := healthRepair(t, options, client, "plugin-controller")
			raw, _, _ := healthRead(file)
			next, err := healthWriteValues(raw, format, []healthValue{{Keys: []string{"unrelated", "theme"}, After: "dark", AfterPresent: true}}, false)
			if err != nil {
				t.Fatal(err)
			}
			healthPut(t, file, string(next))
			if _, err = UndoAgentFix(options, plan.ID); err != nil {
				t.Fatal(err)
			}
			raw, _, _ = healthRead(file)
			doc, _ := healthDecode(raw, format)
			v, _ := healthGet(doc, "unrelated", "theme")
			if v != "dark" {
				t.Fatal("lost unrelated edit")
			}
		})
	}
}

func TestAgentHealthRejectsStalePlanAndChangedUndo(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".codex", "config.toml")
	healthPut(t, file, "[plugins.simview]\nenabled=true\n")
	f := healthFinding(t, options, "codex", "plugin-controller")
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	healthPut(t, file, "# another client edited this\n[plugins.simview]\nenabled=true\n")
	if _, err = ApplyAgentFix(options, plan.ID); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("stale plan: %v", err)
	}
	plan = healthRepair(t, options, "codex", "plugin-controller")
	healthPut(t, file, "[plugins.simview]\nenabled=true\nmodel='new-value'\n")
	if _, err = UndoAgentFix(options, plan.ID); err == nil {
		t.Fatal("undo overwrote touched setting")
	}
}

func TestAgentHealthTOMLLayouts(t *testing.T) {
	for name, raw := range map[string]string{
		"quoted":  "# comment\n[mcp_servers.\"simview.example\"]\ncommand='simview'\nenabled=true # note\n[mcp_servers.\"simview.example\".env]\nTOKEN='retained'\n",
		"inline":  "mcp_servers = { \"simview.example\" = { command = 'simview', enabled = true, env = { TOKEN = 'retained' } } }\n",
		"dotted":  "mcp_servers.\"simview.example\".command = 'simview'\nmcp_servers.\"simview.example\".enabled = true\n",
		"missing": "[mcp_servers.\"simview.example\"]\ncommand='simview'\n",
	} {
		t.Run(name, func(t *testing.T) {
			next, err := healthTOMLValue([]byte(raw), []string{"mcp_servers", "simview.example", "enabled"}, false, true)
			if err != nil {
				t.Fatal(err)
			}
			doc, err := healthDecode(next, "toml")
			if err != nil {
				t.Fatal(err)
			}
			value, _ := healthGet(doc, "mcp_servers", "simview.example", "enabled")
			if value != false {
				t.Fatal("not disabled")
			}
		})
	}
}

func TestAgentHealthScopeAndDisabledIntegrations(t *testing.T) {
	options := healthFixture(t)
	options.Project = filepath.Join(options.Home, "project")
	_ = os.MkdirAll(options.Project, 0o700)
	healthPut(t, filepath.Join(options.Home, ".claude.json"), `{"mcpServers":{"alias":{"command":"npx","args":["ios-simulator-mcp"]},"supabase":{"url":"https://example.com/mcp"}},"projects":{}}`)
	f := healthFinding(t, options, "claude", "controller-"+healthHash([]byte("alias"))[:8])
	if f.Scope != "Selected project (Claude Code)" {
		t.Fatal(f.Scope)
	}
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	report, err := ApplyAgentFix(options, plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, finding := range report.Findings {
		if strings.HasPrefix(finding.Rule, "controller") {
			t.Fatal("disabled MCP still conflicts")
		}
	}
	global := options
	global.Project = ""
	report, _ = CheckAgents(global)
	found := false
	for _, finding := range report.Findings {
		if finding.Rule == "controller" {
			found = true
			if finding.FixLabel != "" {
				t.Fatal("must not invent global Claude disable setting")
			}
		}
	}
	if !found {
		t.Fatal("project toggle disabled other projects")
	}
}

func TestAgentHealthMalformedAndUntrustedConfigsHaveNoFixes(t *testing.T) {
	for _, kind := range []string{"malformed", "untrusted"} {
		t.Run(kind, func(t *testing.T) {
			options := healthFixture(t)
			healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[plugins.simview]\nenabled=true\n")
			if kind == "malformed" {
				healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "secret = [ 'private-value'\n")
			} else {
				options.Project = filepath.Join(options.Home, "project")
				healthPut(t, filepath.Join(options.Project, ".codex", "config.toml"), "[mcp_servers.maestro]\ncommand='maestro'\n")
			}
			report, err := CheckAgents(options)
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range report.Findings {
				if f.Client == "codex" && f.FixLabel != "" {
					t.Fatal("ambiguous configuration offered automatic fix")
				}
			}
			raw, _ := json.Marshal(report)
			if bytes.Contains(raw, []byte("private-value")) {
				t.Fatal("parse error leaked content")
			}
		})
	}
}

func TestAgentHealthReadOnlyScanAndPrivateHistory(t *testing.T) {
	options := healthFixture(t)
	if _, err := CheckAgents(options); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(healthStateDir(options)); !os.IsNotExist(err) {
		t.Fatal("scan created state")
	}
	f := healthFinding(t, options, "codex", "routing")
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{healthStateDir(options), filepath.Join(healthStateDir(options), plan.ID+".json")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatal("repair data is not private")
		}
	}
	if _, err = ApplyAgentFix(options, "../../config"); err == nil {
		t.Fatal("accepted invalid identifier")
	}
}

func TestAgentHealthSymlinkAndChangedTarget(t *testing.T) {
	options := healthFixture(t)
	target := filepath.Join(options.Home, "dotfiles", "codex.toml")
	healthPut(t, target, "[plugins.simview]\nenabled=true\n")
	link := filepath.Join(options.Home, ".codex", "config.toml")
	_ = os.MkdirAll(filepath.Dir(link), 0o700)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	plan := healthRepair(t, options, "codex", "plugin-controller")
	info, _ := os.Lstat(link)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("destroyed symlink")
	}
	if _, err := UndoAgentFix(options, plan.ID); err != nil {
		t.Fatal(err)
	}
	f := healthFinding(t, options, "codex", "plugin-controller")
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(options.Home, "other.toml")
	healthPut(t, other, "[plugins.simview]\nenabled=true\n")
	_ = os.Remove(link)
	_ = os.Symlink(other, link)
	if _, err = ApplyAgentFix(options, plan.ID); err == nil {
		t.Fatal("followed replaced target")
	}
}

func TestAgentHealthConnectionAndHookFixesPreserveCustomPolicy(t *testing.T) {
	options := healthFixture(t)
	healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[mcp_servers.rndevtools]\ncommand='/old/rndevtools'\nargs=['mcp']\nenabled=false\ntool_timeout_sec=900\n[mcp_servers.rndevtools.env]\nCUSTOM='kept'\n")
	healthPut(t, filepath.Join(options.Home, ".claude.json"), `{"mcpServers":{"rndevtools":{"command":"/old/rndevtools","args":["mcp"],"env":{"CUSTOM":"kept"}}}}`)
	for _, client := range []string{"codex", "claude"} {
		healthRepair(t, options, client, "connection")
		healthRepair(t, options, client, "hooks")
	}
	raw, _, _ := healthRead(filepath.Join(options.Home, ".codex", "config.toml"))
	doc, _ := healthDecode(raw, "toml")
	value, _ := healthGet(doc, "mcp_servers", "rndevtools", "tool_timeout_sec")
	if value != int64(900) {
		t.Fatal("changed timeout")
	}
	value, _ = healthGet(doc, "mcp_servers", "rndevtools", "env", "CUSTOM")
	if value != "kept" {
		t.Fatal("lost env")
	}
}

func TestAgentHealthSkillReviewDoesNotRewriteVendorContent(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".agents", "skills", "expo-demo", "SKILL.md")
	content := "---\nname: expo-demo\n---\n```sh\nxcrun simctl install booted ./App.app\n```\n"
	healthPut(t, file, content)
	f := healthFinding(t, options, "codex", "skill-routing")
	if f.FixLabel != "" || f.Severity != "review" {
		t.Fatal("text became an automatic disable")
	}
	raw, _, _ := healthRead(file)
	if string(raw) != content {
		t.Fatal("modified vendor skill")
	}
}

func TestAgentHealthFindsXcodeBuildMCPAsASimulatorController(t *testing.T) {
	// XcodeBuildMCP (npm package and binary xcodebuildmcp, run as
	// `xcodebuildmcp mcp` or through npx) boots, builds onto, and drives
	// Simulators, so it overlaps RN Devtools' holds like ios-simulator does.
	options := healthFixture(t)
	healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[mcp_servers.xcodebuildmcp]\ncommand = \"/opt/homebrew/bin/xcodebuildmcp\"\nargs = [\"mcp\"]\n[mcp_servers.apple-build]\ncommand = \"npx\"\nargs = [\"-y\", \"xcodebuildmcp@latest\", \"mcp\"]\n")
	healthPut(t, filepath.Join(options.Home, ".claude.json"), `{"mcpServers":{"XcodeBuildMCP":{"type":"stdio","command":"xcodebuildmcp","args":["mcp"]}}}`)
	report, err := CheckAgents(options)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]int{}
	for _, f := range report.Findings {
		if strings.HasPrefix(f.Rule, "controller") && f.Title == "XcodeBuildMCP can also control simulators" {
			found[f.Client]++
		}
	}
	if found["codex"] != 2 || found["claude"] != 1 {
		t.Fatalf("XcodeBuildMCP controllers found: %v in %+v", found, report.Findings)
	}
}

// healthStoredRepair writes a repair record for options' scope with the given
// id and apply time, as ApplyAgentFix stores one.
func healthStoredRepair(t *testing.T, options HealthOptions, id string, appliedAt int64) {
	t.Helper()
	j := healthJournal{Home: options.Home, Project: options.Project, Executable: options.Executable,
		Plan:    HealthPlan{ID: id, Client: "codex", Title: "Disable plugin in Codex"},
		Receipt: HealthReceipt{ID: id, Client: "codex", Title: "Disable plugin in Codex", Scope: "All Codex projects", AppliedAt: appliedAt, Status: "applied"},
		Before:  []byte("[plugins.simview]\nenabled = true\n"), Format: "toml"}
	if err := healthSaveReceipt(options, j); err != nil {
		t.Fatal(err)
	}
}

func healthHistoryFiles(t *testing.T, options HealthOptions) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(healthStateDir(options))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	files := map[string]bool{}
	for _, entry := range entries {
		files[entry.Name()] = true
	}
	return files
}

func TestAgentHealthListsRepairsNewestFirstWithinTheLimit(t *testing.T) {
	// Repair ids are random, so the order of their files says nothing about
	// when they were applied: the newest repair must be listed even when its
	// id sorts after thirty-two older ones.
	options := healthFixture(t)
	for i := 1; i <= 40; i++ {
		healthStoredRepair(t, options, fmt.Sprintf("check-%032x", i), int64(1_000+i))
	}
	newest := "check-" + strings.Repeat("f", 32)
	healthStoredRepair(t, options, newest, 9_000)
	report, err := CheckAgents(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Repairs) != 32 || report.Repairs[0].ID != newest {
		t.Fatalf("want the newest of 41 repairs first, 32 in all; got %d starting with %+v", len(report.Repairs), report.Repairs[0])
	}
	for i := 1; i < len(report.Repairs); i++ {
		if report.Repairs[i-1].AppliedAt < report.Repairs[i].AppliedAt {
			t.Fatalf("repairs are not newest first: %+v", report.Repairs)
		}
	}
	// Applying another repair keeps only the newest 32 records of the scope.
	healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[plugins.simview]\nenabled=true\n")
	plan := healthRepair(t, options, "codex", "plugin-controller")
	files := healthHistoryFiles(t, options)
	summaries := 0
	for name := range files {
		if strings.HasSuffix(name, ".summary.json") {
			summaries++
			if !files[strings.TrimSuffix(name, ".summary.json")+".json"] {
				t.Fatalf("summary %s kept without its record", name)
			}
		}
	}
	if summaries != 32 || !files[plan.ID+".summary.json"] || !files[newest+".json"] || files[fmt.Sprintf("check-%032x", 10)+".json"] {
		t.Fatalf("history after a repair: %v", files)
	}
}

func TestAgentHealthDeletesPreviewsAndOriginalBytesItNoLongerNeeds(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".codex", "config.toml")
	healthPut(t, file, "[plugins.simview]\nenabled=true\n[mcp_servers.cloud.env]\nTOKEN='sensitive-fixture'\n")
	f := healthFinding(t, options, "codex", "plugin-controller")
	stale, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A preview the user cancelled, or never applied, expires after five
	// minutes; so does the temporary file of a write that was interrupted.
	old := time.Now().Add(-10 * time.Minute)
	leftover := filepath.Join(healthStateDir(options), ".rndevtools-setup-123456")
	healthPut(t, leftover, "TOKEN='sensitive-fixture'")
	for _, path := range []string{filepath.Join(healthStateDir(options), stale.ID+".json"), leftover} {
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := CheckAgents(options); err != nil {
		t.Fatal(err)
	}
	files := healthHistoryFiles(t, options)
	if files[stale.ID+".json"] || files[filepath.Base(leftover)] || !files[fresh.ID+".json"] {
		t.Fatalf("expired previews must go and fresh ones stay: %v", files)
	}
	// Once a repair is undone, its copy of the original file is not needed.
	if _, err := ApplyAgentFix(options, fresh.ID); err != nil {
		t.Fatal(err)
	}
	report, err := UndoAgentFix(options, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	files = healthHistoryFiles(t, options)
	if files[fresh.ID+".json"] || files[fresh.ID+".summary.json"] {
		t.Fatalf("undo must delete the repair's record: %v", files)
	}
	for _, repair := range report.Repairs {
		if repair.ID == fresh.ID {
			t.Fatalf("an undone repair is still offered: %+v", report.Repairs)
		}
	}
	for name := range files {
		raw, _ := os.ReadFile(filepath.Join(healthStateDir(options), name))
		if bytes.Contains(raw, []byte("sensitive-fixture")) {
			t.Fatalf("%s still holds the original configuration", name)
		}
	}
}

func TestAgentHealthPlanNamesTheFileItWritesThroughALink(t *testing.T) {
	// A dotfiles link is edited where it points; the preview says so.
	options := healthFixture(t)
	target := filepath.Join(options.Home, "dotfiles", "codex.toml")
	healthPut(t, target, "[plugins.simview]\nenabled=true\n")
	link := filepath.Join(options.Home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	plan, err := PlanAgentFix(options, healthFinding(t, options, "codex", "plugin-controller").ID)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Source != "~/.codex/config.toml" || plan.Target != "~/dotfiles/codex.toml" {
		t.Fatalf("the preview must name the file it writes: %+v", plan)
	}
	// A plain file is written where it is, and the preview names it once.
	healthPut(t, filepath.Join(options.Home, ".claude", "settings.json"), `{"enabledPlugins":{"simview@tools":true}}`)
	plan, err = PlanAgentFix(options, healthFinding(t, options, "claude", "plugin-controller").ID)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Target != "" {
		t.Fatalf("a plain file needs no second name: %+v", plan)
	}
}

func TestAgentHealthOffersNoProjectRepairThatWritesOutsideTheProject(t *testing.T) {
	// A repository can commit .claude/settings.local.json as a link to the
	// user's own settings. A "Selected project" repair through it would edit
	// every project, so none is offered, and the user settings stay as they are.
	options := healthFixture(t)
	options.Project = filepath.Join(options.Home, "code", "example-app")
	global := filepath.Join(options.Home, ".claude", "settings.json")
	original := `{"enabledPlugins":{"simview@tools":true}}`
	healthPut(t, global, original)
	local := filepath.Join(options.Project, ".claude", "settings.local.json")
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../../.claude/settings.json", local); err != nil {
		t.Fatal(err)
	}
	f := healthFinding(t, options, "claude", "plugin-controller")
	if f.Scope != "Selected project (Claude Code)" || f.FixLabel != "" || !strings.Contains(f.Detail, "outside the project") || !strings.Contains(f.Detail, "~/.claude/settings.json") {
		t.Fatalf("a project repair that writes outside the project must not be offered: %+v", f)
	}
	if _, err := PlanAgentFix(options, f.ID); err == nil {
		t.Fatal("planned a project repair outside the project")
	}
	f.FixLabel = "Disable plugin in Claude"
	if _, err := prepareHealthFix(options, f); err == nil || !strings.Contains(err.Error(), "outside the project") {
		t.Fatalf("prepare must refuse it too: %v", err)
	}
	if string(mustRead(t, global)) != original {
		t.Fatal("user settings changed")
	}
}

func TestAgentHealthRaisesAShortCodexToolTimeoutAsSetupDoes(t *testing.T) {
	// Setup raises a Codex tool timeout below 240 s, which a cold lane or
	// Supabase start over MCP can exceed; the check and its repair agree.
	for _, row := range []struct {
		setting string
		flagged bool
		want    any
	}{
		{"tool_timeout_sec = 60\n", true, int64(codexToolTimeoutSeconds)},
		{"tool_timeout_sec = 0\n", true, int64(codexToolTimeoutSeconds)},
		{"", true, int64(codexToolTimeoutSeconds)},
		{"tool_timeout_sec = 240\n", false, int64(240)},
		{"tool_timeout_sec = 900\n", false, int64(900)},
	} {
		options := healthFixture(t)
		file := filepath.Join(options.Home, ".codex", "config.toml")
		healthPut(t, file, "[mcp_servers.rndevtools]\ncommand = "+tomlString(options.Executable)+"\nargs = [\"mcp\"]\n"+row.setting)
		report, err := CheckAgents(options)
		if err != nil {
			t.Fatal(err)
		}
		flagged := false
		for _, f := range report.Findings {
			flagged = flagged || (f.Client == "codex" && f.Rule == "connection")
		}
		if flagged != row.flagged {
			t.Fatalf("%q: connection finding %v, want %v", row.setting, flagged, row.flagged)
		}
		if row.flagged {
			healthRepair(t, options, "codex", "connection")
		}
		raw, _, _ := healthRead(file)
		doc, _ := healthDecode(raw, "toml")
		if value, _ := healthGet(doc, "mcp_servers", "rndevtools", "tool_timeout_sec"); value != row.want {
			t.Fatalf("%q: timeout %#v after the check, want %#v", row.setting, value, row.want)
		}
		merged, err := mergeCodexServer(raw, options.Executable)
		if err != nil || !bytes.Equal(merged, raw) {
			t.Fatalf("%q: setup would still change the repaired configuration:\n%s", row.setting, merged)
		}
	}
}
