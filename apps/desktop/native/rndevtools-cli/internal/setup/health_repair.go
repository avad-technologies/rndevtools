package setup

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
)

type HealthPlan struct {
	ID     string `json:"id"`
	Client string `json:"client"`
	Title  string `json:"title"`
	Scope  string `json:"scope"`
	Source string `json:"source"`
	// Target is the file the repair writes when it is not Source: the file a
	// link at Source points to. The confirmation shows both.
	Target    string `json:"target,omitempty"`
	Summary   string `json:"summary"`
	ExpiresAt int64  `json:"expiresAt"`
}

type healthValue struct {
	Keys          []string `json:"keys"`
	Before        any      `json:"before"`
	BeforePresent bool     `json:"beforePresent"`
	After         any      `json:"after"`
	AfterPresent  bool     `json:"afterPresent"`
}
type healthJournal struct {
	Plan        HealthPlan    `json:"plan"`
	Receipt     HealthReceipt `json:"receipt"`
	Home        string        `json:"home"`
	Project     string        `json:"project"`
	Executable  string        `json:"executable"`
	FindingID   string        `json:"findingId"`
	Fingerprint string        `json:"fingerprint"`
	File        string        `json:"file"`
	Target      string        `json:"target"`
	Format      string        `json:"format"`
	Mode        string        `json:"mode"`
	Before      []byte        `json:"before"`
	After       []byte        `json:"after"`
	Present     bool          `json:"present"`
	Values      []healthValue `json:"values"`
}

func healthSet(doc map[string]any, keys []string, value any, present bool) error {
	if len(keys) == 0 {
		return errors.New("No setting selected.")
	}
	cursor := doc
	for _, key := range keys[:len(keys)-1] {
		next, exists := cursor[key]
		if !exists {
			m := map[string]any{}
			cursor[key] = m
			cursor = m
			continue
		}
		m, ok := next.(map[string]any)
		if !ok {
			return errors.New("The setting has an unsupported shape; review it manually.")
		}
		cursor = m
	}
	if present {
		cursor[keys[len(keys)-1]] = value
	} else {
		delete(cursor, keys[len(keys)-1])
	}
	return nil
}

func healthLiteral(value any) (string, error) {
	if object, ok := value.(map[string]any); ok {
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := []string{}
		for _, key := range keys {
			literal, err := healthLiteral(object[key])
			if err != nil {
				return "", err
			}
			parts = append(parts, tomlString(key)+" = "+literal)
		}
		return "{ " + strings.Join(parts, ", ") + " }", nil
	}
	if array, ok := value.([]any); ok {
		parts := []string{}
		for _, v := range array {
			literal, err := healthLiteral(v)
			if err != nil {
				return "", err
			}
			parts = append(parts, literal)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	}
	data, err := toml.Marshal(map[string]any{"value": value})
	if err != nil {
		return "", errors.New("Cannot preserve this TOML value.")
	}
	return strings.TrimSpace(strings.TrimPrefix(string(data), "value = ")), nil
}

// Edit a single TOML expression using the parser's offsets. Comments, other
// tables, quoted keys, inline tables and unknown policy remain intact.
func healthTOMLValue(raw []byte, keys []string, value any, present bool) ([]byte, error) {
	doc, err := healthDecode(raw, "toml")
	if err != nil {
		return nil, err
	}
	existing, _ := healthGet(doc, keys...)
	emptyTable, isTable := existing.(map[string]any)
	removeEmptyTable := !present && isTable && len(emptyTable) == 0
	if err = healthSet(doc, keys, value, present); err != nil {
		return nil, err
	}
	var parser unstable.Parser
	parser.Reset(raw)
	var table []string
	insertAt := -1
	for parser.NextExpression() {
		node := parser.Expression()
		switch node.Kind {
		case unstable.Table, unstable.ArrayTable:
			table = tomlNodeKey(node)
			if node.Kind == unstable.Table && removeEmptyTable && slices.Equal(table, keys) {
				// Removing leaves alone leaves an invalid empty MCP registration.
				// Drop only its now-empty header, retaining comments on that line.
				first := int(node.Child().Raw.Offset)
				start := bytes.LastIndexByte(raw[:first], '\n') + 1
				keyEnd := first
				parts := node.Key()
				for parts.Next() {
					key := parts.Node()
					keyEnd = int(key.Raw.Offset + key.Raw.Length)
				}
				end := keyEnd + bytes.IndexByte(raw[keyEnd:], ']') + 1
				next := append(bytes.Clone(raw[:start]), raw[end:]...)
				if _, e := healthDecode(next, "toml"); e != nil {
					return nil, errors.New("Cannot safely remove this empty TOML table.")
				}
				return next, nil
			}
			if node.Kind == unstable.Table && slices.Equal(table, keys[:len(keys)-1]) {
				start := int(node.Child().Raw.Offset)
				end := bytes.IndexByte(raw[start:], '\n')
				if end < 0 {
					insertAt = len(raw)
				} else {
					insertAt = start + end + 1
				}
			}
		case unstable.KeyValue:
			path := append(slices.Clone(table), tomlNodeKey(node)...)
			if len(path) > len(keys) || !slices.Equal(path, keys[:len(path)]) {
				continue
			}
			start, end := int(node.Raw.Offset), int(node.Raw.Offset+node.Raw.Length)
			updated, exists := healthGet(doc, path...)
			replacement := ""
			if exists {
				literal, e := healthLiteral(updated)
				if e != nil {
					return nil, e
				}
				sep := tomlValueSeparator(raw, node)
				if sep < start || sep >= end {
					return nil, errors.New("Unsupported TOML layout.")
				}
				replacement = string(raw[start:sep+1]) + " " + literal
			}
			next := append([]byte{}, raw[:start]...)
			next = append(next, []byte(replacement)...)
			next = append(next, raw[end:]...)
			if _, e := healthDecode(next, "toml"); e != nil {
				return nil, errors.New("Cannot safely preserve this TOML layout.")
			}
			return next, nil
		}
	}
	if parser.Error() != nil {
		return nil, errors.New("Invalid TOML configuration.")
	}
	if !present {
		return raw, nil
	}
	literal, err := healthLiteral(value)
	if err != nil {
		return nil, err
	}
	line := tomlString(keys[len(keys)-1]) + " = " + literal + "\n"
	if insertAt < 0 {
		insertAt = len(raw)
		parts := []string{}
		for _, key := range keys[:len(keys)-1] {
			parts = append(parts, tomlString(key))
		}
		if len(parts) > 0 {
			line = "\n[" + strings.Join(parts, ".") + "]\n" + line
		}
	}
	if insertAt > 0 && raw[insertAt-1] != '\n' {
		line = "\n" + line
	}
	next := append([]byte{}, raw[:insertAt]...)
	next = append(next, []byte(line)...)
	next = append(next, raw[insertAt:]...)
	if _, e := healthDecode(next, "toml"); e != nil {
		return nil, errors.New("Cannot safely preserve this TOML layout; edit the setting in the client.")
	}
	return next, nil
}

func healthWriteValues(raw []byte, format string, changes []healthValue, undo bool) ([]byte, error) {
	doc, err := healthDecode(raw, format)
	if err != nil {
		return nil, err
	}
	for _, change := range changes {
		wanted, present := change.After, change.AfterPresent
		if undo {
			current, exists := healthGet(doc, change.Keys...)
			if exists != change.AfterPresent || !jsonEqual(current, change.After) {
				return nil, errors.New("This setting changed after the repair. Undo stopped to preserve the newer edit.")
			}
			wanted, present = change.Before, change.BeforePresent
		}
		if err = healthSet(doc, change.Keys, wanted, present); err != nil {
			return nil, err
		}
		if format == "toml" {
			raw, err = healthTOMLValue(raw, change.Keys, wanted, present)
			if err != nil {
				return nil, err
			}
		}
	}
	if format == "toml" {
		return raw, nil
	}
	raw, err = json.MarshalIndent(doc, "", "  ")
	return append(raw, '\n'), err
}

// Remove only empty containers created by the repair. Existing containers and
// any later settings inside a new container remain the operator's configuration.
func healthPruneCreatedParents(raw []byte, j healthJournal) ([]byte, error) {
	original, err := healthDecode(j.Before, j.Format)
	if err != nil {
		return nil, err
	}
	doc, err := healthDecode(raw, j.Format)
	if err != nil {
		return nil, err
	}
	for _, change := range j.Values {
		for depth := len(change.Keys) - 1; depth > 0; depth-- {
			keys := change.Keys[:depth]
			if _, existed := healthGet(original, keys...); existed {
				continue
			}
			value, _ := healthGet(doc, keys...)
			object, ok := value.(map[string]any)
			if ok && len(object) > 0 && depth == 2 && keys[1] == "rndevtools" && (keys[0] == "mcp_servers" || keys[0] == "mcpServers") {
				return nil, errors.New("This connection has new settings since the repair. Undo stopped to preserve the newer configuration.")
			}
			if !ok || len(object) != 0 {
				continue
			}
			if err = healthSet(doc, keys, nil, false); err != nil {
				return nil, err
			}
			if j.Format == "toml" {
				raw, err = healthTOMLValue(raw, keys, nil, false)
				if err != nil {
					return nil, err
				}
			}
		}
	}
	if j.Format == "toml" {
		return raw, nil
	}
	raw, err = json.MarshalIndent(doc, "", "  ")
	return append(raw, '\n'), err
}

func prepareHealthFix(options HealthOptions, f HealthFinding) (healthJournal, error) {
	raw, present, err := healthRead(f.file)
	if err != nil {
		return healthJournal{}, errors.New("The selected configuration cannot be read.")
	}
	target, reason := writeTarget(f.file)
	if reason != "" {
		return healthJournal{}, errors.New("This configuration is managed or not writable; edit it in its owning client.")
	}
	if escapes, label := healthEscapesProject(options, f.file); escapes {
		return healthJournal{}, errors.New("This project file resolves to " + label + ", outside the project. Change the setting where that file lives.")
	}
	j := healthJournal{Home: options.Home, Project: options.Project, Executable: options.Executable, FindingID: f.ID, File: f.file, Target: target, Format: f.format, Mode: f.mode, Before: raw, Present: present}
	if f.format == "text" {
		switch f.mode {
		case "skill":
			j.After = []byte(healthString(f.value))
		case "routing":
			block := healthRoutingBlock()
			start, end, found, valid := agentsBlockSpan(string(raw))
			if !valid {
				return j, errors.New("Existing routing markers need manual review.")
			}
			if found {
				j.After = []byte(string(raw[:start]) + block + string(raw[end:]))
			} else {
				j.After = append(append(bytes.Clone(raw), []byte("\n")...), []byte(block)...)
			}
		default:
			return j, errors.New("Unsupported instruction repair.")
		}
		return j, nil
	}
	doc, err := healthDecode(raw, f.format)
	if err != nil {
		return j, err
	}
	add := func(keys []string, value any) {
		before, exists := healthGet(doc, keys...)
		if exists && jsonEqual(before, value) {
			return
		}
		j.Values = append(j.Values, healthValue{Keys: keys, Before: before, BeforePresent: exists, After: value, AfterPresent: true})
	}
	switch f.mode {
	case "values":
		add(f.keys, f.value)
	case "connection":
		prefix := "mcpServers"
		if f.Client == "codex" {
			prefix = "mcp_servers"
		}
		if entry := healthMap(doc, prefix, "rndevtools"); entry["url"] != nil {
			return j, errors.New("A custom transport must be reviewed in the client.")
		}
		add([]string{prefix, "rndevtools", "command"}, options.Executable)
		add([]string{prefix, "rndevtools", "args"}, []any{"mcp"})
		if f.Client == "codex" {
			add([]string{prefix, "rndevtools", "enabled"}, true)
			if timeout, _ := healthGet(doc, prefix, "rndevtools", "tool_timeout_sec"); codexTimeoutShort(timeout) {
				add([]string{prefix, "rndevtools", "tool_timeout_sec"}, int64(codexToolTimeoutSeconds))
			}
		} else {
			add([]string{prefix, "rndevtools", "type"}, "stdio")
		}
	case "hooks":
		pre, end := hookDocument(options.Executable)
		for event, wanted := range map[string]map[string]any{"PreToolUse": pre, "SessionEnd": end} {
			existing, exists := healthGet(doc, "hooks", event)
			entries, ok := existing.([]any)
			if exists && !ok {
				return j, errors.New("An existing hook event is not an array; review it manually.")
			}
			kept, current, _ := withoutRndevtoolsHooks(entries, wanted, options.Executable)
			if !current {
				kept = append(kept, wanted)
			}
			add([]string{"hooks", event}, kept)
		}
	default:
		return j, errors.New("Unsupported configuration repair.")
	}
	j.After, err = healthWriteValues(raw, f.format, j.Values, false)
	return j, err
}

func healthRoutingBlock() string {
	// Keep all owned guidance inside the markers so upgrades replace it once.
	return strings.TrimSuffix(AgentsBlock(""), agentsBlockEnd+"\n") +
		"\nUse RN Devtools for managed local Supabase lifecycle; never stop another worktree's stack.\n" + agentsBlockEnd + "\n"
}

func healthStateDir(options HealthOptions) string {
	return filepath.Join(options.Home, "Library", "Application Support", "RN Devtools", "agent-check")
}

const (
	// healthPlanLifetime is how long a preview can be applied. A preview not
	// applied by then, because the user cancelled it or never confirmed, is
	// deleted at the next check, with its copy of the configuration.
	healthPlanLifetime = 5 * time.Minute
	// healthReceiptLimit is how many repairs a scope keeps for undo, newest
	// first: as many as the report lists and the desktop shows.
	healthReceiptLimit = 32
	// healthHistoryEntries bounds the repair-history entries one call reads.
	healthHistoryEntries = 4096
	// healthSummaryLimit bounds a repair summary file.
	healthSummaryLimit = 4096
)

// healthHistory lists the repair history: the files in it, by name, and when
// each was last written. It reads at most healthHistoryEntries entries, in
// the order the directory returns them, and complete says that was all of
// them. A listing cut short cannot show that a file is missing, so nothing is
// pruned from one.
func healthHistory(options HealthOptions) (files map[string]time.Time, complete bool) {
	directory, err := os.Open(healthStateDir(options))
	if err != nil {
		return nil, errors.Is(err, fs.ErrNotExist)
	}
	defer directory.Close()
	entries, err := directory.ReadDir(healthHistoryEntries + 1)
	complete = (err == nil || errors.Is(err, io.EOF)) && len(entries) <= healthHistoryEntries
	if len(entries) > healthHistoryEntries {
		entries = entries[:healthHistoryEntries]
	}
	files = make(map[string]time.Time, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		if info, err := entry.Info(); err == nil {
			files[entry.Name()] = info.ModTime()
		}
	}
	return files, complete
}

// healthOnDisk reports whether the history holds name now, as the directory
// says rather than a listing taken earlier; also when that cannot be told, so
// a file whose partner may exist keeps its pair.
func healthOnDisk(options HealthOptions, name string) bool {
	_, err := os.Lstat(filepath.Join(healthStateDir(options), name))
	return !errors.Is(err, fs.ErrNotExist)
}

// healthPruneExpired deletes what an expired preview left: its record, which
// holds a copy of the whole configuration file, and the temporary file of a
// write that was interrupted. A record with a summary is a repair, kept for
// undo; a record without one is a preview, or an apply that stopped before it
// changed the configuration.
func healthPruneExpired(options HealthOptions) {
	files, complete := healthHistory(options)
	if !complete {
		return
	}
	expired := time.Now().Add(-healthPlanLifetime)
	for name, modified := range files {
		if !modified.Before(expired) {
			continue
		}
		id, isRecord := strings.CutSuffix(name, ".json")
		preview := isRecord && healthID.MatchString(id) && !healthOnDisk(options, id+".summary.json")
		if preview || strings.HasPrefix(name, ".rndevtools-setup-") {
			_ = os.Remove(filepath.Join(healthStateDir(options), name))
		}
	}
}

// healthSummary is a repair's summary as healthSaveReceipt writes it: its
// scope and its receipt.
type healthSummary struct {
	Project string        `json:"project"`
	Receipt HealthReceipt `json:"receipt"`
}

// healthSummaries are the summaries among files whose record is on disk, of
// every scope.
func healthSummaries(options HealthOptions, files map[string]time.Time) []healthSummary {
	result := []healthSummary{}
	for name := range files {
		id, isSummary := strings.CutSuffix(name, ".summary.json")
		if !isSummary || !healthID.MatchString(id) || !healthOnDisk(options, id+".json") {
			continue
		}
		data, _, err := healthRead(filepath.Join(healthStateDir(options), name))
		var stored healthSummary
		if err == nil && len(data) < healthSummaryLimit && json.Unmarshal(data, &stored) == nil && stored.Receipt.ID == id {
			result = append(result, stored)
		}
	}
	return result
}

// healthScopeReceipts are the repairs of options' scope among summaries that
// undo can still reach, newest first: an undone repair cannot be undone
// again.
func healthScopeReceipts(options HealthOptions, summaries []healthSummary) []HealthReceipt {
	result := []HealthReceipt{}
	for _, stored := range summaries {
		if stored.Project == options.Project && stored.Receipt.Status != "undone" {
			result = append(result, stored.Receipt)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].AppliedAt != result[j].AppliedAt {
			return result[i].AppliedAt > result[j].AppliedAt
		}
		return result[i].ID > result[j].ID
	})
	return result
}

// healthReceipts are the scope's newest repairs, at most healthReceiptLimit.
func healthReceipts(options HealthOptions) []HealthReceipt {
	files, _ := healthHistory(options)
	result := healthScopeReceipts(options, healthSummaries(options, files))
	if len(result) > healthReceiptLimit {
		result = result[:healthReceiptLimit]
	}
	return result
}

// healthPruneReceipts deletes the repairs that undo cannot reach: those an
// earlier build kept after undoing them, in any scope, the scope's repairs
// past the newest healthReceiptLimit, which the report no longer lists, and
// summaries left without their record.
func healthPruneReceipts(options HealthOptions) {
	files, complete := healthHistory(options)
	if !complete {
		return
	}
	summaries := healthSummaries(options, files)
	for _, stored := range summaries {
		// Builds before undo deleted a repair's record marked it undone and
		// kept it, with its copies of the configuration.
		if stored.Receipt.Status == "undone" {
			healthForget(options, stored.Receipt.ID)
		}
	}
	receipts := healthScopeReceipts(options, summaries)
	for index := healthReceiptLimit; index < len(receipts); index++ {
		healthForget(options, receipts[index].ID)
	}
	for name := range files {
		if id, isSummary := strings.CutSuffix(name, ".summary.json"); isSummary && healthID.MatchString(id) && !healthOnDisk(options, id+".json") {
			_ = os.Remove(filepath.Join(healthStateDir(options), name))
		}
	}
}

// healthForget deletes a repair's record, with its copy of the original
// configuration, and then its summary.
func healthForget(options HealthOptions, id string) {
	if !healthID.MatchString(id) {
		return
	}
	_ = os.Remove(filepath.Join(healthStateDir(options), id+".json"))
	_ = os.Remove(filepath.Join(healthStateDir(options), id+".summary.json"))
}
func healthPrivateDir(options HealthOptions) (string, error) {
	dir := healthStateDir(options)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", errors.New("Cannot create private repair history.")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("Repair history must be a real private directory.")
	}
	if err = os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

var healthID = regexp.MustCompile(`^check-[a-f0-9]{32}$`)

func newHealthID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return "check-" + hex.EncodeToString(id[:]), nil
}
func healthSave(options HealthOptions, id, suffix string, value any) error {
	dir, err := healthPrivateDir(options)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeFileAtomically(filepath.Join(dir, id+suffix), raw, 0o600)
}
func healthLoad(options HealthOptions, id string) (healthJournal, error) {
	var j healthJournal
	if !healthID.MatchString(id) {
		return j, errors.New("Invalid repair identifier.")
	}
	file := filepath.Join(healthStateDir(options), id+".json")
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8*1024*1024 {
		return j, errors.New("Repair history is unavailable.")
	}
	raw, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(raw, &j) != nil || j.Home != options.Home || j.Project != options.Project || j.Executable != options.Executable || j.Plan.ID != id {
		return j, errors.New("Repair history does not match this configuration scope.")
	}
	if len(j.Values) > 0 {
		// JSON journals cannot retain TOML integer/date types in interface values.
		// Recover each setting from the saved source bytes before selective Undo.
		before, beforeErr := healthDecode(j.Before, j.Format)
		after, afterErr := healthDecode(j.After, j.Format)
		if beforeErr != nil || afterErr != nil {
			return j, errors.New("Repair history contains invalid configuration snapshots.")
		}
		for i := range j.Values {
			change := &j.Values[i]
			change.Before, change.BeforePresent = healthGet(before, change.Keys...)
			change.After, change.AfterPresent = healthGet(after, change.Keys...)
		}
	}
	return j, nil
}
func healthSaveReceipt(options HealthOptions, j healthJournal) error {
	if err := healthSave(options, j.Plan.ID, ".json", j); err != nil {
		return err
	}
	return healthSave(options, j.Plan.ID, ".summary.json", struct {
		Project string        `json:"project"`
		Receipt HealthReceipt `json:"receipt"`
	}{options.Project, j.Receipt})
}

func PlanAgentFix(options HealthOptions, findingID string) (HealthPlan, error) {
	options, err := healthOptions(options)
	if err != nil {
		return HealthPlan{}, err
	}
	report, err := CheckAgents(options)
	if err != nil {
		return HealthPlan{}, err
	}
	for _, finding := range report.Findings {
		if finding.ID != findingID || finding.FixLabel == "" {
			continue
		}
		j, err := prepareHealthFix(options, finding)
		if err != nil {
			return HealthPlan{}, err
		}
		id, err := newHealthID()
		if err != nil {
			return HealthPlan{}, err
		}
		j.Fingerprint = report.Fingerprint
		j.Plan = HealthPlan{ID: id, Client: finding.Client, Title: finding.FixLabel, Scope: finding.Scope, Source: finding.Source, Target: healthLinkTarget(options, finding.file, j.Target), Summary: finding.Detail + " The change is reversible. Reload the affected client after applying it.", ExpiresAt: time.Now().Add(healthPlanLifetime).UnixMilli()}
		if err = healthSave(options, id, ".json", j); err != nil {
			return HealthPlan{}, err
		}
		return j.Plan, nil
	}
	return HealthPlan{}, errors.New("This finding changed or has no automatic fix. Recheck agent setup.")
}

// healthLinkTarget names target, the file a repair of file writes, when a
// link makes that another file: file itself is a link, or a directory
// between the configuration home (or the selected project) and file is. A
// link above them, such as macOS's /var for /private/var or a home that is a
// link to another volume, leaves file where it is, and "" names no second
// file. Both sides of the comparison are fully resolved.
func healthLinkTarget(options HealthOptions, file, target string) string {
	written := file
	for _, base := range []string{options.Project, options.Home} {
		if base == "" || !healthInside(base, file) {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(base); err == nil {
			rel, _ := filepath.Rel(base, file)
			written = filepath.Join(resolved, rel)
		}
		break
	}
	if target == written {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(options.Home); err == nil && !healthInside(options.Home, target) && healthInside(resolved, target) && target != resolved {
		rel, _ := filepath.Rel(resolved, target)
		return "~/" + rel
	}
	return healthLabel(options.Home, target)
}

func healthWithLock(options HealthOptions, fn func() error) error {
	dir, err := healthPrivateDir(options)
	if err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "repair.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("Another repair is running. Recheck when it finishes.")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return fn()
}

func ApplyAgentFix(options HealthOptions, id string) (HealthReport, error) {
	options, err := healthOptions(options)
	if err != nil {
		return HealthReport{}, err
	}
	err = healthWithLock(options, func() error {
		j, err := healthLoad(options, id)
		if err != nil {
			return err
		}
		if j.Receipt.Status != "" || time.Now().UnixMilli() > j.Plan.ExpiresAt {
			return errors.New("This preview expired or was already applied. Recheck and preview again.")
		}
		report, err := CheckAgents(options)
		if err != nil {
			return err
		}
		if report.Fingerprint != j.Fingerprint {
			return errors.New("Agent configuration changed after the preview. Recheck before applying.")
		}
		var fresh healthJournal
		found := false
		for _, f := range report.Findings {
			if f.ID == j.FindingID && f.FixLabel != "" {
				fresh, err = prepareHealthFix(options, f)
				found = true
				break
			}
		}
		if err != nil {
			return err
		}
		if !found || fresh.Target != j.Target || !bytes.Equal(fresh.After, j.After) || fresh.Present != j.Present || !bytes.Equal(fresh.Before, j.Before) {
			return errors.New("The repair target changed. Recheck before applying.")
		}
		j.Receipt = HealthReceipt{ID: id, Client: j.Plan.Client, Title: j.Plan.Title, Scope: j.Plan.Scope, AppliedAt: time.Now().UnixMilli(), Status: "prepared"}
		if err = healthSaveReceipt(options, j); err != nil {
			return err
		}
		if err = writeFileAtomically(j.Target, j.After, 0o600); err != nil {
			return errors.New("Configuration was not written. The recovery record was kept.")
		}
		j.Receipt.Status = "applied"
		if err = healthSaveReceipt(options, j); err != nil {
			return err
		}
		healthPruneReceipts(options)
		return nil
	})
	if err != nil {
		return HealthReport{}, err
	}
	return CheckAgents(options)
}

func UndoAgentFix(options HealthOptions, id string) (HealthReport, error) {
	options, err := healthOptions(options)
	if err != nil {
		return HealthReport{}, err
	}
	err = healthWithLock(options, func() error {
		j, err := healthLoad(options, id)
		if err != nil {
			return err
		}
		if j.Receipt.Status != "applied" && j.Receipt.Status != "prepared" {
			return errors.New("This repair has already been undone or was not applied.")
		}
		target, reason := writeTarget(j.File)
		if reason != "" || target != j.Target {
			return errors.New("The configuration target changed. Undo stopped.")
		}
		current, present, err := healthRead(target)
		if err != nil {
			return errors.New("The configuration cannot be read for undo.")
		}
		if bytes.Equal(current, j.Before) && present == j.Present {
			// Undone already: the record is no longer needed.
			healthForget(options, id)
			return nil
		}
		if bytes.Equal(current, j.After) {
			if !j.Present {
				err = os.Remove(target)
			} else {
				err = writeFileAtomically(target, j.Before, 0o600)
			}
		} else if j.Format != "text" {
			var restored []byte
			restored, err = healthWriteValues(current, j.Format, j.Values, true)
			if err == nil {
				restored, err = healthPruneCreatedParents(restored, j)
			}
			if err == nil {
				err = writeFileAtomically(target, restored, 0o600)
			}
		} else {
			err = errors.New("These instructions changed after the repair. Undo stopped to preserve the newer edit.")
		}
		if err != nil {
			return err
		}
		// An undone repair cannot be undone again, so its copy of the original
		// configuration goes with it.
		healthForget(options, id)
		return nil
	})
	if err != nil {
		return HealthReport{}, err
	}
	return CheckAgents(options)
}
