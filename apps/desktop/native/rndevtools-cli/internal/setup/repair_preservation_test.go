package setup

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupPreservesUnsupportedHookShapes(t *testing.T) {
	for _, original := range []string{
		`{"hooks":"managed externally","model":"retained"}`,
		`{"hooks":{"PreToolUse":{"policy":"retained"}}}`,
		`{"hooks":{"SessionEnd":null}}`,
	} {
		t.Run(original, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "settings.json")
			healthPut(t, file, original)
			for _, apply := range []bool{false, true} {
				change, err := installHooks(file, "/example/rndevtools", apply)
				if err != nil || change.Action != "skip" {
					t.Fatalf("unsupported hooks should be skipped: %+v %v", change, err)
				}
				if got := string(mustRead(t, file)); got != original {
					t.Fatalf("unsupported policy was overwritten: %s", got)
				}
			}
		})
	}
}

func TestSetupAndRepairPreserveUnrelatedJSONNumbers(t *testing.T) {
	options := healthFixture(t)
	claude := filepath.Join(options.Home, ".claude.json")
	hooks := filepath.Join(options.Home, ".claude", "settings.json")
	for _, file := range []string{claude, hooks} {
		healthPut(t, file, `{"customId":9007199254740993,"customDecimal":1.234567890123456789}`)
	}
	if _, err := Apply(Options{Home: options.Home, Executable: options.Executable, Agents: []Agent{AgentClaude}, SkipLink: true}); err != nil {
		t.Fatal(err)
	}
	assertNumbers := func(file string) {
		t.Helper()
		raw := mustRead(t, file)
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		if string(doc["customId"]) != "9007199254740993" || string(doc["customDecimal"]) != "1.234567890123456789" {
			t.Fatalf("unknown numbers changed: %s", raw)
		}
	}
	assertNumbers(claude)
	assertNumbers(hooks)
	healthPut(t, hooks, `{"enabledPlugins":{"simview@tools":true},"customId":9007199254740993,"customDecimal":1.234567890123456789}`)
	plan := healthRepair(t, options, "claude", "plugin-controller")
	assertNumbers(hooks)
	current := mustRead(t, hooks)
	current = bytes.Replace(current, []byte(`"customId"`), []byte(`"unrelated": true, "customId"`), 1)
	healthPut(t, hooks, string(current))
	if _, err := UndoAgentFix(options, plan.ID); err != nil {
		t.Fatal(err)
	}
	assertNumbers(hooks)
}

func TestAgentHealthRejectsChangedAncestorSymlink(t *testing.T) {
	for _, applyFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "apply", true: "undo"}[applyFirst], func(t *testing.T) {
			options := healthFixture(t)
			original := "[plugins.simview]\nenabled=true\n"
			first, second := filepath.Join(options.Home, "first"), filepath.Join(options.Home, "second")
			for _, dir := range []string{first, second} {
				healthPut(t, filepath.Join(dir, "config.toml"), original)
			}
			link := filepath.Join(options.Home, ".codex")
			if err := os.Symlink(first, link); err != nil {
				t.Fatal(err)
			}
			finding := healthFinding(t, options, "codex", "plugin-controller")
			plan, err := PlanAgentFix(options, finding.ID)
			if err != nil {
				t.Fatal(err)
			}
			if applyFirst {
				if _, err = ApplyAgentFix(options, plan.ID); err != nil {
					t.Fatal(err)
				}
				healthPut(t, filepath.Join(second, "config.toml"), string(mustRead(t, filepath.Join(first, "config.toml"))))
			}
			before := mustRead(t, filepath.Join(second, "config.toml"))
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(second, link); err != nil {
				t.Fatal(err)
			}
			if applyFirst {
				_, err = UndoAgentFix(options, plan.ID)
			} else {
				_, err = ApplyAgentFix(options, plan.ID)
			}
			if err == nil {
				t.Fatal("repair followed a replaced ancestor symlink")
			}
			if !bytes.Equal(before, mustRead(t, filepath.Join(second, "config.toml"))) {
				t.Fatal("new target changed")
			}
		})
	}
}

func TestAgentHealthRoutingUsesCompleteCurrentMarkerBlock(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".codex", "AGENTS.md")
	for _, original := range []string{
		"Example: `" + agentsBlockStart + "` and `" + agentsBlockEnd + "`\n",
		agentsBlockStart + "\nold instructions\n" + agentsBlockEnd + "\n",
	} {
		healthPut(t, file, original)
		plan := healthRepair(t, options, "codex", "routing")
		if _, err := UndoAgentFix(options, plan.ID); err != nil {
			t.Fatal(err)
		}
		if string(mustRead(t, file)) != original {
			t.Fatal("routing undo changed instructions")
		}
	}
	healthPut(t, file, agentsBlockStart+"\n"+agentsBlockStart+"\n"+agentsBlockEnd+"\n")
	f := healthFinding(t, options, "codex", "routing-incomplete")
	if f.FixLabel != "" || !strings.Contains(f.Detail, "marker") {
		t.Fatalf("malformed block repairable: %+v", f)
	}
}

func TestAgentHealthTOMLQuotedEqualsKey(t *testing.T) {
	raw := []byte(`mcp_servers."simview=tools".command = 'simview'` + "\nmcp_servers.\"simview=tools\".enabled = true\n")
	next, err := healthTOMLValue(raw, []string{"mcp_servers", "simview=tools", "enabled"}, false, true)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := healthDecode(next, "toml")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := healthGet(doc, "mcp_servers", "simview=tools", "enabled")
	if got != false {
		t.Fatal("quoted key not updated")
	}
}

func TestAgentHealthUndoPreservesTOMLValueTypesFromJournal(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".codex", "config.toml")
	original := "[mcp_servers.rndevtools]\ncommand='/old/rndevtools'\nargs=[9007199254740993, 1979-05-27, 07:32:00]\n"
	// A malformed transport can be repaired, and Undo must retain its original
	// values even after the JSON journal is loaded and another setting changes.
	healthPut(t, file, original)
	plan := healthRepair(t, options, "codex", "connection")
	raw := mustRead(t, file)
	healthPut(t, file, "model = 'new-model'\n"+string(raw))
	if _, err := UndoAgentFix(options, plan.ID); err != nil {
		t.Fatal(err)
	}
	doc, err := healthDecode(mustRead(t, file), "toml")
	if err != nil {
		t.Fatal(err)
	}
	before, _ := healthDecode([]byte(original), "toml")
	got, _ := healthGet(doc, "mcp_servers", "rndevtools", "args")
	want, _ := healthGet(before, "mcp_servers", "rndevtools", "args")
	if !jsonEqual(got, want) {
		t.Fatalf("TOML types or precision changed: %#v != %#v", got, want)
	}
	if doc["model"] != "new-model" {
		t.Fatal("unrelated edit lost")
	}
}

func TestAgentHealthFailedWriteKeepsRecoverablePreparedReceipt(t *testing.T) {
	options := healthFixture(t)
	file := filepath.Join(options.Home, ".codex", "config.toml")
	original := "[plugins.simview]\nenabled=true\n"
	healthPut(t, file, original)
	f := healthFinding(t, options, "codex", "plugin-controller")
	plan, err := PlanAgentFix(options, f.ID)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(file)
	if err = os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if _, err = ApplyAgentFix(options, plan.ID); err == nil {
		t.Fatal("write to read-only directory unexpectedly succeeded")
	}
	if string(mustRead(t, file)) != original {
		t.Fatal("failed write changed configuration")
	}
	j, err := healthLoad(options, plan.ID)
	if err != nil || j.Receipt.Status != "prepared" {
		t.Fatalf("missing recovery record: %+v %v", j.Receipt, err)
	}
	if err = os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err = UndoAgentFix(options, plan.ID); err != nil {
		t.Fatal(err)
	}
	j, err = healthLoad(options, plan.ID)
	if err != nil || j.Receipt.Status != "undone" {
		t.Fatalf("recovery not completed: %+v %v", j.Receipt, err)
	}
	if string(mustRead(t, file)) != original {
		t.Fatal("recovery changed untouched configuration")
	}
}

func TestAgentHealthSelectiveUndoRemovesOnlyCreatedEmptyContainers(t *testing.T) {
	for _, client := range []string{"codex", "claude"} {
		for _, existingEmpty := range []bool{false, true} {
			t.Run(client+map[bool]string{false: "-new", true: "-existing-empty"}[existingEmpty], func(t *testing.T) {
				options := healthFixture(t)
				file := filepath.Join(options.Home, ".codex", "config.toml")
				format, prefix := "toml", "mcp_servers"
				original := ""
				if client == "claude" {
					file = filepath.Join(options.Home, ".claude.json")
					format, prefix = "json", "mcpServers"
				}
				if existingEmpty {
					original = "[mcp_servers]\n"
					if client == "claude" {
						original = `{"mcpServers":{}}`
					}
				}
				healthPut(t, file, original)
				plan := healthRepair(t, options, client, "connection")
				raw := mustRead(t, file)
				if client == "codex" {
					raw = append([]byte("model='new-model'\n# unrelated comment\n"), raw...)
				} else {
					raw = bytes.Replace(raw, []byte("{"), []byte(`{"model":"new-model",`), 1)
				}
				healthPut(t, file, string(raw))
				if _, err := UndoAgentFix(options, plan.ID); err != nil {
					t.Fatal(err)
				}
				raw = mustRead(t, file)
				doc, err := healthDecode(raw, format)
				if err != nil {
					t.Fatal(err)
				}
				if _, exists := healthGet(doc, prefix, "rndevtools"); exists {
					t.Fatalf("empty MCP registration left after undo: %s", raw)
				}
				if _, exists := doc[prefix]; exists != existingEmpty {
					t.Fatalf("wrong container restoration: %s", raw)
				}
				if doc["model"] != "new-model" {
					t.Fatal("unrelated model lost")
				}
				if client == "codex" && !bytes.Contains(raw, []byte("# unrelated comment")) {
					t.Fatal("unrelated comment lost")
				}
			})
		}
	}
}

func TestAgentHealthUndoDoesNotBreakNewConnectionWithLaterSettings(t *testing.T) {
	for _, client := range []string{"codex", "claude"} {
		t.Run(client, func(t *testing.T) {
			options := healthFixture(t)
			file, format, prefix := filepath.Join(options.Home, ".codex", "config.toml"), "toml", "mcp_servers"
			if client == "claude" {
				file, format, prefix = filepath.Join(options.Home, ".claude.json"), "json", "mcpServers"
			}
			plan := healthRepair(t, options, client, "connection")
			next, err := healthWriteValues(mustRead(t, file), format, []healthValue{{Keys: []string{prefix, "rndevtools", "env", "CUSTOM"}, After: "retained", AfterPresent: true}}, false)
			if err != nil {
				t.Fatal(err)
			}
			healthPut(t, file, string(next))
			if _, err = UndoAgentFix(options, plan.ID); err == nil {
				t.Fatal("Undo left an unusable registration after new connection settings were added")
			}
			if !bytes.Equal(next, mustRead(t, file)) {
				t.Fatal("Undo changed newer connection settings")
			}
		})
	}
}

func TestAgentHealthConnectionPreviewReportsProjectScope(t *testing.T) {
	for _, client := range []string{"codex", "claude"} {
		t.Run(client, func(t *testing.T) {
			options := healthFixture(t)
			options.Project = filepath.Join(options.Home, "project")
			file := filepath.Join(options.Project, ".codex", "config.toml")
			original := "[mcp_servers.rndevtools]\ncommand='/old/rndevtools'\nargs=['mcp']\n"
			expected := "Selected project (Codex)"
			if client == "codex" {
				healthPut(t, filepath.Join(options.Home, ".codex", "config.toml"), "[projects."+tomlString(options.Project)+"]\ntrust_level='trusted'\n")
			} else {
				file = filepath.Join(options.Project, ".mcp.json")
				original = `{"mcpServers":{"rndevtools":{"command":"/old/rndevtools","args":["mcp"]}}}`
				expected = "Selected project (Claude Code)"
			}
			healthPut(t, file, original)
			finding := healthFinding(t, options, client, "connection")
			plan, err := PlanAgentFix(options, finding.ID)
			if err != nil {
				t.Fatal(err)
			}
			if finding.Scope != expected || plan.Scope != expected || finding.file != file {
				t.Fatalf("wrong connection repair scope: finding=%+v plan=%+v", finding, plan)
			}
		})
	}
}
