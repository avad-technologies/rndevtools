package setup

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// positionalOperation is an rndevtools operation written as a positional
// word (`lane up`, `native plan`). The CLI rejects those with "unexpected
// positional arguments": an operation is always the --operation flag.
var positionalOperation = regexp.MustCompile(`\b(?:lane\s+(?:up|down|ls|launch|log)|native\s+(?:plan|install)|simulator\s+(?:boot|shutdown)|supabase\s+(?:up|down))\b`)

// agentTexts are the texts setup and the hook hand to agents: the AGENTS.md
// block, the routing block agent-check writes into a client's instructions,
// every embedded skill, and every reason the hook gives.
func agentTexts(t *testing.T) map[string]string {
	t.Helper()
	project := t.TempDir()
	write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	texts := map[string]string{
		"the AGENTS.md block": AgentsBlock(project),
		"the routing block":   healthRoutingBlock(),
		"the Metro reason":    metroDecision().Reason,
	}
	for verb, replacement := range steeredVerbs {
		texts["the simctl "+verb+" reason"] = simctlDecision(verb, replacement).Reason
	}
	for _, name := range skillNames() {
		content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		texts["the "+name+" skill"] = string(content)
	}
	return texts
}

func TestAgentTextsSpellOperationsAsTheCLIParsesThem(t *testing.T) {
	for name, text := range agentTexts(t) {
		if match := positionalOperation.FindString(text); match != "" {
			t.Errorf("%s spells an operation as a positional word, which the CLI rejects: %q", name, match)
		}
	}
}

func TestAgentsBlockGivesTheLaneCommandsAsTheCLIParsesThem(t *testing.T) {
	flat := strings.Join(strings.Fields(AgentsBlock("")), " ")
	for _, phrase := range []string{
		"`rndevtools lane --operation up --worktree <app directory>`",
		"`rndevtools lane --operation launch --worktree <app directory> --restart`",
		// RN Devtools picks the device unless the user named one.
		"Leave out `--udid` unless the user named a device",
		// Expo CLI's default command is start.
		"`npx expo`",
		"`expo run:ios` without `--no-bundler`",
	} {
		if !strings.Contains(flat, phrase) {
			t.Errorf("the AGENTS.md block lacks %q:\n%s", phrase, flat)
		}
	}
	if strings.Contains(flat, "Always pass `--udid`") {
		t.Error("the AGENTS.md block must not tell agents to always pass --udid")
	}
}

func TestTheLanesSkillDocumentsRestartAndTheDeviceChoice(t *testing.T) {
	content, err := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	flat := strings.Join(strings.Fields(string(content)), " ")
	for _, phrase := range []string{
		// The restart contract: lane up resuming a lane, and lane launch.
		`rndevtools lane --operation up --worktree "$PWD" --restart`,
		`rndevtools lane --operation launch --worktree "$PWD" --restart`,
		"A new lane does this on its first launch without the flag",
		"without `--restart` never terminates the app",
		"Terminating an app that is not running counts as success",
		// The device choice stays with RN Devtools unless the user named one.
		"Leave `--udid` out unless the user named a device",
		"a booted Simulator nobody holds can still be one a person is using",
		// Recovering a held Simulator is not ending the lane.
		"rndevtools simulator --operation shutdown --udid <UDID>",
	} {
		if !strings.Contains(flat, phrase) {
			t.Errorf("the lanes skill lacks %q", phrase)
		}
	}
	if strings.Contains(flat, "Always pass `--udid`") {
		t.Error("the lanes skill must not tell agents to always pass --udid")
	}
}
