package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/mcp"
	"github.com/adalloul0928/rndevtools-cli/internal/setup"
)

const agentCheckUsage = `Usage: rndevtools agent-check [flags]

Check Claude Code and Codex setup without starting competing servers.
Fixes require a preview followed by an explicit apply; undo preserves unrelated edits.

  --operation scan|plan|apply|undo|probe  Default: scan
  --project /absolute/project           Include this project's overrides
  --finding-id finding-...               Finding to preview (plan)
  --plan-id check-...                    Preview or repair to apply/undo
  --config-home /absolute/home          Isolated client configuration for testing
  --executable /absolute/rndevtools      Bundled executable to register/probe

probe verifies the bundled MCP and desktop connection, not another client's
loaded tool list or hook trust. No simulator or database state is changed.
`

func runAgentCheck(config Config) int {
	flags := flag.NewFlagSet("agent-check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	operation := flags.String("operation", "scan", "")
	project := flags.String("project", "", "")
	home := flags.String("config-home", "", "")
	executable := flags.String("executable", "", "")
	finding := flags.String("finding-id", "", "")
	plan := flags.String("plan-id", "", "")
	help := flags.Bool("help", false, "")
	if err := flags.Parse(config.Arguments[1:]); err != nil || flags.NArg() > 0 || *help {
		if err == flag.ErrHelp || *help {
			fmt.Fprint(config.Stdout, agentCheckUsage)
			return ExitSuccess
		}
		writeLocalError(config.Stderr, "invalid_arguments", "Invalid agent-check flags.", false, "Run rndevtools agent-check --help.", "")
		return ExitUsage
	}
	if *executable == "" {
		*executable, _ = os.Executable()
		if real, err := filepath.EvalSymlinks(*executable); err == nil {
			*executable = real
		}
	}
	// What a caller got wrong is a usage error, which retrying cannot fix;
	// agent_check_failed is left for a check or repair that could not run.
	usage := func(message string) int {
		writeLocalError(config.Stderr, "invalid_arguments", message, false, "Run rndevtools agent-check --help.", "")
		return ExitUsage
	}
	switch *operation {
	case "scan", "probe":
	case "plan":
		if *finding == "" {
			return usage("plan requires --finding-id.")
		}
	case "apply", "undo":
		if *plan == "" {
			return usage(*operation + " requires --plan-id.")
		}
	default:
		return usage("Unknown agent-check operation; use scan, plan, apply, undo, or probe.")
	}
	for flag, path := range map[string]string{"project": *project, "config-home": *home, "executable": *executable} {
		if path != "" && !filepath.IsAbs(path) {
			return usage("--" + flag + " must be an absolute path.")
		}
	}
	options := setup.HealthOptions{Home: *home, Project: *project, Executable: *executable}
	var result any
	var err error
	switch *operation {
	case "scan":
		result, err = setup.CheckAgents(options)
	case "plan":
		result, err = setup.PlanAgentFix(options, *finding)
	case "apply":
		result, err = setup.ApplyAgentFix(options, *plan)
	case "undo":
		result, err = setup.UndoAgentFix(options, *plan)
	default: // probe, the last operation checked above
		result, err = probeAgentMCP(*executable)
	}
	if err != nil {
		writeLocalError(config.Stderr, "agent_check_failed", err.Error(), true, "Recheck agent setup and review the current scope.", "")
		return ExitInternal
	}
	writeJSON(config.Stdout, result)
	return ExitSuccess
}

func probeAgentMCP(executable string) (map[string]any, error) {
	if !filepath.IsAbs(executable) {
		return nil, errors.New("The MCP executable must be absolute.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "mcp")
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, errors.New("Cannot open the MCP probe input.")
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, errors.New("Cannot open the MCP probe output.")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		return nil, errors.New("The registered MCP executable could not start.")
	}
	defer func() { _ = in.Close(); cancel(); _ = cmd.Wait() }()
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 8192), 1024*1024)
	call := func(id int, method string, params any) (map[string]any, error) {
		if err := json.NewEncoder(in).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			return nil, errors.New("MCP probe write failed.")
		}
		for count := 0; count < 100 && scanner.Scan(); count++ {
			var response struct {
				ID     int             `json:"id"`
				Result map[string]any  `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				continue
			}
			if response.ID != id {
				continue
			}
			if len(response.Error) > 0 || response.Result["isError"] == true {
				return nil, errors.New("The MCP returned an error. Check the desktop connection and retry.")
			}
			return response.Result, nil
		}
		return nil, errors.New("The MCP probe timed out or returned an invalid response.")
	}
	if _, err = call(1, "initialize", map[string]any{"protocolVersion": mcp.ProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "rndevtools-setup-check", "version": "1"}}); err != nil {
		return nil, err
	}
	_ = json.NewEncoder(in).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	catalog, err := call(2, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	entries, _ := catalog["tools"].([]any)
	names := map[string]bool{}
	for _, entry := range entries {
		m, _ := entry.(map[string]any)
		name, _ := m["name"].(string)
		names[name] = true
	}
	for _, required := range []string{"doctor", "lane", "supabase", "input", "native"} {
		if !names[required] {
			return nil, errors.New("The MCP catalog is missing a required RN Devtools tool.")
		}
	}
	if _, err = call(3, "tools/call", map[string]any{"name": "doctor", "arguments": map[string]any{}}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "checkedAt": time.Now().UnixMilli(), "toolCount": len(entries), "message": "Bundled MCP initialize, tools/list and doctor passed. Reload Claude/Codex to load configuration changes; this probe does not verify their loaded tools or hook trust."}, nil
}
