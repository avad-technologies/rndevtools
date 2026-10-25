package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
	"github.com/adalloul0928/rndevtools-cli/internal/command"
	"github.com/adalloul0928/rndevtools-cli/internal/mcp"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const (
	ExitSuccess     = 0
	ExitUsage       = 2
	ExitUnavailable = 3
	ExitTimeout     = 4
	ExitTransport   = 5
	ExitRejected    = 6
	ExitInternal    = 7
)

type Config struct {
	Version        string
	BuildCommit    string
	Arguments      []string
	Stdin          io.Reader
	StdinAvailable bool
	Stdout         io.Writer
	Stderr         io.Writer
	SocketPath     string
	// Lookup reads environment variables; nil means os.Getenv. Tests inject it
	// so a developer's own agent session variables cannot leak into them.
	Lookup func(string) string
}

// lookup returns the environment reader this run uses.
func (c Config) lookup() func(string) string {
	if c.Lookup != nil {
		return c.Lookup
	}
	return os.Getenv
}

func Run(config Config) int {
	if len(config.Arguments) == 0 {
		fmt.Fprint(config.Stdout, RootUsage())
		return ExitUsage
	}
	if len(config.Arguments) == 1 &&
		(config.Arguments[0] == "--help" || config.Arguments[0] == "help") {
		fmt.Fprint(config.Stdout, RootUsage())
		return ExitSuccess
	}
	if len(config.Arguments) == 1 && config.Arguments[0] == "--version" {
		writeJSON(config.Stdout, map[string]string{
			"name":        "rndevtools",
			"version":     config.Version,
			"buildCommit": config.BuildCommit,
		})
		return ExitSuccess
	}
	switch config.Arguments[0] {
	case "mcp":
		return runMCP(config)
	case "setup":
		return runSetup(config)
	case "hook":
		return runHook(config)
	}
	requestID, err := protocol.NewRequestID("cli-")
	if err != nil {
		writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", "")
		return ExitInternal
	}

	kind, err := protocol.ParseCommand(config.Arguments[0])
	if err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			"Run rndevtools --help for the command list.",
			requestID,
		)
		return ExitUsage
	}
	getenv := config.lookup()
	parsed, err := command.ParseWithEnvironment(
		kind,
		config.Arguments[1:],
		config.Stdin,
		config.StdinAvailable,
		getenv,
	)
	if errors.Is(err, command.ErrHelp) {
		fmt.Fprint(config.Stdout, command.Usage(kind))
		return ExitSuccess
	}
	if err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			fmt.Sprintf("Run rndevtools %s --help for command flags.", kind),
			requestID,
		)
		return ExitUsage
	}

	socketPath := config.SocketPath
	if socketPath == "" {
		socketPath, err = client.DefaultSocketPath()
		if err != nil {
			writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", requestID)
			return ExitInternal
		}
	}
	localClient, err := client.New(socketPath, parsed.Timeout)
	if err != nil {
		writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", requestID)
		return ExitInternal
	}
	request := protocol.Request{
		Protocol: protocol.Name,
		ID:       requestID,
		Command:  parsed.Command,
	}
	// Attribution rides on the envelope for every command, so the desktop can
	// show which session is driving which Simulator without per-command flags.
	if agent := command.AgentFromEnvironment(getenv); agent != nil {
		request.Agent = agent
	}
	if _, err := protocol.EncodeRequest(request); err != nil {
		writeLocalError(
			config.Stderr,
			"invalid_arguments",
			err.Error(),
			false,
			"Reduce the JSON payload so the complete request fits within 256 KiB.",
			requestID,
		)
		return ExitUsage
	}
	response, err := localClient.Do(context.Background(), request)
	if err != nil {
		return writeClientError(config.Stderr, requestID, err)
	}
	writeJSON(config.Stdout, response)
	if !response.OK {
		return ExitRejected
	}
	return ExitSuccess
}

func RootUsage() string {
	var builder strings.Builder
	builder.WriteString("Usage: rndevtools <command> [flags]\n\nCommands:\n")
	for _, name := range protocol.Commands() {
		fmt.Fprintf(&builder, "  %s\n", name)
	}
	builder.WriteString("  mcp\n  setup\n")
	builder.WriteString("\nEach command accepts structured flags and an optional bounded JSON object on stdin.\n")
	builder.WriteString("Output is one compact rndevtools/1 JSON response.\n")
	builder.WriteString("`rndevtools mcp` serves the same commands to coding agents as an MCP server on stdio.\n")
	builder.WriteString("`rndevtools setup` registers that server, the lanes and Supabase skills, and the agent hooks with Claude Code, Codex, Cursor, and Kiro.\n")
	return builder.String()
}

func writeClientError(writer io.Writer, requestID string, err error) int {
	var clientError *client.ClientError
	if !errors.As(err, &clientError) {
		writeLocalError(writer, "internal_error", err.Error(), false, "", requestID)
		return ExitInternal
	}
	switch clientError.Kind {
	case client.ErrorUnavailable:
		writeLocalError(
			writer,
			"desktop_unavailable",
			clientError.Error(),
			true,
			"Start RN Devtools and retry. A stale socket is never removed by the CLI.",
			requestID,
		)
		return ExitUnavailable
	case client.ErrorTimeout:
		writeLocalError(
			writer,
			"request_timeout",
			clientError.Error(),
			true,
			"Retry or increase --request-timeout-ms up to 660000.",
			requestID,
		)
		return ExitTimeout
	case client.ErrorProtocol:
		writeLocalError(writer, "invalid_response", clientError.Error(), false, "", requestID)
		return ExitTransport
	default:
		writeLocalError(writer, "transport_error", clientError.Error(), true, "", requestID)
		return ExitTransport
	}
}

func writeLocalError(
	writer io.Writer,
	code string,
	message string,
	retryable bool,
	recovery string,
	requestID string,
) {
	response := protocol.Response{
		Protocol: protocol.Name,
		ID:       requestID,
		OK:       false,
		Error: &protocol.RemoteError{
			Code:      code,
			Message:   message,
			Retryable: retryable,
			Recovery:  recovery,
		},
	}
	writeJSON(writer, response)
}

func writeJSON(writer io.Writer, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "{\"protocol\":%q,\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"internal_error\",\"message\":%q,\"retryable\":false}}\n", protocol.Name, err.Error())
		return
	}
	_, _ = writer.Write(append(encoded, '\n'))
}

// runMCP serves the commands over stdio as a Model Context Protocol server
// until the client closes stdin. Diagnostics go to stderr; stdout is the
// protocol channel and carries nothing else.
func runMCP(config Config) int {
	if len(config.Arguments) > 1 {
		if config.Arguments[1] == "--help" || config.Arguments[1] == "help" {
			fmt.Fprint(config.Stdout, "Usage: rndevtools mcp\n\nServes rndevtools as an MCP server over stdio (JSON-RPC, one message per line).\n"+
				"Register it with your coding agent; `rndevtools setup` does so for Claude Code, Codex, Cursor, and Kiro.\n")
			return ExitSuccess
		}
		writeLocalError(config.Stderr, "invalid_arguments", "mcp takes no flags", false, "Run rndevtools mcp --help.", "")
		return ExitUsage
	}
	socketPath := config.SocketPath
	if socketPath == "" {
		resolved, err := client.DefaultSocketPath()
		if err != nil {
			writeLocalError(config.Stderr, "internal_error", err.Error(), false, "", "")
			return ExitInternal
		}
		socketPath = resolved
	}
	server := mcp.New(mcp.Config{
		Version:   config.Version,
		Transport: mcp.SocketTransport(socketPath),
		Lookup:    config.lookup(),
	})
	if err := server.Serve(context.Background(), config.Stdin, config.Stdout); err != nil {
		fmt.Fprintf(config.Stderr, "rndevtools mcp: %v\n", err)
		return ExitTransport
	}
	return ExitSuccess
}
