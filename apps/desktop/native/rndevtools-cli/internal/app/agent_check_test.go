package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runAgentCheckCLI runs `rndevtools agent-check` with arguments and returns
// its exit status, stdout, and the error object it wrote to stderr, if any.
func runAgentCheckCLI(t *testing.T, arguments ...string) (int, string, map[string]any) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(Config{
		Arguments: append([]string{"agent-check"}, arguments...),
		Stdin:     strings.NewReader(""),
		Stdout:    &stdout,
		Stderr:    &stderr,
		// No agent-check operation talks to the desktop socket; a path that
		// does not exist proves it.
		SocketPath: filepath.Join(t.TempDir(), "missing.sock"),
		Lookup:     func(string) string { return "" },
	})
	var failure struct {
		Error map[string]any `json:"error"`
	}
	if stderr.Len() > 0 {
		if err := json.Unmarshal(stderr.Bytes(), &failure); err != nil {
			t.Fatalf("stderr is not one JSON error: %q", stderr.String())
		}
	}
	return code, stdout.String(), failure.Error
}

// agentCheckHome is an isolated configuration home with a Codex plugin that
// overlaps simulator control.
func agentCheckHome(t *testing.T) (home string, executable string, config string) {
	t.Helper()
	home = t.TempDir()
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real
	}
	config = filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(config), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("# kept\n[plugins.simview]\nenabled = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, filepath.Join(home, "RN Devtools.app", "rndevtools"), config
}

func TestAgentCheckRejectsBadArgumentsAsUsageErrors(t *testing.T) {
	home, executable, _ := agentCheckHome(t)
	for name, arguments := range map[string][]string{
		"an unknown flag":            {"--bogus"},
		"a positional argument":      {"scan"},
		"an unknown operation":       {"--operation", "frobnicate", "--config-home", home, "--executable", executable},
		"a plan without a finding":   {"--operation", "plan", "--config-home", home, "--executable", executable},
		"an apply without a plan id": {"--operation", "apply", "--config-home", home, "--executable", executable},
		"an undo without a plan id":  {"--operation", "undo", "--config-home", home, "--executable", executable},
		"a relative project":         {"--project", "example-app", "--config-home", home, "--executable", executable},
		"a relative home":            {"--config-home", "home", "--executable", executable},
		"a relative executable":      {"--config-home", home, "--executable", "rndevtools"},
	} {
		code, stdout, failure := runAgentCheckCLI(t, arguments...)
		if code != ExitUsage || failure["code"] != "invalid_arguments" || failure["retryable"] != false || stdout != "" {
			t.Errorf("%s: exit %d, stdout %q, error %v; want a usage error", name, code, stdout, failure)
		}
	}
	code, stdout, failure := runAgentCheckCLI(t, "--help")
	if code != ExitSuccess || failure != nil || !strings.Contains(stdout, "--operation scan|plan|apply|undo|probe") {
		t.Fatalf("--help: exit %d, stdout %q, error %v", code, stdout, failure)
	}
}

func TestAgentCheckNamesTheFirstRelativePathInFlagOrder(t *testing.T) {
	// With several relative paths the error names the same flag every time:
	// --project, then --config-home, then --executable.
	for _, row := range []struct {
		arguments []string
		want      string
	}{
		{[]string{"--project", "example-app", "--config-home", "home", "--executable", "rndevtools"}, "--project must be an absolute path."},
		{[]string{"--executable", "rndevtools", "--config-home", "home"}, "--config-home must be an absolute path."},
	} {
		for range 100 {
			code, _, failure := runAgentCheckCLI(t, row.arguments...)
			if code != ExitUsage || failure["message"] != row.want {
				t.Fatalf("%v: exit %d, error %v; want %q", row.arguments, code, failure, row.want)
			}
		}
	}
}

func TestAgentCheckScansPlansAppliesAndUndoesThroughTheCLI(t *testing.T) {
	home, executable, config := agentCheckHome(t)
	original, _ := os.ReadFile(config)
	scope := []string{"--config-home", home, "--executable", executable}
	code, stdout, failure := runAgentCheckCLI(t, scope...)
	if code != ExitSuccess || failure != nil {
		t.Fatalf("scan: exit %d, error %v", code, failure)
	}
	var report struct {
		Findings []struct{ ID, Client, Rule, FixLabel string }
		Repairs  []struct{ ID, Status string }
	}
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("scan output is not a report: %q", stdout)
	}
	finding := ""
	for _, f := range report.Findings {
		if f.Client == "codex" && f.Rule == "plugin-controller" && f.FixLabel != "" {
			finding = f.ID
		}
	}
	if finding == "" {
		t.Fatalf("no plugin finding to repair: %s", stdout)
	}
	code, stdout, failure = runAgentCheckCLI(t, append([]string{"--operation", "plan", "--finding-id", finding}, scope...)...)
	var plan struct{ ID, Source string }
	if code != ExitSuccess || failure != nil || json.Unmarshal([]byte(stdout), &plan) != nil || plan.Source != "~/.codex/config.toml" {
		t.Fatalf("plan: exit %d, stdout %q, error %v", code, stdout, failure)
	}
	if code, _, failure = runAgentCheckCLI(t, append([]string{"--operation", "apply", "--plan-id", plan.ID}, scope...)...); code != ExitSuccess || failure != nil {
		t.Fatalf("apply: exit %d, error %v", code, failure)
	}
	if changed, _ := os.ReadFile(config); bytes.Equal(changed, original) || !bytes.Contains(changed, []byte("enabled = false")) {
		t.Fatalf("apply did not disable the plugin:\n%s", changed)
	}
	if code, _, failure = runAgentCheckCLI(t, append([]string{"--operation", "undo", "--plan-id", plan.ID}, scope...)...); code != ExitSuccess || failure != nil {
		t.Fatalf("undo: exit %d, error %v", code, failure)
	}
	if restored, _ := os.ReadFile(config); !bytes.Equal(restored, original) {
		t.Fatalf("undo did not restore the file:\n%s", restored)
	}
	// A repair that cannot run is the check's failure, not a usage error.
	code, _, failure = runAgentCheckCLI(t, append([]string{"--operation", "undo", "--plan-id", plan.ID}, scope...)...)
	if code != ExitInternal || failure["code"] != "agent_check_failed" || failure["retryable"] != true {
		t.Fatalf("a second undo: exit %d, error %v", code, failure)
	}
}

// fakeMCP writes an executable that answers the probe's requests in order, as
// `rndevtools mcp` does, and records each request it reads. tools is the
// tools/list result and call the tools/call result.
func fakeMCP(t *testing.T, tools string, call string) (executable string, requests string) {
	t.Helper()
	directory := t.TempDir()
	executable = filepath.Join(directory, "rndevtools")
	requests = filepath.Join(directory, "requests.log")
	answer := func(id int, result string) string {
		return "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":" + string(rune('0'+id)) + ",\"result\":" + result + "}'\n"
	}
	script := "#!/bin/sh\n" +
		"[ \"$1\" = mcp ] || exit 64\n" +
		"read -r line; printf '%s\\n' \"$line\" >> " + shellQuoted(requests) + "\n" +
		answer(1, `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"rndevtools","version":"test"}}`) +
		"read -r line; printf '%s\\n' \"$line\" >> " + shellQuoted(requests) + "\n" +
		"read -r line; printf '%s\\n' \"$line\" >> " + shellQuoted(requests) + "\n" +
		answer(2, tools) +
		"read -r line; printf '%s\\n' \"$line\" >> " + shellQuoted(requests) + "\n" +
		answer(3, call)
	if err := os.WriteFile(executable, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return executable, requests
}

func shellQuoted(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

func toolList(names ...string) string {
	entries := make([]string, len(names))
	for i, name := range names {
		entries[i] = `{"name":"` + name + `","inputSchema":{"type":"object"}}`
	}
	return `{"tools":[` + strings.Join(entries, ",") + `]}`
}

func TestAgentCheckProbeRunsTheMCPHandshakeAndDoctor(t *testing.T) {
	required := []string{"doctor", "lane", "supabase", "input", "native", "capture"}
	healthy := `{"content":[{"type":"text","text":"{}"}],"isError":false}`
	executable, requests := fakeMCP(t, toolList(required...), healthy)
	code, stdout, failure := runAgentCheckCLI(t, "--operation", "probe", "--config-home", t.TempDir(), "--executable", executable)
	var probe struct {
		OK        bool `json:"ok"`
		ToolCount int  `json:"toolCount"`
	}
	if code != ExitSuccess || failure != nil || json.Unmarshal([]byte(stdout), &probe) != nil || !probe.OK || probe.ToolCount != len(required) {
		t.Fatalf("probe: exit %d, stdout %q, error %v", code, stdout, failure)
	}
	// initialize, the initialized notification, tools/list, then doctor.
	file, err := os.Open(requests)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var methods []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var request struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			t.Fatalf("request is not JSON: %q", scanner.Text())
		}
		methods = append(methods, strings.TrimSpace(request.Method+" "+request.Params.Name))
	}
	if strings.Join(methods, ", ") != "initialize, notifications/initialized, tools/list, tools/call doctor" {
		t.Fatalf("probe requests: %v", methods)
	}

	for name, row := range map[string]struct{ tools, call, message string }{
		"a missing required tool": {toolList("doctor", "lane", "supabase", "input"), healthy, "missing a required RN Devtools tool"},
		"a doctor error, such as an unreachable desktop": {toolList(required...),
			`{"content":[{"type":"text","text":"{\"code\":\"desktop_unavailable\"}"}],"isError":true}`, "The MCP returned an error"},
	} {
		executable, _ := fakeMCP(t, row.tools, row.call)
		code, stdout, failure := runAgentCheckCLI(t, "--operation", "probe", "--config-home", t.TempDir(), "--executable", executable)
		message, _ := failure["message"].(string)
		if code != ExitInternal || failure["code"] != "agent_check_failed" || !strings.Contains(message, row.message) || stdout != "" {
			t.Errorf("%s: exit %d, stdout %q, error %v", name, code, stdout, failure)
		}
	}
}
