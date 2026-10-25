package command

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const testUDID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

// Parse is ParseWithEnvironment with no environment, so no agent is attributed.
func Parse(kind protocol.Command, arguments []string, stdin io.Reader, stdinAvailable bool) (Parsed, error) {
	return ParseWithEnvironment(kind, arguments, stdin, stdinAvailable, nil)
}

func TestValidateMatchesServerCommandUnion(t *testing.T) {
	tests := map[protocol.Command]string{
		protocol.CommandDoctor:     `{"kind":"doctor"}`,
		protocol.CommandSimulators: `{"kind":"simulators","includeUnavailable":true}`,
		protocol.CommandApps:       `{"kind":"apps","udid":"` + testUDID + `"}`,
		protocol.CommandScreen:     `{"kind":"screen","target":{"deviceId":"device-1"}}`,
		protocol.CommandElements:   `{"kind":"elements","target":{"udid":"` + testUDID + `"},"query":"button","limit":10}`,
		protocol.CommandAct:        `{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"routes","command":"navigate","payload":{"path":null}}}`,
		protocol.CommandWait:       `{"kind":"wait","condition":{"kind":"network-idle","quietMs":500},"timeoutMs":30000}`,
		protocol.CommandCapture:    `{"kind":"capture","udid":"` + testUDID + `","format":"png"}`,
		protocol.CommandRecord:     `{"kind":"record","udid":"` + testUDID + `","operation":"start","codec":"h264"}`,
		protocol.CommandNetwork:    `{"kind":"network","target":{"deviceId":"device-1"},"operation":"set","profileId":"slow-3g"}`,
		protocol.CommandRecipe:     `{"kind":"recipe","operation":"run","recipeId":"smoke","udids":["` + testUDID + `"]}`,
		protocol.CommandJobs:       `{"kind":"jobs","operation":"cancel","jobId":"job-1"}`,
		protocol.CommandSlimming:   `{"kind":"slimming","operation":"verify","udids":["` + testUDID + `"],"profileId":"rndevtools-development"}`,
		protocol.CommandLane:       `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","environment":"development","launch":true,"slimProfileId":"rndevtools-development","agent":{"kind":"claude","sessionId":"session-1"}}`,
		protocol.CommandSupabase:   `{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","waitMs":30000}`,
		protocol.CommandNative:     `{"kind":"native","operation":"install","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","configuration":"Release"}`,
		protocol.CommandAgents:     `{"kind":"agents"}`,
		protocol.CommandClaim:      `{"kind":"claim","udid":"` + testUDID + `","note":"checkout flow"}`,
		protocol.CommandRelease:    `{"kind":"release","udid":"` + testUDID + `"}`,
		protocol.CommandInput:      `{"kind":"input","input":{"kind":"swipe","udid":"` + testUDID + `","fromX":0.5,"fromY":0.9,"toX":0.5,"toY":0.2,"durationMilliseconds":300,"steps":20}}`,
	}
	for kind, encoded := range tests {
		t.Run(string(kind), func(t *testing.T) {
			if err := Validate(json.RawMessage(encoded), kind); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestValidateRejectsMutationUnknownFieldsAndNullOptionals(t *testing.T) {
	tests := []struct {
		kind    protocol.Command
		encoded string
	}{
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"apply","udids":["` + testUDID + `"]}`},
		{protocol.CommandDoctor, `{"kind":"doctor","shell":"whoami"}`},
		{protocol.CommandCapture, `{"kind":"capture","udid":"` + testUDID + `","format":null}`},
		{protocol.CommandNetwork, `{"kind":"network","target":{"deviceId":"device-1"},"operation":"status","profileId":"unexpected"}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"status","udids":["` + testUDID + `"]}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"doctor","udids":["` + testUDID + `"],"profileId":"ignored-profile"}`},
		{protocol.CommandSlimming, `{"kind":"slimming","operation":"preview","udids":["` + testUDID + `"]}`},
		{protocol.CommandScreen, `{"kind":"screen","target":{"udid":"` + testUDID + `","deviceId":"device-1"}}`},
		{protocol.CommandAct, `{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"storage","command":"set","payload":{}}}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","udid":"` + testUDID + `"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"relative","udid":"` + testUDID + `"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"ls","laneId":"lane-11111111-2222-4333-8444-555555555555"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"launch","laneId":"lane-11111111-2222-4333-8444-555555555555","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"down"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"log","laneId":"lane-11111111-2222-4333-8444-555555555555","url":"x"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","agent":{"kind":"gpt","sessionId":"s"}}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","shell":"whoami"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","udid":"` + testUDID + `","slimProfileId":"../escape"}`},
		{protocol.CommandLane, `{"kind":"lane","operation":"launch","laneId":"lane-11111111-2222-4333-8444-555555555555","slimProfileId":"rndevtools-development"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"install","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"plan","worktreePath":"relative"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"build","worktreePath":"/Users/dev/app"}`},
		{protocol.CommandNative, `{"kind":"native","operation":"plan","worktreePath":"/Users/dev/app","configuration":"debug"}`},
		{protocol.CommandClaim, `{"kind":"claim"}`},
		{protocol.CommandRelease, `{"kind":"release","udid":"` + testUDID + `","note":"x"}`},
		{protocol.CommandAgents, `{"kind":"agents","udid":"` + testUDID + `"}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"` + testUDID + `","x":1.5,"y":0.5}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"booted","x":0.5,"y":0.5}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"tap","udid":"` + testUDID + `","x":0.5,"y":0.5,"button":"home"}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"text","udid":"` + testUDID + `","text":"héllo"}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"key","udid":"` + testUDID + `","usage":3}}`},
		{protocol.CommandInput, `{"kind":"input","input":{"kind":"button","udid":"` + testUDID + `","button":"power"}}`},
		{protocol.CommandInput, `{"kind":"input"}`},
	}
	for _, test := range tests {
		if err := Validate(json.RawMessage(test.encoded), test.kind); err == nil {
			t.Fatalf("expected rejection: %s", test.encoded)
		}
	}
}

func TestReleaseAcceptsSessionCwdOnlyWithAll(t *testing.T) {
	for _, accepted := range []string{
		`{"kind":"release","all":true,"sessionCwd":"/Users/dev/app"}`,
		`{"kind":"release","all":true,"sessionCwd":"/` + strings.Repeat("a", 1023) + `"}`,
		`{"kind":"release","all":true}`,
	} {
		if err := Validate(json.RawMessage(accepted), protocol.CommandRelease); err != nil {
			t.Fatalf("%s: %v", accepted, err)
		}
	}
	for _, rejected := range []struct {
		kind    protocol.Command
		encoded string
	}{
		{protocol.CommandRelease, `{"kind":"release","sessionCwd":"/Users/dev/app"}`},
		{protocol.CommandRelease, `{"kind":"release","udid":"` + testUDID + `","sessionCwd":"/Users/dev/app"}`},
		{protocol.CommandRelease, `{"kind":"release","udid":"` + testUDID + `","all":true,"sessionCwd":"/Users/dev/app"}`},
		{protocol.CommandRelease, `{"kind":"release","all":false,"sessionCwd":"/Users/dev/app"}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":"relative/app"}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":"/"}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":""}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":"/` + strings.Repeat("a", 1024) + `"}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":"/Users/dev/\u0000app"}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":null}`},
		{protocol.CommandRelease, `{"kind":"release","all":true,"sessionCwd":7}`},
		{protocol.CommandClaim, `{"kind":"claim","udid":"` + testUDID + `","sessionCwd":"/Users/dev/app"}`},
	} {
		if err := Validate(json.RawMessage(rejected.encoded), rejected.kind); err == nil {
			t.Fatalf("expected rejection: %s", rejected.encoded)
		}
	}
	// Agents do not set it: only the session-end hook knows the ending
	// session's directory, so no flag or tool argument carries it.
	if _, err := Parse(protocol.CommandRelease, []string{"--all", "--session-cwd", "/Users/dev/app"}, strings.NewReader(""), false); err == nil {
		t.Fatal("release must not grow a session-cwd flag")
	}
}

func TestValidateAllowsOnlyAppScopedNetworkProfileActions(t *testing.T) {
	for _, action := range []string{
		`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"setProfile","payload":{"profileId":"lte"}}}`,
		`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"clearProfile","payload":{}}}`,
	} {
		if err := Validate(json.RawMessage(action), protocol.CommandAct); err != nil {
			t.Fatalf("safe app-scoped network action was rejected: %v", err)
		}
	}
	if err := Validate(
		json.RawMessage(`{"kind":"act","target":{"deviceId":"device-1"},"action":{"tool":"network","command":"clear","payload":{}}}`),
		protocol.CommandAct,
	); err == nil {
		t.Fatal("captured-network-log clearing must not be available through unattended act")
	}
}

func TestParseMergesDistinctFlagsAndStdin(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandSlimming,
		[]string{"--operation", "preview", "--udids", testUDID, "--request-timeout-ms", "45000"},
		strings.NewReader(`{"profileId":"rndevtools-development"}`),
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Timeout.Milliseconds() != 45_000 {
		t.Fatalf("timeout = %s", parsed.Timeout)
	}
	var command map[string]any
	if err := json.Unmarshal(parsed.Command, &command); err != nil {
		t.Fatal(err)
	}
	if command["kind"] != "slimming" || command["operation"] != "preview" || command["profileId"] != "rndevtools-development" {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestParseDerivesWaitSocketDeadlineBeyondServerGrace(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandWait,
		[]string{"--timeout-ms", "600000", "--condition", "network-idle", "--quiet-ms", "500"},
		strings.NewReader(""),
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Timeout != 610*time.Second {
		t.Fatalf("timeout = %s, want 610s", parsed.Timeout)
	}
}

func TestParseRejectsAmbiguityAndOversizedInput(t *testing.T) {
	if _, err := Parse(
		protocol.CommandJobs,
		[]string{"--operation", "list"},
		strings.NewReader(`{"operation":"get","jobId":"job-1"}`),
		true,
	); err == nil {
		t.Fatal("expected duplicate field rejection")
	}
	if _, err := Parse(
		protocol.CommandSimulators,
		nil,
		strings.NewReader(strings.Repeat("x", protocol.MaxRequestBytes+1)),
		true,
	); err == nil {
		t.Fatal("expected oversized stdin rejection")
	}
}

// unreadable fails the test that reads it: stdin a command must not touch.
type unreadable struct{ t *testing.T }

func (reader unreadable) Read([]byte) (int, error) {
	reader.t.Error("stdin was read")
	return 0, io.EOF
}

func TestCommandsWithoutFieldsNeverReadStdin(t *testing.T) {
	// `ssh host rndevtools doctor` hands the CLI an open pipe it would
	// otherwise wait on until the user presses Ctrl-D.
	for _, kind := range []protocol.Command{protocol.CommandDoctor, protocol.CommandAgents} {
		parsed, err := Parse(kind, nil, unreadable{t}, true)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if string(parsed.Command) != `{"kind":"`+string(kind)+`"}` {
			t.Fatalf("%s: command %s", kind, parsed.Command)
		}
		if !strings.Contains(Usage(kind), "never reads stdin") {
			t.Fatalf("%s usage must say it ignores stdin:\n%s", kind, Usage(kind))
		}
	}
	// A command with fields still merges stdin with its flags.
	if !strings.Contains(Usage(protocol.CommandSimulators), "JSON command object on stdin") {
		t.Fatal("commands with fields still document stdin")
	}
}

func TestParseStructuredNestedActionFlags(t *testing.T) {
	parsed, err := Parse(
		protocol.CommandAct,
		[]string{
			"--device-id", "device-1",
			"--tool", "routes",
			"--action-command", "navigate",
			"--action-payload", `{"path":"/settings"}`,
		},
		strings.NewReader(""),
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(parsed.Command), `"command":"navigate"`) {
		t.Fatalf("unexpected command: %s", parsed.Command)
	}
}

func TestLaneFlagsBuildOperationSpecificCommands(t *testing.T) {
	parsed, err := Parse(protocol.CommandLane, []string{
		"--operation", "launch",
		"--lane-id", "lane-11111111-2222-4333-8444-555555555555",
		"--url", "checkout",
	}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["operation"] != "launch" || decoded["url"] != "checkout" {
		t.Fatalf("unexpected command: %s", parsed.Command)
	}
	if parsed.Timeout < 240*time.Second {
		t.Fatalf("lane commands need a long socket deadline, got %s", parsed.Timeout)
	}
}

func TestLaneUpNeedsOnlyAWorktree(t *testing.T) {
	// Without a udid the desktop picks a free Simulator or parks a device
	// request for the user; the CLI must not demand one up front.
	if err := Validate(json.RawMessage(`{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app"}`), protocol.CommandLane); err != nil {
		t.Fatal(err)
	}
	if err := Validate(json.RawMessage(`{"kind":"lane","operation":"up","udid":"`+testUDID+`"}`), protocol.CommandLane); err == nil {
		t.Fatal("lane up without a worktree must be rejected")
	}
}

func TestLaneAttributionComesFromAgentEnvironment(t *testing.T) {
	env := map[string]string{"CLAUDE_CODE_SESSION_ID": "session-abc"}
	lookup := func(key string) string { return env[key] }
	parsed, err := ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up",
		"--worktree", "/Users/dev/app",
		"--udid", testUDID,
	}, strings.NewReader(""), false, lookup)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Agent map[string]string `json:"agent"`
	}
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Agent["kind"] != "claude" || decoded.Agent["sessionId"] != "session-abc" {
		t.Fatalf("expected claude attribution, got %s", parsed.Command)
	}

	// Explicit stdin attribution wins over the environment.
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up", "--worktree", "/Users/dev/app", "--udid", testUDID,
	}, strings.NewReader(`{"agent":{"kind":"codex","sessionId":"thread-9"}}`), true, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Agent["kind"] != "codex" {
		t.Fatalf("stdin attribution should win, got %s", parsed.Command)
	}

	// Operations that do not accept attribution never receive it.
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{"--operation", "ls"},
		strings.NewReader(""), false, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(parsed.Command), "agent") {
		t.Fatalf("ls must not carry attribution: %s", parsed.Command)
	}

	// Malformed identifiers are dropped rather than forwarded.
	bad := func(string) string { return "has spaces" }
	parsed, err = ParseWithEnvironment(protocol.CommandLane, []string{
		"--operation", "up", "--worktree", "/Users/dev/app", "--udid", testUDID,
	}, strings.NewReader(""), false, bad)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(parsed.Command), "agent") {
		t.Fatalf("invalid session ids must be ignored: %s", parsed.Command)
	}
}

const testStackID = "64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f"

func TestSupabaseValidateMatchesTheDesktopRules(t *testing.T) {
	for _, accepted := range []string{
		`{"kind":"supabase","operation":"ls"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","waitMs":0}`,
		`{"kind":"supabase","operation":"up","stackId":"64616c83","waitMs":45000}`,
		`{"kind":"supabase","operation":"down","stackId":"` + testStackID + `"}`,
		`{"kind":"supabase","operation":"status","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"env","stackId":"0123abcd"}`,
		`{"kind":"supabase","operation":"reset","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"reset","worktreePath":"/Users/dev/app","seed":false,"note":"clean slate for the checkout test"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["auth","gateway","0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a"],"tail":1,"since":"start"}`,
		`{"kind":"supabase","operation":"log","stackId":"0123abcd","tail":1000,"since":"1h30m"}`,
		`{"kind":"supabase","operation":"log","stackId":"0123abcd","since":"2.5s"}`,
		`{"kind":"supabase","operation":"log","stackId":"0123abcd","since":"2026-10-17T09:30Z"}`,
		`{"kind":"supabase","operation":"log","stackId":"0123abcd","since":"2026-10-17T09:30:15.123456789+02:00"}`,
		`{"kind":"supabase","operation":"log","stackId":"0123abcd","since":"2026-10-17T09:30-23:59"}`,
		`{"kind":"supabase","operation":"destroy","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"destroy","stackId":"0123abcd","note":"` + strings.Repeat("é", 240) + `"}`,
	} {
		if err := Validate(json.RawMessage(accepted), protocol.CommandSupabase); err != nil {
			t.Errorf("%s: %v", accepted, err)
		}
	}
	for _, rejected := range []string{
		`{"kind":"supabase"}`,
		`{"kind":"supabase","operation":"start","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"ls","worktreePath":"/Users/dev/app"}`,
		`{"kind":"supabase","operation":"ls","stackId":"0123abcd"}`,
		`{"kind":"supabase","operation":"ls","waitMs":10}`,
		`{"kind":"supabase","operation":"up"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","stackId":"0123abcd"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"relative/app"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/\u0000app"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/\napp"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/\u0085app"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/` + strings.Repeat("a", 1024) + `"}`,
		`{"kind":"supabase","operation":"up","stackId":"0123abc"}`,
		`{"kind":"supabase","operation":"up","stackId":"0123ABCD"}`,
		`{"kind":"supabase","operation":"up","stackId":"` + testStackID + `0"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","waitMs":45001}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","waitMs":-1}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","waitMs":1.5}`,
		`{"kind":"supabase","operation":"down","worktreePath":"/Users/dev/app","waitMs":1000}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","seed":true}`,
		`{"kind":"supabase","operation":"status","worktreePath":"/Users/dev/app","tail":10}`,
		`{"kind":"supabase","operation":"env","worktreePath":"/Users/dev/app","services":["auth"]}`,
		`{"kind":"supabase","operation":"reset","worktreePath":"/Users/dev/app","since":"start"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":[]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["auth","auth"]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["unknown"]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["postgres"]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["0F8C2A4E-1B3D-4C5E-8F9A-0B1C2D3E4F5A"]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["auth","rest","realtime","storage","imgproxy","functions","studio","pgmeta","mail","analytics","pooler","gateway","database","0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a","1f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a","2f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a","3f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a"]}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","tail":0}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","tail":1001}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"yesterday"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"10"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"2026-10-17"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"2026-02-30T09:30Z"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"2026-10-17T25:30Z"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"2026-10-17T09:30+24:00"}`,
		`{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","since":"2026-10-17T09:30:60Z"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","note":"why"}`,
		`{"kind":"supabase","operation":"destroy","stackId":"0123abcd","note":"` + strings.Repeat("a", 241) + `"}`,
		`{"kind":"supabase","operation":"destroy","stackId":"0123abcd","note":"` + strings.Repeat("😀", 121) + `"}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","agent":{"kind":"claude","sessionId":"s"}}`,
		`{"kind":"supabase","operation":"up","worktreePath":"/Users/dev/app","runtime":"native"}`,
		`{"kind":"supabase","operation":"up","worktreePath":null}`,
	} {
		if err := Validate(json.RawMessage(rejected), protocol.CommandSupabase); err == nil {
			t.Errorf("expected rejection: %s", rejected)
		}
	}
}

func TestSupabaseFlagsBuildTheWireCommand(t *testing.T) {
	parsed, err := Parse(protocol.CommandSupabase, []string{
		"--operation", "log", "--worktree", "/Users/dev/app",
		"--service", "auth", "--service", "rest,gateway", "--tail", "50", "--since", "10m",
	}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"kind":"supabase","operation":"log","worktreePath":"/Users/dev/app","services":["auth","rest","gateway"],"tail":50,"since":"10m"}`
	if !sameJSON(t, parsed.Command, want) {
		t.Fatalf("command %s, want %s", parsed.Command, want)
	}
	reset, err := Parse(protocol.CommandSupabase, []string{"--operation", "reset", "--stack-id", "0123abcd", "--seed=false", "--note", "flaky seed"}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	if !sameJSON(t, reset.Command, `{"kind":"supabase","operation":"reset","stackId":"0123abcd","seed":false,"note":"flaky seed"}`) {
		t.Fatalf("reset command %s", reset.Command)
	}
	// Other flags still refuse repetition.
	if _, err := Parse(protocol.CommandSupabase, []string{"--operation", "up", "--operation", "down", "--worktree", "/w"}, strings.NewReader(""), false); err == nil {
		t.Fatal("a repeated --operation must be rejected")
	}
	if _, err := Parse(protocol.CommandSupabase, []string{"--operation", "log", "--worktree", "/w", "--service", "auth,"}, strings.NewReader(""), false); err == nil {
		t.Fatal("an empty service name must be rejected")
	}
}

func TestPathFlagsResolveAgainstTheWorkingDirectory(t *testing.T) {
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		kind      protocol.Command
		arguments []string
	}{
		{protocol.CommandSupabase, []string{"--operation", "up", "--worktree", "."}},
		{protocol.CommandLane, []string{"--operation", "up", "--worktree", "."}},
		{protocol.CommandNative, []string{"--operation", "plan", "--worktree", "."}},
	} {
		parsed, err := Parse(testCase.kind, testCase.arguments, strings.NewReader(""), false)
		if err != nil {
			t.Fatalf("%s: %v", testCase.kind, err)
		}
		var decoded struct {
			WorktreePath string `json:"worktreePath"`
		}
		if err := json.Unmarshal(parsed.Command, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.WorktreePath != directory {
			t.Fatalf("%s: worktreePath %q, want %q", testCase.kind, decoded.WorktreePath, directory)
		}
	}
	// Absolute paths pass through untouched; stdin and tool calls are never
	// resolved, because neither shares the caller's directory.
	parsed, err := Parse(protocol.CommandSupabase, []string{"--operation", "up", "--worktree", "/Users/dev/app/"}, strings.NewReader(""), false)
	if err != nil || !strings.Contains(string(parsed.Command), `"worktreePath":"/Users/dev/app/"`) {
		t.Fatalf("absolute path changed: %s %v", parsed.Command, err)
	}
	if _, err := Parse(protocol.CommandSupabase, []string{"--operation", "up"}, strings.NewReader(`{"worktreePath":"."}`), true); err == nil {
		t.Fatal("a relative stdin path must be rejected")
	}
	if _, err := Build(protocol.CommandSupabase, map[string]any{"operation": "up", "worktree": "."}, nil); err == nil {
		t.Fatal("a relative tool-call path must be rejected")
	}
}

func TestSupabaseDeadlinesSitPastTheDesktopBudgets(t *testing.T) {
	for _, testCase := range []struct {
		arguments []string
		stdin     string
		want      time.Duration
	}{
		{[]string{"--operation", "up", "--worktree", "/w"}, "", 45 * time.Second},
		{[]string{"--operation", "up", "--worktree", "/w", "--wait-ms", "0"}, "", 15 * time.Second},
		{[]string{"--operation", "up", "--worktree", "/w", "--wait-ms", "45000"}, "", 60 * time.Second},
		{[]string{"--operation", "up", "--worktree", "/w"}, `{"waitMs":20000}`, 35 * time.Second},
		{[]string{"--operation", "reset", "--worktree", "/w"}, "", 75 * time.Second},
		{[]string{"--operation", "ls"}, "", 45 * time.Second},
		{[]string{"--operation", "down", "--worktree", "/w"}, "", 45 * time.Second},
		{[]string{"--operation", "log", "--worktree", "/w"}, "", 45 * time.Second},
		{[]string{"--operation", "up", "--worktree", "/w", "--request-timeout-ms", "5000"}, "", 5 * time.Second},
	} {
		parsed, err := Parse(protocol.CommandSupabase, testCase.arguments, strings.NewReader(testCase.stdin), testCase.stdin != "")
		if err != nil {
			t.Fatalf("%v: %v", testCase.arguments, err)
		}
		if parsed.Timeout != testCase.want {
			t.Errorf("%v %s: timeout %v, want %v", testCase.arguments, testCase.stdin, parsed.Timeout, testCase.want)
		}
	}
	// A wait read from stdin is a json.Number; it must still size the deadline.
	wait, err := Parse(protocol.CommandWait, []string{"--condition", "network-idle"}, strings.NewReader(`{"timeoutMs":120000}`), true)
	if err != nil {
		t.Fatal(err)
	}
	if wait.Timeout != 130*time.Second {
		t.Fatalf("wait timeout from stdin %v", wait.Timeout)
	}
}

func TestSupabaseCarriesNoAgentInTheCommand(t *testing.T) {
	lookup := func(name string) string {
		if name == "CLAUDE_CODE_SESSION_ID" {
			return "session-abc"
		}
		return ""
	}
	parsed, err := ParseWithEnvironment(protocol.CommandSupabase, []string{"--operation", "up", "--worktree", "/Users/dev/app"}, strings.NewReader(""), false, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(parsed.Command), "agent") {
		t.Fatalf("the agent rides on the envelope only: %s", parsed.Command)
	}
}

func TestLaneUpAcceptsABackendPolicy(t *testing.T) {
	parsed, err := Parse(protocol.CommandLane, []string{"--operation", "up", "--worktree", "/Users/dev/app", "--backend", "required"}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(parsed.Command), `"backend":"required"`) {
		t.Fatalf("backend not sent: %s", parsed.Command)
	}
	for _, accepted := range []string{"auto", "off", "required"} {
		if err := Validate(json.RawMessage(`{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","backend":"`+accepted+`"}`), protocol.CommandLane); err != nil {
			t.Fatalf("%s: %v", accepted, err)
		}
	}
	for _, rejected := range []string{
		`{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","backend":"docker"}`,
		`{"kind":"lane","operation":"up","worktreePath":"/Users/dev/app","backend":""}`,
		`{"kind":"lane","operation":"launch","worktreePath":"/Users/dev/app","backend":"auto"}`,
		`{"kind":"lane","operation":"down","worktreePath":"/Users/dev/app","backend":"off"}`,
		`{"kind":"lane","operation":"ls","backend":"off"}`,
	} {
		if err := Validate(json.RawMessage(rejected), protocol.CommandLane); err == nil {
			t.Fatalf("expected rejection: %s", rejected)
		}
	}
}

func sameJSON(t *testing.T, encoded json.RawMessage, want string) bool {
	t.Helper()
	var left, right any
	if err := json.Unmarshal(encoded, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &right); err != nil {
		t.Fatal(err)
	}
	return string(mustJSON(left)) == string(mustJSON(right))
}
