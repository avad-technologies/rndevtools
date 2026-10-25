package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

const testID = "cli-0123456789abcdef0123456789abcdef"

func TestEncodeRequestUsesFrozenEnvelope(t *testing.T) {
	encoded, err := EncodeRequest(Request{
		Protocol: Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"protocol":"rndevtools/1","id":"cli-0123456789abcdef0123456789abcdef","command":{"kind":"doctor"}}`
	if string(encoded) != want {
		t.Fatalf("encoded request = %s, want %s", encoded, want)
	}
}

func TestSupabaseIsACommandListedAfterLane(t *testing.T) {
	if command, err := ParseCommand("supabase"); err != nil || command != CommandSupabase {
		t.Fatalf("ParseCommand(supabase) = %q, %v", command, err)
	}
	commands := Commands()
	for index, command := range commands {
		if command == CommandLane {
			if index+1 >= len(commands) || commands[index+1] != CommandSupabase {
				t.Fatalf("supabase must follow lane: %v", commands)
			}
		}
	}
	if _, err := EncodeRequest(Request{Protocol: Name, ID: testID, Command: json.RawMessage(`{"kind":"supabase","operation":"ls"}`)}); err != nil {
		t.Fatal(err)
	}
}

func TestNewRequestIDIsAPrefixedRandomIdentifier(t *testing.T) {
	first, err := NewRequestID("mcp-")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewRequestID("mcp-")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first, "mcp-") || len(first) != len("mcp-")+32 || first == second {
		t.Fatalf("request ids %q and %q", first, second)
	}
	if _, err := EncodeRequest(Request{Protocol: Name, ID: first, Command: json.RawMessage(`{"kind":"doctor"}`)}); err != nil {
		t.Fatalf("a generated id must be a valid request id: %v", err)
	}
}

func TestEncodeRequestRejectsUnknownCommandAndOversize(t *testing.T) {
	for name, request := range map[string]Request{
		"unknown": {
			Protocol: Name,
			ID:       testID,
			Command:  json.RawMessage(`{"kind":"shell"}`),
		},
		"oversize": {
			Protocol: Name,
			ID:       testID,
			Command: json.RawMessage(
				`{"kind":"doctor","padding":"` + strings.Repeat("x", MaxRequestBytes) + `"}`,
			),
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := EncodeRequest(request); err == nil {
				t.Fatal("expected request rejection")
			}
		})
	}
}

func TestDecodeResponseValidatesCorrelationAndShape(t *testing.T) {
	response, err := DecodeResponse(
		[]byte(`{"protocol":"rndevtools/1","id":"`+testID+`","ok":true,"result":{"healthy":true}}`),
		testID,
	)
	if err != nil || !response.OK {
		t.Fatalf("DecodeResponse() = %#v, %v", response, err)
	}

	failures := []string{
		`{"protocol":"rndevtools/1","id":"other","ok":true,"result":{}}`,
		`{"protocol":"rndevtools/1","id":"` + testID + `","result":{}}`,
		`{"protocol":"rndevtools/1","id":"` + testID + `","ok":false,"error":{"code":"busy","message":"busy"}}`,
		`{"protocol":"rndevtools/1","id":"` + testID + `","ok":true,"result":{},"extra":true}`,
	}
	for _, encoded := range failures {
		if _, err := DecodeResponse([]byte(encoded), testID); err == nil {
			t.Fatalf("expected response rejection: %s", encoded)
		}
	}
}

func TestDecodeResponseAcceptsCorrelatedAndPreparseErrors(t *testing.T) {
	for _, id := range []string{testID, ""} {
		response, err := DecodeResponse(
			[]byte(`{"protocol":"rndevtools/1","id":"`+id+`","ok":false,"error":{"code":"server_busy","message":"Busy","retryable":true,"recovery":"Retry."}}`),
			testID,
		)
		if err != nil || response.OK || !response.Error.Retryable {
			t.Fatalf("DecodeResponse() = %#v, %v", response, err)
		}
	}
}
