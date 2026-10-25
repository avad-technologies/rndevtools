package command

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

func TestDescribeMirrorsTheFlagTable(t *testing.T) {
	for _, kind := range protocol.Commands() {
		fields, ok := Describe(kind)
		if !ok {
			t.Fatalf("%s: no description", kind)
		}
		if len(fields) != len(commandFields[kind]) {
			t.Fatalf("%s: %d fields described, %d flags defined", kind, len(fields), len(commandFields[kind]))
		}
		for index, field := range fields {
			switch field.Type {
			case "string", "integer", "number", "boolean", "object":
			case "array":
				if field.Items != "string" {
					t.Fatalf("%s.%s: array without string items", kind, field.Name)
				}
			default:
				t.Fatalf("%s.%s: unexpected type %q", kind, field.Name, field.Type)
			}
			if field.Usage == "" || len(commandFields[kind][index].path) == 0 {
				t.Fatalf("%s.%s: missing usage or path", kind, field.Name)
			}
		}
	}
	if _, ok := Describe(protocol.Command("nope")); ok {
		t.Fatal("unknown command described")
	}
}

func TestBuildPlacesTypedArgumentsLikeFlags(t *testing.T) {
	fromFlags, err := Parse(protocol.CommandInput, []string{
		"--udid", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "--kind", "swipe",
		"--from-x", "0.5", "--from-y", "0.8", "--to-x", "0.5", "--to-y", "0.3", "--duration-ms", "300",
	}, strings.NewReader(""), false)
	if err != nil {
		t.Fatal(err)
	}
	fromArguments, err := Build(protocol.CommandInput, map[string]any{
		"udid": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "kind": "swipe",
		"from-x": 0.5, "from-y": 0.8, "to-x": 0.5, "to-y": 0.3, "duration-ms": float64(300),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var a, b map[string]any
	_ = json.Unmarshal(fromFlags.Command, &a)
	_ = json.Unmarshal(fromArguments.Command, &b)
	if string(mustJSON(a)) != string(mustJSON(b)) {
		t.Fatalf("flag and argument builds differ:\n%s\n%s", fromFlags.Command, fromArguments.Command)
	}
}

func TestBuildValidatesAndDerivesTimeouts(t *testing.T) {
	if _, err := Build(protocol.CommandInput, map[string]any{"udid": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "kind": "tap", "x": 1.5, "y": 0.5}, nil); err == nil {
		t.Fatal("out-of-range tap accepted")
	}
	if _, err := Build(protocol.CommandLane, map[string]any{"operation": "ls", "bogus": true}, nil); err == nil || !strings.Contains(err.Error(), "unknown argument") {
		t.Fatalf("unknown argument accepted: %v", err)
	}
	if _, err := Build(protocol.CommandInput, map[string]any{"udid": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "kind": "key", "usage": 40.5}, nil); err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("fractional integer accepted: %v", err)
	}
	if _, err := Build(protocol.CommandInput, map[string]any{"udid": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "kind": "key", "usage": 40, "modifiers": []any{"shift", 7}}, nil); err == nil {
		t.Fatal("non-string modifier accepted")
	}
	lane, err := Build(protocol.CommandLane, map[string]any{"operation": "ls"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if lane.Timeout != 240*time.Second {
		t.Fatalf("lane timeout %v", lane.Timeout)
	}
	wait, err := Build(protocol.CommandWait, map[string]any{"condition": "network-idle", "quiet-ms": 500, "timeout-ms": 120000}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if wait.Timeout != 130*time.Second {
		t.Fatalf("wait timeout %v", wait.Timeout)
	}
}

func TestBuildAttachesAgentToLaneUp(t *testing.T) {
	lookup := func(name string) string {
		if name == "CODEX_THREAD_ID" {
			return "thread-9"
		}
		return ""
	}
	parsed, err := Build(protocol.CommandLane, map[string]any{"operation": "up", "worktree": "/tmp/wt", "udid": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"}, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(parsed.Command), `"agent":{"kind":"codex","sessionId":"thread-9"}`) {
		t.Fatalf("agent not attached: %s", parsed.Command)
	}
	listed, err := Build(protocol.CommandLane, map[string]any{"operation": "ls"}, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(listed.Command), "agent") {
		t.Fatalf("agent attached to ls: %s", listed.Command)
	}
}

func TestBuildSupabaseFromToolArguments(t *testing.T) {
	fields, _ := Describe(protocol.CommandSupabase)
	types := map[string]string{}
	for _, field := range fields {
		types[field.Name] = field.Type
	}
	if types["service"] != "array" || types["wait-ms"] != "integer" || types["seed"] != "boolean" || types["worktree"] != "string" {
		t.Fatalf("supabase field types: %v", types)
	}
	up, err := Build(protocol.CommandSupabase, map[string]any{"operation": "up", "worktree": "/Users/dev/app", "wait-ms": float64(10_000)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if up.Timeout != 25*time.Second || !strings.Contains(string(up.Command), `"waitMs":10000`) {
		t.Fatalf("up: %s timeout %v", up.Command, up.Timeout)
	}
	// One service may arrive as a plain string; it means a list of one.
	for _, services := range []any{[]any{"auth", "gateway"}, "auth,gateway"} {
		logs, err := Build(protocol.CommandSupabase, map[string]any{"operation": "log", "stack-id": "0123abcd", "service": services}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(logs.Command), `"services":["auth","gateway"]`) || logs.Timeout != 45*time.Second {
			t.Fatalf("log: %s timeout %v", logs.Command, logs.Timeout)
		}
	}
	for _, bad := range []map[string]any{
		{"operation": "log", "stack-id": "0123abcd", "service": []any{}},
		{"operation": "log", "stack-id": "0123abcd", "service": []any{"auth", 3}},
		{"operation": "log", "stack-id": "0123abcd", "service": ""},
		{"operation": "up", "worktree": "/Users/dev/app", "wait-ms": 1.5},
		{"operation": "up", "worktree": "/Users/dev/app", "backend": "auto"},
	} {
		if _, err := Build(protocol.CommandSupabase, bad, nil); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	reset, err := Build(protocol.CommandSupabase, map[string]any{"operation": "reset", "worktree": "/Users/dev/app", "seed": false}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if reset.Timeout != 75*time.Second || !strings.Contains(string(reset.Command), `"seed":false`) {
		t.Fatalf("reset: %s timeout %v", reset.Command, reset.Timeout)
	}
}

func mustJSON(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}
