package setup

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const healthFileLimit = 2 * 1024 * 1024
const healthRulesVersion = "2026-11-09.1"

// HealthOptions are local filesystem inputs, never accepted through the MCP.
type HealthOptions struct {
	Home       string
	Project    string
	Executable string
}

type HealthFinding struct {
	ID       string `json:"id"`
	Client   string `json:"client"`
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Source   string `json:"source"`
	Scope    string `json:"scope"`
	FixLabel string `json:"fixLabel,omitempty"`
	// Repair inputs stay in the trusted CLI process; the renderer receives IDs.
	file   string
	format string
	keys   []string
	value  any
	mode   string
}

type HealthClient struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Configuration string `json:"configuration"`
	Connection    string `json:"connection"`
	Hooks         string `json:"hooks"`
}

type HealthReceipt struct {
	ID        string `json:"id"`
	Client    string `json:"client"`
	Title     string `json:"title"`
	Scope     string `json:"scope"`
	AppliedAt int64  `json:"appliedAt"`
	Status    string `json:"status"`
}

type HealthReport struct {
	Version      int             `json:"version"`
	RulesVersion string          `json:"rulesVersion"`
	CheckedAt    int64           `json:"checkedAt"`
	Fingerprint  string          `json:"fingerprint"`
	Project      string          `json:"project"`
	Clients      []HealthClient  `json:"clients"`
	Findings     []HealthFinding `json:"findings"`
	Repairs      []HealthReceipt `json:"repairs"`
	Coverage     []string        `json:"coverage"`
	Limitations  []string        `json:"limitations"`
}

type healthScanner struct {
	options HealthOptions
	report  HealthReport
	files   map[string]string
	blocked map[string]bool
}

func healthOptions(options HealthOptions) (HealthOptions, error) {
	if options.Home == "" {
		options.Home, _ = os.UserHomeDir()
	}
	if !filepath.IsAbs(options.Home) || !filepath.IsAbs(options.Executable) || (options.Project != "" && !filepath.IsAbs(options.Project)) {
		return options, errors.New("Agent checks require absolute home, executable and project paths.")
	}
	options.Home = filepath.Clean(options.Home)
	if options.Project != "" {
		options.Project = filepath.Clean(options.Project)
		// Claude indexes project toggles by real cwd (not macOS /var aliases
		// or a symlink used to open a repository). Match that identity.
		if real, err := filepath.EvalSymlinks(options.Project); err == nil {
			options.Project = real
		}
	}
	return options, nil
}

func healthHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// Read only regular, bounded files. A FIFO or device must never hang setup.
func healthRead(file string) ([]byte, bool, error) {
	info, err := os.Stat(file)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > healthFileLimit {
		return nil, false, errors.New("File is unreadable, not regular, or exceeds the check limit.")
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, healthFileLimit+1))
	if err != nil || len(data) > healthFileLimit {
		return nil, false, errors.New("File exceeds the check limit.")
	}
	return data, true, nil
}

func healthDecode(data []byte, format string) (map[string]any, error) {
	doc := map[string]any{}
	if len(bytes.TrimSpace(data)) == 0 {
		return doc, nil
	}
	var err error
	if format == "toml" {
		err = toml.Unmarshal(data, &doc)
	} else {
		err = decodeJSONDocument(data, &doc)
	}
	if err != nil || doc == nil {
		return nil, errors.New("Configuration is not a valid object; no automatic edits are available.")
	}
	return doc, nil
}

// Unknown client settings can contain identifiers and precise numeric policy.
// Keep their JSON representation instead of rounding every number to float64.
func decodeJSONDocument(data []byte, doc *map[string]any) error {
	if !json.Valid(data) {
		return errors.New("Invalid JSON configuration.")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(doc)
}

func healthGet(doc map[string]any, keys ...string) (any, bool) {
	var value any = doc
	for _, key := range keys {
		m, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok = m[key]
		if !ok {
			return nil, false
		}
	}
	return value, true
}
func healthMap(doc map[string]any, keys ...string) map[string]any {
	v, _ := healthGet(doc, keys...)
	m, _ := v.(map[string]any)
	return m
}
func healthString(value any) string { s, _ := value.(string); return s }
func healthFalse(value any) bool    { b, ok := value.(bool); return ok && !b }
func healthContains(value any, wanted string) bool {
	list, _ := value.([]any)
	for _, v := range list {
		if v == wanted {
			return true
		}
	}
	return false
}

// healthClientNames are the clients' names as the report and the desktop
// show them.
var healthClientNames = map[string]string{"codex": "Codex", "claude": "Claude Code"}

func (s *healthScanner) label(file string) string { return healthLabel(s.options.Home, file) }

// healthLabel shows file relative to home when it is inside it.
func healthLabel(home, file string) string {
	if healthInside(home, file) && file != home {
		rel, _ := filepath.Rel(home, file)
		return "~/" + rel
	}
	return file
}

// healthInside reports whether path is base or inside it, lexically.
func healthInside(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	return err == nil && !filepath.IsAbs(rel) && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// healthEscapesProject reports a file of the selected project that an edit
// would write outside it, through a link the repository committed (a
// .claude/settings.local.json that points at the user's own settings): a
// "Selected project" repair there would change every project. label names
// the file the edit would write.
func healthEscapesProject(options HealthOptions, file string) (escapes bool, label string) {
	if options.Project == "" || !healthInside(options.Project, file) {
		return false, ""
	}
	target, reason := writeTarget(file)
	if reason != "" || healthInside(options.Project, target) {
		return false, ""
	}
	return true, healthLabel(options.Home, target)
}

func (s *healthScanner) add(f HealthFinding) {
	if len(s.report.Findings) >= 200 {
		return
	}
	if f.FixLabel != "" {
		if escapes, label := healthEscapesProject(s.options, f.file); escapes {
			f.FixLabel = ""
			f.Detail += " This project file resolves to " + label + ", outside the project, so no automatic fix is offered; change the setting where that file lives."
		}
	}
	f.Source = s.label(f.file)
	if f.Scope == "" {
		f.Scope = "All " + healthClientNames[f.Client] + " projects"
	}
	f.ID = "finding-" + healthHash([]byte(f.Client + "\x00" + f.Rule + "\x00" + f.file + "\x00" + strings.Join(f.keys, "\x00")))[:32]
	for _, existing := range s.report.Findings {
		if existing.ID == f.ID {
			return
		}
	}
	s.report.Findings = append(s.report.Findings, f)
}
func (s *healthScanner) read(file, client string) ([]byte, bool) {
	data, present, err := healthRead(file)
	if err != nil {
		s.files[file] = "unreadable"
		s.blocked[client] = true
		s.add(HealthFinding{Client: client, Rule: "unreadable", Severity: "review", Title: "Configuration was not checked", Detail: "This file is unreadable, not regular, or too large. Review it before changing agent setup.", file: file})
		return nil, false
	}
	if present {
		s.files[file] = healthHash(data)
	} else {
		s.files[file] = "missing"
	}
	return data, present
}
func (s *healthScanner) document(file, client, format string) map[string]any {
	data, _ := s.read(file, client)
	doc, err := healthDecode(data, format)
	if err != nil {
		s.blocked[client] = true
		s.add(HealthFinding{Client: client, Rule: "invalid-config", Severity: "review", Title: "Configuration needs review", Detail: err.Error(), file: file})
		return map[string]any{}
	}
	s.validateDocument(doc, file, client)
	return doc
}

// Unsupported shapes must not silently turn into an empty, repairable config.
func (s *healthScanner) validateDocument(doc map[string]any, file, client string) {
	invalid := false
	for _, key := range []string{"mcp_servers", "mcpServers", "plugins", "enabledPlugins", "hooks", "projects"} {
		// Codex's TOML hook policy is not the event arrays in hooks.json.
		if key == "hooks" && client == "codex" && strings.HasSuffix(file, ".toml") {
			continue
		}
		value, present := doc[key]
		if !present {
			continue
		}
		entries, ok := value.(map[string]any)
		if !ok {
			invalid = true
			continue
		}
		for _, entry := range entries {
			switch key {
			case "enabledPlugins":
				if _, ok := entry.(bool); !ok {
					invalid = true
				}
			case "hooks":
				if _, ok := entry.([]any); !ok {
					invalid = true
				}
			default:
				if _, ok := entry.(map[string]any); !ok {
					invalid = true
				}
			}
		}
	}
	if invalid {
		s.blocked[client] = true
		s.add(HealthFinding{Client: client, Rule: "unsupported-config", Severity: "review", Title: "Configuration needs review", Detail: "A known configuration section has an unsupported shape. No automatic edits are offered for this client.", file: file})
	}
}

// controllerNames are signatures of MCP servers and plugins that drive
// Simulators themselves, matched in a server's name, command, and arguments.
// xcodebuildmcp is XcodeBuildMCP's npm package and binary (`xcodebuildmcp
// mcp`, or `npx -y xcodebuildmcp@latest`), whose boot_sim and build_run_sim
// ignore RN Devtools' holds.
var controllerNames = []struct{ signature, name string }{
	{"simview", "SimView"}, {"argent", "Argent"}, {"agent-device", "agent-device"}, {"maestro", "Maestro"}, {"radon", "Radon"}, {"ios-simulator", "iOS Simulator MCP"}, {"serve-sim", "serve-sim"}, {"appium", "Appium"}, {"mobile-mcp", "Mobile MCP"}, {"bridge4simulator", "bridge4simulator"}, {"xcodebuildmcp", "XcodeBuildMCP"},
}

func healthController(name string, entry map[string]any) string {
	parts := []string{name, filepath.Base(healthString(entry["command"]))}
	if args, ok := entry["args"].([]any); ok {
		for _, a := range args {
			parts = append(parts, healthString(a))
		}
	}
	// Match package/binary identifiers, not secret-bearing URLs or environment.
	text := strings.ToLower(strings.Join(parts, " "))
	for _, candidate := range controllerNames {
		if strings.Contains(text, candidate.signature) {
			return candidate.name
		}
	}
	return ""
}

// CheckAgents never launches MCP servers or changes client/device configuration.
func CheckAgents(options HealthOptions) (HealthReport, error) {
	options, err := healthOptions(options)
	if err != nil {
		return HealthReport{}, err
	}
	s := healthScanner{options: options, files: map[string]string{}, blocked: map[string]bool{}, report: HealthReport{Version: 1, RulesVersion: healthRulesVersion, CheckedAt: time.Now().UnixMilli(), Project: options.Project, Clients: []HealthClient{}, Findings: []HealthFinding{}, Repairs: []HealthReceipt{}, Coverage: []string{"Claude Code and Codex user configuration, selected project overrides, known controller registrations, routing skills and hooks"}, Limitations: []string{"Configuration checks do not inspect tools already loaded in a running client. Reload after changes.", "Remote clients, Claude Desktop, command-line overrides and organization-managed policy are not certified by this check.", "Hook installation is not proof of trust or invocation; shell steering is not an MCP security boundary."}}}
	s.scanCodex()
	s.scanClaude()
	s.report.Limitations = append(s.report.Limitations,
		"Checks use the default client homes and selected project. Custom configuration homes, profiles and ancestor project overrides require review in the client.",
		"Controller matching covers known names and launch commands. Custom wrappers, plugin tool filters and active runners require review; a warning does not prove interference.")
	for _, client := range []string{"codex", "claude"} {
		s.scanGuidance(client)
	}
	for i := range s.report.Findings {
		if s.blocked[s.report.Findings[i].Client] {
			s.report.Findings[i].FixLabel = ""
		}
	}
	for i := range s.report.Clients {
		c := &s.report.Clients[i]
		c.Configuration = "checked"
		for _, f := range s.report.Findings {
			if f.Client == c.ID && f.Severity != "info" {
				c.Configuration = "attention"
			}
		}
		if s.blocked[c.ID] {
			c.Configuration = "not-checked"
		}
	}
	sort.Slice(s.report.Findings, func(i, j int) bool { return s.report.Findings[i].ID < s.report.Findings[j].ID })
	paths := make([]string, 0, len(s.files))
	for file := range s.files {
		paths = append(paths, file)
	}
	sort.Strings(paths)
	var fingerprints strings.Builder
	fingerprints.WriteString(healthRulesVersion + options.Executable + options.Project)
	for _, file := range paths {
		fingerprints.WriteString(file + "\x00" + s.files[file] + "\n")
	}
	s.report.Fingerprint = healthHash([]byte(fingerprints.String()))
	// Read-only, like the rest of the check: previews, repairs and undos prune.
	s.report.Repairs = healthReceipts(options)
	return s.report, nil
}

func (s *healthScanner) scanCodex() {
	file := filepath.Join(s.options.Home, ".codex", "config.toml")
	doc := s.document(file, "codex", "toml")
	serverSources := map[string]string{}
	pluginSources := map[string]string{}
	servers := map[string]any{}
	plugins := map[string]any{}
	merge := func(d map[string]any, source string) {
		s.validateDocument(d, source, "codex")
		for name, value := range healthMap(d, "mcp_servers") {
			base, _ := servers[name].(map[string]any)
			if base == nil {
				base = map[string]any{}
			}
			next, ok := value.(map[string]any)
			if !ok {
				s.blocked["codex"] = true
				continue
			}
			for k, v := range next {
				base[k] = v
			}
			servers[name] = base
			serverSources[name] = source
		}
		for name, value := range healthMap(d, "plugins") {
			base, _ := plugins[name].(map[string]any)
			if base == nil {
				base = map[string]any{}
			}
			next, _ := value.(map[string]any)
			for k, v := range next {
				base[k] = v
			}
			plugins[name] = base
			pluginSources[name] = source
		}
	}
	merge(doc, file)
	if s.options.Project != "" {
		projectFile := filepath.Join(s.options.Project, ".codex", "config.toml")
		data, present := s.read(projectFile, "codex")
		if present {
			projectDoc, e := healthDecode(data, "toml")
			if e != nil {
				s.blocked["codex"] = true
				s.add(HealthFinding{Client: "codex", Rule: "project-invalid", Severity: "review", Title: "Project configuration was not checked", Detail: e.Error(), file: projectFile})
			} else {
				merge(projectDoc, projectFile)
				trust, _ := healthGet(doc, "projects", s.options.Project, "trust_level")
				if trust != "trusted" {
					s.blocked["codex"] = true
					s.add(HealthFinding{Client: "codex", Rule: "project-trust", Severity: "review", Title: "Confirm project trust in Codex", Detail: "Project settings were found, but their activation cannot be confirmed. Trust the project in Codex and recheck; no fixes are offered while precedence is uncertain.", file: projectFile})
				}
			}
		}
	}
	server, _ := servers["rndevtools"].(map[string]any)
	connection := "configured"
	for _, required := range []string{"doctor", "lane", "supabase", "input", "native"} {
		allowed, restricted := server["enabled_tools"]
		if (restricted && !healthContains(allowed, required)) || healthContains(server["disabled_tools"], required) {
			s.add(HealthFinding{Client: "codex", Rule: "tool-filter", Severity: "review", Title: "RN Devtools tools are restricted", Detail: "The MCP tool filter excludes a required tool. Review enabled_tools and disabled_tools in Codex. Your approval policy is preserved.", file: serverSources["rndevtools"]})
			break
		}
	}
	// A short tool timeout cuts a cold lane or Supabase start off; setup raises
	// it, so the check does too.
	if healthString(server["command"]) != s.options.Executable || !jsonEqual(server["args"], []any{"mcp"}) || healthFalse(server["enabled"]) || codexTimeoutShort(server["tool_timeout_sec"]) {
		connection = "needs-setup"
		target := serverSources["rndevtools"]
		if target == "" {
			target = file
		}
		scope := "All Codex projects"
		if target != file {
			scope = "Selected project (Codex)"
		}
		f := HealthFinding{Client: "codex", Rule: "connection", Severity: "warning", Title: "RN Devtools connection needs setup", Detail: "Register the bundled executable, enable its MCP, and raise a tool timeout shorter than 240 seconds, which can cut off a cold lane or Supabase start. Existing environment and approval settings are preserved.", file: target, format: "toml", mode: "connection", Scope: scope, FixLabel: "Repair Codex connection"}
		if server["url"] != nil {
			f.FixLabel = ""
			f.Detail = "A custom RN Devtools transport is configured. Review it in Codex; it will not be replaced automatically."
		}
		s.add(f)
	}
	for name, value := range servers {
		entry, _ := value.(map[string]any)
		if healthFalse(entry["enabled"]) || name == "rndevtools" {
			continue
		}
		controller := healthController(name, entry)
		if controller == "" {
			continue
		}
		target := serverSources[name]
		scope := "All Codex projects"
		if target != file {
			scope = "Selected project (Codex)"
		}
		s.add(HealthFinding{Client: "codex", Rule: "controller", Severity: "warning", Title: controller + " can also control simulators", Detail: "This enabled MCP can bypass RN Devtools device holds. Disabling it preserves its configuration; existing client sessions need a reload.", file: target, format: "toml", keys: []string{"mcp_servers", name, "enabled"}, value: false, mode: "values", Scope: scope, FixLabel: "Disable MCP in Codex"})
	}
	for name, value := range plugins {
		entry, _ := value.(map[string]any)
		if healthFalse(entry["enabled"]) {
			continue
		}
		controller := healthController(name, nil)
		if controller == "" {
			continue
		}
		target, scope := pluginSources[name], "All Codex projects"
		if target != file {
			scope = "Selected project (Codex)"
		}
		s.add(HealthFinding{Client: "codex", Rule: "plugin-controller", Severity: "warning", Title: controller + " plugin overlaps simulator control", Detail: "Disable this plugin's tools and routing skills for the shown scope. Its installation and other settings are kept. Reload Codex afterward.", file: target, format: "toml", keys: []string{"plugins", name, "enabled"}, value: false, mode: "values", Scope: scope, FixLabel: "Disable plugin in Codex"})
	}
	s.report.Clients = append(s.report.Clients, HealthClient{ID: "codex", Name: "Codex", Connection: connection, Hooks: "not-verified"})
}

func (s *healthScanner) scanClaude() {
	file := filepath.Join(s.options.Home, ".claude.json")
	doc := s.document(file, "claude", "json")
	settingsFile := filepath.Join(s.options.Home, ".claude", "settings.json")
	settings := s.document(settingsFile, "claude", "json")
	if settings["disableAllHooks"] == true {
		s.add(HealthFinding{Client: "claude", Rule: "hooks-disabled", Severity: "review", Title: "Claude hooks are disabled", Detail: "disableAllHooks prevents steering and session cleanup. Review this setting in Claude; setup will not override your policy.", file: settingsFile})
	}
	disabledProject := append([]any{}, asHealthList(settings["disabledMcpjsonServers"])...)
	servers := map[string]any{}
	sources := map[string]string{}
	plugins := map[string]any{}
	merge := func(d map[string]any, source string) {
		s.validateDocument(d, source, "claude")
		for k, v := range healthMap(d, "mcpServers") {
			servers[k] = v
			sources[k] = source
		}
	}
	merge(doc, file)
	for k, v := range healthMap(settings, "enabledPlugins") {
		plugins[k] = v
	}
	projectSettings := settingsFile
	if s.options.Project != "" {
		pfile := filepath.Join(s.options.Project, ".mcp.json")
		merge(s.document(pfile, "claude", "json"), pfile)
		merge(healthMap(doc, "projects", s.options.Project), file)
		for _, name := range []string{"settings.json", "settings.local.json"} {
			p := filepath.Join(s.options.Project, ".claude", name)
			d := s.document(p, "claude", "json")
			if d["disableAllHooks"] == true {
				s.add(HealthFinding{Client: "claude", Rule: "hooks-disabled", Severity: "review", Title: "Project hooks are disabled", Detail: "This project disables hooks. Review disableAllHooks in Claude; setup preserves that choice.", file: p, Scope: "Selected project (Claude Code)"})
			}
			disabledProject = append(disabledProject, asHealthList(d["disabledMcpjsonServers"])...)
			for k, v := range healthMap(d, "enabledPlugins") {
				plugins[k] = v
			}
		}
		projectSettings = filepath.Join(s.options.Project, ".claude", "settings.local.json")
	}
	disabled, _ := healthGet(doc, "projects", s.options.Project, "disabledMcpServers")
	projectMCPFile := filepath.Join(s.options.Project, ".mcp.json")
	server, _ := servers["rndevtools"].(map[string]any)
	connection := "configured"
	if healthString(server["command"]) != s.options.Executable || !jsonEqual(server["args"], []any{"mcp"}) || healthContains(disabled, "rndevtools") || (sources["rndevtools"] == projectMCPFile && healthContains(disabledProject, "rndevtools")) {
		connection = "needs-setup"
		target := sources["rndevtools"]
		if target == "" {
			target = file
		}
		scope := "All Claude Code projects"
		if target == projectMCPFile || healthMap(doc, "projects", s.options.Project, "mcpServers", "rndevtools") != nil {
			scope = "Selected project (Claude Code)"
		}
		f := HealthFinding{Client: "claude", Rule: "connection", Severity: "warning", Title: "RN Devtools connection needs setup", Detail: "Register the bundled MCP executable. Existing environment and approval settings are preserved.", file: target, format: "json", mode: "connection", Scope: scope, FixLabel: "Repair Claude connection"}
		if server["url"] != nil || healthContains(disabled, "rndevtools") || healthContains(disabledProject, "rndevtools") || (target == file && healthMap(doc, "projects", s.options.Project, "mcpServers", "rndevtools") != nil) {
			f.FixLabel = ""
			f.Detail = "Review this project override or disabled connection in Claude /mcp, then recheck."
		}
		s.add(f)
	}
	for name, value := range servers {
		entry, _ := value.(map[string]any)
		if healthContains(disabled, name) || (sources[name] == projectMCPFile && healthContains(disabledProject, name)) || name == "rndevtools" {
			continue
		}
		controller := healthController(name, entry)
		if controller == "" {
			continue
		}
		f := HealthFinding{Client: "claude", Rule: "controller", Severity: "warning", Title: controller + " can also control simulators", Detail: "This registered MCP can drive devices outside RN Devtools if approved in Claude. Choose a project to disable it without removing its registration. Project MCP approval is verified in Claude /mcp.", file: sources[name], keys: []string{"mcpServers", name}}
		if s.options.Project != "" {
			list, _ := disabled.([]any)
			list = append(append([]any{}, list...), name)
			f.file = file
			f.format = "json"
			f.keys = []string{"projects", s.options.Project, "disabledMcpServers"}
			f.value = list
			f.mode = "values"
			f.FixLabel = "Disable MCP for this project"
			f.Scope = "Selected project (Claude Code)"
			f.Rule += "-" + healthHash([]byte(name))[:8]
		}
		s.add(f)
	}
	for name, value := range plugins {
		if value != true {
			continue
		}
		controller := healthController(name, nil)
		if controller == "" {
			continue
		}
		scope := "All Claude Code projects"
		if s.options.Project != "" {
			scope = "Selected project (Claude Code)"
		}
		s.add(HealthFinding{Client: "claude", Rule: "plugin-controller", Severity: "warning", Title: controller + " plugin overlaps simulator control", Detail: "Disable this plugin's tools and routing skills for the shown scope. Its installation and other settings are kept. Reload Claude afterward.", file: projectSettings, format: "json", keys: []string{"enabledPlugins", name}, value: false, mode: "values", Scope: scope, FixLabel: "Disable plugin in Claude"})
	}
	s.report.Clients = append(s.report.Clients, HealthClient{ID: "claude", Name: "Claude Code", Connection: connection, Hooks: "not-verified"})
}

var conflictingSkillCommand = regexp.MustCompile(`(?m)^\s*(?:\$\s*)?(?:npx\s+|pnpm\s+exec\s+)?(?:xcrun\s+simctl\s+(?:boot|install|launch|shutdown)\s|expo\s+start\b|supabase\s+stop\s+--all\b)`)

func (s *healthScanner) scanGuidance(client string) {
	dir := ".codex"
	instruction := "AGENTS.md"
	hooks := "hooks.json"
	skillDir := ".agents"
	if client == "claude" {
		dir = ".claude"
		instruction = "CLAUDE.md"
		hooks = "settings.json"
		skillDir = ".claude"
	}
	root := filepath.Join(s.options.Home, dir)
	file := filepath.Join(root, instruction)
	data, _ := s.read(file, client)
	start, blockEnd, found, valid := agentsBlockSpan(string(data))
	if !valid {
		s.add(HealthFinding{Client: client, Rule: "routing-incomplete", Severity: "review", Title: "Routing instructions are incomplete", Detail: "The RN Devtools instruction markers do not form one complete block. Review the file before repairing its instructions.", file: file})
	} else if !found && s.projectRouting(client) {
		// setup --project wrote the block into the project instead.
	} else if !found || string(data[start:blockEnd]) != healthRoutingBlock() {
		title, label := "Add RN Devtools routing instructions", "Add routing instructions"
		if found {
			title, label = "Update RN Devtools routing instructions", "Update routing instructions"
		}
		s.add(HealthFinding{Client: client, Rule: "routing", Severity: "warning", Title: title, Detail: "Tell this client to use RN Devtools for local simulator, Metro and managed Supabase work. Existing instructions outside its managed block are kept.", file: file, format: "text", mode: "routing", FixLabel: label})
	}
	hookFile := filepath.Join(root, hooks)
	doc := s.document(hookFile, client, "json")
	pre, end := hookDocument(s.options.Executable)
	_, preCurrent, _ := withoutRndevtoolsHooks(asHealthList(healthMap(doc, "hooks")["PreToolUse"]), pre, s.options.Executable)
	_, endCurrent, _ := withoutRndevtoolsHooks(asHealthList(healthMap(doc, "hooks")["SessionEnd"]), end, s.options.Executable)
	if !preCurrent || !endCurrent {
		s.add(HealthFinding{Client: client, Rule: "hooks", Severity: "warning", Title: "RN Devtools steering hooks need setup", Detail: "Install shell steering and session cleanup hooks. Other hooks are preserved. Codex requires reviewing new hooks with /hooks; installing them does not grant trust.", file: hookFile, format: "json", mode: "hooks", FixLabel: "Install RN Devtools hooks"})
	} else {
		for i := range s.report.Clients {
			if s.report.Clients[i].ID == client {
				s.report.Clients[i].Hooks = "installed-unverified"
			}
		}
	}
	for _, name := range skillNames() {
		file := filepath.Join(s.options.Home, skillDir, "skills", name, "SKILL.md")
		data, present := s.read(file, client)
		wanted, _ := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if !present && s.options.Project != "" {
			// setup --project installs the skills into the project instead.
			if installed, _ := s.peek(filepath.Join(s.options.Project, skillDir, "skills", name, "SKILL.md")); bytes.Equal(installed, wanted) {
				continue
			}
		}
		if !bytes.Equal(data, wanted) {
			s.add(HealthFinding{Client: client, Rule: "skill-" + name, Severity: "warning", Title: "Update " + name + " instructions", Detail: "Install the skill matching this RN Devtools build. Only this RN Devtools skill file changes.", file: file, format: "text", mode: "skill", value: string(wanted), FixLabel: "Update RN Devtools skill"})
		}
	}
	roots := []string{filepath.Join(s.options.Home, skillDir, "skills")}
	if client == "codex" {
		roots = append(roots, filepath.Join(root, "skills"))
	}
	if s.options.Project != "" {
		roots = append(roots, filepath.Join(s.options.Project, skillDir, "skills"))
	}
	seen := map[string]bool{}
	count := 0
	for _, skillsRoot := range roots {
		entries, err := os.ReadDir(skillsRoot)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			s.report.Limitations = append(s.report.Limitations, "A skill directory could not be inspected.")
			continue
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "rndevtools-") {
				continue
			}
			count++
			if count > 300 {
				s.report.Limitations = append(s.report.Limitations, "Skill scan reached its 300-entry limit.")
				return
			}
			file := filepath.Join(skillsRoot, entry.Name(), "SKILL.md")
			real, err := filepath.EvalSymlinks(file)
			if err != nil || seen[real] {
				continue
			}
			seen[real] = true
			info, err := os.Stat(real)
			if err != nil || info.Size() > 64*1024 {
				continue
			}
			data, _ := s.read(file, client)
			if conflictingSkillCommand.Match(data) {
				s.add(HealthFinding{Client: client, Rule: "skill-routing", Severity: "review", Title: "Skill contains overlapping simulator commands", Detail: "This skill includes direct simulator or Metro lifecycle commands. Review its use and prefer RN Devtools routing. Text alone does not prove a running conflict; no vendor skill will be edited.", file: file})
			}
		}
	}
}

// peek reads a file that may stand in for a missing one, such as the copy
// setup --project installed in the project. Like read, it counts toward the
// fingerprint; unlike read, a file it cannot read only means no stand-in.
func (s *healthScanner) peek(file string) ([]byte, bool) {
	data, present, err := healthRead(file)
	switch {
	case err != nil:
		s.files[file] = "unreadable"
		return nil, false
	case present:
		s.files[file] = healthHash(data)
	default:
		s.files[file] = "missing"
	}
	return data, present
}

// projectRouting reports whether the selected project carries this client's
// routing as setup --project writes it, current: Codex reads the project's
// AGENTS.md, and Claude Code its CLAUDE.md, which may import AGENTS.md.
func (s *healthScanner) projectRouting(client string) bool {
	if s.options.Project == "" {
		return false
	}
	current := func(name string) bool {
		data, present := s.peek(filepath.Join(s.options.Project, name))
		start, end, found, valid := agentsBlockSpan(string(data))
		return present && valid && found && string(data[start:end]) == AgentsBlock(s.options.Project)
	}
	if client == "codex" {
		return current("AGENTS.md")
	}
	if current("CLAUDE.md") {
		return true
	}
	claude, _ := s.peek(filepath.Join(s.options.Project, "CLAUDE.md"))
	return importsAgentsFile(claude) && current("AGENTS.md")
}

// importsAgentsFile reports a CLAUDE.md with a line that imports the
// AGENTS.md beside it (@AGENTS.md).
func importsAgentsFile(claude []byte) bool {
	for _, line := range strings.Split(string(claude), "\n") {
		if line := strings.TrimSpace(line); line == "@AGENTS.md" || line == "@./AGENTS.md" {
			return true
		}
	}
	return false
}

func asHealthList(value any) []any { list, _ := value.([]any); return list }
