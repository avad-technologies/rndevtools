package setup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const codexRulesHeader = "# Managed by RN Devtools. Put custom rules in a separate file.\n"

func codexRulesPath(home string) string {
	return filepath.Join(home, ".codex", "rules", "rndevtools.rules")
}

func codexRulesContent() string {
	var rules strings.Builder
	rules.WriteString(codexRulesHeader)
	writeRule := func(pattern, guidance string) {
		fmt.Fprintf(&rules, "\nprefix_rule(\n    pattern = %s,\n    decision = \"forbidden\",\n    justification = %s,\n)\n",
			pattern, strconv.Quote(guidance))
	}
	verbs := make([]string, 0, len(steeredVerbs))
	for verb := range steeredVerbs {
		verbs = append(verbs, strconv.Quote(verb))
	}
	sort.Strings(verbs)
	actions := "[" + strings.Join(verbs, ", ") + "]"
	const simulator = "Use RN Devtools for Simulator control. Start a lane with rndevtools lane --operation up --worktree <app directory>."
	writeRule("[[\"xcrun\", \"/usr/bin/xcrun\"], \"simctl\", "+actions+"]", simulator)
	writeRule("[\"simctl\", "+actions+"]", simulator)
	const metro = "Use rndevtools lane --operation up --worktree <app directory> to start Metro on a leased port."
	const program = "[\"expo\", \"react-native\"], \"start\""
	for _, prefix := range []string{
		"", "[\"npx\", \"bunx\", \"yarn\", \"pnpm\", \"bun\"], ",
		"\"npx\", \"--no-install\", ", "[\"pnpm\", \"npm\", \"yarn\", \"bun\"], \"exec\", ",
		"\"npm\", \"exec\", \"--\", ",
	} {
		writeRule("["+prefix+program+"]", metro)
	}
	return rules.String()
}

func installCodexRules(home string, write bool) (Change, error) {
	file := codexRulesPath(home)
	change := Change{Path: file, Action: "create", Detail: "install Codex rules for direct Simulator mutations and Metro starts"}
	data, present, err := healthRead(file)
	if err != nil {
		change.Action, change.Detail = "skip", "the existing rules file could not be read"
		return change, nil
	}
	wanted := codexRulesContent()
	if present {
		if string(data) == wanted {
			change.Action, change.Detail = "unchanged", "RN Devtools command rules already current"
			return change, nil
		}
		if !strings.HasPrefix(string(data), codexRulesHeader) {
			change.Action, change.Detail = "skip", "this rules file is not managed by RN Devtools"
			return change, nil
		}
		change.Action = "update"
	}
	return commit(change, file, []byte(wanted), 0o600, write)
}

// removeCodexHooks is an explicit opt-out for users migrating an existing
// setup. It keeps other tools' hooks, including ones in a shared entry.
func removeCodexHooks(home, executable string, write bool) (Change, error) {
	file := filepath.Join(home, ".codex", "hooks.json")
	change := Change{Path: file, Action: "unchanged", Detail: "no RN Devtools hooks to remove"}
	raw, present, err := healthRead(file)
	if err != nil {
		return change, err
	}
	if !present {
		return change, nil
	}
	doc, err := healthDecode(raw, "json")
	if err != nil {
		return change, err
	}
	hooks, ok := doc["hooks"].(map[string]any)
	if !ok {
		if _, exists := doc["hooks"]; exists {
			return change, errors.New("Codex hooks is not an object")
		}
		return change, nil
	}
	for _, event := range []string{"PreToolUse", "SessionEnd"} {
		value, exists := hooks[event]
		if !exists {
			continue
		}
		entries, ok := value.([]any)
		if !ok {
			return change, errors.New("an existing Codex hook event is not an array")
		}
		kept, _, removed := withoutRndevtoolsHooks(entries, nil, executable)
		if removed {
			change.Action, change.Detail = "update", "remove RN Devtools hooks and keep other Codex hooks"
			if len(kept) == 0 {
				delete(hooks, event)
			} else {
				hooks[event] = kept
			}
		}
	}
	if change.Action == "unchanged" {
		return change, nil
	}
	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return change, err
	}
	info, err := os.Stat(file)
	if err != nil {
		return change, err
	}
	return commit(change, file, append(encoded, '\n'), info.Mode().Perm(), write)
}
