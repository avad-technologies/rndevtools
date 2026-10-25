// Package mcp serves the rndevtools commands to coding agents as a Model
// Context Protocol server over stdio. Every tool call is assembled, validated,
// and sent through exactly the path the CLI uses, so the desktop sees one kind
// of peer; this package adds only the JSON-RPC framing, the tool and resource
// catalog, and image embedding for screenshots.
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
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/command"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const (
	// ProtocolVersion is the MCP revision this server speaks.
	ProtocolVersion = "2025-06-18"
	serverName      = "rndevtools"
	// maxLineBytes bounds one incoming JSON-RPC message. Tool arguments are
	// small; anything larger is not a legitimate client.
	maxLineBytes = 1 << 20
	// maxImageBytes bounds a screenshot embedded in a response. Larger
	// captures are returned by path only.
	maxImageBytes = 8 << 20
	// maxConcurrentCalls bounds the socket requests one session keeps open,
	// cancelled ones included until the desktop lets go of them (see
	// cancelLinger). The desktop accepts eight connections from all its
	// clients together.
	maxConcurrentCalls = 4
	// cancelLinger is how long a call cancelled while the desktop had it
	// keeps its slot and its place in the device order. Cancelling closes the
	// call's socket, but the desktop sees that only at its next liveness
	// probe, a write it makes about once a second while a handler runs; then
	// it aborts the handler and frees the connection. A desktop job the
	// handler started (a native install, a slimming change) runs on, and the
	// linger does not wait for it.
	cancelLinger = 2 * time.Second
)

// Transport sends one rndevtools request and returns the response. The
// production transport is the socket client; tests substitute a recorder.
type Transport func(ctx context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error)

// Config wires the server to its process environment.
type Config struct {
	Version   string
	Transport Transport
	// Lookup reads environment variables (os.Getenv). Agent attribution comes
	// from it: Claude Code and Codex pass their session identifiers to the
	// MCP servers they spawn.
	Lookup func(string) string
	// ReadFile loads a capture for embedding; defaults to os.ReadFile.
	ReadFile func(string) ([]byte, error)
}

// Server is one stdio MCP session.
type Server struct {
	config Config
	// lock guards clientName: initialize sets it on the reader while calls
	// read it on their own goroutines.
	lock       sync.Mutex
	clientName string
	// linger is cancelLinger; tests shorten it.
	linger time.Duration
}

// New builds a server with defaults filled in.
func New(config Config) *Server {
	if config.Lookup == nil {
		config.Lookup = os.Getenv
	}
	if config.ReadFile == nil {
		config.ReadFile = os.ReadFile
	}
	return &Server{config: config, linger: cancelLinger}
}

// SocketTransport sends requests over the desktop's private socket.
func SocketTransport(socketPath string) Transport {
	return func(ctx context.Context, request protocol.Request, timeout time.Duration) (protocol.Response, error) {
		localClient, err := client.New(socketPath, timeout)
		if err != nil {
			return protocol.Response{}, err
		}
		return localClient.Do(ctx, request)
	}
}

// Serve reads newline-delimited JSON-RPC messages from `reader` until EOF and
// writes responses to `writer`. Reading never waits on the desktop: each tool
// call and resource read runs on its own goroutine with its own context, so a
// long wait or lane up never holds up a ping or an unrelated call, and
// notifications/cancelled stops the call it names at once, with no response.
// Its socket closes; the desktop notices at its next liveness probe and
// aborts the handler, so until then (cancelLinger) the call still holds its
// slot and its place in the device order. A desktop job the handler started
// keeps running after that. Calls that name the same Simulator
// keep their order where it shows (see sequencer). At EOF, Serve finishes the
// calls in flight and writes their responses before it returns.
func (server *Server) Serve(ctx context.Context, reader io.Reader, writer io.Writer) error {
	ctx, cancelAll := context.WithCancel(ctx)
	defer cancelAll()
	session := &session{
		server: server,
		slots:  make(chan struct{}, maxConcurrentCalls),
		calls:  map[string]*inFlight{},
		writer: writer,
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxLineBytes)
	for session.writeError() == nil && scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		session.receive(ctx, line)
	}
	readErr := scanner.Err()
	if readErr != nil || session.writeError() != nil {
		// The client can no longer send or read: stop what is still running.
		cancelAll()
	}
	session.running.Wait()
	if err := session.writeError(); err != nil {
		return err
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return readErr
	}
	return nil
}

// session is the state of one Serve: the calls in flight by JSON-RPC id, the
// order calls naming the same Simulator start in, and the shared writer.
type session struct {
	server  *Server
	order   sequencer
	slots   chan struct{}
	running sync.WaitGroup

	lock  sync.Mutex
	calls map[string]*inFlight

	writeLock sync.Mutex
	writer    io.Writer
	writeErr  error
}

// inFlight is one running call, found by its id when the client cancels it.
type inFlight struct {
	cancel context.CancelFunc
}

// receive handles one message on the reader: a call starts on its own
// goroutine, a cancel takes effect at once, and anything else is answered
// in place.
func (session *session) receive(ctx context.Context, line []byte) {
	request, failure := parseRequest(line)
	switch {
	case failure != nil:
		session.write(failure)
	case request.Method == "tools/call" || request.Method == "resources/read":
		session.start(ctx, request)
	default:
		if request.Method == "notifications/cancelled" {
			session.cancel(request.Params)
		}
		if response := session.server.respond(ctx, request); response != nil {
			session.write(response)
		}
	}
}

// start runs a call on its own goroutine, after the calls it must follow
// and once a slot is free.
func (session *session) start(ctx context.Context, request rpcRequest) {
	devices, mutating := callScope(request)
	after, done := session.order.admit(devices, mutating)
	callContext, cancel := context.WithCancel(ctx)
	call := &inFlight{cancel: cancel}
	key := ""
	if !request.notification() {
		key = string(request.ID)
		session.track(key, call)
	}
	session.running.Add(1)
	go func() {
		defer session.running.Done()
		defer session.untrack(key, call)
		defer cancel()
		response, lingering := session.run(callContext, request, after)
		if response != nil && callContext.Err() == nil {
			session.write(response)
		}
		if done != nil {
			// A cancelled call keeps its place, so whatever follows it still
			// waits for the calls it followed, and, when the desktop had it,
			// for the desktop to let go.
			for _, previous := range after {
				<-previous
			}
			finish := func() {
				close(done)
				session.order.release(devices, done)
			}
			if lingering {
				time.AfterFunc(session.server.linger, finish)
			} else {
				finish()
			}
		}
	}()
}

// run answers a call once the calls it follows have finished and a slot is
// free, or returns nil when the call is cancelled first. A call cancelled
// while it held a slot may still run on the desktop, so it keeps the slot
// for the linger and reports lingering.
func (session *session) run(ctx context.Context, request rpcRequest, after []chan struct{}) (response *rpcResponse, lingering bool) {
	for _, previous := range after {
		select {
		case <-previous:
		case <-ctx.Done():
			return nil, false
		}
	}
	select {
	case session.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, false
	}
	response = session.server.respond(ctx, request)
	if ctx.Err() != nil {
		time.AfterFunc(session.server.linger, func() { <-session.slots })
		return response, true
	}
	<-session.slots
	return response, false
}

func (session *session) track(key string, call *inFlight) {
	session.lock.Lock()
	defer session.lock.Unlock()
	session.calls[key] = call
}

func (session *session) untrack(key string, call *inFlight) {
	session.lock.Lock()
	defer session.lock.Unlock()
	if session.calls[key] == call {
		delete(session.calls, key)
	}
}

// cancel stops the call a notifications/cancelled names, if it still runs.
func (session *session) cancel(params json.RawMessage) {
	var notice struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(params, &notice) != nil || len(notice.RequestID) == 0 {
		return
	}
	session.lock.Lock()
	call := session.calls[string(notice.RequestID)]
	session.lock.Unlock()
	if call != nil {
		call.cancel()
	}
}

// write sends one response line. Every goroutine writes through it; the
// first failure is kept and ends the session.
func (session *session) write(response *rpcResponse) {
	encoded, err := json.Marshal(response)
	session.writeLock.Lock()
	defer session.writeLock.Unlock()
	if session.writeErr != nil {
		return
	}
	if err == nil {
		_, err = session.writer.Write(append(encoded, '\n'))
	}
	session.writeErr = err
}

func (session *session) writeError() error {
	session.writeLock.Lock()
	defer session.writeLock.Unlock()
	return session.writeErr
}

// sequencer keeps the order in which calls naming the same Simulator
// arrived, where that order shows: a call starts only after the earlier
// calls that may change one of its devices have finished, so a swipe's steps
// and the screenshot after them run in the agent's order. A read-only call
// holds nothing up, so a long wait never delays the device it watches.
type sequencer struct {
	lock sync.Mutex
	// latest is, per device, the done channel of the last call admitted that
	// may change it.
	latest map[string]chan struct{}
}

// admit records a call in arrival order. It returns the channels the call
// must wait for and, for a call that may change a device, the channel it
// closes once it has finished.
func (order *sequencer) admit(devices []string, mutating bool) (after []chan struct{}, done chan struct{}) {
	order.lock.Lock()
	defer order.lock.Unlock()
	for _, device := range devices {
		if previous, ok := order.latest[device]; ok {
			after = append(after, previous)
		}
	}
	if mutating && len(devices) > 0 {
		if order.latest == nil {
			order.latest = map[string]chan struct{}{}
		}
		done = make(chan struct{})
		for _, device := range devices {
			order.latest[device] = done
		}
	}
	return after, done
}

// release forgets a finished call's devices unless a later call took them.
func (order *sequencer) release(devices []string, done chan struct{}) {
	order.lock.Lock()
	defer order.lock.Unlock()
	for _, device := range devices {
		if order.latest[device] == done {
			delete(order.latest, device)
		}
	}
}

// callScope is what the ordering needs from a call: the devices it names,
// and whether it may change them, which any tool not marked read-only may.
func callScope(request rpcRequest) (devices []string, mutating bool) {
	switch request.Method {
	case "tools/call":
		var call struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.Unmarshal(request.Params, &call) != nil {
			return nil, false
		}
		kind, err := protocol.ParseCommand(call.Name)
		if err != nil {
			return nil, false
		}
		return namedDevices(call.Arguments), !toolMeta[kind].readOnly
	case "resources/read":
		var read struct {
			URI string `json:"uri"`
		}
		if json.Unmarshal(request.Params, &read) == nil {
			if udid, ok := strings.CutPrefix(read.URI, "rndevtools://screen/"); ok && udid != "" {
				return []string{"udid:" + strings.ToUpper(udid)}, false
			}
		}
	}
	return nil, false
}

// namedDevices lists the Simulators (udid, udids) and connected devices
// (device-id) a tool call's arguments name.
func namedDevices(arguments map[string]any) []string {
	var devices []string
	udids, _ := arguments["udids"].([]any)
	for _, value := range append([]any{arguments["udid"]}, udids...) {
		if udid, ok := value.(string); ok && udid != "" {
			devices = append(devices, "udid:"+strings.ToUpper(udid))
		}
	}
	if device, ok := arguments["device-id"].(string); ok && device != "" {
		devices = append(devices, "device:"+device)
	}
	return devices
}

type rpcRequest struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// notification reports a request without an id, which gets no response.
func (request rpcRequest) notification() bool {
	return len(request.ID) == 0 || string(request.ID) == "null"
}

type rpcResponse struct {
	Version string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

// parseRequest decodes one message, or returns the error response for a
// message that is not a JSON-RPC 2.0 request.
func parseRequest(line []byte) (rpcRequest, *rpcResponse) {
	var request rpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return request, &rpcResponse{Version: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: codeParse, Message: "invalid JSON"}}
	}
	if request.Version != "2.0" || request.Method == "" {
		return request, &rpcResponse{Version: "2.0", ID: idOrNull(request.ID), Error: &rpcError{Code: codeInvalidRequest, Message: "expected a JSON-RPC 2.0 request"}}
	}
	return request, nil
}

// respond answers one request; a notification gets nil.
func (server *Server) respond(ctx context.Context, request rpcRequest) *rpcResponse {
	result, rpcErr := server.dispatch(ctx, request)
	if request.notification() {
		return nil
	}
	response := &rpcResponse{Version: "2.0", ID: request.ID}
	if rpcErr != nil {
		response.Error = rpcErr
	} else {
		response.Result = result
	}
	return response
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func (server *Server) dispatch(ctx context.Context, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		return server.initialize(request.Params)
	case "notifications/initialized":
		return nil, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": Tools()}, nil
	case "tools/call":
		return server.callTool(ctx, request.Params)
	case "resources/list":
		return map[string]any{"resources": staticResources()}, nil
	case "resources/templates/list":
		return map[string]any{"resourceTemplates": resourceTemplates()}, nil
	case "resources/read":
		return server.readResource(ctx, request.Params)
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	default:
		if strings.HasPrefix(request.Method, "notifications/") {
			return nil, nil
		}
		return nil, &rpcError{Code: codeMethodNotFound, Message: fmt.Sprintf("method %q is not supported", request.Method)}
	}
}

func (server *Server) initialize(params json.RawMessage) (any, *rpcError) {
	var request struct {
		ClientInfo struct {
			Name string `json:"name"`
		} `json:"clientInfo"`
	}
	_ = json.Unmarshal(params, &request)
	server.lock.Lock()
	server.clientName = request.ClientInfo.Name
	server.lock.Unlock()
	return map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities": map[string]any{
			"tools":     map[string]any{"listChanged": false},
			"resources": map[string]any{"subscribe": false, "listChanged": false},
		},
		"serverInfo":   map[string]any{"name": serverName, "version": server.config.Version},
		"instructions": instructions,
	}, nil
}

// instructions is what the client shows its model about this server as a
// whole. It carries the rules a tool description cannot: when to reach for
// these tools at all, and what never to do instead.
const instructions = `RN Devtools controls the iOS Simulators on this Mac and, when the user has ` +
	`turned it on, each git worktree's local Supabase. Use these tools for anything involving a ` +
	`Simulator: booting one for a git worktree or branch, starting Metro without colliding with ` +
	`another agent, launching the dev client, reading or driving the running app, tapping or typing ` +
	`on the device, taking screenshots, and cleaning up. Do not run xcrun simctl boot, shutdown, ` +
	`openurl, install, launch, or io directly, and do not start Metro by hand: several agents share ` +
	`these Simulators and the desktop app owns their ports and claims. A Simulator is free or held: ` +
	`held while a lane runs on it or a session claimed it, and only the holder may run a lane on ` +
	`it, send it input, install on it, slim it, run a recipe on it, or cancel its jobs (anyone else ` +
	`gets device_held, naming the holder), though a session can always stop or cancel a recording ` +
	`it started itself; act and network are not gated, so a hold does not keep other sessions out ` +
	`of the app itself. Start with lane ` +
	`(operation "up") for a worktree; leave udid out and the desktop picks a free device, or parks a ` +
	`deviceRequest for the user when none is free (then poll lane ls). For a worktree with ` +
	`supabase/config.toml, get its own database with supabase (operation "up") or lane up, which ` +
	`connects the app automatically; if RN Devtools says it is not managing that worktree, start ` +
	`it yourself from the worktree with supabase start --runtime native (never without --runtime ` +
	`native). Use the worktree's own supabase CLI with --local for migrations, resets, and types; ` +
	`never start or stop a stack RN Devtools manages by hand, and never run supabase stop --all, ` +
	`stack destroy, or kill postgres, which hit other agents' stacks. When your task is done, call ` +
	`release with all=true so your devices go back to the pool and your stacks stop (data kept). ` +
	`Errors carry "recovery" text and native plan carries a "recommendation"; follow them before ` +
	`improvising.`

// Tool is one MCP tool entry.
type Tool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

// Tools lists every rndevtools command as an MCP tool, with input schemas
// generated from the CLI's own field table so the two cannot drift.
func Tools() []Tool {
	tools := make([]Tool, 0, len(toolOrder))
	for _, kind := range toolOrder {
		fields, ok := command.Describe(kind)
		if !ok {
			continue
		}
		properties := map[string]any{}
		for _, field := range fields {
			property := map[string]any{"type": field.Type, "description": field.Usage}
			if field.Type == "array" {
				property["items"] = map[string]any{"type": field.Items}
			}
			properties[field.Name] = property
		}
		schema := map[string]any{
			"type":                 "object",
			"properties":           properties,
			"additionalProperties": false,
		}
		if required := requiredFields[kind]; len(required) > 0 {
			schema["required"] = required
		}
		meta := toolMeta[kind]
		tools = append(tools, Tool{
			Name:        string(kind),
			Title:       meta.title,
			Description: meta.description,
			InputSchema: schema,
			// No tool is destructive; destructiveHint is stated anyway because MCP
			// reads an absent one as true.
			Annotations: map[string]any{
				"readOnlyHint":    meta.readOnly,
				"destructiveHint": false,
				"idempotentHint":  meta.readOnly,
				"openWorldHint":   false,
			},
		})
	}
	return tools
}

func (server *Server) callTool(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var call struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: "tools/call needs name and arguments"}
	}
	kind, err := protocol.ParseCommand(call.Name)
	if err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf("unknown tool %q", call.Name)}
	}
	if call.Arguments == nil {
		call.Arguments = map[string]any{}
	}
	parsed, err := command.Build(kind, call.Arguments, server.config.Lookup)
	if err != nil {
		// Argument problems are reported as a tool error, not a protocol error,
		// so the model sees the message and can correct the call.
		return toolError("invalid_arguments", err.Error(), false, fmt.Sprintf("Check the %s tool's input schema.", kind)), nil
	}
	response, err := server.send(ctx, parsed)
	if err != nil {
		return toolError(classifyTransportError(err)), nil
	}
	if !response.OK {
		remote := response.Error
		return toolError(remote.Code, remote.Message, remote.Retryable, remote.Recovery), nil
	}
	return server.toolSuccess(kind, response.Result), nil
}

func (server *Server) send(ctx context.Context, parsed command.Parsed) (protocol.Response, error) {
	requestID, err := protocol.NewRequestID("mcp-")
	if err != nil {
		return protocol.Response{}, err
	}
	request := protocol.Request{Protocol: protocol.Name, ID: requestID, Command: parsed.Command}
	if agent := server.agent(); agent != nil {
		request.Agent = agent
	}
	if _, err := protocol.EncodeRequest(request); err != nil {
		return protocol.Response{}, err
	}
	return server.config.Transport(ctx, request, parsed.Timeout)
}

// agent attributes requests to the coding-agent session that spawned this
// server. The session variables win; failing those, the MCP client's name
// identifies at least which agent product is calling.
func (server *Server) agent() map[string]any {
	if agent := command.AgentFromEnvironment(server.config.Lookup); agent != nil {
		return agent
	}
	server.lock.Lock()
	clientName := server.clientName
	server.lock.Unlock()
	if clientName != "" {
		kind := "other"
		lower := strings.ToLower(clientName)
		switch {
		case strings.Contains(lower, "claude"):
			kind = "claude"
		case strings.Contains(lower, "codex"):
			kind = "codex"
		}
		return map[string]any{"kind": kind, "sessionId": "mcp-" + sanitizeSession(clientName)}
	}
	return nil
}

func sanitizeSession(value string) string {
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('-')
		}
		if builder.Len() >= 100 {
			break
		}
	}
	if builder.Len() == 0 {
		return "client"
	}
	return builder.String()
}

// toolSuccess renders a result. Screenshots are embedded as an image content
// block alongside the JSON so the model can look at the device directly.
func (server *Server) toolSuccess(kind protocol.Command, result json.RawMessage) map[string]any {
	content := []any{map[string]any{"type": "text", "text": compact(result)}}
	if kind == protocol.CommandCapture {
		if image := server.embeddedCapture(result); image != nil {
			content = append(content, image)
		}
	}
	return map[string]any{"content": content, "structuredContent": json.RawMessage(result), "isError": false}
}

func (server *Server) embeddedCapture(result json.RawMessage) map[string]any {
	var capture struct {
		Path    string `json:"path"`
		Capture struct {
			MimeType string `json:"mimeType"`
		} `json:"capture"`
	}
	if err := json.Unmarshal(result, &capture); err != nil || capture.Path == "" {
		return nil
	}
	if !strings.HasPrefix(capture.Capture.MimeType, "image/") {
		return nil
	}
	data, err := server.config.ReadFile(filepath.Clean(capture.Path))
	if err != nil || len(data) == 0 || len(data) > maxImageBytes {
		return nil
	}
	return map[string]any{
		"type":     "image",
		"data":     base64.StdEncoding.EncodeToString(data),
		"mimeType": capture.Capture.MimeType,
	}
}

func toolError(code string, message string, retryable bool, recovery string) map[string]any {
	text := fmt.Sprintf("%s: %s", code, message)
	if recovery != "" {
		text += " Recovery: " + recovery
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"structuredContent": map[string]any{
			"error": map[string]any{"code": code, "message": message, "retryable": retryable, "recovery": recovery},
		},
		"isError": true,
	}
}

func classifyTransportError(err error) (string, string, bool, string) {
	var clientError *client.ClientError
	if errors.As(err, &clientError) {
		switch clientError.Kind {
		case client.ErrorUnavailable:
			return "desktop_unavailable", clientError.Error(), true,
				"RN Devtools is not running. Ask the user to start the RN Devtools app, then retry."
		case client.ErrorTimeout:
			return "request_timeout", clientError.Error(), true, "Retry once; long operations may still be completing."
		case client.ErrorProtocol:
			return "invalid_response", clientError.Error(), false, ""
		}
		return "transport_error", clientError.Error(), true, ""
	}
	return "internal_error", err.Error(), false, ""
}

func compact(raw json.RawMessage) string {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return string(raw)
	}
	return buffer.String()
}
