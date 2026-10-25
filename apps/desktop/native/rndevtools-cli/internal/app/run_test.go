package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

func TestRunEmitsCompactSuccessAndRejectedResponses(t *testing.T) {
	for name, serverResponse := range map[string]func(string) string{
		"success": func(id string) string {
			return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
		},
		"rejected": func(id string) string {
			return `{"protocol":"rndevtools/1","id":"` + id + `","ok":false,"error":{"code":"approval_required","message":"Approve in the app.","retryable":false,"recovery":"Open RN Devtools."}}`
		},
	} {
		t.Run(name, func(t *testing.T) {
			socketPath := appTestServer(t, serverResponse)
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exitCode := Run(Config{
				Version:     "test",
				BuildCommit: "fixture",
				Arguments:   []string{"doctor"},
				Stdin:       strings.NewReader(""),
				Stdout:      &stdout,
				Stderr:      &stderr,
				SocketPath:  socketPath,
			})
			wantExit := ExitSuccess
			if name == "rejected" {
				wantExit = ExitRejected
			}
			if exitCode != wantExit {
				t.Fatalf("exit = %d, want %d; stderr=%s", exitCode, wantExit, stderr.String())
			}
			if strings.Count(stdout.String(), "\n") != 1 || !json.Valid(bytes.TrimSpace(stdout.Bytes())) {
				t.Fatalf("stdout is not one compact JSON line: %q", stdout.String())
			}
		})
	}
}

func TestRunUsesStableExitCodesForLocalFailures(t *testing.T) {
	for name, fixture := range map[string]struct {
		arguments  []string
		socketPath string
		wantExit   int
		wantCode   string
	}{
		"invalid": {
			arguments: []string{"slimming", "--operation", "apply"},
			wantExit:  ExitUsage,
			wantCode:  "invalid_arguments",
		},
		"unavailable": {
			arguments:  []string{"doctor"},
			socketPath: filepath.Join(t.TempDir(), "missing.sock"),
			wantExit:   ExitUnavailable,
			wantCode:   "desktop_unavailable",
		},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			exitCode := Run(Config{
				Arguments:  fixture.arguments,
				Stdin:      strings.NewReader(""),
				Stdout:     &stdout,
				Stderr:     &stderr,
				SocketPath: fixture.socketPath,
			})
			if exitCode != fixture.wantExit || !strings.Contains(stderr.String(), `"code":"`+fixture.wantCode+`"`) {
				t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunClassifiesOversizedEnvelopeAsInvalidArguments(t *testing.T) {
	payload := strings.Repeat("x", protocol.MaxRequestBytes-150)
	stdin := `{"target":{"deviceId":"device-1"},"action":{"tool":"routes","command":"navigate","payload":{"path":"` + payload + `"}}}`
	if len(stdin) > protocol.MaxRequestBytes {
		t.Fatalf("test stdin unexpectedly exceeds the input limit: %d", len(stdin))
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Arguments:      []string{"act"},
		Stdin:          strings.NewReader(stdin),
		StdinAvailable: true,
		Stdout:         &stdout,
		Stderr:         &stderr,
	})
	if exitCode != ExitUsage || !strings.Contains(stderr.String(), "complete request fits within 256 KiB") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
}

func appTestServer(t *testing.T, response func(string) string) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "pd-app-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "rndevtools.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		line, ok := readRequestLikeTheDesktop(connection)
		if !ok {
			return
		}
		var request protocol.Request
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &request) != nil {
			return
		}
		_, _ = connection.Write([]byte(response(request.ID) + "\n"))
	}()
	return socketPath
}

// readRequestLikeTheDesktop reads the request line and then, as the desktop
// does, waits for the client's half-close before anything is answered. A
// server that answered and closed first could leave the client's CloseWrite
// failing with ENOTCONN.
func readRequestLikeTheDesktop(connection net.Conn) (string, bool) {
	reader := bufio.NewReader(connection)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", false
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return "", false
	}
	return line, true
}

func TestRunServesMCPOverStdio(t *testing.T) {
	var seen protocol.Request
	socketPath := appTestServerCapturing(t, &seen, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
	})
	// The injected lookup, not the developer's own session, attributes the call.
	lookup := func(name string) string {
		if name == "CODEX_THREAD_ID" {
			return "thread-mcp"
		}
		return ""
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Version:   "test",
		Arguments: []string{"mcp"},
		Stdin: strings.NewReader(
			`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test"}}}` + "\n" +
				`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doctor","arguments":{}}}` + "\n"),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
		Lookup:     lookup,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("exit = %d; stderr=%s", exitCode, stderr.String())
	}
	if seen.Agent["kind"] != "codex" || seen.Agent["sessionId"] != "thread-mcp" {
		t.Fatalf("MCP calls must be attributed through the injected lookup: %v", seen.Agent)
	}
	if !strings.HasPrefix(seen.ID, "mcp-") {
		t.Fatalf("MCP request id %q", seen.ID)
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected two JSON-RPC responses, got %q", stdout.String())
	}
	if !strings.Contains(lines[0], `"serverInfo":{"name":"rndevtools","version":"test"}`) {
		t.Fatalf("initialize response: %s", lines[0])
	}
	if !strings.Contains(lines[1], `"healthy":true`) || !strings.Contains(lines[1], `"isError":false`) {
		t.Fatalf("tool response: %s", lines[1])
	}
	if !strings.Contains(RootUsage(), "  mcp\n") {
		t.Fatal("root usage must list mcp")
	}
	var usage bytes.Buffer
	if Run(Config{Arguments: []string{"mcp", "--help"}, Stdout: &usage, Stderr: &stderr}) != ExitSuccess {
		t.Fatal("mcp --help should succeed")
	}
	if Run(Config{Arguments: []string{"mcp", "--bogus"}, Stdout: &usage, Stderr: &stderr}) != ExitUsage {
		t.Fatal("mcp with flags should be a usage error")
	}
}

func TestRunSetupDryRunAndHook(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	socketPath := appTestServer(t, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"healthy":true}}`
	})
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := Run(Config{
		Version:    "test",
		Arguments:  []string{"setup", "--dry-run", "--agents", "claude", "--executable", "/opt/rndevtools"},
		Stdin:      strings.NewReader(""),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("exit = %d; stderr=%s", exitCode, stderr.String())
	}
	var report map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("report is not JSON: %s", stdout.String())
	}
	if report["dryRun"] != true || report["executable"] != "/opt/rndevtools" {
		t.Fatalf("report: %v", report)
	}
	if _, present := report["codexHooksNeedTrust"]; !present {
		t.Fatal("report must carry codexHooksNeedTrust so the desktop can show the /hooks step")
	}
	if report["doctor"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor should have reached the fixture socket: %v", report["doctor"])
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatalf("dry run wrote into HOME: %v", entries)
	}

	stdout.Reset()
	stderr.Reset()
	exitCode = Run(Config{
		Arguments: []string{"hook", "claude-pre-tool-use"},
		Stdin:     strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44"}}`),
		Stdout:    &stdout,
		Stderr:    &stderr,
	})
	if exitCode != 2 || !strings.Contains(stderr.String(), "rndevtools") {
		t.Fatalf("hook exit %d stderr %q", exitCode, stderr.String())
	}
	exitCode = Run(Config{
		Arguments: []string{"hook", "claude-pre-tool-use"},
		Stdin:     strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl list"}}`),
		Stdout:    &stdout,
		Stderr:    &stderr,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("read-only simctl must pass, exit %d", exitCode)
	}
}

func TestSessionEndHookReleasesEverythingForThePayloadSession(t *testing.T) {
	var seen protocol.Request
	socketPath := appTestServerCapturing(t, &seen, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":true,"result":{"stoppedLanes":["lane-1"],"releasedClaims":[],"errors":[]}}`
	})
	// No agent variables: the developer's own session must not leak in.
	noEnvironment := func(string) string { return "" }
	var stdout, stderr bytes.Buffer
	exitCode := Run(Config{
		Arguments:  []string{"hook", "session-end"},
		Stdin:      strings.NewReader(`{"session_id":"thr_abc","cwd":"/w","hook_event_name":"SessionEnd","reason":"other"}`),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
		Lookup:     noEnvironment,
	})
	if exitCode != ExitSuccess {
		t.Fatalf("exit %d stderr %s", exitCode, stderr.String())
	}
	if string(seen.Command) != `{"kind":"release","all":true,"sessionCwd":"/w"}` {
		t.Fatalf("command sent: %s", seen.Command)
	}
	if seen.Agent["sessionId"] != "thr_abc" {
		t.Fatalf("the payload's session id must attribute the release: %v", seen.Agent)
	}
	if stdout.Len() != 0 {
		t.Fatalf("hooks must not write to stdout: %q", stdout.String())
	}

	// No payload, no environment: nothing to release, still exit 0.
	stderr.Reset()
	if Run(Config{Arguments: []string{"hook", "session-end"}, Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr, SocketPath: socketPath, Lookup: noEnvironment}) != ExitSuccess {
		t.Fatal("session-end must never fail the agent's exit")
	}
	if !strings.Contains(stderr.String(), "nothing to release") {
		t.Fatalf("stderr %q", stderr.String())
	}
	// Desktop not running: silent success.
	if Run(Config{Arguments: []string{"hook", "session-end"}, Stdin: strings.NewReader(`{"session_id":"thr_x"}`), Stdout: &stdout, Stderr: &stderr, SocketPath: filepath.Join(t.TempDir(), "missing.sock"), Lookup: noEnvironment}) != ExitSuccess {
		t.Fatal("session-end must succeed when the desktop is down")
	}
}

// appTestServerCapturing is appTestServer that also records the request it saw.
func appTestServerCapturing(t *testing.T, captured *protocol.Request, response func(string) string) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "pd-app-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	socketPath := filepath.Join(directory, "rndevtools.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		line, ok := readRequestLikeTheDesktop(connection)
		if !ok {
			return
		}
		var request protocol.Request
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &request) != nil {
			return
		}
		*captured = request
		_, _ = connection.Write([]byte(response(request.ID) + "\n"))
	}()
	// Close first: an Accept that no client ever reaches would never return, and
	// a regression that skips the socket must fail its assertions, not hang.
	t.Cleanup(func() {
		listener.Close()
		<-done
	})
	return socketPath
}

func TestSupabaseCommandsCarryTheAgentOnTheEnvelopeOnly(t *testing.T) {
	var seen protocol.Request
	socketPath := appTestServerCapturing(t, &seen, func(id string) string {
		return `{"protocol":"rndevtools/1","id":"` + id + `","ok":false,"error":{"code":"supabase_disabled","message":"Local Supabase is off.","retryable":false,"recovery":"RN Devtools is not managing this worktree. Start it yourself from the worktree with ` + "`supabase start --runtime native`" + ` (never without --runtime native)."}}`
	})
	lookup := func(name string) string {
		if name == "CLAUDE_CODE_SESSION_ID" {
			return "sess-9"
		}
		return ""
	}
	var stdout, stderr bytes.Buffer
	exitCode := Run(Config{
		Arguments:  []string{"supabase", "--operation", "up", "--worktree", "/Users/example/app", "--wait-ms", "1000"},
		Stdin:      strings.NewReader(""),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: socketPath,
		Lookup:     lookup,
	})
	if exitCode != ExitRejected {
		t.Fatalf("a typed refusal exits %d, got %d; stderr %s", ExitRejected, exitCode, stderr.String())
	}
	if string(seen.Command) != `{"kind":"supabase","operation":"up","waitMs":1000,"worktreePath":"/Users/example/app"}` {
		t.Fatalf("command sent: %s", seen.Command)
	}
	if seen.Agent["kind"] != "claude" || seen.Agent["sessionId"] != "sess-9" {
		t.Fatalf("the envelope must attribute the call: %v", seen.Agent)
	}
	if !strings.HasPrefix(seen.ID, "cli-") {
		t.Fatalf("CLI request id %q", seen.ID)
	}
	if !strings.Contains(stdout.String(), `"code":"supabase_disabled"`) || !strings.Contains(stdout.String(), "--runtime native") {
		t.Fatalf("the refusal and its recovery reach stdout: %s", stdout.String())
	}

	// Invalid combinations never reach the socket.
	stdout.Reset()
	stderr.Reset()
	if code := Run(Config{Arguments: []string{"supabase", "--operation", "ls", "--stack-id", "0123abcd"}, Stdin: strings.NewReader(""), Stdout: &stdout, Stderr: &stderr, SocketPath: filepath.Join(t.TempDir(), "missing.sock"), Lookup: lookup}); code != ExitUsage {
		t.Fatalf("ls with a target exits %d", code)
	}
	if !strings.Contains(stderr.String(), "rndevtools supabase --help") {
		t.Fatalf("stderr %s", stderr.String())
	}
	var usage bytes.Buffer
	if Run(Config{Arguments: []string{"supabase", "--help"}, Stdout: &usage, Stderr: &stderr}) != ExitSuccess {
		t.Fatal("supabase --help should succeed")
	}
	for _, flag := range []string{"--operation", "--worktree", "--stack-id", "--wait-ms", "--seed", "--service", "--tail", "--since", "--note"} {
		if !strings.Contains(usage.String(), "  "+flag+" ") {
			t.Fatalf("usage lacks %s:\n%s", flag, usage.String())
		}
	}
	if !strings.Contains(RootUsage(), "  supabase\n") {
		t.Fatal("root usage must list supabase")
	}
}

func TestAHookEventThisBuildDoesNotKnowNeverBlocks(t *testing.T) {
	// Exit status 2 is the agents' "block": a newer setup's event, or none,
	// must let the Bash call run instead of refusing every one of them.
	for _, arguments := range [][]string{{"hook", "pre-tool-use-v2"}, {"hook"}} {
		var stdout, stderr bytes.Buffer
		exitCode := Run(Config{
			Arguments: arguments,
			Stdin:     strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"git status"}}`),
			Stdout:    &stdout,
			Stderr:    &stderr,
		})
		if exitCode != ExitSuccess {
			t.Fatalf("%v: exit %d", arguments, exitCode)
		}
		if stdout.Len() != 0 {
			t.Fatalf("%v: hooks must keep stdout empty, got %q", arguments, stdout.String())
		}
		if !strings.Contains(stderr.String(), "Usage: rndevtools hook <event>") {
			t.Fatalf("%v: stderr %q", arguments, stderr.String())
		}
	}
	var stderr bytes.Buffer
	Run(Config{Arguments: []string{"hook", "pre-tool-use-v2"}, Stdin: strings.NewReader(""), Stdout: io.Discard, Stderr: &stderr})
	if !strings.Contains(stderr.String(), `unknown event "pre-tool-use-v2"`) || !strings.Contains(stderr.String(), "rerun rndevtools setup") {
		t.Fatalf("the note must name the event and the fix: %q", stderr.String())
	}
}

func TestHookUsageDescribesTheSupabaseRules(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if Run(Config{Arguments: []string{"hook", "--help"}, Stdout: &stdout, Stderr: &stderr}) != ExitSuccess {
		t.Fatal("hook --help should succeed")
	}
	for _, phrase := range []string{"local Supabase is turned on", "steering.json", "--runtime native", "release its stacks"} {
		if !strings.Contains(stdout.String(), phrase) {
			t.Fatalf("hook usage lacks %q:\n%s", phrase, stdout.String())
		}
	}
}

func TestSessionEndReleaseCommandForwardsOnlyAnAbsoluteCwd(t *testing.T) {
	cases := []struct {
		cwd  string
		want string
	}{
		{"/Users/example/app", `{"kind":"release","all":true,"sessionCwd":"/Users/example/app"}`},
		{"/Users/example/app/../app/", `{"kind":"release","all":true,"sessionCwd":"/Users/example/app"}`},
		{"", `{"kind":"release","all":true}`},
		{"relative/dir", `{"kind":"release","all":true}`},
		{"/" + strings.Repeat("a", maxSessionCwdLength), `{"kind":"release","all":true}`},
		{"/bad\x00path", `{"kind":"release","all":true}`},
	}
	for _, testCase := range cases {
		if got := string(sessionEndReleaseCommand(testCase.cwd)); got != testCase.want {
			t.Errorf("sessionEndReleaseCommand(%q) = %s, want %s", testCase.cwd, got, testCase.want)
		}
	}
}
