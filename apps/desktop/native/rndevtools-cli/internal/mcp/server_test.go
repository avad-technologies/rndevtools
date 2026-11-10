package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const udid = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

type recorded struct {
	request protocol.Request
	timeout time.Duration
}

func newTestServer(t *testing.T, respond func(protocol.Request) (protocol.Response, error), files map[string][]byte, env map[string]string) (*Server, *[]recorded) {
	t.Helper()
	var calls []recorded
	// Calls run on their own goroutines; Serve has returned, and every call
	// with it, before a test reads the slice.
	var lock sync.Mutex
	server := New(Config{
		Version: "test",
		Transport: func(_ context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
			lock.Lock()
			calls = append(calls, recorded{request: request, timeout: timeout})
			lock.Unlock()
			return respond(request)
		},
		Lookup: func(name string) string { return env[name] },
		ReadFile: func(path string) ([]byte, error) {
			if data, ok := files[path]; ok {
				return data, nil
			}
			return nil, errors.New("missing")
		},
	})
	return server, &calls
}

// exchange sends messages and returns the responses ordered by id, with the
// id-less ones (parse errors) first: calls run concurrently, so they may
// finish in any order.
func exchange(t *testing.T, server *Server, messages ...string) []map[string]any {
	t.Helper()
	var output bytes.Buffer
	if err := server.Serve(context.Background(), strings.NewReader(strings.Join(messages, "\n")+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	return decodeResponses(t, output.String())
}

func decodeResponses(t *testing.T, output string) []map[string]any {
	t.Helper()
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Fatalf("invalid response line %q: %v", line, err)
		}
		responses = append(responses, decoded)
	}
	order := func(response map[string]any) float64 {
		if id, ok := response["id"].(float64); ok {
			return id
		}
		return -1
	}
	sort.SliceStable(responses, func(a, b int) bool { return order(responses[a]) < order(responses[b]) })
	return responses
}

// callWith is the recorded socket call whose command contains fragment.
func callWith(t *testing.T, calls []recorded, fragment string) recorded {
	t.Helper()
	for _, call := range calls {
		if strings.Contains(string(call.request.Command), fragment) {
			return call
		}
	}
	t.Fatalf("no socket call carries %s", fragment)
	return recorded{}
}

func okResponse(request protocol.Request, result string) (protocol.Response, error) {
	return protocol.Response{Protocol: protocol.Name, ID: request.ID, OK: true, Result: json.RawMessage(result)}, nil
}

func TestInitializeAndListTools(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"ping"}`,
	)
	if len(responses) != 3 {
		t.Fatalf("expected 3 responses (notification is silent), got %d", len(responses))
	}
	init := responses[0]["result"].(map[string]any)
	if init["protocolVersion"] != ProtocolVersion {
		t.Fatalf("protocol version %v", init["protocolVersion"])
	}
	if !strings.Contains(init["instructions"].(string), "xcrun simctl") {
		t.Fatal("instructions must warn against raw simctl")
	}
	tools := responses[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(protocol.Commands()) {
		t.Fatalf("%d tools for %d commands", len(tools), len(protocol.Commands()))
	}
	first := tools[0].(map[string]any)
	if first["name"] != "lane" {
		t.Fatalf("lane must be listed first, got %v", first["name"])
	}
	schema := first["inputSchema"].(map[string]any)
	if schema["additionalProperties"] != false {
		t.Fatal("schemas must close additional properties")
	}
	properties := schema["properties"].(map[string]any)
	if properties["preferred-port"].(map[string]any)["type"] != "integer" {
		t.Fatalf("preferred-port type: %v", properties["preferred-port"])
	}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		if tool["description"] == "" || tool["title"] == "" {
			t.Fatalf("tool %v lacks description or title", tool["name"])
		}
		// Some clients cut descriptions at 2048 characters.
		if length := len([]rune(tool["description"].(string))); length > 2048 {
			t.Fatalf("tool %v description has %d characters", tool["name"], length)
		}
		if _, ok := tool["annotations"].(map[string]any)["readOnlyHint"]; !ok {
			t.Fatalf("tool %v lacks annotations", tool["name"])
		}
	}
}

func TestToolCallBuildsValidatesAndAttributes(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"udid":"`+udid+`","kind":"tap","messages":2,"elapsedMilliseconds":9,"transport":"indigo"}`)
	}, nil, map[string]string{"CLAUDE_CODE_SESSION_ID": "sess-1"})
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"`+udid+`","kind":"tap","x":0.39,"y":0.92}}}`,
	)
	result := responses[0]["result"].(map[string]any)
	if result["isError"] != false {
		t.Fatalf("unexpected error: %v", result)
	}
	if len(*calls) != 1 {
		t.Fatalf("%d socket calls", len(*calls))
	}
	request := (*calls)[0].request
	if request.Agent["kind"] != "claude" || request.Agent["sessionId"] != "sess-1" {
		t.Fatalf("agent not attributed from the environment: %v", request.Agent)
	}
	if !strings.HasPrefix(request.ID, "mcp-") {
		t.Fatalf("request id %q", request.ID)
	}
	var sent map[string]any
	_ = json.Unmarshal(request.Command, &sent)
	input := sent["input"].(map[string]any)
	if input["x"] != 0.39 || input["kind"] != "tap" || sent["kind"] != "input" {
		t.Fatalf("command shape: %s", request.Command)
	}
	structured := result["structuredContent"].(map[string]any)
	if structured["transport"] != "indigo" {
		t.Fatalf("structured content missing: %v", structured)
	}
}

func TestToolCallFallsBackToClientNameForAttribution(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{"simulators":[]}`) }, nil, nil)
	exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Codex CLI","version":"1"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"simulators","arguments":{}}}`,
	)
	agent := (*calls)[0].request.Agent
	if agent["kind"] != "codex" || agent["sessionId"] != "mcp-Codex-CLI" {
		t.Fatalf("fallback attribution: %v", agent)
	}
}

func TestInvalidArgumentsAreToolErrorsNotProtocolErrors(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"`+udid+`","kind":"tap","x":2,"y":0.5}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"teleport","arguments":{}}}`,
	)
	if len(*calls) != 0 {
		t.Fatal("invalid calls must not reach the socket")
	}
	bad := responses[0]["result"].(map[string]any)
	if bad["isError"] != true {
		t.Fatalf("expected isError for out-of-range tap: %v", bad)
	}
	text := bad["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "invalid_arguments") || !strings.Contains(text, "input schema") {
		t.Fatalf("tool error text: %q", text)
	}
	if responses[1]["error"].(map[string]any)["code"].(float64) != codeInvalidParams {
		t.Fatalf("unknown tool should be a protocol error: %v", responses[1])
	}
}

func TestRemoteAndTransportErrorsCarryRecovery(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return protocol.Response{Protocol: protocol.Name, ID: r.ID, OK: false, Error: &protocol.RemoteError{Code: "target_not_found", Message: "no such device", Retryable: true, Recovery: "Run simulators."}}, nil
	}, nil, nil)
	responses := exchange(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"`+udid+`"}}}`)
	result := responses[0]["result"].(map[string]any)
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "target_not_found") || !strings.Contains(text, "Recovery: Run simulators.") {
		t.Fatalf("remote error text: %q", text)
	}

	down, _ := newTestServer(t, func(protocol.Request) (protocol.Response, error) {
		return protocol.Response{}, &client.ClientError{Kind: client.ErrorUnavailable, Cause: errors.New("connect: no such file")}
	}, nil, nil)
	responses = exchange(t, down, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simulators","arguments":{}}}`)
	text = responses[0]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "desktop_unavailable") || !strings.Contains(text, "start the RN Devtools app") {
		t.Fatalf("unavailable text: %q", text)
	}
}

func TestCaptureEmbedsTheImage(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"job":{"id":"j"},"capture":{"id":"c","mimeType":"image/png","bytes":7},"path":"/captures/c.png"}`)
	}, map[string][]byte{"/captures/c.png": png}, nil)
	responses := exchange(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"`+udid+`"}}}`)
	content := responses[0]["result"].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("expected text + image, got %d blocks", len(content))
	}
	image := content[1].(map[string]any)
	if image["type"] != "image" || image["mimeType"] != "image/png" {
		t.Fatalf("image block: %v", image)
	}
	decoded, _ := base64.StdEncoding.DecodeString(image["data"].(string))
	if !bytes.Equal(decoded, png) {
		t.Fatal("image bytes differ")
	}
}

func TestResources(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G'}
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		if strings.Contains(string(r.Command), `"capture"`) {
			return okResponse(r, `{"capture":{"id":"c","mimeType":"image/png"},"path":"/captures/c.png"}`)
		}
		return okResponse(r, `{"lanes":[]}`)
	}, map[string][]byte{"/captures/c.png": png}, nil)
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"resources/templates/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"rndevtools://lanes"}}`,
		`{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"rndevtools://screen/`+strings.ToLower(udid)+`"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"rndevtools://screen/booted"}}`,
	)
	if len(responses[0]["result"].(map[string]any)["resources"].([]any)) != 4 {
		t.Fatal("expected four static resources")
	}
	if len(responses[1]["result"].(map[string]any)["resourceTemplates"].([]any)) != 1 {
		t.Fatal("expected the screen template")
	}
	lanes := responses[2]["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if lanes["text"] != `{"lanes":[]}` {
		t.Fatalf("lanes resource: %v", lanes)
	}
	if lane := callWith(t, *calls, `"kind":"lane"`); !strings.Contains(string(lane.request.Command), `"operation":"ls"`) {
		t.Fatalf("lanes resource must run lane ls: %s", lane.request.Command)
	}
	screen := responses[3]["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if screen["mimeType"] != "image/png" || screen["blob"] != base64.StdEncoding.EncodeToString(png) {
		// The fixture capture reports PNG, so the resource echoes that mime type.
		t.Fatalf("screen resource: %v", screen)
	}
	capture := callWith(t, *calls, `"kind":"capture"`)
	if !strings.Contains(string(capture.request.Command), strings.ToUpper(udid)) {
		t.Fatal("screen resource must canonicalise the UDID")
	}
	if !strings.Contains(string(capture.request.Command), `"format":"jpeg"`) {
		t.Fatal("screen resource must request JPEG to keep the frame small")
	}
	if responses[4]["error"] == nil {
		t.Fatal("non-UDID screen resource must be rejected")
	}
}

func TestSupabaseToolFollowsLaneAndSpeaksTheWireContract(t *testing.T) {
	tools := Tools()
	if len(tools) < 2 || tools[0].Name != "lane" || tools[1].Name != "supabase" {
		t.Fatalf("supabase must be listed right after lane: %v, %v", tools[0].Name, tools[1].Name)
	}
	supabase := tools[1]
	if supabase.Annotations["readOnlyHint"] != false || supabase.Annotations["destructiveHint"] != false {
		t.Fatalf("supabase annotations: %v", supabase.Annotations)
	}
	if required, _ := supabase.InputSchema["required"].([]string); len(required) != 1 || required[0] != "operation" {
		t.Fatalf("supabase required fields: %v", supabase.InputSchema["required"])
	}
	properties := supabase.InputSchema["properties"].(map[string]any)
	for _, name := range []string{"operation", "worktree", "stack-id", "wait-ms", "seed", "service", "tail", "since", "note"} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("supabase tool lacks %s", name)
		}
	}
	if properties["service"].(map[string]any)["type"] != "array" {
		t.Fatalf("service must be an array: %v", properties["service"])
	}
	for _, phrase := range []string{"supabase/config.toml", "--runtime native", "never run supabase start, stop, stack, or local", "lane up", "jobId"} {
		if !strings.Contains(supabase.Description, phrase) {
			t.Fatalf("supabase description lacks %q", phrase)
		}
	}
	if !strings.Contains(tools[0].Description, "backend") {
		t.Fatal("the lane description must explain backend")
	}
	if _, ok := tools[0].InputSchema["properties"].(map[string]any)["backend"]; !ok {
		t.Fatal("lane up must take backend")
	}
	for _, phrase := range []string{"Supabase", "supabase start --runtime native", "stop --all", "release with all=true"} {
		if !strings.Contains(instructions, phrase) {
			t.Fatalf("instructions lack %q", phrase)
		}
	}

	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"operation":"ls","stacks":[]}`)
	}, nil, map[string]string{"CLAUDE_CODE_SESSION_ID": "sess-1"})
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"supabase","arguments":{"operation":"up","worktree":"/Users/dev/app","wait-ms":5000}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"rndevtools://supabase"}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"supabase","arguments":{"operation":"ls","worktree":"/Users/dev/app"}}}`,
	)
	if len(*calls) != 2 {
		t.Fatalf("%d socket calls; the invalid ls must not reach the socket", len(*calls))
	}
	up := callWith(t, *calls, `"operation":"up"`)
	if string(up.request.Command) != `{"kind":"supabase","operation":"up","waitMs":5000,"worktreePath":"/Users/dev/app"}` {
		t.Fatalf("up command: %s", up.request.Command)
	}
	if up.request.Agent["sessionId"] != "sess-1" || up.timeout != 20*time.Second {
		t.Fatalf("up attribution %v, timeout %v", up.request.Agent, up.timeout)
	}
	if ls := callWith(t, *calls, `"operation":"ls"`); string(ls.request.Command) != `{"kind":"supabase","operation":"ls"}` {
		t.Fatalf("the supabase resource must run ls: %s", ls.request.Command)
	}
	contents := responses[1]["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if contents["uri"] != "rndevtools://supabase" || contents["mimeType"] != "application/json" {
		t.Fatalf("supabase resource: %v", contents)
	}
	if responses[2]["result"].(map[string]any)["isError"] != true {
		t.Fatalf("ls with a worktree must be a tool error: %v", responses[2])
	}
}

func TestLaneToolTakesRestartAndTheInstructionsSayWhen(t *testing.T) {
	lane := Tools()[0]
	if lane.Name != "lane" {
		t.Fatalf("lane must be listed first, got %s", lane.Name)
	}
	properties := lane.InputSchema["properties"].(map[string]any)
	restart, ok := properties["restart"].(map[string]any)
	if !ok || restart["type"] != "boolean" {
		t.Fatalf("lane restart parameter: %v", restart)
	}
	usage, _ := restart["description"].(string)
	for _, phrase := range []string{"(up, launch)", "first launch", "another lane or a person", "debug target", "without restart keeps the app's state", "ios.bundleIdentifier"} {
		if !strings.Contains(usage, phrase) {
			t.Fatalf("restart description lacks %q: %s", phrase, usage)
		}
	}
	for _, phrase := range []string{"pass restart to up or launch", "names the lane and the command that retries it", "(lane-id, url, restart)"} {
		if !strings.Contains(lane.Description, phrase) {
			t.Fatalf("lane description lacks %q", phrase)
		}
	}
	// The desktop picks a free iPhone when udid is left out; nothing tells
	// agents to always pass one.
	if udid, _ := properties["udid"].(map[string]any)["description"].(string); !strings.Contains(udid, "Omit it to let RN Devtools pick a free iPhone") {
		t.Fatalf("udid description: %s", udid)
	}
	for _, phrase := range []string{"leave udid out and the desktop picks a free device", "pass udid when the user named a device or is using one", "Pass restart to lane up or launch", "started by another lane or by hand", "launch, terminate, or io directly"} {
		if !strings.Contains(instructions, phrase) {
			t.Fatalf("instructions lack %q: %s", phrase, instructions)
		}
	}
	if strings.Contains(instructions, "always pass") {
		t.Fatalf("instructions must not tell agents to always pass a udid: %s", instructions)
	}

	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"completed":true}`)
	}, nil, map[string]string{"CLAUDE_CODE_SESSION_ID": "sess-1"})
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lane","arguments":{"operation":"launch","lane-id":"lane-11111111-2222-4333-8444-555555555555","restart":true}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lane","arguments":{"operation":"ls","restart":true}}}`,
	)
	if len(*calls) != 1 {
		t.Fatalf("%d socket calls; lane ls with restart must not reach the socket", len(*calls))
	}
	launch := callWith(t, *calls, `"operation":"launch"`)
	if string(launch.request.Command) != `{"agent":{"kind":"claude","sessionId":"sess-1"},"kind":"lane","laneId":"lane-11111111-2222-4333-8444-555555555555","operation":"launch","restart":true}` {
		t.Fatalf("launch command: %s", launch.request.Command)
	}
	refused := responses[1]["result"].(map[string]any)
	if refused["isError"] != true || !strings.Contains(fmt.Sprint(refused["content"]), "only lane up and launch accept restart") {
		t.Fatalf("lane ls with restart must be a tool error that says why: %v", refused)
	}
}

func TestMalformedInputIsAnsweredNotFatal(t *testing.T) {
	server, _ := newTestServer(t, func(r protocol.Request) (protocol.Response, error) { return okResponse(r, `{}`) }, nil, nil)
	responses := exchange(t, server, `not json`, `{"jsonrpc":"1.0","id":1,"method":"ping"}`, `{"jsonrpc":"2.0","id":2,"method":"wat"}`)
	if responses[0]["error"].(map[string]any)["code"].(float64) != codeParse {
		t.Fatalf("parse error code: %v", responses[0])
	}
	if responses[1]["error"].(map[string]any)["code"].(float64) != codeInvalidRequest {
		t.Fatalf("invalid request code: %v", responses[1])
	}
	if responses[2]["error"].(map[string]any)["code"].(float64) != codeMethodNotFound {
		t.Fatalf("method not found code: %v", responses[2])
	}
}

// liveSession runs Serve over pipes so a test can send one message at a time
// and see each response as it is written.
type liveSession struct {
	t         *testing.T
	input     *io.PipeWriter
	responses chan map[string]any
	served    chan error
}

func startSession(t *testing.T, server *Server) *liveSession {
	t.Helper()
	in, input := io.Pipe()
	fromServer, out := io.Pipe()
	session := &liveSession{t: t, input: input, responses: make(chan map[string]any, 16), served: make(chan error, 1)}
	go func() {
		session.served <- server.Serve(context.Background(), in, out)
		_ = out.Close()
	}()
	go func() {
		defer close(session.responses)
		scanner := bufio.NewScanner(fromServer)
		for scanner.Scan() {
			var decoded map[string]any
			if json.Unmarshal(scanner.Bytes(), &decoded) == nil {
				session.responses <- decoded
			}
		}
	}()
	return session
}

// send writes one message; a server that stops reading fails fast.
func (session *liveSession) send(message string) {
	session.t.Helper()
	written := make(chan error, 1)
	go func() {
		_, err := io.WriteString(session.input, message+"\n")
		written <- err
	}()
	select {
	case err := <-written:
		if err != nil {
			session.t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		session.t.Fatal("the server stopped reading within 5 s: something held up the session")
	}
}

// receive is the next response; a session that stops answering fails fast.
func (session *liveSession) receive() map[string]any {
	session.t.Helper()
	select {
	case response, ok := <-session.responses:
		if !ok {
			session.t.Fatal("the server stopped writing responses")
		}
		return response
	case <-time.After(5 * time.Second):
		session.t.Fatal("no response within 5 s: something held up the session")
	}
	return nil
}

// close ends the input and waits for Serve, which must write nothing more.
func (session *liveSession) close() {
	session.t.Helper()
	_ = session.input.Close()
	select {
	case err := <-session.served:
		if err != nil {
			session.t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		session.t.Fatal("Serve did not return after EOF")
	}
	for response := range session.responses {
		session.t.Fatalf("unexpected response after the last call: %v", response)
	}
}

func within(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

const otherUDID = "BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF"

func TestALongCallHoldsUpNothingAndACancelStopsIt(t *testing.T) {
	waiting := make(chan struct{})
	cancelled := make(chan struct{})
	server := New(Config{
		Version: "test",
		Transport: func(ctx context.Context, request protocol.Request, _ time.Duration) (protocol.Response, error) {
			if strings.Contains(string(request.Command), `"kind":"wait"`) {
				// The desktop never answers this one; only the client's cancel ends it.
				close(waiting)
				<-ctx.Done()
				close(cancelled)
				return protocol.Response{}, ctx.Err()
			}
			return okResponse(request, `{}`)
		},
		Lookup: func(string) string { return "" },
	})
	session := startSession(t, server)
	session.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait","arguments":{"udid":"` + udid + `","condition":"element","element-id":"e1","timeout-ms":600000}}}`)
	within(t, waiting, "the wait to reach the desktop")
	session.send(`{"jsonrpc":"2.0","id":2,"method":"ping"}`)
	if id := session.receive()["id"]; id != float64(2) {
		t.Fatalf("ping answered as %v", id)
	}
	// A read-only wait holds up nothing, not even a tap on the device it watches.
	session.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"input","arguments":{"udid":"` + udid + `","kind":"button","button":"home"}}}`)
	if response := session.receive(); response["id"] != float64(3) || response["result"].(map[string]any)["isError"] != false {
		t.Fatalf("input while the wait runs: %v", response)
	}
	session.send(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"user pressed Esc"}}`)
	within(t, cancelled, "the cancel to reach the in-flight wait")
	// The cancelled call gets no response.
	session.close()
}

func TestCallsNamingOneSimulatorKeepTheAgentsOrder(t *testing.T) {
	tapping := make(chan struct{})
	release := make(chan struct{})
	captured := make(chan string, 2)
	server := New(Config{
		Version: "test",
		Transport: func(_ context.Context, request protocol.Request, _ time.Duration) (protocol.Response, error) {
			command := string(request.Command)
			switch {
			case strings.Contains(command, `"kind":"input"`):
				close(tapping)
				<-release
			case strings.Contains(command, `"kind":"capture"`):
				var sent struct {
					UDID string `json:"udid"`
				}
				_ = json.Unmarshal(request.Command, &sent)
				captured <- sent.UDID
			}
			return okResponse(request, `{}`)
		},
		Lookup:   func(string) string { return "" },
		ReadFile: func(string) ([]byte, error) { return nil, errors.New("no file") },
	})
	session := startSession(t, server)
	session.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"` + udid + `","kind":"tap","x":0.5,"y":0.5}}}`)
	within(t, tapping, "the tap to reach the desktop")
	session.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"` + udid + `"}}}`)
	session.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"` + otherUDID + `"}}}`)
	// Another Simulator is not held up by the tap.
	if response := session.receive(); response["id"] != float64(3) {
		t.Fatalf("the other device's capture must finish first: %v", response)
	}
	if first := <-captured; first != otherUDID {
		t.Fatalf("captured %s before the tap finished", first)
	}
	// The screenshot of the tapped device waits for the tap.
	select {
	case early := <-captured:
		t.Fatalf("captured %s while its tap was still running", early)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	answered := map[float64]bool{}
	for range 2 {
		answered[session.receive()["id"].(float64)] = true
	}
	if !answered[1] || !answered[2] {
		t.Fatalf("answered %v, want the tap and its screenshot", answered)
	}
	if second := <-captured; second != udid {
		t.Fatalf("captured %s, want %s after its tap", second, udid)
	}
	session.close()
}

func TestACancelledCallKeepsItsSlotAndItsPlaceUntilTheDesktopLetsGo(t *testing.T) {
	// Cancelling closes the call's socket, and the desktop sees that only at
	// its next liveness probe, so for a moment it still runs the call on a
	// connection of its own. Until then the call counts against the session's
	// slots and stays ahead of later calls on its device.
	const linger = 300 * time.Millisecond
	reached := make(chan string, 16)
	server := New(Config{
		Version: "test",
		Transport: func(ctx context.Context, request protocol.Request, _ time.Duration) (protocol.Response, error) {
			var sent struct {
				Kind string `json:"kind"`
			}
			_ = json.Unmarshal(request.Command, &sent)
			reached <- sent.Kind
			if sent.Kind == "wait" || sent.Kind == "input" {
				// The desktop is still working on these when the client gives up.
				<-ctx.Done()
				return protocol.Response{}, ctx.Err()
			}
			return okResponse(request, `{}`)
		},
		Lookup:   func(string) string { return "" },
		ReadFile: func(string) ([]byte, error) { return nil, errors.New("no file") },
	})
	server.linger = linger
	session := startSession(t, server)
	reachedAt := func(want string) time.Time {
		t.Helper()
		select {
		case kind := <-reached:
			if kind != want {
				t.Fatalf("%s reached the desktop, want %s", kind, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never reached the desktop", want)
		}
		return time.Now()
	}
	cancel := func(id int) {
		session.send(fmt.Sprintf(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":%d}}`, id))
	}

	session.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input","arguments":{"udid":"` + udid + `","kind":"tap","x":0.5,"y":0.5}}}`)
	reachedAt("input")
	cancelled := time.Now()
	cancel(1)
	session.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture","arguments":{"udid":"` + udid + `"}}}`)
	if waited := reachedAt("capture").Sub(cancelled); waited < linger {
		t.Fatalf("the screenshot reached the desktop %s after its tap was cancelled, while the desktop may still run the tap", waited)
	}
	if response := session.receive(); response["id"] != float64(2) {
		t.Fatalf("the screenshot was answered as %v", response)
	}

	// Four waits fill the session's slots, and a cancelled one keeps its own.
	for id := 3; id <= 6; id++ {
		session.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"wait","arguments":{"udid":"%s","condition":"element","element-id":"e%d","timeout-ms":600000}}}`, id, otherUDID, id))
		reachedAt("wait")
	}
	cancelled = time.Now()
	cancel(3)
	session.send(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"simulators","arguments":{}}}`)
	if waited := reachedAt("simulators").Sub(cancelled); waited < linger {
		t.Fatalf("a fifth call reached the desktop %s after a cancel, while the desktop may still hold four", waited)
	}
	if response := session.receive(); response["id"] != float64(7) {
		t.Fatalf("the fifth call was answered as %v", response)
	}
	for id := 4; id <= 6; id++ {
		cancel(id)
	}
	session.close()
}

func TestOnlyToolsThatOnlyObserveAreReadOnly(t *testing.T) {
	readOnly := map[string]bool{}
	for _, tool := range Tools() {
		readOnly[tool.Name] = tool.Annotations["readOnlyHint"] == true
	}
	// jobs can cancel another session's job; slimming applies profiles.
	for _, name := range []string{"simulator", "jobs", "slimming", "lane", "input", "act", "claim", "release", "record", "network", "recipe", "native", "supabase"} {
		if readOnly[name] {
			t.Errorf("%s changes state but is marked read-only", name)
		}
	}
	listed := ReadOnlyTools()
	for _, name := range listed {
		if !readOnly[name] {
			t.Errorf("ReadOnlyTools lists %s, whose readOnlyHint is false", name)
		}
	}
	count := 0
	for _, isReadOnly := range readOnly {
		if isReadOnly {
			count++
		}
	}
	if len(listed) != count || len(listed) == 0 {
		t.Fatalf("ReadOnlyTools %v must name every read-only tool (%d)", listed, count)
	}
}

func TestSimulatorLifecycleToolIsSeparateFromReadOnlySimulators(t *testing.T) {
	tools := make(map[string]Tool)
	for _, tool := range Tools() {
		tools[tool.Name] = tool
	}
	listing := tools["simulators"]
	listFields := listing.InputSchema["properties"].(map[string]any)
	if listing.Title != "List Simulators" || listing.Annotations["readOnlyHint"] != true || listing.Annotations["destructiveHint"] != false || len(listFields) != 1 || listFields["include-unavailable"] == nil {
		t.Fatalf("legacy simulators metadata changed: %#v", listing)
	}
	if !slices.Contains(ReadOnlyTools(), "simulators") || slices.Contains(ReadOnlyTools(), "simulator") {
		t.Fatalf("read-only grants are not preserved: %v", ReadOnlyTools())
	}
	lifecycle := tools["simulator"]
	properties := lifecycle.InputSchema["properties"].(map[string]any)
	operation := properties["operation"].(map[string]any)
	if !slices.Equal(operation["enum"].([]string), []string{"boot", "shutdown"}) || !slices.Equal(lifecycle.InputSchema["required"].([]string), []string{"operation", "udid"}) {
		t.Fatalf("simulator lifecycle metadata missing: %#v", lifecycle)
	}
	if lifecycle.Annotations["readOnlyHint"] != false || lifecycle.Annotations["destructiveHint"] != true || !strings.Contains(lifecycle.Description, "already claimed") {
		t.Fatalf("simulator ownership or mutation hint missing: %#v", lifecycle)
	}
}

func TestSimulatorLifecycleToolUsesNativeSessionAndExactUDID(t *testing.T) {
	server, calls := newTestServer(t, func(r protocol.Request) (protocol.Response, error) {
		return okResponse(r, `{"completed":true}`)
	}, nil, map[string]string{"CODEX_THREAD_ID": "owned-session"})
	responses := exchange(t, server,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"simulator","arguments":{"operation":"shutdown","udid":"`+udid+`"}}}`,
	)
	if responses[0]["result"].(map[string]any)["isError"] != false || len(*calls) != 1 {
		t.Fatalf("unexpected lifecycle response: %v, calls: %d", responses, len(*calls))
	}
	call := (*calls)[0].request
	if string(call.Command) != `{"kind":"simulator","operation":"shutdown","udid":"`+udid+`"}` || call.Agent["sessionId"] != "owned-session" {
		t.Fatalf("wrong lifecycle request: %s, agent: %v", call.Command, call.Agent)
	}
}

func TestClaimIsDescribedAsTheHoldTheDesktopEnforces(t *testing.T) {
	// The desktop refuses a claim on a device someone else holds and keeps
	// other agents' lanes, input, installs, slimming, recipe runs, and cancels
	// off a held one, so the text must not undersell a hold. It does not gate
	// act or network, which reach the app on the device, nor a session
	// stopping or cancelling a recording it started, so the text must not
	// promise those either.
	const ownRecording = "a session can always stop or cancel a recording it started itself"
	for _, tool := range Tools() {
		if tool.Name != "claim" {
			continue
		}
		for _, phrase := range []string{"A claim is a hold", "device_held", "release when finished", "act and network are not gated", ownRecording} {
			if !strings.Contains(tool.Description, phrase) {
				t.Fatalf("claim description lacks %q: %s", phrase, tool.Description)
			}
		}
		for _, overclaim := range []string{"advisory", "cannot drive", "drive or change"} {
			if strings.Contains(strings.ToLower(tool.Description), overclaim) {
				t.Fatalf("claim description says %q, which the desktop does not enforce: %s", overclaim, tool.Description)
			}
		}
		if strings.Contains(instructions, "only the holder may boot, drive") || !strings.Contains(instructions, "act and network are not gated") {
			t.Fatalf("the instructions must say what a hold gates and that act and network are not: %s", instructions)
		}
		if !strings.Contains(instructions, ownRecording) {
			t.Fatalf("the instructions must say a session can always stop its own recording: %s", instructions)
		}
		return
	}
	t.Fatal("no claim tool is listed")
}

func TestNativeToolGivesTheBuildWithoutAPort(t *testing.T) {
	// Expo CLI refuses --port with --no-bundler, so the build native plan
	// gives names no port, and a lane launch with restart then reopens the
	// app with the lane's Metro.
	for _, tool := range Tools() {
		if tool.Name != "native" {
			continue
		}
		for _, phrase := range []string{"names no port", "Expo CLI refuses --port with --no-bundler", "lane with operation launch, the lane-id, and restart"} {
			if !strings.Contains(tool.Description, phrase) {
				t.Fatalf("native description lacks %q: %s", phrase, tool.Description)
			}
		}
		if strings.Contains(tool.Description, "keep its --port") {
			t.Fatalf("native description still tells agents to keep a port: %s", tool.Description)
		}
		return
	}
	t.Fatal("no native tool is listed")
}

func TestNativeToolSaysAPlanMayWaitForAStartingLane(t *testing.T) {
	// A plan that is due to advise a build, and an install's cache_miss
	// answer, wait up to 15 s for the worktree's lane to turn ready while
	// its Metro is still starting, as it is right after lane up with launch
	// false. Agents told only "about two seconds" may give up on that wait.
	for _, tool := range Tools() {
		if tool.Name != "native" {
			continue
		}
		for _, phrase := range []string{"builds nothing and takes about two seconds", "up to 15 s longer", "lane is still starting"} {
			if !strings.Contains(tool.Description, phrase) {
				t.Fatalf("native description lacks %q: %s", phrase, tool.Description)
			}
		}
		return
	}
	t.Fatal("no native tool is listed")
}
