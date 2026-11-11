package setup

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
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
		"the run:ios reason":  runIOSDecision().Reason,
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

func TestNoStringOfTheCLISpellsAnOperationAsAWord(t *testing.T) {
	// Every string of the CLI's sources can reach an agent: an argument
	// error, a flag's usage, an MCP tool's description, the MCP
	// instructions, a hook's reason. The desktop's agent-text test reads its
	// own sources with the same pattern.
	fileSet := token.NewFileSet()
	for _, root := range []string{"..", filepath.Join("..", "..", "cmd")} {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return err
			}
			// Comments are left out of the tree unless asked for.
			file, err := parser.ParseFile(fileSet, path, nil, 0)
			if err != nil {
				return err
			}
			ast.Inspect(file, func(node ast.Node) bool {
				literal, ok := node.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return true
				}
				text, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatalf("%s: %v", fileSet.Position(literal.Pos()), err)
				}
				if match := positionalOperation.FindString(text); match != "" {
					t.Errorf("%s spells an operation as a positional word, which the CLI rejects: %q", fileSet.Position(literal.Pos()), match)
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentTextsAgreeOnTheSimctlCommandsAndTheUDIDCaveat(t *testing.T) {
	// The texts that list the simctl commands never to run name the same
	// ones as the MCP instructions (restart replaced terminate), and the ones
	// that say to leave --udid out give the same caveat: a booted Simulator
	// nobody holds can still be in a person's hands.
	flat := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	skill, err := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		name, text string
		phrases    []string
	}{
		{"the AGENTS.md block", flat(AgentsBlock("")), []string{
			"`xcrun simctl boot`, `shutdown`, `openurl`, `install`, `launch`, `terminate`, or `io`",
			"Leave out `--udid` unless the user named a device or is using one",
		}},
		{"the routing block", flat(healthRoutingBlock()), []string{"`launch`, `terminate`, or `io`", "named a device or is using one"}},
		{"the Metro reason", flat(metroDecision().Reason), []string{"Leave out `--udid` unless the user named a device or is using one"}},
		{"the lanes skill", flat(string(skill)), []string{"xcrun simctl boot/shutdown/openurl/install/launch/terminate/io"}},
	} {
		for _, phrase := range row.phrases {
			if !strings.Contains(row.text, phrase) {
				t.Errorf("%s lacks %q", row.name, phrase)
			}
		}
	}
}

// laneCommand is a lane command a text writes out, up to the end of its code
// span, its line, or a shell comment.
var laneCommand = regexp.MustCompile("(?:rndevtools )?lane --operation (?:up|launch|down|log)\\b([^`\\n#]*)")

func TestTheSkillsGiveEveryLaneCommandTheLaneItActsOn(t *testing.T) {
	// up takes --worktree, and launch, down, and log exactly one of
	// --lane-id or --worktree: a command written out with its flags but
	// without its lane is refused as written.
	for _, name := range skillNames() {
		content, err := skillFiles.ReadFile("skills/" + name + "/SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range laneCommand.FindAllStringSubmatch(string(content), -1) {
			flags := match[1]
			if strings.Contains(flags, "--") && !strings.Contains(flags, "--lane-id") && !strings.Contains(flags, "--worktree") {
				t.Errorf("the %s skill writes %q without the lane it acts on", name, strings.TrimSpace(match[0]))
			}
		}
	}
}

// nativeCommand is a native command a text tells an agent to run, up to the
// end of its code span or its line.
var nativeCommand = regexp.MustCompile("rndevtools native --operation (plan|install)\\b([^`\\n]*)")

func TestAgentTextsGiveEveryNativeCommandWhatItNeeds(t *testing.T) {
	// native refuses a command without an absolute worktreePath ("native
	// requires an absolute worktreePath"), and install one without its udid,
	// so each native command an agent is told to run names them.
	for name, text := range agentTexts(t) {
		for _, match := range nativeCommand.FindAllStringSubmatch(text, -1) {
			flags := match[2]
			if !strings.Contains(flags, "--worktree") || (match[1] == "install" && !strings.Contains(flags, "--udid")) {
				t.Errorf("%s writes %q without what native needs", name, strings.TrimSpace(match[0]))
			}
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

func TestTheLanesSkillGivesTheBuildAsNativePlanDoes(t *testing.T) {
	// native plan's build is two steps once the lane's Metro is ready: an
	// expo run:ios that names no port, since Expo CLI refuses --port with
	// --no-bundler and opens the app against 8081, then a lane launch with
	// restart that reopens it with the lane's Metro.
	content, err := skillFiles.ReadFile("skills/rndevtools-lanes/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	flat := strings.Join(strings.Fields(string(content)), " ")
	for _, phrase := range []string{
		"`npx expo run:ios --device <UDID> --no-bundler`",
		"Expo CLI refuses `--port` with `--no-bundler`",
		"`rndevtools lane --operation launch --lane-id <laneId> --restart`",
		"only once the lane's Metro is ready",
	} {
		if !strings.Contains(flat, phrase) {
			t.Errorf("the lanes skill lacks %q", phrase)
		}
	}
	for _, stale := range []string{"lane port", "--port <", "keep its --port", "keep the exact"} {
		if strings.Contains(flat, stale) {
			t.Errorf("the lanes skill still says %q", stale)
		}
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
		// Which launch restarts the app unasked: a lane's first dev-client
		// launch, whichever command opens it, as far as app.json and the
		// Simulator let it; a deep link leaves it to the launch after.
		"A lane does this on its first dev-client launch without the flag",
		"from whichever of `up` or `launch` opens it",
		"started with `--launch=false`",
		"`ios.bundleIdentifier`",
		"the result's `warnings`",
		"without `--restart` never terminates the app",
		"leaves that first restart to the dev-client launch after it",
		// A lane keeps the scheme it started with, and up takes no URL.
		"`rndevtools lane --operation launch --lane-id <laneId> --url <full launch URL>`",
		"`lane --operation up` takes no URL",
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
	// A lane started with --launch=false restarts the app at its first
	// dev-client launch too, so no relaunch is "without terminating" as such.
	for _, stale := range []string{"new lane's first launch", "A new lane does this", "relaunches without terminating the app"} {
		if strings.Contains(flat, stale) {
			t.Errorf("the lanes skill still says %q", stale)
		}
	}
}
