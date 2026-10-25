package setup

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
)

// EvaluateShellCommand applies the steering rules to one shell command line.
func EvaluateShellCommand(command string) HookDecision {
	return evaluateShellCall(shellCall{command: command})
}

func TestHookBlocksMutatingSimctlAndHandStartedMetro(t *testing.T) {
	for command, want := range map[string]string{
		"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44": "lane",
		"simctl shutdown all":                           "down",
		"cd app && xcrun simctl openurl booted exp://x": "launch",
		"xcrun simctl install booted ./build/App.app":   "native",
		"xcrun simctl io booted screenshot /tmp/a.png":  "capture",
		"npx expo start --port 8081":                    "lane",
		"yarn react-native start":                       "lane",
		"pnpm exec expo start":                          "lane",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block {
			t.Fatalf("%q should be blocked", command)
		}
		if !strings.Contains(decision.Reason, want) {
			t.Fatalf("%q reason %q lacks %q", command, decision.Reason, want)
		}
	}
}

func TestSimctlVerbReadsTheGlobalOptionsBeforeTheSubcommand(t *testing.T) {
	// simctl takes --set and --profiles, each with a path, before its
	// subcommand. It is read past a few options, not past thousands: a line
	// can chain simctl words that each take the next one as a value.
	seven := strings.Fields("-a -b -c -d -e -f -g")
	for _, row := range []struct {
		arguments []string
		want      string
	}{
		{nil, ""},
		{[]string{"boot", "X"}, "boot"},
		{[]string{"--set", "/devices", "boot", "X"}, "boot"},
		{[]string{"--set", "/devices", "--profiles", "/p", "shutdown", "all"}, "shutdown"},
		{[]string{"-v", "--set", "a", "--profiles", "b", "erase"}, "erase"},
		{[]string{"--set"}, ""},
		{[]string{"--set", "boot"}, ""},
		{append(append([]string{}, seven...), "boot"), "boot"},
		{append(append([]string{}, seven...), "-h", "boot"), ""},
	} {
		if got := simctlVerb(row.arguments); got != row.want {
			t.Errorf("simctlVerb(%q) = %q, want %q", row.arguments, got, row.want)
		}
	}
	wantBlocked(t, map[string]string{
		"xcrun simctl --set /tmp/devices boot X":                     "simctl boot",
		"xcrun simctl --set /tmp/devices --profiles /p shutdown all": "simctl shutdown",
		"simctl --set simctl --set simctl boot X":                    "simctl boot",
	})
}

func TestHookAllowsReadOnlyAndUnrelatedCommands(t *testing.T) {
	for _, command := range []string{
		"xcrun simctl list devices -j",
		"xcrun simctl list devicetypes",
		"xcrun simctl getenv booted HOME",
		"xcrun simctl help",
		"git status && pnpm test",
		"rndevtools lane --operation up --worktree /w --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44",
		"rndevtools input --kind button --button home --udid X",
		"echo 'simctl boot is what we avoid'",
		"xcrun xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookJudgesEachCommandOfALineOnItsOwn(t *testing.T) {
	// An rndevtools command anywhere in the line used to exempt all of it.
	for command, want := range map[string]string{
		"rndevtools doctor; expo start":                                   "Metro",
		"rndevtools doctor && npx expo start --port 8081":                 "Metro",
		"rndevtools lane --operation ls || yarn react-native start":       "Metro",
		"rndevtools doctor & pnpm exec expo start":                        "Metro",
		"rndevtools doctor | expo start":                                  "Metro",
		"rndevtools doctor\nexpo start":                                   "Metro",
		"(rndevtools doctor; expo start)":                                 "Metro",
		"if rndevtools doctor; then npx expo start; fi":                   "Metro",
		"cd ~/src/rndevtools/examples/app && npx expo start":              "Metro",
		"RNDEVTOOLS_AGENT_SESSION_ID=s1 rndevtools doctor; expo start":    "Metro",
		"rndevtools claim --udid X --note `expo start`":                   "Metro",
		"rndevtools doctor; xcrun simctl shutdown all":                    "simctl shutdown",
		`rndevtools claim --udid X --note "$(xcrun simctl boot booted)"`:  "simctl boot",
		"rndevtools claim --udid X --note $(xcrun simctl io booted list)": "simctl io",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block {
			t.Fatalf("%q should be blocked", command)
		}
		if !strings.Contains(decision.Reason, want) {
			t.Fatalf("%q reason %q lacks %q", command, decision.Reason, want)
		}
	}
}

func TestHookReadsCommitMessagesAsTextNotCommands(t *testing.T) {
	for _, command := range []string{
		"git commit -m \"$(cat <<'EOF'\nfix(cli): stop agents running xcrun simctl boot and expo start by hand\nEOF\n)\"",
		"cat > notes.md <<'EOF'\nxcrun simctl shutdown all\nnpx expo start\nEOF",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
	if !EvaluateShellCommand("cat > notes.md <<'EOF'\nnotes\nEOF\nxcrun simctl shutdown all").Block {
		t.Fatal("a command after the here-document is still judged")
	}
}

func TestHookExemptsOnlyTheCommandThatRunsRndevtools(t *testing.T) {
	for _, command := range []string{
		`rndevtools claim --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44 --note "expo start hung; restart it"`,
		`~/.local/bin/rndevtools claim --udid X --note 'then xcrun simctl boot it'`,
		`'/Applications/RN Devtools.app/Contents/Resources/native/rndevtools' lane --operation launch --worktree /w --url "expo start"`,
		`rndevtools lane --operation log --lane-id lane-1 | grep 'expo start'`,
		`rndevtools doctor && git status`,
		"git status # expo start comes later",
		// The text rule leaves the command that runs rndevtools alone even
		// when the line has commands the excuse would not cover.
		`rndevtools claim --udid X --note 'npx expo start hung' && pnpm test`,
		`pnpm test && ~/.local/bin/rndevtools claim --udid X --note 'xcrun simctl boot it'`,
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Fatalf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookReadsQuotedMentionsAsTextAndFindsTheCommandsThatRun(t *testing.T) {
	// Searching for, or writing about, these commands runs none of them: a
	// quoted string is one word, and every command on these lines looks as if
	// it only reads or prints text (see
	// TestHookExcusesMentionsThatNothingOnTheLineCanRun).
	for _, command := range []string{
		"grep -rn 'xcrun simctl boot' apps/desktop",
		`rg "xcrun simctl boot" .`,
		`git commit -m "docs: never run xcrun simctl boot by hand"`,
		`git commit -m "fix: npx expo start crashes on launch"`,
		`gh pr create --title "Stop agents calling simctl install"`,
		`echo "Run npx expo start to begin"`,
		`git log -S 'xcrun simctl boot'`,
		`grep "simctl boot|simctl shutdown" device.log`,
		"xcrun simctl list devices | grep Booted",
		"npx expo install expo-camera",
		"xcrun -f simctl",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Errorf("%q should pass, got %q", command, decision.Reason)
		}
	}
	// The commands themselves are caught however they are launched.
	for command, want := range map[string]string{
		"xcrun simctl --set /tmp/devices boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44": "simctl boot",
		"xcrun simctl --profiles /tmp/profiles boot 727CE7B2":                       "simctl boot",
		"xcrun --sdk iphonesimulator simctl boot 727CE7B2":                          "simctl boot",
		"/Applications/Xcode.app/Contents/Developer/usr/bin/simctl shutdown all":    "simctl shutdown",
		"xcrun simctl list devices | grep Booted | xargs xcrun simctl shutdown":     "simctl shutdown",
		"timeout 30 xcrun simctl boot 727CE7B2":                                     "simctl boot",
		`bash -c "xcrun simctl boot 727CE7B2"`:                                      "simctl boot",
		"bash -lc 'simctl boot 727CE7B2'":                                           "simctl boot",
		"eval xcrun simctl shutdown all":                                            "simctl shutdown",
		"sh -c 'npx expo start'":                                                    "Metro",
		"nohup npx expo start > metro.log 2>&1 &":                                   "Metro",
		"./node_modules/.bin/expo start":                                            "Metro",
		"npx expo@latest start --port 8082":                                         "Metro",
		"pnpm -C apps/mobile exec expo start":                                       "Metro",
		"sudo -E npx react-native start":                                            "Metro",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", command, want, decision)
		}
	}
}

func TestHookFollowsScriptsHandedToAShellHoweverTheShellRuns(t *testing.T) {
	// A script is one quoted word, so it is judged as the script a shell runs:
	// behind a command that runs the shell, from a here-string, from what echo
	// or printf pipes into it, or from a file the line writes and then runs.
	for command, want := range map[string]string{
		"timeout 120 sh -c 'cd apps/mobile && npx expo start'":                                  "Metro",
		"gtimeout 120 bash -lc 'npx expo start'":                                                "Metro",
		`timeout 60 bash -c "xcrun simctl boot 727CE7B2"`:                                       "simctl boot",
		"timeout 120 /bin/sh -c 'npx expo start'":                                               "Metro",
		"xcrun simctl list devices | grep Booted | xargs -I{} sh -c 'xcrun simctl shutdown {}'": "simctl shutdown",
		`find . -name '*.app' -exec sh -c 'xcrun simctl install booted "$1"' sh {} \;`:          "simctl install",
		"nice -n 10 sh -c 'npx expo start'":                                                     "Metro",
		"caffeinate -i bash -c 'cd apps/mobile && npx expo start'":                              "Metro",
		"sudo -u me bash -c 'xcrun simctl shutdown all'":                                        "simctl shutdown",
		"env -u FOO bash -c 'npx expo start'":                                                   "Metro",
		"/usr/bin/env bash -c 'npx expo start'":                                                 "Metro",
		"script -q /dev/null bash -c 'npx expo start'":                                          "Metro",
		"stdbuf -oL sh -c 'npx expo start'":                                                     "Metro",
		"arch -arm64 bash -c 'npx expo start'":                                                  "Metro",
		"bash -c -e 'xcrun simctl boot 727CE7B2'":                                               "simctl boot",
		`bash -c "timeout 60 sh -c 'npx expo start'"`:                                           "Metro",
		"bash <<< 'xcrun simctl boot 727CE7B2'":                                                 "simctl boot",
		"sh <<<'npx expo start'":                                                                "Metro",
		"bash -s <<< 'xcrun simctl shutdown all'":                                               "simctl shutdown",
		"nohup bash <<< 'npx expo start' > metro.log 2>&1 &":                                    "Metro",
		"echo 'xcrun simctl boot 727CE7B2' | sh":                                                "simctl boot",
		`echo -e 'cd apps/mobile\nnpx expo start' | bash`:                                       "Metro",
		`printf 'npx expo start\n' | sudo sh`:                                                   "Metro",
		// Text piped into a shell that another command runs.
		"echo 'xcrun simctl shutdown all' | sudo -u me sh":         "simctl shutdown",
		"echo 'npx expo start' | sudo --user me bash":              "Metro",
		"echo 'npx expo start' | sudo -nu me sh -s":                "Metro",
		"echo 'npx expo start' | timeout 60 sh":                    "Metro",
		"echo 'npx expo start' | gtimeout -s KILL 60 bash":         "Metro",
		"echo 'npx expo start' | timeout --kill-after=5 1m sh":     "Metro",
		"echo 'npx expo start' | nice -n 5 bash":                   "Metro",
		"echo 'npx expo start' | nice -5 nohup bash":               "Metro",
		"echo 'npx expo start' | env -u FOO bash":                  "Metro",
		"echo 'npx expo start' | /usr/bin/env bash":                "Metro",
		"echo 'npx expo start' | caffeinate -i bash":               "Metro",
		"echo 'npx expo start' | stdbuf -oL bash":                  "Metro",
		"echo 'npx expo start' | arch -arch arm64 bash":            "Metro",
		"echo 'npx expo start' | script -q /dev/null bash":         "Metro",
		"echo 'npx expo start' | sandbox-exec -n no-network bash":  "Metro",
		"printf 'xcrun simctl boot 727CE7B2\n' | timeout 10 sh":    "simctl boot",
		"echo 'npx expo start' | tee -a metro.log | bash":          "Metro",
		"echo 'npx expo start' | cat | sh":                         "Metro",
		"{ echo 'cd apps/mobile'; echo 'npx expo start'; } | bash": "Metro",
		"(echo 'cd apps/mobile'; echo 'npx expo start') | bash":    "Metro",
		"( echo 'xcrun simctl boot 727CE7B2' ) |& sudo -u me sh":   "simctl boot",
		"(echo 'npx expo start') | (bash)":                         "Metro",
		"echo 'npx expo start' | fish":                             "Metro",
		// A script file the line writes and then runs.
		"echo 'npx expo start' > start.sh && bash start.sh":                                 "Metro",
		"printf 'npx expo start\n' > run.sh && chmod +x run.sh && ./run.sh":                 "Metro",
		"echo '#!/bin/sh' > s.sh; echo 'xcrun simctl boot 727CE7B2' >> s.sh; sh s.sh":       "simctl boot",
		"echo 'npx expo start' | tee start.sh; bash ./start.sh":                             "Metro",
		"echo 'npx expo start' > start.sh; source start.sh":                                 "Metro",
		"cat > /tmp/metro.sh <<'EOF'\ncd apps/mobile\nnpx expo start\nEOF\n. /tmp/metro.sh": "Metro",
		// A here-string written against the shell's name, or read by a shell
		// that another command runs.
		"bash<<<'npx expo start'":                         "Metro",
		`sh<<<"xcrun simctl boot 727CE7B2"`:               "simctl boot",
		"bash -s<<<'npx expo start'":                      "Metro",
		"bash 0<<<'npx expo start'":                       "Metro",
		"timeout 60 bash <<< 'npx expo start'":            "Metro",
		"sudo -u me bash <<< 'xcrun simctl shutdown all'": "simctl shutdown",
		"nice -n5 sh <<< 'npx expo start'":                "Metro",
		"cat <<< 'npx expo start' | bash":                 "Metro",
		`bash <<< $'cd apps/mobile\nnpx expo start'`:      "Metro",
		// What xargs builds a shell's -c string from.
		"echo 'npx expo start' | xargs -I{} sh -c '{}'":   "Metro",
		"echo 'npx expo start' | xargs -I % bash -c %":    "Metro",
		"echo 'npx expo start' | xargs -0 bash -c":        "Metro",
		`printf 'npx expo start\n' | xargs -d '\n' sh -c`: "Metro",
		"xargs -I{} sh -c '{}' <<< 'xcrun simctl boot X'": "simctl boot",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", command, want, decision)
		}
	}
	// A shell that runs a file, and a word that only names a shell, run
	// nothing the hook can see. Lines that name a steered command in text
	// pass only when nothing on them can run it (see
	// TestHookExcusesMentionsThatNothingOnTheLineCanRun); the rest keep the
	// text in a here-document, which the text rule does not read, so that
	// only the word rules judge them.
	for _, command := range []string{
		"timeout 60 bash scripts/start.sh",
		"bash < scripts/start.sh",
		"sh -c 'xcrun simctl list devices'",
		"xargs -I{} sh -c 'echo {}'",
		"echo 'npx expo start' | grep sh",
		"grep -c bash notes.md",
		`git commit -m "fix: run bash -c 'npx expo start' through a lane"`,
		// Standard input is the shell's only when the shell is the command.
		"grep sh <<< 'npx expo start'",
		"grep -c bash <<< 'xcrun simctl boot 727CE7B2'",
		"nice -n 5 grep sh <<< 'npx expo start'",
		"echo 'npx expo start' | sudo -u me grep sh",
		"echo 'npx expo start' | timeout 5 cat",
		"echo 'npx expo start' | command -v bash",
		"cat <<'EOF' | sudo -u me tee notes.md\nnpx expo start\nEOF",
		"cat <<'EOF' | sudo -l bash\nnpx expo start\nEOF",
		"tee notes.md <<'EOF'\nnpx expo start\nEOF",
		// A shell whose input is something else.
		"cat <<'EOF' | bash scripts/run.sh\nnpx expo start\nEOF",
		"cat <<'EOF' | bash -c 'cat'\nnpx expo start\nEOF",
		"cat <<'EOF' | bash < /dev/null\nnpx expo start\nEOF",
		"cat <<'EOF' > notes.md | bash\nnpx expo start\nEOF",
		"{ cat <<'EOF' > notes.md; echo 'echo hi'; } | bash\nnpx expo start\nEOF",
		"(cat <<'EOF') > notes.md | sh\nnpx expo start\nEOF",
		"(cat <<'EOF') || sh\nnpx expo start\nEOF",
		"cat install.sh | bash",
		"xargs -I{} echo {} <<'EOF'\nnpx expo start\nEOF",
		"cat <<'EOF' | xargs -0 echo\nnpx expo start\nEOF",
		// Without -0 or -d xargs splits its input at blanks: sh -c npx expo start.
		"cat <<'EOF' | xargs sh -c\nnpx expo start\nEOF",
		// A script file written and not run, run but not written by the line,
		// or written over before it runs.
		"echo 'npx expo start' > notes.md && cat notes.md",
		"cat > start.sh <<'EOF'\nnpx expo start\nEOF\nbash other.sh",
		"cat > start.sh <<'EOF'\nnpx expo start\nEOF\ncat > start.sh <<'EOF'\necho hi\nEOF\nsh start.sh",
		"bash start.sh",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Errorf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookFollowsHereDocumentsAShellReads(t *testing.T) {
	// A here-document is input: a shell runs it, and anything else reads it
	// as text.
	for command, want := range map[string]string{
		"bash <<'EOF'\nnpx expo start\nEOF":                                      "Metro",
		"bash<<'EOF'\ncd apps/mobile\nnpx expo start\nEOF":                       "Metro",
		"bash -s <<EOF\nxcrun simctl boot 727CE7B2\nEOF":                         "simctl boot",
		"sh <<-EOF\n\tnpx expo start\n\tEOF":                                     "Metro",
		"sudo -u me bash <<'EOF'\nnpx expo start\nEOF":                           "Metro",
		"timeout 60 bash <<'EOF'\nbash -c 'npx expo start'\nEOF":                 "Metro",
		"bash <<'A' <<'B'\nignored\nA\nnpx expo start\nB":                        "Metro",
		"cat <<'EOF' | bash\nnpx expo start\nEOF":                                "Metro",
		"cat <<'EOF' | sudo -u me sh; echo done\nxcrun simctl shutdown all\nEOF": "simctl shutdown",
		"{ cat <<'EOF'; } | bash\nnpx expo start\nEOF":                           "Metro",
		"bash -c \"$(cat <<'EOF'\nnpx expo start\nEOF\n)\"":                      "Metro",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", command, want, decision)
		}
	}
	for _, command := range []string{
		"cat > start.sh <<'EOF'\nnpx expo start\nEOF",
		"cat <<'EOF' | grep sh\nnpx expo start\nEOF",
		"cat <<'EOF' | tee notes.md\nnpx expo start\nEOF",
		"grep -c bash <<'EOF'\nnpx expo start\nEOF",
		"git commit -F - <<'EOF'\nfix: npx expo start\nEOF",
		"sudo -u me tee notes.md <<'EOF'\nnpx expo start\nEOF",
		"bash <<'EOF'\necho 'npx expo start'\nEOF",
		"bash <<'EOF'\ngit commit -m \"fix: npx expo start crash\"\nEOF",
		"bash <<'EOF'\ncat > notes.md <<'INNER'\nnpx expo start\nINNER\nEOF",
		"bash scripts/run.sh <<'EOF'\nnpx expo start\nEOF",
		"sh -c 'cat >> notes.md' <<EOF\nxcrun simctl boot 727CE7B2\nEOF",
		"cat <<'A' | bash <<'B'\nnpx expo start\nA\necho hi\nB",
		"cat <<'EOF' > a.md; cat <<'EOF2' | bash\nnpx expo start\nEOF\necho hi\nEOF2",
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Errorf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookFollowsCommandStringsThatOtherToolsRun(t *testing.T) {
	for command, want := range map[string]string{
		// More shells, eval behind builtin, and a shell fed what a lone
		// $(echo …) prints.
		"fish -c 'npx expo start'":                    "Metro",
		"fish --command='npx expo start'":             "Metro",
		"csh -c 'xcrun simctl boot 727CE7B2'":         "simctl boot",
		"tcsh -c 'npx expo start'":                    "Metro",
		"mksh -c 'npx expo start'":                    "Metro",
		"builtin eval 'npx expo start'":               "Metro",
		`bash -c "$(echo 'npx expo start')"`:          "Metro",
		`eval "$(echo 'xcrun simctl boot 727CE7B2')"`: "simctl boot",
		"sh -c \"`echo 'npx expo start'`\"":           "Metro",
		`bash <<<"$(printf 'npx expo start')"`:        "Metro",
		"$(echo 'npx expo start')":                    "Metro",
		// Launchers and package runners with a command string of their own.
		`env -S 'bash -c "npx expo start"'`:            "Metro",
		"env -S'npx expo start'":                       "Metro",
		"script -q -c 'npx expo start' /dev/null":      "Metro",
		"npx -c 'expo start'":                          "Metro",
		"npm exec --call='npx expo start'":             "Metro",
		"npm exec -c 'expo start'":                     "Metro",
		"pnpm exec --shell-mode 'expo start'":          "Metro",
		"yarn exec 'cd apps/mobile && npx expo start'": "Metro",
		"bun exec 'npx expo start'":                    "Metro",
		// Tools that run their own string arguments.
		"npx concurrently 'npx expo start' 'npm run api'":                                                                  "Metro",
		`concurrently -n metro,api "cd apps/mobile && npx expo start" "npm run api"`:                                       "Metro",
		"pnpm exec concurrently 'npx expo start'":                                                                          "Metro",
		"yarn concurrently 'npx expo start'":                                                                               "Metro",
		"./node_modules/.bin/concurrently 'npx expo start'":                                                                "Metro",
		"tmux new-session -d -s metro 'npx expo start'":                                                                    "Metro",
		"tmux send-keys -t metro 'npx expo start' Enter":                                                                   "Metro",
		"tmux new-window 'xcrun simctl boot 727CE7B2'":                                                                     "simctl boot",
		"watch -n 5 'xcrun simctl io booted screenshot /tmp/a.png'":                                                        "simctl io",
		"nodemon --exec 'npx expo start'":                                                                                  "Metro",
		"npx nodemon -x 'npx expo start'":                                                                                  "Metro",
		"watchexec -r 'npx expo start'":                                                                                    "Metro",
		"ls | entr -r -s 'npx expo start'":                                                                                 "Metro",
		"parallel 'xcrun simctl shutdown {}' ::: A B":                                                                      "simctl shutdown",
		"su - me -c 'xcrun simctl boot 727CE7B2'":                                                                          "simctl boot",
		`osascript -e 'tell application "Terminal" to do script "cd /w && npx expo start"'`:                                "Metro",
		`osascript -e 'do shell script "xcrun simctl boot 727CE7B2"'`:                                                      "simctl boot",
		`osascript -e 'tell application "iTerm" to tell current session of current window to write text "npx expo start"'`: "Metro",
		"osascript <<'EOF'\ntell application \"Terminal\"\n  do script \"cd /w && npx expo start\"\nend tell\nEOF":         "Metro",
	} {
		decision := EvaluateShellCommand(command)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", command, want, decision)
		}
	}
	for _, command := range []string{
		"npx concurrently 'npm run api' 'npm run web'",
		"tmux new -d -s logs 'tail -f metro.log'",
		"tmux display-message 'build finished'",
		"watch -n 2 'xcrun simctl list devices'",
		"su -c 'whoami'",
		"npx -c 'echo hi'",
		"env -S 'node build.js'",
		"script -q /dev/null git status",
		// Text for a tool that only shows it, in a here-document the text
		// rule does not read.
		"osascript <<'EOF'\ndisplay notification \"npx expo start finished\"\nEOF",
		"osascript <<'EOF'\ndisplay dialog \"Run npx expo start?\"\nEOF",
		"jq '.scripts.start = \"expo start\"' package.json",
		"node <<'EOF'\nconsole.log('npx expo start')\nEOF",
		`bash -c 'echo "$(echo npx)"'`,
	} {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Errorf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookReadsThePayloadCwd(t *testing.T) {
	payload := `{"session_id":"s","cwd":"/Users/dev/app","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rndevtools doctor; expo start"}}`
	call, ok := readPreToolUse(strings.NewReader(payload))
	if !ok || call.cwd != "/Users/dev/app" || call.command != "rndevtools doctor; expo start" {
		t.Fatalf("call %+v ok %v", call, ok)
	}
	if !EvaluateClaudePreToolUse(strings.NewReader(payload)).Block {
		t.Fatal("the payload's command must still be judged segment by segment")
	}
	if _, ok := readPreToolUse(strings.NewReader(`{"tool_name":"Read","cwd":"/w","tool_input":{"file_path":"/w/a"}}`)); ok {
		t.Fatal("only Bash calls are judged")
	}
}

func TestHookReadsClaudePayloadAndFailsOpen(t *testing.T) {
	blocked := EvaluateClaudePreToolUse(strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"xcrun simctl boot 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44"}}`))
	if !blocked.Block {
		t.Fatal("Bash simctl boot must be blocked")
	}
	for _, payload := range []string{
		`{"tool_name":"Read","tool_input":{"file_path":"/tmp/simctl boot"}}`,
		`not json at all`,
		``,
	} {
		if decision := EvaluateClaudePreToolUse(strings.NewReader(payload)); decision.Block {
			t.Fatalf("%q must fail open", payload)
		}
	}
}

func TestReadSessionEnd(t *testing.T) {
	payload := ReadSessionEnd(strings.NewReader(`{"session_id":"thr_123","transcript_path":"/x","cwd":"/w","hook_event_name":"SessionEnd","reason":"other"}`))
	if payload.SessionID != "thr_123" || payload.Cwd != "/w" {
		t.Fatalf("payload %+v", payload)
	}
	if ReadSessionEnd(strings.NewReader("garbage")).SessionID != "" {
		t.Fatal("unparseable input must yield an empty session id")
	}
}

// MARK: - The text rule and its excuse

// wantBlocked checks that each command is declined with its wanted phrase in
// the reason.
func wantBlocked(t *testing.T, commands map[string]string) {
	t.Helper()
	for command, want := range commands {
		decision := EvaluateShellCommand(command)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", command, want, decision)
		}
	}
}

// wantPassing checks that each command runs.
func wantPassing(t *testing.T, commands []string) {
	t.Helper()
	for _, command := range commands {
		if decision := EvaluateShellCommand(command); decision.Block {
			t.Errorf("%q should pass, got %q", command, decision.Reason)
		}
	}
}

func TestHookDeclinesEveryLineTheFirstVersionDeclined(t *testing.T) {
	// The first version matched the steered commands in each command's text.
	// These 57 lines only look text-only, so the word rules alone let them
	// through; the text rule declines every one again, because it reads what
	// the line says whatever the shell constructs around it.
	wantBlocked(t, map[string]string{
		// Process substitution.
		`bash < <(echo 'npx expo start')`: `Metro`,
		`bash <(echo 'npx expo start')`:   `Metro`,
		`source <(echo 'npx expo start')`: `Metro`,
		`. <(echo 'xcrun simctl boot X')`: `simctl boot`,
		`sh <(printf 'npx expo start\n')`: `Metro`,
		// /dev/stdin as the script.
		`source /dev/stdin <<< 'npx expo start'`:    `Metro`,
		`bash /dev/stdin <<< 'npx expo start'`:      `Metro`,
		`echo 'npx expo start' | bash /dev/stdin`:   `Metro`,
		`echo 'npx expo start' | sh /dev/fd/0`:      `Metro`,
		`echo 'npx expo start' | source /dev/stdin`: `Metro`,
		// Text through any other filter.
		`echo 'npx expo start' | sed 's/^//' | bash`: `Metro`,
		`echo 'npx expo start' | tr -d '\r' | sh`:    `Metro`,
		`echo 'npx expo start' | head -n 1 | bash`:   `Metro`,
		`grep 'npx expo start' README.md | bash`:     `Metro`,
		// A file the line wrote, run by redirect, pipe or substitution.
		`echo 'npx expo start' > s.sh; cat s.sh | bash`:                 `Metro`,
		`echo 'npx expo start' > s.sh; bash < s.sh`:                     `Metro`,
		`echo 'npx expo start' > s.sh; sh -s < s.sh`:                    `Metro`,
		`echo 'npx expo start' > s.sh; sh -c "$(cat s.sh)"`:             `Metro`,
		`echo 'npx expo start' > m.sh; bash -c "source m.sh"`:           `Metro`,
		`echo 'npx expo start' > /tmp/m.command && open /tmp/m.command`: `Metro`,
		// printf with a format and several arguments: a shebang or a comment
		// first.
		`printf '%s\n' '#!/bin/sh' 'npx expo start' > s.sh && sh s.sh`:              `Metro`,
		`printf '%s\n' '# start metro' 'npx expo start' | bash`:                     `Metro`,
		`printf '%s\n' '#!/bin/bash' 'xcrun simctl boot X' > boot.sh; bash boot.sh`: `simctl boot`,
		// trap.
		`trap 'npx expo start' EXIT`:                     `Metro`,
		`trap "xcrun simctl shutdown all" EXIT; sleep 1`: `simctl shutdown`,
		// A -c script that runs its positional parameters.
		`sh -c '"$@"' _ npx expo start`:                     `Metro`,
		`bash -c 'cd apps/mobile && "$@"' _ npx expo start`: `Metro`,
		`bash -c '$1' _ 'npx expo start'`:                   `Metro`,
		`sh -c 'exec "$@"' sh xcrun simctl boot X`:          `simctl boot`,
		// A shell inside a group that reads the pipe.
		`echo 'npx expo start' | (cd apps && bash)`:  `Metro`,
		`echo 'npx expo start' | { cd apps; bash; }`: `Metro`,
		`echo 'npx expo start' | (bash)`:             `Metro`,
		// A shell that a launcher starts without a command.
		`echo 'npx expo start' | sudo -i`:             `Metro`,
		`echo 'npx expo start' | sudo -s`:             `Metro`,
		`sudo -s <<< 'npx expo start'`:                `Metro`,
		`sudo -i <<< 'xcrun simctl boot X'`:           `simctl boot`,
		`echo 'npx expo start' | script -q /dev/null`: `Metro`,
		// Tools that read commands from their input, and shells within shells.
		`echo 'npx expo start' | parallel`:            `Metro`,
		`at now <<< 'npx expo start'`:                 `Metro`,
		`echo 'npx expo start' | at now`:              `Metro`,
		`echo 'npx expo start' | bash -c 'bash'`:      `Metro`,
		`bash -c "$(echo 'npx expo start' | tr a a)"`: `Metro`,
		// Shells outside the list.
		`yash -c 'npx expo start'`:           `Metro`,
		`pwsh -c 'npx expo start'`:           `Metro`,
		`nu -c 'npx expo start'`:             `Metro`,
		`elvish -c 'npx expo start'`:         `Metro`,
		`xonsh -c 'npx expo start'`:          `Metro`,
		`echo 'npx expo start' | busybox sh`: `Metro`,
		`echo 'npx expo start' | yash`:       `Metro`,
		// Code in another language.
		`npx tsx -e "require('child_process').execSync('npx expo start')"`:                `Metro`,
		`ruby -e 'system("npx expo start")'`:                                              `Metro`,
		`perl -e 'system("npx expo start")'`:                                              `Metro`,
		`osascript -l JavaScript -e 'Application("Terminal").doScript("npx expo start")'`: `Metro`,
		`osascript -e 'tell application "Terminal" to do script ("npx expo start")'`:      `Metro`,
		// xargs, also with clustered options.
		`echo "'npx expo start'" | xargs sh -c`:          `Metro`,
		`echo 'npx expo start' | xargs -rI{} sh -c '{}'`: `Metro`,
		`echo 'npx expo start' | xargs -tI{} sh -c '{}'`: `Metro`,
	})
}

func TestHookExcusesMentionsThatNothingOnTheLineCanRun(t *testing.T) {
	// A mention is excused when the line looks as if every command on it only
	// reads or prints text: a commit message, a PR, a search, a note.
	wantPassing(t, []string{
		`git commit -m 'fix: run npx expo start through a lane'`,
		`git commit -m "docs: never run xcrun simctl boot by hand"`,
		`git commit -am 'stop agents running npx expo start' && git push origin main`,
		`gh pr create --title 'Stop npx expo start' --body 'Use the lane tool, not xcrun simctl boot.'`,
		`gh issue comment 12 --body 'Metro hung after npx expo start'`,
		`grep -rn "npx expo start" .`,
		`rg 'xcrun simctl boot' apps/desktop | head -n 20`,
		`git log -S 'xcrun simctl boot' --oneline`,
		`git grep -n 'npx expo start' -- docs`,
		`grep sh <<< 'npx expo start'`,
		`echo 'npx expo start' > notes.md`,
		`printf '%s\n' 'run npx expo start' >> notes.md`,
		`rndevtools claim --udid 727CE7B2 --note 'npx expo start hung; xcrun simctl boot it'`,
		`~/.local/bin/rndevtools claim --udid X --note 'npx expo start'`,
		`tmux rename-window 'expo start'`,
		`bash -n s.sh`,
		"gh pr create --body \"$(cat <<'EOF'\nTest plan: npx expo start\nxcrun simctl boot X\nEOF\n)\"",
		`cd apps/mobile && git commit -m 'npx expo start'`,
		`ls docs | grep 'npx expo start'; echo done`,
	})
	// Every program of the list.
	for _, program := range strings.Fields("echo printf cat grep egrep fgrep rg head tail wc sort uniq cut tr nl jq ls pwd cd mkdir touch test true false sleep date basename dirname realpath which type") {
		wantPassing(t, []string{program + " 'npx expo start'", program + " 'xcrun simctl boot X'"})
	}
	wantPassing(t, []string{
		`test -n 'npx expo start' && echo yes`,
		`command -v 'npx expo start'`,
		`command -V 'xcrun simctl boot X'`,
	})
	// The launchers that only run their operand.
	wantPassing(t, []string{
		`nice -n 5 git commit -m 'npx expo start'`,
		`nice -5 grep -rn 'npx expo start' .`,
		`nohup git push origin 'npx expo start' &`,
		`time git log -S 'npx expo start'`,
		`timeout 60 grep -rn 'npx expo start' .`,
		`gtimeout -s KILL 60 git log -S 'npx expo start'`,
		`sudo git status 'npx expo start'`,
		`sudo -u me git log -S 'npx expo start'`,
		`sudo -E -H git log -S 'npx expo start'`,
		`env -i git log -S 'npx expo start'`,
		`env -u FOO git log -S 'npx expo start'`,
		`sudo nice -n 5 timeout 5 git log -S 'npx expo start'`,
	})
	// The git and gh commands of the list, also behind git's directory options.
	for _, subcommand := range strings.Fields("add commit log show diff status tag stash push fetch branch checkout switch restore rm mv grep blame describe rev-parse ls-files") {
		wantPassing(t, []string{
			"git " + subcommand + " 'npx expo start'",
			"git -C apps/mobile " + subcommand + " 'xcrun simctl boot X'",
			"git --no-pager " + subcommand + " 'npx expo start'",
		})
	}
	for _, subcommand := range strings.Fields("pr issue release api label search") {
		wantPassing(t, []string{"gh " + subcommand + " 'npx expo start'"})
	}
	// gh repo only for the commands that read: view and list.
	wantPassing(t, []string{"gh repo view 'npx expo start'", "gh repo list 'npx expo start'"})
	// Output sent nowhere, or to another descriptor, writes no file git could
	// run; a note written by a program that is not git or gh is no hook.
	wantPassing(t, []string{
		`git commit -m 'npx expo start' >/dev/null 2>&1`,
		`git commit -m 'npx expo start' > /dev/null`,
		`git commit -m 'npx expo start' &>/dev/null`,
		`git log -S 'npx expo start' 2>&1 | head -n 5`,
		`git log -S 'npx expo start' >&2`,
		`gh pr view 12 --json body 2>&1 | grep 'npx expo start'`,
		`cat notes.md | grep 'npx expo start' > matches.txt`,
		`echo 'npx expo start' | tr a-z A-Z >> notes.md`,
	})
}

func TestHookKeepsDecliningMentionsThatSomethingOnTheLineCouldRun(t *testing.T) {
	// The excuse is one rule with no data flow, so a line that has any command
	// outside it keeps the first version's verdict, whatever else it does.
	wantBlocked(t, map[string]string{
		// A mixed line.
		`git commit -m 'npx expo start' && pnpm test`:      `Metro`,
		`echo 'npx expo start'; xcrun simctl list devices`: `Metro`,
		`git commit -m 'npx expo start'; ./deploy.sh`:      `Metro`,
		// A program that is not on the list, or named by a path.
		`sed -n '/xcrun simctl boot/p' notes.md`:                    `simctl boot`,
		`awk '/npx expo start/' notes.md`:                           `Metro`,
		`echo 'npx expo start' | pbcopy`:                            `Metro`,
		`echo 'xcrun simctl boot X' | xargs echo`:                   `simctl boot`,
		`find . -name '*.md' -exec grep 'npx expo start' {} +`:      `Metro`,
		`echo 'npx expo start' | tee notes.md`:                      `Metro`,
		`ssh host 'npx expo start'`:                                 `Metro`,
		`python3 -c "print('npx expo start')"`:                      `Metro`,
		`node -e "console.log('npx expo start')"`:                   `Metro`,
		`osascript -e 'display notification "npx expo start done"'`: `Metro`,
		`/usr/bin/git commit -m 'npx expo start'`:                   `Metro`,
		`./git commit -m 'npx expo start'`:                          `Metro`,
		`/bin/echo 'npx expo start'`:                                `Metro`,
		`mytool --note 'npx expo start'`:                            `Metro`,
		`$CMD 'npx expo start'`:                                     `Metro`,
		`"${EDITOR}" 'npx expo start'`:                              `Metro`,
		// Shells and the commands that run text, however little they do.
		`bash -c 'echo npx expo start'`:                    `Metro`,
		`sh -n <<< 'npx expo start'`:                       `Metro`,
		`echo 'npx expo start' | bash -n`:                  `Metro`,
		`eval 'echo hi' 'npx expo start'`:                  `Metro`,
		`source notes.sh 'npx expo start'`:                 `Metro`,
		`exec git commit -m 'npx expo start'`:              `Metro`,
		`command git commit -m 'npx expo start'`:           `Metro`,
		`export NOTE='npx expo start'`:                     `Metro`,
		`alias metro='npx expo start'`:                     `Metro`,
		`set -- 'npx expo start'`:                          `Metro`,
		`tmux display-message 'npx expo start is running'`: `Metro`,
		`watch -t 'echo npx expo start'`:                   `Metro`,
		`parallel echo ::: 'npx expo start'`:               `Metro`,
		`xargs -I{} sh -c 'echo {}' <<< 'npx expo start'`:  `Metro`,
		`for f in a b; do echo 'npx expo start'; done`:     `Metro`,
		// Substitution bodies are commands too, and a $ or a backtick anywhere
		// ends the excuse, whatever the substitution runs.
		`echo "$(npx expo start)"`:                                `Metro`,
		"echo `xcrun simctl boot X`":                              `simctl boot`,
		`git commit -m "$(sed 's/a/b/' notes.md) npx expo start"`: `Metro`,
		`echo 'npx expo start' <(sed p notes.md)`:                 `Metro`,
		`echo "$(date) npx expo start"`:                           `Metro`,
		`echo "$(git log -1 --format=%s) npx expo start"`:         `Metro`,
		// An assignment prefix, which GIT_PAGER and its kind run.
		`FOO=1 git commit -m 'npx expo start'`:        `Metro`,
		`GIT_PAGER='npx expo start' git log`:          `Metro`,
		`env FOO=1 git log -S 'npx expo start'`:       `Metro`,
		`FOO=1; git log -S 'npx expo start'`:          `Metro`,
		`git log -S 'npx expo start' && BAR=2 echo x`: `Metro`,
		// A launcher that starts a shell or runs a command string.
		`sudo -s git log -S 'npx expo start'`:             `Metro`,
		`sudo -i git log -S 'npx expo start'`:             `Metro`,
		`sudo -iu me git log -S 'npx expo start'`:         `Metro`,
		`sudo --login git log -S 'npx expo start'`:        `Metro`,
		`sudo -l 'npx expo start'`:                        `Metro`,
		`env -S 'git log -S "npx expo start"'`:            `Metro`,
		`timeout 5 bash -c 'git log -S "npx expo start"'`: `Metro`,
		// git that runs another program, or that is not on the list.
		`git -c core.pager='npx expo start' log`:                  `Metro`,
		`git -c core.hooksPath=/tmp/h commit -m 'npx expo start'`: `Metro`,
		`git commit -c HEAD -m 'npx expo start'`:                  `Metro`,
		`git --config-env=core.pager=X log -S 'npx expo start'`:   `Metro`,
		`git --exec-path=/tmp/x log -S 'npx expo start'`:          `Metro`,
		`git fetch --upload-pack='npx expo start' origin`:         `Metro`,
		`git push --receive-pack='npx expo start' origin`:         `Metro`,
		`git grep -O'npx expo start' x`:                           `Metro`,
		`git config alias.x '!npx expo start'`:                    `Metro`,
		`git rebase --exec 'npx expo start' main`:                 `Metro`,
		`git bisect run sh -c 'npx expo start'`:                   `Metro`,
		`git submodule foreach 'npx expo start'`:                  `Metro`,
		`git clone https://example.com/x.git 'npx expo start'`:    `Metro`,
		`git worktree add 'npx expo start'`:                       `Metro`,
		`git reset --hard 'npx expo start'`:                       `Metro`,
		`git 'npx expo start'`:                                    `Metro`,
		// gh beyond its list.
		`gh alias set metro '!npx expo start'`: `Metro`,
		`gh extension exec 'npx expo start'`:   `Metro`,
		`gh run list 'npx expo start'`:         `Metro`,
		// A text program told to run another.
		`rg --pre 'npx expo start' x .`:                     `Metro`,
		`rg --pre='npx expo start' x .`:                     `Metro`,
		`sort --compress-program='npx expo start' notes.md`: `Metro`,
		// A line that writes a file and also runs git or gh: git runs hook
		// files, and the line could have written one.
		`echo 'npx expo start' > notes.md && git commit -am notes`: `Metro`,
		`git commit -m 'npx expo start' > commit.log`:              `Metro`,
		`git log -S 'npx expo start' 2> err.log`:                   `Metro`,
		`git log -S 'npx expo start' &> log.txt`:                   `Metro`,
		`git log -S 'npx expo start' >| log.txt`:                   `Metro`,
		`git log -S 'npx expo start' >> log.txt`:                   `Metro`,
		`git log -S 'npx expo start' >&log.txt`:                    `Metro`,
		`git log -S 'npx expo start'>log.txt`:                      `Metro`,
		`gh pr create --body 'npx expo start' > pr.txt`:            `Metro`,
		`echo hi > a.txt; gh pr create --body 'npx expo start'`:    `Metro`,
	})
}

func TestHookJudgesAFollowedScriptAsALineOfItsOwn(t *testing.T) {
	// A script the word rules follow (a here-document a shell reads, a file the
	// line writes and runs) is judged as a line of its own: by the word rules,
	// by the text rule with its excuse, and by the Supabase rules. The
	// here-document body is text the first pass never sees.
	wantBlocked(t, map[string]string{
		"bash <<'EOF'\ntrap 'npx expo start' EXIT\nEOF":                                  "Metro",
		"bash <<'EOF'\nsed -n '/xcrun simctl boot/p' notes.md\nEOF":                      "simctl boot",
		"bash <<'EOF'\ngit commit -m 'fix: npx expo start' && pnpm test\nEOF":            "Metro",
		"bash <<'EOF'\necho 'npx expo start' | pbcopy\nEOF":                              "Metro",
		"cat > run.sh <<'EOF'\nprintf '%s\\n' 'x' 'npx expo start' | sh\nEOF\nsh run.sh": "Metro",
		"bash <<'EOF'\nex''po start\nEOF":                                                "Metro",
		"bash <<'EOF'\nbash <<'INNER'\nnpx expo start\nINNER\nEOF":                       "Metro",
		"bash -c \"$(cat <<'EOF'\nxcrun simctl shutdown all | cat\nEOF\n)\"":             "simctl shutdown",
	})
	wantPassing(t, []string{
		"bash <<'EOF'\ngit commit -m 'fix: npx expo start'\nEOF",
		"bash <<'EOF'\ngrep -rn 'xcrun simctl boot' docs | head -n 5\nEOF",
		"cat > run.sh <<'EOF'\ngit log -S 'npx expo start'\nEOF\nsh run.sh",
		"bash <<'EOF'\ngh pr create --body 'run npx expo start'\nEOF",
	})
	// The Supabase rules judge the same script as a line of its own, from the
	// directory it runs in.
	fixture := newSupabaseFixture(t)
	fixture.expect(t, fixture.legacy, "bash <<'EOF'\ncd "+fixture.linked+"\nsupabase start\nEOF", "--runtime native")
	fixture.expect(t, fixture.legacy, "cat > run.sh <<'EOF'\nsupabase stop --all\nEOF\nsh run.sh", "every agent's local Supabase stack")
	fixture.expect(t, fixture.legacy, "bash <<'EOF'\ngit commit -m 'npx expo start'\nEOF")
}

// The three cases below keep their steered text where the text rule cannot
// see it (a here-document, a command split by quotes, ex''po), so that the
// word rules alone decide.

func TestHookReadsAShellGivenNAsParsingNotRunning(t *testing.T) {
	// A shell given -n checks the syntax of its script and runs none of it.
	script := "cat > s.sh <<'EOF'\nnpx expo start\nEOF\n"
	wantPassing(t, []string{
		script + "bash -n s.sh",
		script + "sh -n s.sh",
		script + "bash -nx s.sh",
		script + "bash -o noexec s.sh",
		script + "zsh -n s.sh",
		script + "fish --no-execute s.sh",
		"sh -n <<'EOF'\nnpx expo start\nEOF",
		"cat <<'EOF' | bash -n\nnpx expo start\nEOF",
		"bash -n -c 'ex''po start'",
		"bash -n s.sh",
	})
	// A shell that runs the script, or whose -n is a parameter of it, does.
	wantBlocked(t, map[string]string{
		script + "bash s.sh":               "Metro",
		script + "bash -x s.sh":            "Metro",
		script + "bash -n s.sh; bash s.sh": "Metro",
		script + "bash +n s.sh":            "Metro",
		"sh <<'EOF'\nnpx expo start\nEOF":  "Metro",
		"bash -c 'ex''po start' -n":        "Metro",
		"bash -c 'ex''po start' _ -n":      "Metro",
	})
}

func TestHookFollowsTmuxOnlyWhereItCarriesACommand(t *testing.T) {
	// tmux commands that rename, show, or set something handle text; the ones
	// that start a shell command or type keys carry it.
	wantPassing(t, []string{
		"tmux rename-window 'expo start'",
		"tmux display-message 'expo start'",
		"tmux set -g status-right 'expo start'",
		"tmux list-windows -F 'expo start'",
		"tmux new-session -d -s 'expo start' -n 'expo start' -c apps/mobile",
		"tmux new-window -n 'expo start' -c 'expo start'",
		"tmux split-window -h -c 'expo start'",
		"tmux send-keys -t 'expo start' Enter",
		"tmux run-shell -t 'expo start' 'echo hi'",
		"tmux display-popup -T 'expo start' 'echo hi'",
	})
	wantBlocked(t, map[string]string{
		"tmux new-session -d -s metro 'ex''po start'":                    "Metro",
		"tmux new -d -s metro \"$(cat <<'EOF'\nnpx expo start\nEOF\n)\"": "Metro",
		"tmux new-window 'ex''po start'":                                 "Metro",
		"tmux neww 'ex''po start'":                                       "Metro",
		"tmux split-window -h 'ex''po start'":                            "Metro",
		"tmux splitw -h 'ex''po start'":                                  "Metro",
		"tmux respawn-pane -k 'ex''po start'":                            "Metro",
		"tmux respawnp -k 'ex''po start'":                                "Metro",
		"tmux respawn-window -k 'ex''po start'":                          "Metro",
		"tmux respawnw -k 'ex''po start'":                                "Metro",
		"tmux run-shell 'ex''po start'":                                  "Metro",
		"tmux run -b 'ex''po start'":                                     "Metro",
		"tmux if-shell true 'ex''po start'":                              "Metro",
		"tmux if true 'ex''po start'":                                    "Metro",
		"tmux pipe-pane -t metro 'ex''po start'":                         "Metro",
		"tmux pipep -t metro 'ex''po start'":                             "Metro",
		"tmux display-popup -E 'ex''po start'":                           "Metro",
		"tmux popup -E 'ex''po start'":                                   "Metro",
		"tmux send-keys -t metro 'ex''po start' Enter":                   "Metro",
		"tmux send -t metro 'ex''po start' Enter":                        "Metro",
		"tmux new-session -d -- 'ex''po start'":                          "Metro",
		"tmux -L sock -f /dev/null new -d 'ex''po start'":                "Metro",
		"tmux -c 'ex''po start'":                                         "Metro",
	})
}

func TestHookReadsXargsReplacementsAsQuotedWords(t *testing.T) {
	// xargs puts each input line where the replacement string is. In a string
	// that does something with it (echo {}), it is one word of the command;
	// only a string that is the replacement alone (sh -c '{}') is the command
	// line itself.
	wantPassing(t, []string{
		"xargs -I{} sh -c 'echo {}' <<'EOF'\nnpx expo start\nEOF",
		"cat <<'EOF' | xargs -I{} sh -c 'echo {} >> notes.md'\nnpx expo start\nEOF",
		"cat <<'EOF' | xargs -I% bash -c 'printf \"%s\" % > notes.md'\nnpx expo start\nEOF",
		"cat <<'EOF' | xargs -I{} sh -c 'grep -c {} notes.md'\nxcrun simctl boot X\nEOF",
	})
	// The third row above with a newline in the printf format. The script xargs
	// fills in is a line of its own, and the backslash in its double quotes
	// turns the excuse off for it, so its mention is declined. The first
	// version of the hook passed this line, because it never read a
	// here-document body; the README names this cost under "The one excuse".
	// Without the backslash the script is text, as above.
	wantBlocked(t, map[string]string{
		"cat <<'EOF' | xargs -I% bash -c 'printf \"%s\\n\" % > notes.md'\nnpx expo start\nEOF": "Metro",
	})
	wantBlocked(t, map[string]string{
		"xargs -I{} sh -c '{}' <<'EOF'\nnpx expo start\nEOF":          "Metro",
		"cat <<'EOF' | xargs -I{} sh -c '{}'\nnpx expo start\nEOF":    "Metro",
		"xargs -I % bash -c % <<'EOF'\nxcrun simctl boot X\nEOF":      "simctl boot",
		"cat <<'EOF' | xargs -0 sh -c\nnpx expo start\nEOF":           "Metro",
		"xargs -I{} sh -c 'ex''po start {}' <<'EOF'\na\nEOF":          "Metro",
		"xargs -I{} sh -c 'xcrun simctl shutdown {}' <<'EOF'\nA\nEOF": "simctl shutdown",
	})
}

func TestXargsFillQuotesInputLinesAndStopsAtTheCap(t *testing.T) {
	for _, row := range []struct {
		script  string
		items   []string
		want    []string
		message string
	}{
		{"echo {}", []string{"npx expo start", "a'b", "plain"}, []string{"echo 'npx expo start'", `echo 'a'\''b'`, "echo plain"}, "an item is a word"},
		{"{}", []string{"npx expo start", "a; b"}, []string{"npx expo start", "a; b"}, "an item alone is the command line"},
		{" {} ", []string{"x y"}, []string{" x y "}, "so is one with blanks around it"},
		{"cd {} && ls {}", []string{"a b"}, []string{"cd 'a b' && ls 'a b'"}, "every replacement is quoted"},
	} {
		if got := xargsFill(row.script, "{}", row.items); !reflect.DeepEqual(got, row.want) {
			t.Errorf("%s: xargsFill(%q, %q) = %q, want %q", row.message, row.script, row.items, got, row.want)
		}
	}
	// A long script and many lines build scripts up to the cap, not one per
	// line.
	items := make([]string, 50_000)
	for index := range items {
		items[index] = "x"
	}
	script := "{} " + strings.Repeat("echo a; ", 10_000)
	filled := xargsFill(script, "{}", items)
	total := 0
	for _, built := range filled {
		total += len(built)
	}
	if len(filled) == 0 || total > maxFollowedScriptBytes {
		t.Fatalf("built %d scripts of %d bytes in all, want some within %d", len(filled), total, maxFollowedScriptBytes)
	}
}

func TestScriptLedgerJudgesAWrittenFileOnceAndStopsAtTheCap(t *testing.T) {
	file := handedScript{text: "echo a", file: fileVersion{path: "s.sh", last: 0}}
	var ledger scriptLedger
	if !ledger.follow(file, "/w", 0) || ledger.follow(file, "/w", 0) || ledger.follow(file, "/w", 2) {
		t.Fatal("the text of a written file is judged once from a directory, however deep it is reached again")
	}
	if !ledger.follow(file, "/other", 0) {
		t.Fatal("the same file run from another directory is judged there too")
	}
	if !ledger.follow(handedScript{text: "echo a", file: fileVersion{path: "s.sh", last: 1}}, "/w", 0) {
		t.Fatal("another version of the file is another text")
	}
	deep := scriptLedger{}
	if !deep.follow(file, "", 2) || deep.follow(file, "", 3) || !deep.follow(file, "", 1) {
		t.Fatal("a file reached again shallower is judged again, because it reaches further")
	}
	plain := handedScript{text: "echo a"}
	if !deep.follow(plain, "", 0) || !deep.follow(plain, "", 0) {
		t.Fatal("scripts that are not files are all judged")
	}
	if deep.follow(handedScript{}, "", 0) {
		t.Fatal("an empty script has nothing to judge")
	}
	capped := scriptLedger{}
	if !capped.follow(handedScript{text: strings.Repeat("a", maxFollowedScriptBytes-10)}, "", 0) {
		t.Fatal("a script within the cap is followed")
	}
	if capped.exhausted() || capped.follow(handedScript{text: strings.Repeat("a", 20)}, "", 0) || !capped.exhausted() {
		t.Fatal("the script that passes the cap is not followed, and the ledger is spent")
	}
	if capped.follow(handedScript{text: "a"}, "", 0) {
		t.Fatal("past the cap nothing more is followed")
	}
}

func TestWrittenScriptReadsEachVersionOfAFileOnce(t *testing.T) {
	// Segments: 0 and 1 write s.sh, 2 and 3 run it, 4 appends, 5 runs it.
	line := parseShellLine("echo a > s.sh; echo b >> s.sh; sh s.sh; sh s.sh; echo c >> s.sh; sh s.sh")
	first, firstVersion, ok := writtenScript(line, 2, "s.sh")
	if !ok || first != "a\nb" {
		t.Fatalf("the first run reads %q (%v), want the two writes before it", first, ok)
	}
	second, secondVersion, _ := writtenScript(line, 3, "./s.sh")
	if secondVersion != firstVersion || second != first {
		t.Fatalf("the second run is the same version: %+v %q, then %+v %q", secondVersion, second, firstVersion, first)
	}
	if line.files.pieces != 2 {
		t.Fatalf("two runs of one version read %d writes, want the 2 of the version", line.files.pieces)
	}
	third, thirdVersion, _ := writtenScript(line, 5, "s.sh")
	if thirdVersion == firstVersion || third != "a\nb\nc" {
		t.Fatalf("an append makes another version: %+v %q", thirdVersion, third)
	}
	if _, _, ok := writtenScript(line, 0, "s.sh"); ok {
		t.Fatal("a file is not read before the line writes it")
	}
	if _, _, ok := writtenScript(line, 5, "other.sh"); ok {
		t.Fatal("a file the line did not write is not read")
	}
	// A file appended to and run thousands of times has a version per run,
	// and each is built from up to 64 writes; the line reads 16,384 writes in
	// all. The sizes are written out, so that a limit that is changed does not
	// change the line this builds.
	many := parseShellLine(strings.Repeat("echo a >> s.sh; sh s.sh; ", 1280))
	for index, segment := range many.segments {
		if segment.program() == "sh" {
			writtenScript(many, index, "s.sh")
		}
	}
	if many.files.pieces != 16384 {
		t.Fatalf("read %d writes, want 16384", many.files.pieces)
	}
}

func TestHookFollowsScriptsOnlyUpToTheCapAndRunningAFileDoesNotSpendIt(t *testing.T) {
	steered := "xcrun simctl boot X\nEOF"
	within := strings.Repeat("echo a\n", maxFollowedScriptBytes/2/7)
	past := strings.Repeat("echo a\n", (maxFollowedScriptBytes+1000)/7)
	if decision := EvaluateShellCommand("bash <<'EOF'\n" + within + steered); !decision.Block {
		t.Fatal("a script within the cap is followed")
	}
	// Past the cap the rule stops following, and the text rule decides what
	// is left: the text rule does not read here-documents.
	if decision := EvaluateShellCommand("bash <<'EOF'\n" + past + steered); decision.Block {
		t.Fatalf("a script past the cap is not followed: %q", decision.Reason)
	}
	// Running one file again is not another script: five runs of a file of
	// 100 KB do not use up a cap of 256 KiB for the here-document after them.
	body := strings.Repeat("echo a\n", 100_000/7)
	line := "cat > s.sh <<'EOF'\n" + body + "EOF\n" + strings.Repeat("sh s.sh\n", 5) + "bash <<'EOF'\n" + steered
	if decision := EvaluateShellCommand(line); !decision.Block {
		t.Fatal("a file run five times is judged once, and the script after it is still followed")
	}
	// The Supabase rules keep their own account of the same limits.
	fixture := newSupabaseFixture(t)
	supabaseLine := "cat > s.sh <<'EOF'\n" + body + "EOF\n" + strings.Repeat("sh s.sh\n", 5) + "bash <<'EOF'\nsupabase stop --all\nEOF"
	fixture.expect(t, fixture.legacy, supabaseLine, "every agent's local Supabase stack")
	fixture.expect(t, fixture.legacy, "bash <<'EOF'\n"+within+"supabase stop --all\nEOF", "every agent's local Supabase stack")
	fixture.expect(t, fixture.legacy, "bash <<'EOF'\n"+past+"supabase stop --all\nEOF")
}

// quietSupabaseEnvironment is a Mac whose local Supabase is off: none of the
// Supabase rules applies.
func quietSupabaseEnvironment() supabaseEnvironment {
	return supabaseEnvironment{
		steering:  func() (steeringState, bool) { return steeringState{}, false },
		reachable: func() bool { return false },
		now:       time.Now,
		home:      func() string { return "/Users/example" },
		getenv:    func(string) string { return "" },
	}
}

// judgeWithin judges line with the Supabase rules off in a goroutine the test
// can leave behind, and reports whether it answered within budget. A line
// that is slow once is judged a second time, so that a busy machine does not
// fail the test; a rule that grows with the square of the line fails both.
func judgeWithin(budget time.Duration, line string) (decision HookDecision, took time.Duration, answered bool) {
	for attempt := 0; attempt < 2 && !answered; attempt++ {
		started := time.Now()
		answer := make(chan HookDecision, 1)
		go func() { answer <- evaluateShellCallWith(shellCall{command: line}, quietSupabaseEnvironment()) }()
		select {
		case decision = <-answer:
			answered = true
		case <-time.After(budget):
		}
		took = time.Since(started)
	}
	return decision, took, answered
}

func TestHookStaysFastOnLinesNearTheLimit(t *testing.T) {
	// The payload limit is 1 MiB. A line that is quick to write can still make
	// a rule judge one text over and over (a file run tens of thousands of
	// times, a long xargs string filled in from thousands of lines) or walk
	// back over every command it has read (a bare shell in each of thousands
	// of substitutions or nested groups, a here-document operator each time).
	// Each of these lines takes 30 to 180 ms on a Mac, and the slowest took
	// 260 ms when other jobs loaded it. A budget must not depend on how fast
	// the machine is, so it is more than ten times the slowest of those: five
	// seconds, which is also what the installed hook gets. A rule that grows
	// with the square of the line takes from ten seconds to minutes on them,
	// which is why most of them are close to the payload limit.
	// The race detector makes the code fifteen to twenty times slower (up to
	// 1.8 s a line here), so under it the lines are a quarter as long and the
	// budget is thirty seconds, sixteen times the slowest line. There it
	// catches only the worst of the quadratic rules; the plain run is what
	// tells the rest from a linear one.
	budget, quarter := 5*time.Second, 1
	if raceDetector {
		budget, quarter = 30*time.Second, 4
	}
	repeat := func(unit string, count int) string { return strings.Repeat(unit, count/quarter) }
	script := repeat("echo a; ", 40_000)
	lines := map[string]string{
		// Near the limit: the two lines that used to take minutes.
		"a file written once and run tens of thousands of times": "echo '" + script + "' > s.sh" + repeat("; sh s.sh", 60_000),
		"a file written by a here-document":                      "cat > s.sh <<'EOF'\n" + script + "\nEOF\n" + repeat("sh s.sh\n", 80_000),
		"xargs filling a long string for each of 100,000 lines":  "printf '" + repeat("x\\n", 100_000) + "' | xargs -I{} sh -c '{} " + repeat("echo a;", 60_000) + "'",
		// Other lines that could grow with the square of their size.
		"a file appended to and run 15,000 times": repeat("echo 'echo a' >> s.sh; sh s.sh; ", 15_000),
		"a file appended to from unknown sources": repeat("cat x >> s.sh; sh s.sh; ", 15_000),
		"many small scripts":                      repeat("sh -c 'echo a'; ", 20_000),
		"many pipes into a shell":                 repeat("echo $(a) | sh; ", 15_000),
		// A bare shell in each of 174,000 substitutions looks for the command
		// before it in its own scope, which is the first of its scope.
		"substitutions that each run a shell": "echo " + repeat("$(sh) ", 174_000),
		// 116,000 groups nested in each other, each piped into a shell, read
		// the commands of the group, which come after those nested in it.
		"nested groups, each piped into a shell": repeat("( ", 116_000) + "echo a" + repeat(") | sh ", 116_000),
		// A { is a word, not a scope, so the } of each of 95,000 groups nested in
		// each other reads back through the groups inside it, and the first
		// command has a word for each of them.
		"nested { } groups, each piped into a shell": repeat("{ ", 95_000) + "echo a" + repeat("; } | sh ", 95_000),
		// A } with no { before it reads back to the start of the line, and
		// reached every } before it that did the same, to a depth of eight.
		"closing braces chained into a shell": "{ echo a; " + repeat("}; ", 300_000) + "} | sh",
		// A script is a line of its own, and 90 of them fit in what the rules
		// follow; each of these nests 280 groups, enough to use up the reading
		// of groups that a line may do, so that reading is the call's to
		// spend, not each script's.
		"scripts that each nest groups": repeat("bash <<'EOF'\n"+strings.Repeat("{ ", 280)+"echo a"+strings.Repeat("; } | sh ", 280)+"\nEOF\n", 90),
		// A here-document operator is held until the line ends, so each of
		// 262,000 on one line is held while the next is read. A redirection
		// alone is a command, and the shortest there is, so the most of them fit
		// in a megabyte, and the further a rule that walks them all for each
		// command goes past the budget.
		"here-document operators on one line": repeat("<<A;", 262_000),
		// Each simctl word reads the options after it for the subcommand, and
		// --set takes the next simctl as its value.
		"simctl options that take simctl as their value": "simctl " + repeat("--set simctl ", 80_000),
		// A file that is a lone $(echo …) prints what it runs, which is read
		// from its text once, however many times the line runs the file.
		"a 200 KB file of one substitution, run 94,000 times": "echo '$(echo a #" + repeat("x", 200_000) + "\n)' > s.sh" + repeat("; sh s.sh", 94_000),
	}
	for name, line := range lines {
		if len(line) > 1<<20 {
			t.Fatalf("%s: the line is %d bytes, over the payload limit", name, len(line))
		}
		decision, took, answered := judgeWithin(budget, line)
		switch {
		case !answered:
			t.Errorf("%s: no answer within %s", name, budget)
		case decision.Block:
			t.Errorf("%s: declined, %q", name, decision.Reason)
		}
		t.Logf("%s: %d bytes in %s", name, len(line), took.Round(time.Millisecond))
	}
	// A steered command at the very end of a long line is still found.
	end := strings.Repeat("echo a; ", 100_000) + "npx expo start"
	if !EvaluateShellCommand(end).Block {
		t.Fatal("a steered command after a long line is declined")
	}
}

func TestSupabaseRulesStayFastOnLongChainsAndPipelines(t *testing.T) {
	// With local Supabase on, a command reads the commands chained or piped
	// around it, and a cd builds the directory it runs in. A line of a few
	// hundred KB can make each of thousands of commands read all the others.
	// Reading around a command stops at maxChainSteps, and a directory longer
	// than a path can be is unknown. The lines take 30 to 130 ms on a Mac, and
	// the slowest took 200 ms when other jobs loaded it, so the budget is five
	// seconds, as for the lines of TestHookStaysFastOnLinesNearTheLimit, which
	// is more than twenty times the slowest. A rule that reads the whole chain,
	// or builds every directory, takes from ten seconds on them. The race
	// detector makes the code up to thirty times slower (1.3 s a line here), so
	// under it the lines are a quarter as long and the budget is thirty seconds.
	// A status --env pipeline is not timed. Each of its commands reads the
	// project's files, so the line that would show the walk along the pipeline
	// for a .env file to be unbounded (10,000 commands, 10 s without the limit)
	// takes 0.8 s with it on a Mac, and can pass five seconds on a slow, busy one.
	// TestSupabaseRulesReadAtMostMaxChainStepsAroundACommand checks where that
	// walk stops instead.
	budget, quarter := 5*time.Second, 1
	if raceDetector {
		budget, quarter = 30*time.Second, 4
	}
	repeat := func(unit string, count int) string { return strings.Repeat(unit, count/quarter) }
	fixture := newSupabaseFixture(t)
	lines := map[string]string{
		"a native start, then declarative syncs chained with &&": "supabase start --runtime native && " + repeat("supabase db schema declarative sync --local && ", 8_000) + "true",
		"xargs kill in one pipeline":                             "echo a" + repeat(" | xargs kill", 12_000),
		"groups that each cd one level deeper":                   repeat("( cd a; ", 100_000) + "supabase start" + repeat(" )", 100_000),
	}
	for name, line := range lines {
		for _, directory := range []string{fixture.linked, fixture.managed} {
			started := time.Now()
			answer := make(chan HookDecision, 1)
			go func() { answer <- fixture.judge(directory, line) }()
			select {
			case <-answer:
			case <-time.After(budget):
				t.Errorf("%s: no answer within %s in %s", name, budget, directory)
			}
			t.Logf("%s: %d bytes in %s", name, len(line), time.Since(started).Round(time.Millisecond))
		}
	}
}

func TestSupabaseRulesReadAtMostMaxChainStepsAroundACommand(t *testing.T) {
	fixture := newSupabaseFixture(t)
	// A native start earlier in the && chain makes a declarative sync safe; the
	// rule looks 32 commands back for it, which is more than any chain written
	// by hand. The sizes are written out, so that a limit that is changed does
	// not change the line this builds.
	chain := func(between int) string {
		return "supabase start --runtime native && " + strings.Repeat("true && ", between) + "supabase db schema declarative sync --local"
	}
	fixture.expect(t, fixture.linked, chain(0))
	fixture.expect(t, fixture.linked, chain(30))
	fixture.expect(t, fixture.linked, chain(34), "Blocked")
	// A process killed by a pipeline into xargs kill is read the same way.
	pipeline := func(between int) string {
		return "echo postgres" + strings.Repeat(" | cat", between) + " | xargs kill"
	}
	fixture.expect(t, fixture.plain, pipeline(1), "Blocked")
	fixture.expect(t, fixture.plain, pipeline(30), "Blocked")
	fixture.expect(t, fixture.plain, pipeline(34))
	// And so is the pipeline that tees a .env file after a status --env.
	envPipeline := func(between int) string {
		return "supabase status --env" + strings.Repeat(" | cat", between) + " | tee .env"
	}
	fixture.expect(t, fixture.linked, envPipeline(1), ".env")
	fixture.expect(t, fixture.linked, envPipeline(30), ".env")
	fixture.expect(t, fixture.linked, envPipeline(34))
}

func TestSupabaseRulesPlaceNoDirectoryLongerThanAPath(t *testing.T) {
	fixture := newSupabaseFixture(t)
	rules := &supabaseRules{environment: fixture.environment()}
	if got := rules.resolveDirectory("/w", "a/b"); got != "/w/a/b" {
		t.Fatalf("resolveDirectory = %q", got)
	}
	long := strings.Repeat("a/", maxPathLength/2)
	if got := rules.resolveDirectory("/w", long); got != "" {
		t.Fatalf("a directory of %d bytes is placed: %d", len("/w/"+long), len(got))
	}
	if got := rules.resolveDirectory("/w", strings.Repeat("a/", maxPathLength/2-4)); got == "" {
		t.Fatal("a directory that fits is unknown")
	}
	if got := rules.resolveDirectory("", "/"+strings.Repeat("a/", maxPathLength)); got != "" {
		t.Fatalf("an absolute directory of %d bytes is placed", 2*maxPathLength+1)
	}
}

// MARK: - Supabase steering

// supabaseFixture is a Mac for the Supabase rules. managed is a worktree RN
// Devtools runs (a main checkout on refs/heads/feat-a); linked is a linked
// worktree of another repository that opted into the stack backend with a
// dotted key; legacy is a project that did not opt in; plain has no
// Supabase project. Paths are canonical, like the desktop's; raw is the
// same temporary directory through its /var symlink.
type supabaseFixture struct {
	raw, base             string
	managed, linked, repo string
	legacy, plain, home   string
	steering              steeringState
	steeringOK            bool
	reachable             bool
	reads, probes         int
	now                   time.Time
	env                   map[string]string
}

func newSupabaseFixture(t *testing.T) *supabaseFixture {
	t.Helper()
	raw := t.TempDir()
	base, err := filepath.EvalSymlinks(raw)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &supabaseFixture{raw: raw, base: base, steeringOK: true, reachable: true, now: time.UnixMilli(1_760_000_000_000), env: map[string]string{}}
	fixture.managed = filepath.Join(base, "wt", "feat-a")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "ref: refs/heads/feat-a\n")
	write(t, filepath.Join(fixture.managed, "supabase", "config.toml"), "project_id = \"example-app\"\n\n[experimental]\nstack = true\n")
	write(t, filepath.Join(fixture.managed, "apps", "mobile", "app.json"), "{}\n")
	write(t, filepath.Join(fixture.managed, "node_modules", ".bin", "supabase"), "#!/bin/sh\n")
	fixture.repo = filepath.Join(base, "repo")
	fixture.linked = filepath.Join(base, "wt", "feat-b")
	write(t, filepath.Join(fixture.repo, ".git", "HEAD"), "ref: refs/heads/main\n")
	write(t, filepath.Join(fixture.repo, ".git", "worktrees", "feat-b", "HEAD"), "ref: refs/heads/feat-b\n")
	write(t, filepath.Join(fixture.repo, ".git", "worktrees", "feat-b", "commondir"), "../..\n")
	write(t, filepath.Join(fixture.repo, "node_modules", ".bin", "supabase"), "#!/bin/sh\n")
	write(t, filepath.Join(fixture.linked, ".git"), "gitdir: "+filepath.Join(fixture.repo, ".git", "worktrees", "feat-b")+"\n")
	write(t, filepath.Join(fixture.linked, "supabase", "config.toml"), "# opted in with a dotted key\nexperimental.stack = true # local stacks\n")
	fixture.legacy = filepath.Join(base, "legacy")
	write(t, filepath.Join(fixture.legacy, ".git", "HEAD"), "ref: refs/heads/main\n")
	write(t, filepath.Join(fixture.legacy, "supabase", "config.toml"), "project_id = \"legacy\"\n\n[api]\nport = 54321\n")
	fixture.plain = filepath.Join(base, "plain")
	fixture.home = filepath.Join(base, "home")
	for _, directory := range []string{fixture.plain, fixture.home} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fixture.steering = steeringState{
		writtenAt: fixture.now.Add(-30 * time.Second),
		enabled:   true,
		roots: []steeringRoot{{
			worktreeRoot:  fixture.managed,
			projectRoot:   fixture.managed,
			branchContext: "refs/heads/feat-a",
			stackReady:    true,
			runner:        "pnpm exec supabase",
		}},
	}
	return fixture
}

func (fixture *supabaseFixture) environment() supabaseEnvironment {
	return supabaseEnvironment{
		steering: func() (steeringState, bool) {
			fixture.reads++
			return fixture.steering, fixture.steeringOK
		},
		reachable: func() bool {
			fixture.probes++
			return fixture.reachable
		},
		now:    func() time.Time { return fixture.now },
		home:   func() string { return fixture.home },
		getenv: func(name string) string { return fixture.env[name] },
	}
}

func (fixture *supabaseFixture) judge(cwd string, command string) HookDecision {
	return evaluateShellCallWith(shellCall{command: command, cwd: cwd}, fixture.environment())
}

// expect checks one command run from cwd: blocked with every wanted phrase
// in the reason, or allowed when nothing is wanted.
func (fixture *supabaseFixture) expect(t *testing.T, cwd string, command string, wants ...string) {
	t.Helper()
	decision := fixture.judge(cwd, command)
	if len(wants) == 0 {
		if decision.Block {
			t.Errorf("%q (in %s) should pass, got %q", command, cwd, decision.Reason)
		}
		return
	}
	if !decision.Block {
		t.Errorf("%q (in %s) should be blocked", command, cwd)
		return
	}
	for _, want := range wants {
		if !strings.Contains(decision.Reason, want) {
			t.Errorf("%q (in %s): reason %q lacks %q", command, cwd, decision.Reason, want)
		}
	}
}

func TestSupabaseRulesApplyOnlyWhileTheFeatureIsOn(t *testing.T) {
	fixture := newSupabaseFixture(t)
	for _, command := range []string{"supabase stop --all", "pkill postgres", "supabase start", "supabase status --env > .env"} {
		fixture.steeringOK = false
		fixture.expect(t, fixture.linked, command)
		fixture.steeringOK = true
		fixture.steering.enabled = false
		fixture.expect(t, fixture.linked, command)
		fixture.steering.enabled = true
		fixture.expect(t, fixture.linked, command, "Blocked")
	}
	// Lines that run neither supabase nor a kill tool never read the file.
	fixture.reads = 0
	for _, command := range []string{"git status", "pnpm test", "cd /tmp && ls", "echo supabase stop --all", "grep -r 'pkill postgres' docs", "cat supabase/config.toml"} {
		fixture.expect(t, fixture.linked, command)
	}
	if fixture.reads != 0 {
		t.Fatalf("steering.json read %d times for unrelated commands", fixture.reads)
	}
}

func TestSupabaseFallbackKeepsStacksNative(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.linked
	for command, corrected := range map[string]string{
		"supabase start":                               "supabase start --runtime native",
		"npx supabase start":                           "npx supabase start --runtime native",
		"npx -y supabase start --exclude studio":       "npx -y supabase start --runtime native --exclude studio",
		"npx supabase@2.121.0 start":                   "npx supabase@2.121.0 start --runtime native",
		"pnpm exec supabase start":                     "pnpm exec supabase start --runtime native",
		"pnpm dlx supabase start":                      "pnpm dlx supabase start --runtime native",
		"pnpm supabase start":                          "pnpm supabase start --runtime native",
		"yarn supabase start":                          "yarn supabase start --runtime native",
		"yarn dlx supabase start":                      "yarn dlx supabase start --runtime native",
		"bunx supabase start":                          "bunx supabase start --runtime native",
		"bun x supabase start":                         "bun x supabase start --runtime native",
		"npm exec -- supabase start":                   "npm exec -- supabase start --runtime native",
		"./node_modules/.bin/supabase start":           "./node_modules/.bin/supabase start --runtime native",
		"supabase start --runtime docker":              "supabase start --runtime native",
		"supabase start --runtime=auto -x studio":      "supabase start --runtime native -x studio",
		"supabase start --runtime podman":              "supabase start --runtime native",
		"supabase start --runtime":                     "supabase start --runtime native",
		"supabase --workdir . start":                   "supabase --workdir . start --runtime native",
		"supabase stack start":                         "supabase stack start --runtime native",
		"supabase stack prepare":                       "supabase stack prepare --runtime native",
		"supabase local start":                         "supabase local start --runtime native",
		"SUPABASE_EXPERIMENTAL_STACK=1 supabase start": "SUPABASE_EXPERIMENTAL_STACK=1 supabase start --runtime native",
		"supabase start > start.log 2>&1":              "supabase start --runtime native > start.log 2>&1",
		"supabase start --exclude 'studio, mail'":      "supabase start --runtime native --exclude 'studio, mail'",
	} {
		fixture.expect(t, in, command, "without `--runtime native`", "`"+corrected+"`", "ask the user")
	}
	fixture.expect(t, in, "supabase db start", "`supabase db start`", "`supabase start --runtime native`")
	fixture.expect(t, in, "pnpm exec supabase db start", "`pnpm exec supabase start --runtime native`")
	for _, command := range []string{
		"supabase db schema declarative generate",
		"supabase db schema declarative sync --local",
		"supabase db schema declarative generate --local=true",
		"supabase start --runtime native; supabase db schema declarative generate",
		"supabase start --runtime native || supabase db schema declarative generate",
		"supabase start --runtime native & supabase db schema declarative generate",
	} {
		fixture.expect(t, in, command, "automatic runtime selection", "`supabase start --runtime native && ")
	}
	fixture.expect(t, in, "supabase start --runtime docker && supabase db schema declarative generate", "without `--runtime native`")
	for _, command := range []string{
		"supabase start --runtime native",
		"supabase start --runtime=native",
		"npx supabase start --runtime native",
		"npx -y supabase@2.121.0 start --runtime=native",
		"pnpm dlx supabase start --runtime native",
		"pnpm supabase start --runtime native",
		"yarn supabase start --runtime native",
		"yarn dlx supabase start --runtime native",
		"bunx supabase start --runtime native",
		"bun x supabase start --runtime native",
		"npm exec -- supabase start --runtime native",
		"./node_modules/.bin/supabase start --runtime native",
		"supabase stack start --runtime native",
		"supabase stack prepare --runtime=native",
		"supabase start --runtime docker --runtime native",
		"pnpm exec supabase start --runtime native --exclude studio,analytics",
		"supabase start --help",
		"supabase start -h",
		"supabase help start",
		"supabase db start --help",
		"supabase stop",
		"supabase status",
		"supabase stack restart",
		"supabase stack list",
		"supabase stack logs --service auth",
		"supabase stack status",
		"supabase migration up --local",
		"supabase migration new add_profiles",
		"supabase db reset --local",
		"supabase gen types typescript --local > src/types/database.ts",
		"supabase test db",
		"supabase seed buckets --local",
		"supabase inspect db db-stats --local",
		"supabase functions serve",
		"supabase init",
		"supabase link --project-ref abcdefghijklmnopqrst",
		"supabase db diff",
		"supabase start --runtime native && supabase db schema declarative generate",
		"pnpm exec supabase start --runtime native && pnpm exec supabase db schema declarative sync --local",
		"supabase start --runtime native && echo ready && supabase db schema declarative generate",
		"supabase db schema declarative generate --linked",
		"supabase db schema declarative sync --db-url postgresql://example.com:5432/postgres",
		"supabase db schema declarative generate --local=false",
	} {
		fixture.expect(t, in, command)
	}
}

func TestSupabaseFallbackAppliesOnlyToOptedInProjects(t *testing.T) {
	fixture := newSupabaseFixture(t)
	native := "--runtime native"
	for _, cwd := range []string{fixture.legacy, fixture.plain, fixture.home, "", "relative/dir"} {
		for _, command := range []string{"supabase start", "supabase db start", "supabase db schema declarative generate"} {
			fixture.expect(t, cwd, command)
		}
	}
	fixture.expect(t, fixture.legacy, "SUPABASE_EXPERIMENTAL_STACK=1 supabase start", native)
	fixture.expect(t, fixture.legacy, "env SUPABASE_EXPERIMENTAL_STACK=1 npx supabase start", native)
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=0 supabase start")
	// The CLI accepts only 0 or 1.
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=true supabase start")
	// The hook's own environment counts when the segment does not say.
	fixture.env["SUPABASE_EXPERIMENTAL_STACK"] = "1"
	fixture.expect(t, fixture.legacy, "supabase start", native)
	fixture.env["SUPABASE_EXPERIMENTAL_STACK"] = "0"
	fixture.expect(t, fixture.linked, "supabase start")
	fixture.expect(t, fixture.linked, "SUPABASE_EXPERIMENTAL_STACK=1 supabase start", native)
	delete(fixture.env, "SUPABASE_EXPERIMENTAL_STACK")
	// The CLI's routing prefers config.json over config.toml.
	project := filepath.Join(fixture.base, "json-project")
	write(t, filepath.Join(project, "supabase", "config.toml"), "project_id = \"json\"\n")
	write(t, filepath.Join(project, "supabase", "config.json"), `{"experimental":{"stack":true}}`)
	fixture.expect(t, project, "supabase start", native)
	write(t, filepath.Join(project, "supabase", "config.json"), `{"experimental":{"stack":false}}`)
	write(t, filepath.Join(project, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	fixture.expect(t, project, "supabase start")
	// A command below the project root finds the config above it.
	fixture.expect(t, filepath.Join(fixture.linked, "supabase"), "supabase start", native)
}

func TestTomlStackFlagForms(t *testing.T) {
	for text, want := range map[string]bool{
		"[experimental]\nstack = true\n":                              true,
		"[experimental]\nstack=true":                                  true,
		"[ experimental ]  # local stacks\n  stack = true  # on\n":    true,
		"experimental.stack = true\n":                                 true,
		"\"experimental\".\"stack\" = true\n":                         true,
		"experimental = { stack = true }\n":                           true,
		"experimental = { other = 1, stack = true }\n":                true,
		"[experimental]\nother = \"# not a comment\"\nstack = true\n": true,
		"[experimental]\nstack = false\n":                             false,
		"[experimental]\nstack = \"true\"\n":                          false,
		"[experimental]\nstack = env(SUPABASE_STACK)\n":               false,
		"[experimental]\nstack = true\nstack = true\n":                false,
		"[api]\nstack = true\n":                                       false,
		"stack = true\n":                                              false,
		"[experimental]\n# stack = true\n":                            false,
		"[experimental.stack]\nenabled = true\n":                      false,
		"[db]\nnote = \"\"\"\n[experimental]\nstack = true\n\"\"\"\n": false,
		"[[remotes]]\nstack = true\n":                                 false,
		"":                                                            false,
	} {
		if got := tomlStackEnabled(text); got != want {
			t.Errorf("%q: %v, want %v", text, got, want)
		}
	}
}

func TestSupabaseRulesFollowTheCommandDirectory(t *testing.T) {
	fixture := newSupabaseFixture(t)
	from := fixture.plain
	native := "--runtime native"
	fixture.expect(t, from, "cd "+fixture.linked+" && supabase start", native)
	fixture.expect(t, from, "cd "+fixture.legacy+" && supabase start")
	fixture.expect(t, fixture.legacy, "cd ../wt/feat-b && supabase start", native)
	fixture.expect(t, from, "cd "+fixture.linked+"; supabase start", native)
	fixture.expect(t, from, "cd "+fixture.linked+"\nsupabase start", native)
	fixture.expect(t, from, "cd -P "+fixture.linked+" && supabase start", native)
	fixture.expect(t, from, "(cd "+fixture.linked+"; supabase start)", native)
	fixture.expect(t, from, "(cd "+fixture.linked+"); supabase start")
	fixture.expect(t, from, "cd "+fixture.linked+" | supabase start")
	fixture.expect(t, from, "cd "+fixture.linked+" & supabase start")
	fixture.expect(t, from, "pushd "+fixture.linked+" && supabase start", native)
	fixture.expect(t, fixture.linked, "popd && supabase start")
	fixture.expect(t, fixture.linked, `cd "$SOMEWHERE" && supabase start`)
	fixture.expect(t, fixture.linked, "cd - && supabase start")
	fixture.expect(t, from, "echo $(cd "+fixture.linked+" && supabase start)", native)
	fixture.expect(t, from, "echo $(cd "+fixture.linked+") && supabase start")
	fixture.expect(t, from, "supabase start --workdir "+fixture.linked, native)
	fixture.expect(t, from, "supabase start --workdir="+fixture.linked, native)
	// --workdir is used exactly as given, with no search above it.
	fixture.expect(t, from, "supabase start --workdir "+filepath.Join(fixture.linked, "supabase"))
	fixture.expect(t, from, "SUPABASE_WORKDIR="+fixture.linked+" supabase start", native)
	fixture.expect(t, from, "pnpm -C "+fixture.linked+" exec supabase start", native)
	fixture.expect(t, from, "pnpm --dir="+fixture.linked+" exec supabase start", native)
	fixture.expect(t, from, "yarn --cwd "+fixture.linked+" supabase start", native)
	fixture.expect(t, from, "bash -lc 'cd "+fixture.linked+" && supabase start'", native)
	fixture.expect(t, fixture.linked, `sh -c "supabase start"`, native)
	fixture.expect(t, fixture.linked, "bash -o pipefail -c 'supabase start | tee start.log'", native)
	fixture.expect(t, fixture.linked, "bash -O extglob --norc -ec 'supabase start'", native)
	fixture.expect(t, fixture.linked, "eval supabase start", native)
	fixture.expect(t, fixture.linked, "bash scripts/start.sh")
	fixture.expect(t, from, "timeout 120 bash -lc 'cd "+fixture.linked+" && supabase start'", native)
	fixture.expect(t, fixture.linked, "bash <<< 'supabase start'", native)
	// A package runner's shell mode runs its string in a shell too.
	fixture.expect(t, fixture.linked, "npx -c 'supabase start'", native)
	fixture.expect(t, fixture.linked, "pnpm exec -c 'supabase start'", native)
	fixture.expect(t, from, "bash <<'EOF'\ncd "+fixture.linked+"\nsupabase start\nEOF", native)
	fixture.home = fixture.linked
	fixture.expect(t, from, "cd && supabase start", native)
	fixture.expect(t, from, "cd ~ && supabase start", native)
	fixture.expect(t, from, "cd $HOME/supabase/.. && supabase start", native)
	fixture.expect(t, from, "cd ~/supabase && supabase start", native)
}

func TestSupabaseAlwaysOnRulesProtectOtherAgentsStacks(t *testing.T) {
	fixture := newSupabaseFixture(t)
	for _, cwd := range []string{fixture.legacy, fixture.linked, fixture.managed, fixture.plain, ""} {
		for _, command := range []string{"supabase stop --all", "npx supabase stop --all", "supabase stack stop --all", "supabase local stop --all", "supabase stop --all=true", "supabase --workdir . stop --all"} {
			fixture.expect(t, cwd, command, "every agent's local Supabase stack", "rndevtools `supabase` tool (operation down")
		}
		if cwd != fixture.managed {
			// In the managed worktree any stop is redirected instead.
			fixture.expect(t, cwd, "supabase stop --all=false --stack mine")
		}
		for _, command := range []string{"supabase stop --stack-id 64616c83", "supabase stack stop --stack-id=64616c83912c", "supabase stop --project-id example-app"} {
			fixture.expect(t, cwd, command, "may stop another agent's stack")
		}
		for _, command := range []string{"supabase stack destroy", "supabase stack destroy --stack-id 64616c83 --yes", "pnpm exec supabase local destroy"} {
			fixture.expect(t, cwd, command, "deletes a local database", "RN Devtools › Supabase", "operation destroy", "db reset --local")
		}
	}
	// --workdir and SUPABASE_WORKDIR may name only this worktree.
	fixture.expect(t, fixture.linked, "supabase stop --workdir "+fixture.legacy, "outside this worktree")
	fixture.expect(t, fixture.linked, "SUPABASE_WORKDIR="+fixture.legacy+" supabase stop", "outside this worktree")
	fixture.expect(t, fixture.linked, "supabase stop --workdir ../feat-a", "outside this worktree")
	fixture.expect(t, fixture.linked, "supabase stop --workdir .")
	fixture.expect(t, fixture.linked, "supabase stop --workdir supabase/..")
	fixture.expect(t, filepath.Join(fixture.linked, "supabase"), "supabase stop --workdir ..")

	for _, command := range []string{
		"pkill postgres", "pkill -9 -f supabase", "killall postgres", "sudo pkill -f edge-runtime",
		"kill $(pgrep postgres)", "kill -9 $(pgrep -f supabase)", "kill `pidof postgres`",
		"pgrep -f postgres | xargs kill -9", "ps aux | grep postgres | awk '{print $2}' | xargs kill",
		"pg_ctl -D /tmp/data stop -m fast", "pkill auth", "pkill -f gotrue", "killall beam.smp",
		"pkill -f 'postgres: '", "pkill -f realtime", "pkill mailpit", "/usr/bin/pkill postgres",
	} {
		fixture.expect(t, fixture.legacy, command, "kills every agent's database", "operation down")
	}
	for _, command := range []string{
		"pkill -f node", "kill 1234", "pgrep postgres", "pkill oauth-proxy", "killall Simulator",
		"ps aux | grep postgres", "pg_ctl status", "kill -0 $(cat metro.pid)", "pgrep -f supabase | wc -l",
		"echo postgres | xargs echo",
	} {
		fixture.expect(t, fixture.legacy, command)
	}
	// So are the scripts handed to a shell, however the shell runs, and the
	// command strings of the tools that run them.
	for command, want := range map[string]string{
		"timeout 60 sh -c 'supabase stop --all'":                "every agent's local Supabase stack",
		"xargs -I{} bash -c 'supabase stop --all'":              "every agent's local Supabase stack",
		"bash <<< 'supabase stop --all'":                        "every agent's local Supabase stack",
		"echo 'supabase stop --all' | sh":                       "every agent's local Supabase stack",
		"nice -n 10 bash -lc 'pkill -f supabase'":               "kills every agent's database",
		"sudo -u me sh -c 'kill $(pgrep postgres)'":             "kills every agent's database",
		"echo 'supabase stop --all' | sudo -u me sh":            "every agent's local Supabase stack",
		"echo 'pkill postgres' | timeout 60 bash":               "kills every agent's database",
		"bash<<<'supabase stop --all'":                          "every agent's local Supabase stack",
		"bash <<'EOF'\nsupabase stop --all\nEOF":                "every agent's local Supabase stack",
		"npx concurrently 'supabase stop --all' 'npm run api'":  "every agent's local Supabase stack",
		"tmux new -d 'pkill -f supabase'":                       "kills every agent's database",
		"echo 'supabase stop --all' | xargs -I{} sh -c '{}'":    "every agent's local Supabase stack",
		`osascript -e 'do shell script "supabase stop --all"'`:  "every agent's local Supabase stack",
		"env -S'supabase stop --all'":                           "every agent's local Supabase stack",
		`eval "$(echo 'supabase stop --all')"`:                  "every agent's local Supabase stack",
		"cat <<'EOF' | bash\nsupabase stack destroy --yes\nEOF": "deletes a local database",
	} {
		fixture.expect(t, fixture.legacy, command, want)
	}
	// A here-string or here-document is the shell's only when the shell is the
	// command: grep's input is text.
	for _, command := range []string{
		"grep sh <<< 'supabase stop --all'",
		"grep -c bash <<'EOF'\nsupabase stop --all\nEOF",
		"echo 'supabase stop --all' | sudo -u me tee notes.md",
	} {
		fixture.expect(t, fixture.legacy, command)
	}

	for command, file := range map[string]string{
		"supabase status --env > .env":                                ".env",
		"supabase status -o env >> .env.local":                        ".env.local",
		"supabase status --env &> .env":                               ".env",
		"supabase status --env >.env":                                 ".env",
		"supabase status --env>.env":                                  ".env",
		"supabase status --env >| .env":                               ".env",
		"supabase status -o env > apps/mobile/.env.development.local": "apps/mobile/.env.development.local",
		"supabase status --output=env > .env":                         ".env",
		"supabase status -oenv > .env":                                ".env",
		"supabase status --env --output-format text > .env.local":     ".env.local",
		"supabase status --env | tee .env":                            ".env",
		"supabase status -o env | tee -a .env.local":                  ".env.local",
		"supabase status -o env | grep KEY > .env":                    ".env",
		"supabase stack status --env > .env":                          ".env",
		`npx supabase status --env > "$PWD/.env"`:                     "$PWD/.env",
	} {
		fixture.expect(t, fixture.legacy, command, "SECRET_KEY", "operation env", file)
	}
	for _, command := range []string{
		"supabase status --env", "supabase status > status.txt", "supabase status -o env | grep API_URL",
		"supabase status --env > /tmp/supabase-status.txt", "supabase status -o json > status.json",
		"supabase status --env | pbcopy",
	} {
		fixture.expect(t, fixture.legacy, command)
	}

	// Here-document bodies are input, not commands: commit messages and files
	// that mention these commands pass.
	for _, command := range []string{
		"git commit -m \"$(cat <<'EOF'\nfix: never run supabase stop --all or pkill postgres\nEOF\n)\"",
		"cat > docs/local-db.md <<'EOF'\nsupabase start\nsupabase status --env > .env\nEOF",
		"cat > scripts/reset.sh <<EOF\nsupabase stack destroy --yes\nEOF",
	} {
		fixture.expect(t, fixture.linked, command)
	}
	fixture.expect(t, fixture.linked, "cat > notes.md <<'EOF'\nsupabase start\nEOF\nsupabase stop --all", "every agent's")

	// Only the command that runs rndevtools is exempt.
	fixture.expect(t, fixture.linked, "rndevtools supabase --operation up --worktree "+fixture.linked)
	fixture.expect(t, fixture.linked, `rndevtools claim --udid 727CE7B2-CCBA-47A5-8803-1D61DCEBCF44 --note "supabase stop --all broke it"`)
	fixture.expect(t, fixture.linked, "rndevtools doctor; supabase stop --all", "every agent's")
	fixture.expect(t, fixture.linked, "rndevtools doctor && pkill postgres", "kills every agent's database")
	fixture.expect(t, fixture.linked, "rndevtools supabase --operation up --worktree . && supabase start", "--runtime native")
}

func TestSupabaseManagedModeRedirectsToRNDevtools(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	up := "rndevtools supabase --operation up --worktree " + fixture.managed
	down := "rndevtools supabase --operation down --worktree " + fixture.managed
	for _, command := range []string{
		"supabase start", "supabase start --runtime native", "pnpm exec supabase start", "supabase stack start",
		"supabase stack restart", "supabase stack prepare --runtime native", "supabase local start", "supabase dev",
	} {
		fixture.expect(t, in, command, "RN Devtools runs this worktree's local Supabase", up, "lane up", "`pnpm exec supabase … --local`")
	}
	for _, command := range []string{"supabase stop", "pnpm exec supabase stop", "supabase stack stop", "supabase local stop"} {
		fixture.expect(t, in, command, down, "data is kept")
	}
	fixture.expect(t, in, "supabase db start", up)
	fixture.expect(t, in, "supabase migration up --local --runtime docker", "--runtime`", "always native", up)
	for _, command := range []string{
		"npx supabase@latest migration up --local", "npx -p supabase@2.0.0 supabase migration up --local",
		"pnpm dlx supabase migration up --local", "pnpx supabase gen types typescript --local",
		"yarn dlx supabase gen types typescript --local", "bunx supabase@latest db reset --local",
		"/opt/homebrew/bin/supabase migration up --local", "~/bin/supabase db reset --local",
	} {
		fixture.expect(t, in, command, "only answers the CLI build that started it", "`pnpm exec supabase`")
	}
	for _, command := range []string{
		"pnpm exec supabase migration up --local", "./node_modules/.bin/supabase migration up --local",
		fixture.managed + "/node_modules/.bin/supabase migration list --local", "supabase migration up --local",
		"npx supabase db reset --local", "supabase status", "supabase status --env", "supabase stack list",
		"supabase stack logs --tail 50", "supabase gen types typescript --local", "supabase migration new add_profiles",
		"supabase db diff", "supabase db pull", "supabase migration squash", "supabase db schema declarative generate",
		"supabase test db", "supabase start --help",
	} {
		fixture.expect(t, in, command)
	}
	// The app directory of a monorepo worktree uses the worktree's project.
	fixture.expect(t, filepath.Join(fixture.managed, "apps", "mobile"), "supabase start", up)
	// --workdir and cd reach a managed root from elsewhere.
	fixture.expect(t, fixture.plain, "supabase start --workdir "+fixture.managed, up)
	fixture.expect(t, fixture.plain, "cd "+fixture.managed+" && supabase stop", down)
	// The rules that protect other agents still come first.
	fixture.expect(t, in, "supabase stop --all", "every agent's")
	fixture.expect(t, in, "supabase stack destroy", "deletes a local database")
	// The payload may name the worktree through a symlink (/var and /private/var).
	fixture.expect(t, filepath.Join(fixture.raw, "wt", "feat-a"), "supabase start", up)
	// The desktop is probed once per call, and not at all outside managed roots.
	fixture.probes = 0
	fixture.judge(in, "supabase status; supabase migration up --local; supabase gen types typescript --local")
	if fixture.probes != 1 {
		t.Fatalf("probed the desktop %d times in one call", fixture.probes)
	}
	fixture.probes = 0
	fixture.judge(fixture.linked, "supabase start --runtime native")
	fixture.judge(fixture.legacy, "supabase stop --all")
	if fixture.probes != 0 {
		t.Fatalf("probed the desktop %d times for unmanaged commands", fixture.probes)
	}
}

func TestSupabaseManagedModeWaitsForTheBranchStack(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	fixture.steering.roots[0].stackReady = false
	for _, command := range []string{"supabase db diff", "supabase db pull", "supabase migration squash", "supabase db schema declarative sync", "supabase db diff --linked"} {
		fixture.expect(t, in, command, "no running local stack yet", "operation up")
	}
	for _, command := range []string{"supabase db schema declarative generate --linked", "supabase migration up --local", "supabase gen types typescript --local"} {
		fixture.expect(t, in, command)
	}
	// Ready, until the worktree moves to another branch.
	fixture.steering.roots[0].stackReady = true
	fixture.expect(t, in, "supabase db diff")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "ref: refs/heads/feat-c\n")
	fixture.expect(t, in, "supabase db diff", "no running local stack yet")
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
	fixture.expect(t, in, "supabase db diff", "no running local stack yet")
	fixture.steering.roots[0].branchContext = "detached"
	fixture.expect(t, in, "supabase db diff")
	// An unreadable HEAD is no reason to block.
	write(t, filepath.Join(fixture.managed, ".git", "HEAD"), "garbage\n")
	fixture.expect(t, in, "supabase db diff")
}

func TestSupabaseManagedModeMatchesTheProjectAndTheRepository(t *testing.T) {
	fixture := newSupabaseFixture(t)
	nested := filepath.Join(fixture.managed, "apps", "other")
	write(t, filepath.Join(nested, "supabase", "config.toml"), "[experimental]\nstack = true\n")
	// Another project inside a managed root is not the root's own.
	fixture.expect(t, nested, "supabase start", "without `--runtime native`")
	fixture.expect(t, nested, "supabase start --runtime native")
	// A linked worktree may run the CLI from its repository's main checkout.
	fixture.steering.roots = append(fixture.steering.roots, steeringRoot{
		worktreeRoot: fixture.linked, projectRoot: fixture.linked, branchContext: "refs/heads/feat-b", stackReady: true, runner: "npx supabase",
	})
	fixture.expect(t, fixture.linked, "supabase start", "rndevtools supabase --operation up --worktree "+fixture.linked, "`npx supabase … --local`")
	fixture.expect(t, fixture.linked, fixture.repo+"/node_modules/.bin/supabase migration up --local")
	fixture.expect(t, fixture.linked, fixture.legacy+"/node_modules/.bin/supabase migration up --local", "Run `npx supabase` from this worktree")
	fixture.expect(t, fixture.linked, "supabase db diff")
}

func TestSupabaseManagedModeNeedsALiveDesktop(t *testing.T) {
	fixture := newSupabaseFixture(t)
	in := fixture.managed
	// A desktop that does not answer left its file behind: fallback rules.
	fixture.reachable = false
	fixture.expect(t, in, "supabase start", "without `--runtime native`", "`supabase start --runtime native`")
	fixture.expect(t, in, "supabase start --runtime native")
	fixture.expect(t, in, "supabase stop")
	// So does a file older than three minutes, without a probe.
	fixture.reachable = true
	fixture.probes = 0
	fixture.now = fixture.steering.writtenAt.Add(steeringFreshFor + time.Second)
	fixture.expect(t, in, "supabase start", "without `--runtime native`")
	if fixture.probes != 0 {
		t.Fatalf("probed the desktop %d times for a stale file", fixture.probes)
	}
	fixture.now = fixture.steering.writtenAt.Add(-2 * time.Minute)
	fixture.expect(t, in, "supabase start", "without `--runtime native`")
	fixture.now = fixture.steering.writtenAt.Add(time.Minute)
	fixture.expect(t, in, "supabase start", "operation up")
}

func TestSupabaseSteeringFileThroughTheHook(t *testing.T) {
	fixture := newSupabaseFixture(t)
	// Unix socket paths are short on macOS, so use a short private directory.
	directory, err := os.MkdirTemp("", "rdt-steer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	file := filepath.Join(directory, steeringFileName)
	socket := filepath.Join(directory, "rndevtools.sock")
	environment := supabaseEnvironment{
		steering:  func() (steeringState, bool) { return readSteering(directory) },
		reachable: func() bool { return client.Reachable(socket, desktopProbeTimeout) },
		now:       time.Now,
		home:      func() string { return fixture.home },
		getenv:    func(string) string { return "" },
	}
	judge := func(cwd string, command string) HookDecision {
		return evaluateShellCallWith(shellCall{command: command, cwd: cwd}, environment)
	}
	content := fmt.Sprintf(`{"version":1,"writtenAt":%d,"desktopPid":4242,"supabase":{"enabled":true,"roots":[`+
		`{"worktreeRoot":%q,"projectRoot":%q,"mode":"managed","branchContext":"refs/heads/feat-a","stackReady":true,"runner":"pnpm exec supabase"}]}}`,
		time.Now().UnixMilli(), fixture.managed, fixture.managed)
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// No desktop listens: a crash left the file, so the fallback rules apply.
	if decision := judge(fixture.managed, "supabase start"); !decision.Block || !strings.Contains(decision.Reason, "without `--runtime native`") {
		t.Fatalf("dead desktop: %+v", decision)
	}
	// A desktop listening on its socket manages the root.
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	if err := os.Chmod(socket, 0o600); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.managed, "supabase start"); !decision.Block || !strings.Contains(decision.Reason, "operation up") {
		t.Fatalf("live desktop: %+v", decision)
	}
	if !judge(fixture.legacy, "supabase stop --all").Block {
		t.Fatal("a valid file turns the rules on")
	}
	// A file anyone else could have written turns every Supabase rule off.
	if err := os.Chmod(file, 0o620); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("a group-writable file must be ignored: %q", decision.Reason)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	// So does a symlink in its place, or garbage.
	real := filepath.Join(directory, "real.json")
	if err := os.Rename(file, real); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, file); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("a symlinked file must be ignored: %q", decision.Reason)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if decision := judge(fixture.legacy, "supabase stop --all"); decision.Block {
		t.Fatalf("an invalid file must be ignored: %q", decision.Reason)
	}
	// Simulator rules never depend on the file.
	if !judge(fixture.legacy, "xcrun simctl shutdown all").Block {
		t.Fatal("simctl rules run regardless of steering")
	}
}

func TestSupabaseRulesFailOpen(t *testing.T) {
	broken := supabaseEnvironment{
		steering:  func() (steeringState, bool) { panic("unreadable") },
		reachable: func() bool { return true },
		now:       time.Now,
		home:      func() string { return "/Users/example" },
		getenv:    func(string) string { return "" },
	}
	if decision := evaluateShellCallWith(shellCall{command: "supabase stop --all", cwd: "/w"}, broken); decision.Block {
		t.Fatalf("a failing rule must fail open: %q", decision.Reason)
	}
	fixture := newSupabaseFixture(t)
	for _, command := range []string{
		"supabase", "supabase ''", "npx", "pnpm exec", "pnpm", "yarn dlx", "npm exec --", "bun",
		`supabase "unterminated`, "supabase $(", "cd", "kill", "xargs kill", "supabase --workdir",
		"supabase stop --workdir", "SUPABASE_WORKDIR= supabase stop", "npx -c", "env -S",
		"supabase-cli start", "supabase.sh start",
	} {
		fixture.expect(t, fixture.linked, command)
	}
}
