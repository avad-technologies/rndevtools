package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/adalloul0928/rndevtools-cli/internal/command"
	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

// toolOrder is the order tools are listed in: the ones an agent reaches for
// first come first, because clients that truncate show the head of the list.
var toolOrder = []protocol.Command{
	protocol.CommandLane,
	protocol.CommandSupabase,
	protocol.CommandSimulators,
	protocol.CommandCapture,
	protocol.CommandInput,
	protocol.CommandElements,
	protocol.CommandAct,
	protocol.CommandWait,
	protocol.CommandScreen,
	protocol.CommandNative,
	protocol.CommandAgents,
	protocol.CommandClaim,
	protocol.CommandRelease,
	protocol.CommandApps,
	protocol.CommandRecord,
	protocol.CommandNetwork,
	protocol.CommandRecipe,
	protocol.CommandJobs,
	protocol.CommandSlimming,
	protocol.CommandDoctor,
}

// requiredFields names the arguments a tool call cannot omit. The desktop
// validates everything again; this only lets a client refuse an obviously
// incomplete call before a round trip.
var requiredFields = map[protocol.Command][]string{
	protocol.CommandLane:     {"operation"},
	protocol.CommandSupabase: {"operation"},
	protocol.CommandApps:     {"udid"},
	protocol.CommandCapture:  {"udid"},
	protocol.CommandInput:    {"udid", "kind"},
	protocol.CommandRecord:   {"udid", "operation"},
	protocol.CommandNetwork:  {"operation"},
	protocol.CommandRecipe:   {"operation"},
	protocol.CommandJobs:     {"operation"},
	protocol.CommandSlimming: {"operation"},
	protocol.CommandNative:   {"operation", "worktree"},
	protocol.CommandClaim:    {"udid"},
	protocol.CommandAct:      {"tool", "action-command"},
	protocol.CommandWait:     {"condition"},
}

type meta struct {
	title       string
	description string
	// readOnly means every operation of the tool only observes. It becomes
	// the readOnlyHint, and setup lets Kiro run these tools without asking.
	readOnly bool
}

// ReadOnlyTools names the tools whose every operation only observes, in list
// order: the ones a client may run without asking the user.
func ReadOnlyTools() []string {
	var names []string
	for _, kind := range toolOrder {
		if toolMeta[kind].readOnly {
			names = append(names, string(kind))
		}
	}
	return names
}

// toolMeta is the agent-facing text for each tool. These descriptions do the
// job a skill otherwise does: say when the tool applies, what to call first,
// and what the result means, in the words a model matches a task against.
var toolMeta = map[protocol.Command]meta{
	protocol.CommandLane: {
		title: "Run a worktree on its own Simulator",
		description: "Start, stop, list, launch, or read logs for a lane: one git worktree running on one iOS " +
			"Simulator with its own Metro port leased by RN Devtools, so parallel branches and agents never " +
			"collide on port 8081 or a shared device. Use this whenever asked to run a branch, open the " +
			"simulator, start the app for a worktree, or fix a Metro port clash. operation \"up\" needs the " +
			"absolute worktree path; udid is optional (omit it and RN Devtools picks a free iPhone, booted first; " +
			"when none is free the result has completed=false and a deviceRequest the user settles in the app: poll " +
			"ls until that request is fulfilled with a laneId). It boots the device, starts Metro, and opens the dev client; if the dev client is not " +
			"installed the error says so and names the build command; call the native tool (operation plan) " +
			"before building. Calling up again for the same worktree and Simulator returns the existing lane and " +
			"relaunches. \"down\" stops Metro and releases the port (lane-id). \"ls\" lists lanes. \"launch\" re-opens " +
			"the dev client or a deep link (lane-id, url). \"log\" tails Metro (lane-id, max-characters). Optional " +
			"slim applies a SimSlim profile to the device before Metro starts (when SimSlim is enabled in RN Devtools " +
			"and the device is free or yours); lane.slim in the result says applied, skipped (with why), or failed. " +
			"Optional backend (auto, off, required): with auto, the development default, lane up also starts this " +
			"worktree's local Supabase and passes its URL and publishable key to Metro, so never start Supabase by hand " +
			"for a lane; lane.backend reports ready, starting (the app launches when it is ready; if the result has a " +
			"jobId, call wait (condition job), and without one call lane up again in a few seconds), skipped, " +
			"shadowed (the app's own .env files override the injected URL), refused, or failed, with the reason.",
	},
	protocol.CommandSupabase: {
		title: "Run this worktree's local Supabase",
		description: "Give a git worktree its own local Supabase (Postgres, REST, Auth, Storage, Realtime, Functions) on " +
			"127.0.0.1, run by RN Devtools so parallel agents never share a database or collide on ports. Use it " +
			"when the worktree has supabase/config.toml and you need its database, migrations, seed, a reset, logs, " +
			"or URLs. operation \"up\" (worktree: absolute path) creates or resumes the stack on the native runtime " +
			"and returns its status, API and database ports, the CLI to run from the worktree (cli.run, e.g. pnpm " +
			"exec supabase), and next steps; a lane on the worktree gets Metro restarted with the stack's URL and " +
			"publishable key. A first start downloads services once: if the result has a jobId, call wait " +
			"(condition job), and without one (the start is queued behind RN Devtools' own automatic start) call " +
			"up again in a few seconds. lane up already does this for its worktree; call up yourself only for database work " +
			"without a lane, after creating your git branch (each branch gets its own database). \"down\" releases " +
			"your hold (the stack stops once unused, data kept); \"ls\" lists every stack with lanes and holders; " +
			"\"status\" shows services; \"env\" returns the URLs and the publishable and anon keys (never secret keys " +
			"or the database URL; never write keys into .env files). \"reset\" drops the data and re-runs migrations " +
			"and seed (seed false skips it); \"log\" reads service logs; \"destroy\" only asks the user to delete a " +
			"database, and resetting a stack another session holds becomes a request too. Run database commands " +
			"with the worktree's own CLI and --local (migration up --local, db reset --local, gen types typescript " +
			"--local), and while RN Devtools manages the worktree never run supabase start, stop, stack, or local " +
			"commands by hand. If this tool answers supabase_disabled, supabase_unsupported, or cli_unverified, RN " +
			"Devtools is not managing the worktree: start it yourself from the worktree with the project's CLI and " +
			"start --runtime native (never without it). Never run supabase stop --all or stack destroy, and never " +
			"kill postgres.",
	},
	protocol.CommandSimulators: {
		title:       "List Simulators",
		description: "List the iOS Simulators on this Mac with name, udid, runtime, state (booted or shutdown), lanes, and attached agents. Call this first to choose a udid for lane up, input, or capture; prefer a booted device nobody else has claimed.",
		readOnly:    true,
	},
	protocol.CommandCapture: {
		title:       "Screenshot a Simulator",
		description: "Take a screenshot of a booted Simulator and return it as an image you can look at, plus its file path. Use it to see the current screen before and after tapping or typing, or to verify a UI state. format png (default) or jpeg.",
		readOnly:    true,
	},
	protocol.CommandInput: {
		title: "Tap, swipe, type, or press a button on a Simulator",
		description: "Send real touches and keys to a booted Simulator through the same path Simulator.app uses, so it works on " +
			"Springboard, system alerts, the login screen, and apps that have not connected to RN Devtools. kind " +
			"tap (x, y), swipe (from-x, from-y, to-x, to-y), text (text, typed key by key; printable ASCII), key " +
			"(usage: USB HID keyboard usage, 40 Return, 42 Delete, 41 Escape, 43 Tab), or button (home, lock, " +
			"siri, volume-up, volume-down, apple-pay). Coordinates are 0..1 ratios of the screen from the " +
			"top-left: divide a pixel position by the screenshot's width and height. hold-ms 500+ makes a long " +
			"press. Prefer act for the connected app's own screens; use input for everything outside it. After an " +
			"input, capture a screenshot to see what changed.",
	},
	protocol.CommandElements: {
		title:       "Read the connected app's elements",
		description: "List the semantic elements (buttons, inputs, text) of the React Native app connected to RN Devtools on a Simulator, with ids you can pass to act. Needs the app running with RN Devtools enabled; for other apps or system UI use capture and input. Target with udid or device-id; optional query filters by text; limit caps results.",
		readOnly:    true,
	},
	protocol.CommandAct: {
		title:       "Act in the connected app",
		description: "Run an allowlisted action in the connected React Native app: tool \"components\" with action-command activate, focus, scroll, setText, highlight, waitForElement, or waitForScreenChange; tool \"routes\" with navigate; tool \"network\" with setProfile or clearProfile; tool \"performance\" with start or stop. action-payload carries the arguments as a JSON object (for example {\"elementId\": \"...\"} or {\"elementId\": \"...\", \"text\": \"...\"}). Read elements first to get ids. For taps outside the app's semantic layer use input.",
	},
	protocol.CommandWait: {
		title:       "Wait for the connected app",
		description: "Block until a condition holds in the connected app: condition element (element-id appears), screen-change (screen differs from screen-hash), job (job-id finishes), or network-idle (no requests for quiet-ms). timeout-ms caps the wait. Use it after act or lane launch instead of sleeping.",
		readOnly:    true,
	},
	protocol.CommandScreen: {
		title:       "Describe the connected app's screen",
		description: "Return the connected app's current route, a stable screen hash for wait screen-change, and a summary of what is on screen. Needs the app connected to RN Devtools; otherwise use capture.",
		readOnly:    true,
	},
	protocol.CommandNative: {
		title: "Plan or install the native app build",
		description: "operation \"plan\" fingerprints an Expo worktree's native code and reports whether a matching dev-client " +
			"build is already installed on the Simulator, cached, or must be built, with the exact command in " +
			"its recommendation (installed: / install: / build:); it builds nothing and takes about two seconds. Call it when lane up reports the dev " +
			"client is missing, and before running expo run:ios yourself. operation \"install\" puts a cached " +
			"build on the Simulator (udid). worktree is the absolute app directory; configuration Debug (default) " +
			"or Release. A first native build takes 5-15 minutes; tell the user it is running rather than waiting " +
			"silently, and do not restart it. If the user asked you not to build, report the command instead.",
		readOnly: false,
	},
	protocol.CommandAgents: {
		title:       "List agent sessions and their Simulators",
		description: "Show the coding-agent sessions RN Devtools knows about (Claude Code, Codex, others) and which Simulators each has claimed or recently driven. Check this before using a device another session may be working on.",
		readOnly:    true,
	},
	protocol.CommandClaim: {
		title:       "Claim a Simulator for this session",
		description: "Mark a Simulator as held by this agent session. A claim is a hold: claiming a device someone else holds fails with device_held, and while you hold it, other sessions' lane up, launch, and down, input, native install, slimming, recipe runs, and job or recording cancels on it fail with device_held too, except that a session can always stop or cancel a recording it started itself. act and network are not gated: any session can still act in the app on a held device or change its network profile. note explains why; release when finished.",
	},
	protocol.CommandRelease: {
		title:       "Release a claimed Simulator",
		description: "Release a Simulator this session claimed (udid), or with all=true release everything this session holds: stop its lanes and drop its claims. Call it with all=true when you are done, so the devices go back to the pool at once.",
	},
	protocol.CommandApps: {
		title:       "List apps on a Simulator",
		description: "List the apps installed on a Simulator (bundle ids, names, paths). Use it to check whether the dev client is installed.",
		readOnly:    true,
	},
	protocol.CommandRecord: {
		title:       "Record a Simulator video",
		description: "operation start begins recording a Simulator's screen (codec h264 or hevc, optional name); stop (job-id) finishes and reports the file.",
	},
	protocol.CommandNetwork: {
		title:       "Shape the connected app's network",
		description: "operation status shows the active network profile on the connected app; set applies profile-id (for example offline or slow); clear restores normal networking.",
	},
	protocol.CommandRecipe: {
		title:       "Run a saved recipe",
		description: "list, get, run (recipe-id, udids), cancel, or status (run-id) for scripted multi-Simulator scenarios saved in RN Devtools.",
	},
	protocol.CommandJobs: {
		title:       "Inspect background jobs",
		description: "list, get (job-id), or cancel (job-id) the desktop's background jobs such as captures and recordings.",
		// cancel aborts a job, possibly another session's, so jobs is not read-only.
	},
	protocol.CommandSlimming: {
		title: "Slim Simulators (SimSlim)",
		description: "SimSlim trims a Simulator's background services so it boots faster and uses less memory; applying a profile reboots the device. " +
			"operation status lists profiles and every device's state; preview (udids, profile-id) shows what a profile would change; " +
			"doctor and verify check a device. apply (udids, profile-id) applies a profile, undo reverts the last managed change, " +
			"restore puts all managed services back. Mutations work only on devices you hold or that are free (device_held otherwise), " +
			"only while the user has enabled SimSlim in RN Devtools, and only on runtime/profile combinations SimSlim has verified or " +
			"the user has approved once; the error says which. Prefer lane up with slim to slim the device a lane is about to use.",
		readOnly: false,
	},
	protocol.CommandDoctor: {
		title:       "Check RN Devtools health",
		description: "Report whether the RN Devtools desktop app is running, the native helpers are trusted, and Simulators are reachable. Call it when another tool reports desktop_unavailable.",
		readOnly:    true,
	},
}

// Resources: read-only views an agent can pull without a tool call.

func staticResources() []map[string]any {
	return []map[string]any{
		{
			"uri":         "rndevtools://simulators",
			"name":        "Simulators",
			"description": "The Simulators on this Mac with state, lanes, and attached agents (JSON).",
			"mimeType":    "application/json",
		},
		{
			"uri":         "rndevtools://lanes",
			"name":        "Lanes",
			"description": "Active lanes: worktree, Simulator, Metro port, owning agent (JSON).",
			"mimeType":    "application/json",
		},
		{
			"uri":         "rndevtools://supabase",
			"name":        "Local Supabase stacks",
			"description": "Every worktree's local Supabase stack on this Mac: branch, status, ports, lanes, and holders (JSON; no URLs or keys).",
			"mimeType":    "application/json",
		},
		{
			"uri":         "rndevtools://agents",
			"name":        "Agent sessions",
			"description": "Coding-agent sessions and the Simulators they hold (JSON).",
			"mimeType":    "application/json",
		},
	}
}

func resourceTemplates() []map[string]any {
	return []map[string]any{
		{
			"uriTemplate": "rndevtools://screen/{udid}",
			"name":        "Simulator screen",
			"description": "A fresh JPEG screenshot of the booted Simulator with this UDID (JPEG keeps a 3x retina frame near 0.5 MB; use the capture tool for PNG).",
			"mimeType":    "image/jpeg",
		},
	}
}

func (server *Server) readResource(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var request struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(params, &request); err != nil || request.URI == "" {
		return nil, &rpcError{Code: codeInvalidParams, Message: "resources/read needs a uri"}
	}
	const scheme = "rndevtools://"
	if !strings.HasPrefix(request.URI, scheme) {
		return nil, &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf("unknown resource %q", request.URI)}
	}
	path := strings.TrimPrefix(request.URI, scheme)
	switch {
	case path == "simulators":
		return server.jsonResource(ctx, request.URI, protocol.CommandSimulators, map[string]any{})
	case path == "lanes":
		return server.jsonResource(ctx, request.URI, protocol.CommandLane, map[string]any{"operation": "ls"})
	case path == "supabase":
		return server.jsonResource(ctx, request.URI, protocol.CommandSupabase, map[string]any{"operation": "ls"})
	case path == "agents":
		return server.jsonResource(ctx, request.URI, protocol.CommandAgents, map[string]any{})
	case strings.HasPrefix(path, "screen/"):
		udid := strings.TrimPrefix(path, "screen/")
		if !command.ValidUDID(udid) {
			return nil, &rpcError{Code: codeInvalidParams, Message: "screen resources are addressed by Simulator UDID"}
		}
		return server.screenResource(ctx, request.URI, strings.ToUpper(udid))
	}
	return nil, &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf("unknown resource %q", request.URI)}
}

func (server *Server) jsonResource(ctx context.Context, uri string, kind protocol.Command, arguments map[string]any) (any, *rpcError) {
	result, rpcErr := server.run(ctx, kind, arguments)
	if rpcErr != nil {
		return nil, rpcErr
	}
	return map[string]any{
		"contents": []any{map[string]any{"uri": uri, "mimeType": "application/json", "text": compact(result)}},
	}, nil
}

func (server *Server) screenResource(ctx context.Context, uri string, udid string) (any, *rpcError) {
	result, rpcErr := server.run(ctx, protocol.CommandCapture, map[string]any{"udid": udid, "format": "jpeg"})
	if rpcErr != nil {
		return nil, rpcErr
	}
	var capture struct {
		Path    string `json:"path"`
		Capture struct {
			MimeType string `json:"mimeType"`
		} `json:"capture"`
	}
	if err := json.Unmarshal(result, &capture); err != nil || capture.Path == "" {
		return nil, &rpcError{Code: codeInternal, Message: "the capture completed without a readable path"}
	}
	data, err := server.config.ReadFile(filepath.Clean(capture.Path))
	if err != nil {
		return nil, &rpcError{Code: codeInternal, Message: fmt.Sprintf("read capture: %v", err)}
	}
	if len(data) > maxImageBytes {
		return nil, &rpcError{Code: codeInternal, Message: "the screenshot is too large to embed; use the capture tool and read the path"}
	}
	mimeType := capture.Capture.MimeType
	if mimeType == "" {
		mimeType = "image/jpeg"
	}
	return map[string]any{
		"contents": []any{map[string]any{"uri": uri, "mimeType": mimeType, "blob": base64.StdEncoding.EncodeToString(data)}},
	}, nil
}

// run executes a command for a resource read, mapping failures to JSON-RPC
// errors since resources have no isError channel.
func (server *Server) run(ctx context.Context, kind protocol.Command, arguments map[string]any) (json.RawMessage, *rpcError) {
	parsed, err := command.Build(kind, arguments, server.config.Lookup)
	if err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: err.Error()}
	}
	response, err := server.send(ctx, parsed)
	if err != nil {
		code, message, _, recovery := classifyTransportError(err)
		return nil, &rpcError{Code: codeInternal, Message: fmt.Sprintf("%s: %s", code, message), Data: map[string]any{"recovery": recovery}}
	}
	if !response.OK {
		return nil, &rpcError{Code: codeInternal, Message: fmt.Sprintf("%s: %s", response.Error.Code, response.Error.Message), Data: map[string]any{"recovery": response.Error.Recovery}}
	}
	return response.Result, nil
}
