package setup

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// MARK: - What the README says the hook follows

// The text rule declines a steered command whose text is on the line, so a
// test of what the word rules follow has to keep the command where the text
// rule cannot read it: ex''po start is expo start to a shell and a different
// word to the text rule. Each claim below is a way the README says a command
// hands a script on, with that text as its payload.

// claim is one way to hand a payload on to a shell.
type claim struct {
	what  string
	lines []string
}

// followedClaims are the lines that hand payload on, the ways the README
// lists. In each, PAYLOAD stands for the payload inside double quotes.
func followedClaims(payload string) []claim {
	shells := strings.Fields("bash sh zsh dash ksh mksh ash fish csh tcsh")
	launchers := []string{
		"sudo", "sudo -u me", "doas", "doas -u me", "env", "env -u FOO", "command", "exec", "builtin", "time", "nohup",
		"timeout 5", "gtimeout 5", "nice", "nice -n 5", "caffeinate", "caffeinate -t 5", "stdbuf -oL", "arch",
		"arch -arm64", "script -q /dev/null", "sandbox-exec -p x", "taskpolicy -c utility", "setsid", "unbuffer",
		"chronic", "ionice -c 3", "noglob", "nocorrect",
	}
	runners := []string{"timeout 5", "nice", "xargs", "find . -exec", "sudo -u me", "docker exec box", "ssh host", "kubectl exec pod --", "watch -n 1", "env FOO=1"}
	var shellLines, launcherLines, runnerLines []string
	for _, shell := range shells {
		shellLines = append(shellLines,
			shell+` -c "PAYLOAD"`,
			shell+` <<< "PAYLOAD"`,
			`echo "PAYLOAD" | `+shell,
			shell+" <<'EOF'\nPAYLOAD\nEOF",
		)
	}
	for _, launcher := range launchers {
		launcherLines = append(launcherLines,
			launcher+` bash <<< "PAYLOAD"`,
			`printf "PAYLOAD\n" | `+launcher+` bash`,
		)
	}
	for _, runner := range runners {
		runnerLines = append(runnerLines, runner+` bash -c "PAYLOAD"`)
	}
	claims := []claim{
		{"a shell's -c string, its here-string, its pipe, and its here-document", shellLines},
		{"a shell that a launcher runs", launcherLines},
		{"a shell that another command runs with -c", runnerLines},
		{"eval and what a lone $(echo …) prints", []string{
			`eval "PAYLOAD"`,
			`builtin eval "PAYLOAD"`,
			`eval $(echo "PAYLOAD")`,
			`bash -c "$(echo "PAYLOAD")"`,
			`bash <<<"$(printf "PAYLOAD")"`,
			`$(echo "PAYLOAD")`,
			"sh -c \"`echo \"PAYLOAD\"`\"",
		}},
		{"the command strings of the tools that run one", []string{
			`env -S "PAYLOAD"`,
			`script -c "PAYLOAD" /dev/null`,
			`npx -c "PAYLOAD"`,
			`npm exec --call "PAYLOAD"`,
			`pnpm exec -c "PAYLOAD"`,
			`yarn exec "PAYLOAD"`,
			`bun exec "PAYLOAD"`,
		}},
		{"every argument of the tools that run their strings", []string{
			`concurrently "PAYLOAD"`,
			`npx concurrently -n a,b "echo hi" "PAYLOAD"`,
			`watch "PAYLOAD"`,
			`nodemon "PAYLOAD"`,
			`watchexec "PAYLOAD"`,
			`entr "PAYLOAD"`,
			`parallel "PAYLOAD"`,
			`su me -c "PAYLOAD"`,
		}},
		{"the tmux commands that take a shell command or keys", []string{
			`tmux -c "PAYLOAD"`,
			`tmux new-session -d -s metro "PAYLOAD"`,
			`tmux new -d "PAYLOAD"`,
			`tmux new-window "PAYLOAD"`,
			`tmux neww "PAYLOAD"`,
			`tmux split-window -h "PAYLOAD"`,
			`tmux splitw "PAYLOAD"`,
			`tmux respawn-pane -k "PAYLOAD"`,
			`tmux respawnp -k "PAYLOAD"`,
			`tmux respawn-window -k "PAYLOAD"`,
			`tmux respawnw -k "PAYLOAD"`,
			`tmux run-shell "PAYLOAD"`,
			`tmux run -b "PAYLOAD"`,
			`tmux if-shell true "PAYLOAD"`,
			`tmux if true "PAYLOAD"`,
			`tmux pipe-pane -t metro "PAYLOAD"`,
			`tmux pipep -t metro "PAYLOAD"`,
			`tmux display-popup -E "PAYLOAD"`,
			`tmux popup -E "PAYLOAD"`,
			`tmux send-keys -t metro "PAYLOAD" Enter`,
			`tmux send -t metro "PAYLOAD" Enter`,
		}},
		{"the do shell script, do script, and write text of osascript", []string{
			`osascript -e 'do shell script "PAYLOAD"'`,
			`osascript -e 'tell application "Terminal" to do script "PAYLOAD"'`,
			`osascript -e 'tell application "iTerm" to write text "PAYLOAD"'`,
			"osascript <<'EOF'\ntell application \"Terminal\"\n  do script \"PAYLOAD\"\nend tell\nEOF",
		}},
		{"text echo or printf pipes in, through cat, tee, or a group piped straight in", []string{
			`echo "PAYLOAD" | cat | bash`,
			`echo "PAYLOAD" | tee | bash`,
			`echo "PAYLOAD" | tee out.sh | bash`,
			`echo "PAYLOAD" | tee -a metro.log | bash`,
			`echo -n "PAYLOAD" | bash`,
			`echo -e "PAYLOAD" | bash`,
			`echo -ne "PAYLOAD" | bash`,
			`(echo "PAYLOAD") | bash`,
			`{ echo "PAYLOAD"; } | bash`,
			`(echo a; echo "PAYLOAD") | bash`,
			`( echo "PAYLOAD" ) |& sudo -u me sh`,
			`(echo "PAYLOAD") | (bash)`,
			"{ cat <<'EOF'; } | bash\nPAYLOAD\nEOF",
			"cat <<'EOF' | sudo -u me bash\nPAYLOAD\nEOF",
		}},
		{"a script file the line writes, then runs", []string{
			`echo "PAYLOAD" > run.sh && sh run.sh`,
			`echo "PAYLOAD" > run.sh && source run.sh`,
			`echo "PAYLOAD" > run.sh && . run.sh`,
			`echo "PAYLOAD" > run.sh && chmod +x run.sh && ./run.sh`,
			`echo "PAYLOAD" | tee run.sh >/dev/null && bash run.sh`,
			`echo "PAYLOAD" | tee -a run.sh >/dev/null && bash run.sh`,
			`echo "PAYLOAD" | tee --append run.sh >/dev/null && bash run.sh`,
			`echo "PAYLOAD" | tee -a other.sh run.sh >/dev/null && bash run.sh`,
			"cat > run.sh <<'EOF'\nPAYLOAD\nEOF\nbash run.sh",
			`echo a > run.sh; echo "PAYLOAD" >> run.sh; bash run.sh`,
			`printf '%s\n' "PAYLOAD" > run.sh; bash ./run.sh`,
		}},
		{"what xargs builds a shell's -c string from", []string{
			`echo "PAYLOAD" | xargs -I{} sh -c '{}'`,
			`echo "PAYLOAD" | xargs -I % bash -c %`,
			`echo "PAYLOAD" | xargs -0 bash -c`,
			`printf '%s\n' "PAYLOAD" | xargs -d '\n' sh -c`,
			`xargs -I{} sh -c '{}' <<< "PAYLOAD"`,
		}},
	}
	for index := range claims {
		for at, line := range claims[index].lines {
			claims[index].lines[at] = strings.ReplaceAll(line, "PAYLOAD", payload)
		}
	}
	return claims
}

func TestHookFollowsEveryClaimOfTheREADMEWhenTheTextIsHidden(t *testing.T) {
	for _, claim := range followedClaims(`ex''po start`) {
		if len(claim.lines) == 0 {
			t.Fatalf("%s: no lines", claim.what)
		}
		for _, line := range claim.lines {
			if decision := EvaluateShellCommand(line); !decision.Block || !strings.Contains(decision.Reason, "Metro") {
				t.Errorf("%s: %q should be declined with Metro, got %+v", claim.what, line, decision)
			}
		}
	}
}

func TestSupabaseRulesFollowEveryClaimOfTheREADME(t *testing.T) {
	// The Supabase rules follow the same scripts as the Simulator rules, from
	// the directory they run in, and have no text rule behind them.
	fixture := newSupabaseFixture(t)
	for _, claim := range followedClaims(`supabase stop --all`) {
		for _, line := range claim.lines {
			fixture.expect(t, fixture.legacy, line, "every agent's local Supabase stack")
		}
	}
	for _, claim := range followedClaims(`cd ` + fixture.linked + ` && supabase start`) {
		for _, line := range claim.lines {
			fixture.expect(t, fixture.legacy, line, "--runtime native")
		}
	}
}

func TestSupabaseRulesSeeTheCommandsAfterAnEscapedOperatorAndAnEscapedDelimiter(t *testing.T) {
	// The Supabase rules read the same splitter, and have no text rule behind
	// them: a command the splitter took for an argument of echo, or for the
	// body of a here-document, is a command nobody judges.
	fixture := newSupabaseFixture(t)
	for _, line := range []string{
		`echo \>| eval 'supabase stop --all'`,
		`echo hi \<& eval 'supabase stop --all'`,
		`echo \>& bash -c 'supabase stop --all'`,
		"cat <<E\\ F\nE F\nsupabase stop --all",
		"cat <<EOF\\\\\nEOF\\\n\nsupabase stop --all",
		"cat <<E\\\\F\nE\\F\nsupabase stop --all",
		"cat <<O\\>\nO>\nsupabase stop --all",
	} {
		fixture.expect(t, fixture.legacy, line, "every agent's local Supabase stack")
	}
	// A delimiter whose escapes leave a name still starts a here-document.
	fixture.expect(t, fixture.legacy, "cat <<\\EOF\nsupabase stop --all\nEOF")
	fixture.expect(t, fixture.legacy, "cat <<E\\OF\nsupabase stop --all\nEOF")
}

func TestHookDoesNotFollowWhatTheREADMEListsAsNotRecognized(t *testing.T) {
	// A file the line writes and then feeds to a shell some other way, or
	// reads in a place the hook does not look, runs a steered command the
	// hook never sees when the text is hidden.
	wantPassing(t, []string{
		`echo "ex''po start" > run.sh && bash < run.sh`,
		`echo "ex''po start" > run.sh && cat run.sh | bash`,
		`echo "ex''po start" > run.sh && bash -c "$(cat run.sh)"`,
		`echo ZXhwbyBzdGFydAo= | base64 -d | sh`,
		`(echo "ex''po start") 2>&1 | bash`,
		`CMD="ex''po start"; bash -c "$CMD"`,
		// A << that the shell reads as a shift, and the splitter as a
		// here-document: the lines after it are taken for its body.
		"(( echo << y ))\nex''po start\ny",
		"echo ${x:-<<EOF }\nex''po start\nEOF",
		// A delimiter that is no name is read as commands, and a line of the
		// body that ends in a backslash joins the line after it.
		"cat <<EOF\\\\\nEOF\\\nex''po start",
	})
	// The text rule still sees a mention in a command it reads on such a line,
	// and the excuse never covers one: a line with (( or $ gets none.
	wantDeclined(t, []verdictRow{
		{"echo 'npx expo start'; (( echo << y ))\nex''po start\ny", "Metro", "declined"},
		{"echo 'npx expo start'; echo ${x:-<<EOF }\nex''po start\nEOF", "Metro", "declined"},
		{"echo 'npx expo start'; cat <<EOF\\\\\nEOF\\\nex''po start", "Metro", "declined"},
	})
	// And of the lines it takes for such a body, the text rule reads the $( )
	// and backtick substitutions, as in any << whose delimiter has no quoting:
	// the shell runs them there too. Nothing else of the body is read.
	wantDeclined(t, []verdictRow{
		{"(( x << y ))\n$(npx expo start)\ny", "Metro", "passed"},
		{"(( x << y ))\n`npx expo start`\ny", "Metro", "passed"},
		{"echo ${x:-<<EOF }\n$(npx expo start)\nEOF", "Metro", "passed"},
	})
	wantPassing(t, []string{
		"(( x << y ))\nnpx expo start\ny",
		"echo ${x:-<<EOF }\nnpx expo start\nEOF",
		"(( x << 'y' ))\n$(npx expo start)\ny",
	})
}

// MARK: - How deep the hook follows

// handedDeep builds the nested scripts of a here-document, or of a -c string,
// depth levels deep around inner.
func handedDeep(depth int, inner string, heredocs bool) string {
	if !heredocs {
		text := inner
		for level := 0; level < depth; level++ {
			text = "bash -c '" + strings.ReplaceAll(text, "'", `'\''`) + "'"
		}
		return text
	}
	lines := make([]string, 0, 2*depth+1)
	for level := 1; level <= depth; level++ {
		lines = append(lines, fmt.Sprintf("bash <<'EOF%d'", level))
	}
	lines = append(lines, inner)
	for level := depth; level >= 1; level-- {
		lines = append(lines, fmt.Sprintf("EOF%d", level))
	}
	return strings.Join(lines, "\n")
}

func TestHookFollowsScriptsFourLevelsDeepAndNoDeeper(t *testing.T) {
	// The limit is a number the README states, so the test states it too.
	fixture := newSupabaseFixture(t)
	for _, heredocs := range []bool{true, false} {
		for depth := 1; depth <= 6; depth++ {
			simulator := handedDeep(depth, `ex''po start`, heredocs)
			supabase := handedDeep(depth, `supabase stop --all`, heredocs)
			decision := EvaluateShellCommand(simulator)
			if followed := depth <= 4; decision.Block != followed {
				t.Errorf("heredocs %v, depth %d: Simulator rules declined %v, want %v", heredocs, depth, decision.Block, followed)
			}
			blocked := fixture.judge(fixture.legacy, supabase).Block
			if followed := depth <= 4; blocked != followed {
				t.Errorf("heredocs %v, depth %d: Supabase rules declined %v, want %v", heredocs, depth, blocked, followed)
			}
		}
	}
}

func TestHookFollowsWhatALoneSubstitutionPrintsAtTheDepthOfTheCommandString(t *testing.T) {
	// bash -c "$(echo 'ex''po start')" hands on two scripts at once: the word
	// itself, and what it prints, which is the command string the shell
	// actually receives. Reading the word alone reaches what it prints one
	// level later, and at the fourth level that is past the limit.
	fixture := newSupabaseFixture(t)
	for depth := 0; depth <= 4; depth++ {
		simulator := handedDeep(depth, `bash -c "$(echo 'ex''po start')"`, false)
		supabase := handedDeep(depth, `bash -c "$(echo 'supabase stop --all')"`, false)
		decision := EvaluateShellCommand(simulator)
		blocked := fixture.judge(fixture.legacy, supabase).Block
		// The string is one level deeper than the shell that gets it, so it is
		// the fourth level for the third of three wrappers.
		if followed := depth <= 3; decision.Block != followed || blocked != followed {
			t.Errorf("%d wrappers: Simulator rules declined %v, Supabase rules %v, want %v", depth, decision.Block, blocked, followed)
		}
	}
}

// MARK: - The substitutions in a here-document the shell expands

func TestHookReadsTheSubstitutionsOfAnUnquotedHereDocument(t *testing.T) {
	// The shell runs $( ) and backticks in the body of a here-document whose
	// delimiter has no quoting; the original hook read the body as text. A
	// body with a quoted delimiter ('EOF', "EOF", \EOF, E"O"F) is literal.
	wantDeclined(t, []verdictRow{
		{"gh pr create --title 'Docs' --body \"$(cat <<EOF\nRun `npx expo start` to try it.\nEOF\n)\"", "Metro", "passed"},
		{"git commit -m \"$(cat <<EOF\nDocs: run `xcrun simctl boot X` first\nEOF\n)\"", "simctl boot", "passed"},
		{"gh pr create --body \"$(cat <<EOF\nRun $(npx expo start) to try it.\nEOF\n)\"", "Metro", "passed"},
		{"cat <<EOF > notes.md\nRun `npx expo start`\nEOF", "Metro", "passed"},
		{"cat > notes.md <<EOF\nRun $(npx expo start)\nEOF", "Metro", "passed"},
		{"cat <<EOF\n$(npx expo start)\nEOF", "Metro", "passed"},
		{"cat <<EOF\nRun ${x:-$(npx expo start)}\nEOF", "Metro", "passed"},
		{"cat <<-EOF\n\t$(npx expo start)\n\tEOF", "Metro", "passed"},
		{"cat <<EOF\n$(echo $(npx expo start))\nEOF", "Metro", "passed"},
		{"cat <<EOF\n$(cd app\nnpx expo start)\nEOF", "Metro", "passed"},
		{"cat <<EOF1 <<EOF2\nplain\nEOF1\n$(npx expo start)\nEOF2", "Metro", "passed"},
		{"cat <<\"A\" <<B\nliteral $(npx expo start)\nA\n$(npx expo start)\nB", "Metro", "passed"},
		{"(cat <<EOF\n$(npx expo start)\nEOF\n)", "Metro", "passed"},
		{"cat <<EOF | tr a-z A-Z\n$(xcrun simctl shutdown all)\nEOF", "simctl shutdown", "passed"},
		{"cat <<EOF\n$(cat <<INNER\n$(npx expo start)\nINNER\n)\nEOF", "Metro", "passed"},
		// The original hook declined these only because of the mention before the
		// here-document, and the excuse would have let them through.
		{"echo 'npx expo start' >/dev/null; cat <<EOF\n$(npx expo start)\nEOF", "Metro", "declined"},
		{"echo 'npx expo start' >/dev/null; cat <<EOF\n`xcrun simctl boot X`\nEOF", "Metro", "declined"},
	})
	wantRunning(t, []runningRow{
		{"gh pr create --body \"$(cat <<'EOF'\nRun `npx expo start` to try it.\nEOF\n)\"", "passed"},
		{"cat <<'EOF' > notes.md\nRun `npx expo start` and $(xcrun simctl boot X)\nEOF", "passed"},
		{"cat <<\"EOF\"\nRun $(npx expo start)\nEOF", "passed"},
		{"cat <<\\EOF\nRun $(npx expo start)\nEOF", "passed"},
		{"cat <<E\"O\"F\nRun $(npx expo start)\nEOF", "passed"},
		// A backslash quotes the $ and the backtick; other substitutions are not steered.
		{"cat <<EOF\nRun \\$(npx expo start) and \\`xcrun simctl boot X\\`\nEOF", "passed"},
		{"cat <<EOF\nRun $(date) and `uname`: no steered command here\nEOF", "passed"},
		{"cat <<EOF\nRun $((1 + 2)) times\nEOF", "passed"},
	})
	// The Supabase rules read the same substitutions, from the directory
	// of the command that reads the body.
	fixture := newSupabaseFixture(t)
	fixture.expect(t, fixture.plain, "cat <<EOF\n$(supabase stop --all)\nEOF", "every agent's local Supabase stack")
	fixture.expect(t, fixture.plain, "cat <<EOF\n`pkill postgres`\nEOF", "Blocked")
	fixture.expect(t, fixture.plain, "cd "+fixture.linked+" && cat <<EOF\n$(supabase start)\nEOF", "--runtime native")
	fixture.expect(t, fixture.plain, "(cd "+fixture.linked+" && cat <<EOF\n$(supabase start)\nEOF\n)", "--runtime native")
	fixture.expect(t, fixture.linked, "(cd "+fixture.plain+" && cat <<EOF\n$(supabase start)\nEOF\n)")
	fixture.expect(t, fixture.linked, "cat <<EOF\n$(supabase start --runtime native)\nEOF")
	fixture.expect(t, fixture.plain, "cat <<'EOF'\n$(supabase stop --all)\nEOF")
}

func TestHookReadsWhereAnExpandedHereDocumentEnds(t *testing.T) {
	// In the body of a document whose delimiter is unquoted, a backslash and a
	// newline join two lines. EOF\ and an empty line is the delimiter line, so
	// the shell runs what follows it; a splitter that reads the lines as they
	// are takes that for more body, and with it the command a rule would see.
	wantDeclined(t, []verdictRow{
		{"echo 'npx expo start' <<-_x > f\n_x\\\n\ngh pr create --title 'npx expo start' ; npx expo start", "Metro", "declined"},
		{"git log -S 'npx expo start' << EOF1 2>&1\nEOF1\\\n\nnpx expo start &", "Metro", "declined"},
		{"echo 'npx expo start' <<-A ; echo after\nnpx expo start\nx\nA\\\n\nnpx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start' <<EOF\nEOF\\\n\nnpx expo start", "Metro", "declined"},
		{"tr a b <<-_x > f\n_x\\\n\nnpx expo start &", "Metro", "passed"},
		{"true <<EOF\\\n && cat\nEOF\\\n\nnpx expo start\nEOF \necho done", "Metro", "passed"},
		{"cat <<EOF\nEO\\\nF\nnpx expo start", "Metro", "passed"},
		{"cat <<EOF\nbody\\\n\nEOF\\\n\nnpx expo start", "Metro", "passed"},
		// The body a shell reads has the joined lines, so a command can be split
		// across two of them.
		{"bash <<EOF\nnpx exp\\\no start\nEOF", "Metro", "passed"},
		{"cat > run.sh <<EOF\nnpx exp\\\no start\nEOF\nsh run.sh", "Metro", "passed"},
	})
	// A line that ends in a backslash before a delimiter line is no delimiter
	// line, and a quoted delimiter leaves every line as it is.
	wantRunning(t, []runningRow{
		{"cat <<EOF\nnote\\\nEOF\nEOF\nls", "passed"},
		{"cat <<'EOF'\nnpx expo start\nEOF\\\n\nEOF\nls", "passed"},
		{"cat <<'EOF'\nEOF\\\n\nnpx expo start\nEOF\nls", "passed"},
		{"cat <<EOF\nEOF\nls", "passed"},
	})
}

// MARK: - Groups piped into a shell

func TestHookReadsBraceGroupsNestedInEachOther(t *testing.T) {
	// A { is a word, so one segment can open several groups, and the commands
	// of an inner group print to the outer group's output as well, unless the
	// inner group's own output goes elsewhere.
	wantDeclined(t, []verdictRow{
		{`{ echo 'ex''po start'; { echo b; }; echo c; } | sh`, "Metro", "passed"},
		{`{ echo a; { echo 'ex''po start'; }; echo c; } | sh`, "Metro", "passed"},
		{`{ { echo 'ex''po start'; }; } | sh`, "Metro", "passed"},
		{`{ { { echo 'ex''po start'; }; }; } | sh`, "Metro", "passed"},
		{"{ echo a\n{ echo b\n{ echo 'ex''po start'\n}\n}\n} | bash", "Metro", "passed"},
		{`{ { echo 'ex''po start'; } | cat; } | sh`, "Metro", "passed"},
		{`{ echo a; { echo b; } > /dev/null; echo 'ex''po start'; } | sh`, "Metro", "passed"},
		{`if true; then { echo 'ex''po start'; } | sh; fi`, "Metro", "passed"},
		{`! { echo 'ex''po start'; } | sh`, "Metro", "passed"},
		{`{ echo 'ex''po start'; { echo b; } > notes.txt; } > run.sh && sh run.sh`, "Metro", "passed"},
	})
	// An inner group whose output goes to a file, a pipe that ends in one, or
	// away, prints nothing to the outer group.
	wantRunning(t, []runningRow{
		{`{ echo a; { echo 'ex''po start'; } > /dev/null; } | sh`, "passed"},
		{`{ echo a; { echo 'ex''po start'; } > notes.txt; echo c; } | sh`, "passed"},
		{`{ echo a; { echo 'ex''po start'; } | cat > out.txt; } | sh`, "passed"},
		{`{ { echo 'ex''po start'; } > notes.txt; } | sh`, "passed"},
		{`{ echo a; { { echo 'ex''po start'; }; } > notes.txt; } | sh`, "passed"},
		{`{ echo a; { echo 'ex''po start'; } | wc -l; } | sh`, "passed"},
		// And neither does a command of the group that is piped on, or one that
		// writes to a file.
		{`{ echo 'ex''po start' | wc -l; } | sh`, "passed"},
		{`(echo 'ex''po start' | wc -l) | sh`, "passed"},
		{`{ echo 'ex''po start' > notes.txt; } | sh`, "passed"},
		{`(echo 'ex''po start' > notes.txt) | sh`, "passed"},
	})
}

func TestGroupHelpersReadBraces(t *testing.T) {
	for _, row := range []struct {
		words []string
		opens int
	}{
		{nil, 0},
		{[]string{"echo", "{"}, 0},
		{[]string{"{", "echo"}, 1},
		{[]string{"{", "{", "echo", "{"}, 2},
		{[]string{"then", "{", "echo"}, 1},
		{[]string{"!", "{", "{", "FOO=1", "{", "echo"}, 3},
		{[]string{"{"}, 1},
		{[]string{"}", "{"}, 1},
	} {
		if got := opensGroups(row.words); got != row.opens {
			t.Errorf("opensGroups(%q) = %d, want %d", row.words, got, row.opens)
		}
	}
	for _, row := range []struct {
		line   string
		closes bool
	}{
		{"}", true},
		{"} > out.txt", true},
		{"} 2>&1", true},
		{"} }", false},
		{"echo }", false},
		{"{", false},
	} {
		line := parseShellLine(row.line)
		if got := closesGroup(line.segments[0].io()); got != row.closes {
			t.Errorf("closesGroup(%q) = %v, want %v", row.line, got, row.closes)
		}
	}
}

func TestGroupTextReadsBackToTheMatchingBrace(t *testing.T) {
	// Segments of the first line: `{ echo a`, `{ echo b`, `}`, `echo c`, `}`.
	line := parseShellLine("{ echo a; { echo b; }; echo c; } | sh")
	closer := len(line.segments) - 2
	if text, ok := groupText(line, closer, 0); !ok || text != "a\nb\nc" {
		t.Fatalf("the outer group prints %q (%v), want its own commands and the inner group's", text, ok)
	}
	if text, ok := groupText(line, 2, 0); !ok || text != "b" {
		t.Fatalf("the inner group prints %q (%v)", text, ok)
	}
	// Without an opening brace there is no group to read.
	line = parseShellLine("echo a; } | sh")
	if text, ok := groupText(line, 1, 0); ok {
		t.Fatalf("a } with no { prints %q", text)
	}
	// A group opened outside the scope of the } is not this group: the ( )
	// group is a scope of its own.
	line = parseShellLine("{ (echo a; }) | sh")
	if text, ok := groupText(line, 2, 0); ok {
		t.Fatalf("a } in another scope than its { prints %q", text)
	}
}

func TestScopeTextReadsTheCommandsOfAGroupInOrder(t *testing.T) {
	// The group's own commands, first to last, but for the ones whose output
	// goes elsewhere (down a pipe, into a file).
	line := parseShellLine("(echo a; echo b | wc -l; echo c) | sh")
	if text, ok := scopeText(line, 1, 0); !ok || text != "a\nc" {
		t.Fatalf("the group prints %q (%v), want a then c", text, ok)
	}
	// What cat passes on from its pipe is the group's output.
	line = parseShellLine("(echo a; echo b | cat; echo c) | sh")
	if text, ok := scopeText(line, 1, 0); !ok || text != "a\nb\nc" {
		t.Fatalf("the group prints %q (%v), want a, b and c", text, ok)
	}
	line = parseShellLine("(echo a; echo b > f; echo c; echo d) | sh")
	if text, ok := scopeText(line, 1, 0); !ok || text != "a\nc\nd" {
		t.Fatalf("the group prints %q (%v), want a, c and d", text, ok)
	}
}

func TestGroupsAreReadAtMostMaxGroupReadsWordsInAll(t *testing.T) {
	// The segments are `{ echo a b c`, `}` and `sh`.
	line := parseShellLine("{ echo a b c; } | sh")
	if text, ok := groupText(line, 1, 0); !ok || text != "a b c" {
		t.Fatalf("the group prints %q (%v)", text, ok)
	}
	if *line.groupReads != 6 {
		t.Fatalf("reading the command of 5 words was counted as %d, want 6", *line.groupReads)
	}
	line = parseShellLine("{ echo a b c; } | sh")
	*line.groupReads = 1 << 18
	if text, ok := groupText(line, 1, 0); ok {
		t.Fatalf("a line that read its share of groups reads %q", text)
	}
	line = parseShellLine("(echo a b c) | sh")
	*line.groupReads = 1 << 18
	if text, ok := scopeText(line, 1, 0); ok {
		t.Fatalf("a line that read its share of groups reads %q", text)
	}
	// What the line reads is its own to spend: another line starts at none.
	if text, ok := scopeText(parseShellLine("(echo a b c) | sh"), 1, 0); !ok || text != "a b c" {
		t.Fatalf("a new line reads %q (%v)", text, ok)
	}
}

func TestScriptsShareTheReadingOfGroupsWithTheLineTheyCameFrom(t *testing.T) {
	line := parseShellLine("echo a")
	script := line.parseScript("(echo b) | sh")
	if script.groupReads != line.groupReads {
		t.Fatal("a script has a reading of groups of its own")
	}
	if text, ok := scopeText(script, 1, 0); !ok || text != "b" {
		t.Fatalf("the script's group prints %q (%v)", text, ok)
	}
	if *line.groupReads == 0 {
		t.Fatal("what the script read was not counted for the line")
	}
	// A line of its own starts at none, and so does the substitution that
	// printedBy reads for a line.
	if *parseShellLine("echo a").groupReads != 0 {
		t.Fatal("a new line has read groups")
	}
	before := *line.groupReads
	if printed, ok := printedBy(line, "$(echo a; (echo b) | cat)"); !ok || printed != "a\nb" {
		t.Fatalf("printedBy = %q (%v)", printed, ok)
	}
	if *line.groupReads == before {
		t.Fatal("what printedBy read was not counted for the line")
	}
}

func TestFollowedScriptsOfBothRuleSetsSpendTheGroupReadingOfTheLine(t *testing.T) {
	// Both rule sets follow a script as a line of its own, but the groups it
	// reads count against the line it came from, so that the call as a whole
	// is bounded and not each of the ninety scripts it can follow. A script
	// with a budget of its own is a speed bug that only a clock shows on a
	// long line (TestHookStaysFastOnLinesNearTheLimit); a count shows it on any
	// machine, and in a line this short.
	const line = "bash <<'EOF'\n(echo a) | sh\nEOF"
	simulator := parseShellLine(line)
	judgeSimulatorRules(simulator, 0, &scriptLedger{})
	if *simulator.groupReads == 0 {
		t.Error("the Simulator rules read the groups of a script they follow on a budget of the script's own")
	}
	supabase := parseShellLine(line)
	(&supabaseRules{environment: quietSupabaseEnvironment()}).judge(supabase, "/w")
	if *supabase.groupReads == 0 {
		t.Error("the Supabase rules read the groups of a script they follow on a budget of the script's own")
	}
}

func TestScopeNeighboursAreLinksNotScans(t *testing.T) {
	// A line of 130,000 groups nested in each other (a megabyte) has segments of
	// as many scopes between a segment and its neighbour in its own scope.
	// Following the links takes well under a millisecond (0.6 ms under the
	// race detector), so two seconds is thousands of times what they need,
	// more than a busy machine stalls for; a scan takes five seconds and more,
	// a minute under the race detector.
	depth := 130_000
	line := parseShellLine(strings.Repeat("( a | ", depth) + "b" + strings.Repeat(" )", depth))
	started := time.Now()
	for index := range line.segments {
		previousInScope(line, index)
		nextInScope(line, index)
	}
	if took := time.Since(started); took > 2*time.Second {
		t.Fatalf("finding the neighbours of %d segments took %s", len(line.segments), took)
	}
	// Each of those segments is alone in its scope, but for the innermost
	// pair, which are `a | b`.
	for index := range line.segments[:len(line.segments)-2] {
		if previousInScope(line, index) >= 0 || nextInScope(line, index) >= 0 {
			t.Fatalf("segment %d has a neighbour in its own scope", index)
		}
	}
	if last := len(line.segments) - 1; previousInScope(line, last) != last-1 || nextInScope(line, last-1) != last {
		t.Fatal("the innermost pair are neighbours")
	}
	line = parseShellLine("a; (b; c); d; (e) | f")
	for index, want := range []struct{ before, after int }{
		{-1, 3}, {-1, 2}, {1, -1}, {0, 5}, {-1, -1}, {3, -1},
	} {
		if line.before[index] != want.before || line.after[index] != want.after {
			t.Errorf("segment %d (%q): before %d, after %d, want %d, %d", index, line.segments[index].text, line.before[index], line.after[index], want.before, want.after)
		}
	}
}

// MARK: - The ledger

func TestScriptLedgerKeysAFileByTheLineThatWroteIt(t *testing.T) {
	// A followed script is a line of its own with files of its own: its s.sh
	// is not the s.sh of the line that follows it.
	outer, inner := &lineFiles{}, &lineFiles{}
	file := func(owner *lineFiles) handedScript {
		return handedScript{text: "echo a", file: fileVersion{owner: owner, path: "s.sh", last: 0}}
	}
	var ledger scriptLedger
	if !ledger.follow(file(outer), "/w", 0) {
		t.Fatal("the first file is followed")
	}
	if !ledger.follow(file(inner), "/w", 1) {
		t.Fatal("a file of another line with the same name and index is another file")
	}
	if ledger.follow(file(outer), "/w", 0) || ledger.follow(file(inner), "/w", 1) {
		t.Fatal("each of them is followed once")
	}
	// What a lone $(echo …) in a file prints is a script of its own, judged
	// once like the file.
	printed := handedScript{text: "a", file: file(outer).file, printed: true}
	if !ledger.follow(printed, "/w", 0) || ledger.follow(printed, "/w", 0) {
		t.Fatal("the printed text of a file is followed once, beside the file")
	}
	if !ledger.follow(handedScript{text: "a", file: file(inner).file, printed: true}, "/w", 1) {
		t.Fatal("the printed text of another line's file is another script")
	}
}

func TestHookFollowsAFileOfAScriptThatSharesANameWithAFileOfTheLine(t *testing.T) {
	// echo hi > s.sh; sh s.sh judges the outer s.sh. The script that follows
	// writes and runs an s.sh of its own, with text the text rule cannot see.
	wantDeclined(t, []verdictRow{
		{"echo hi > s.sh; sh s.sh\nbash <<'EOF'\necho \"ex\"\"po start\" > s.sh\nsh s.sh\nEOF", "Metro", "passed"},
		{"echo hi > s.sh; sh s.sh; bash -c 'echo \"ex\"\"po start\" > s.sh; sh s.sh'", "Metro", "passed"},
		{"echo hi > s.sh && sh s.sh && sh <<'EOF'\necho \"ex\"\"po start\" > s.sh && sh s.sh\nEOF", "Metro", "passed"},
	})
	wantPassing(t, []string{
		"echo hi > t.sh; sh t.sh\nbash <<'EOF'\necho hi > s.sh\nsh s.sh\nEOF",
	})
	fixture := newSupabaseFixture(t)
	fixture.expect(t, fixture.legacy, "echo hi > s.sh; sh s.sh\nbash <<'EOF'\necho 'supabase stop --all' > s.sh\nsh s.sh\nEOF", "every agent's local Supabase stack")
	fixture.expect(t, fixture.legacy, "echo hi > s.sh; sh s.sh\nbash <<'EOF'\necho hi > s.sh\nsh s.sh\nEOF")
}

func TestHookStopsFollowingScriptsOnceTheLedgerIsSpent(t *testing.T) {
	// Once the cap is reached the rule builds no more scripts: handedScripts
	// reads the files a line wrote, and reading them is what the cap saves.
	line := parseShellLine("echo hi > s.sh; sh s.sh")
	spent := scriptLedger{full: true}
	if decision := judgeSimulatorRules(line, 0, &spent); decision.Block {
		t.Fatalf("declined: %q", decision.Reason)
	}
	if line.files.pieces != 0 {
		t.Fatalf("the Simulator rules read %d writes of a file after the cap", line.files.pieces)
	}
	line = parseShellLine("echo hi > s.sh; sh s.sh")
	rules := supabaseRules{environment: quietSupabaseEnvironment(), scripts: scriptLedger{full: true}}
	if decision := rules.judge(line, "/Users/example/plain"); decision.Block {
		t.Fatalf("declined: %q", decision.Reason)
	}
	if line.files.pieces != 0 {
		t.Fatalf("the Supabase rules read %d writes of a file after the cap", line.files.pieces)
	}
	// With room left, both read it.
	line = parseShellLine("echo hi > s.sh; sh s.sh")
	judgeSimulatorRules(line, 0, &scriptLedger{})
	if line.files.pieces != 1 {
		t.Fatalf("the Simulator rules read %d writes, want 1", line.files.pieces)
	}
	line = parseShellLine("echo hi > s.sh; sh s.sh")
	rules = supabaseRules{environment: quietSupabaseEnvironment()}
	rules.judge(line, "/Users/example/plain")
	if line.files.pieces != 1 {
		t.Fatalf("the Supabase rules read %d writes, want 1", line.files.pieces)
	}
}

func TestWrittenScriptReadsAtMostMaxScriptWritesOfAFile(t *testing.T) {
	// A file appended to a hundred times has a hundred writes; the script is
	// built from the last maxScriptWrites of them.
	line := parseShellLine(strings.Repeat("echo a >> s.sh; ", 100) + "sh s.sh")
	text, _, ok := writtenScript(line, len(line.segments)-1, "s.sh")
	if !ok || line.files.pieces != 64 || strings.Count(text, "a") != 64 {
		t.Fatalf("read %d writes into %d lines (%v), want 64", line.files.pieces, strings.Count(text, "a"), ok)
	}
	// So a steered command in the oldest appends is not followed.
	steered := "echo 'ex''po start' >> s.sh; " + strings.Repeat("echo a >> s.sh; ", 64) + "sh s.sh"
	if decision := EvaluateShellCommand(steered); decision.Block {
		t.Fatalf("an append more than %d writes before the run is followed: %q", maxScriptWrites, decision.Reason)
	}
	steered = "echo 'ex''po start' >> s.sh; " + strings.Repeat("echo a >> s.sh; ", 63) + "sh s.sh"
	if decision := EvaluateShellCommand(steered); !decision.Block {
		t.Fatal("the 64th write before the run is followed")
	}
}

func TestWrittenScriptKeepsWhatALoneSubstitutionPrintsWithTheFileVersion(t *testing.T) {
	// Running a file again does not parse its text again: what a lone
	// $(echo …) in it prints is worked out when the text is built.
	line := parseShellLine("echo \"\\$(echo 'ex''po start')\" > s.sh; sh s.sh; sh s.sh")
	var scripts [][]handedScript
	for index, segment := range line.segments {
		if segment.program() == "sh" {
			scripts = append(scripts, handedScripts(line, index))
		}
	}
	if len(scripts) != 2 {
		t.Fatalf("%d runs", len(scripts))
	}
	for _, run := range scripts {
		if len(run) != 2 || run[0].file == (fileVersion{}) || run[1].file != run[0].file || !run[1].printed || run[0].printed {
			t.Fatalf("a run hands on %+v, want the file and what it prints, both of one version", run)
		}
		if !strings.Contains(run[1].text, "expo start") {
			t.Fatalf("what the file prints: %q", run[1].text)
		}
	}
	if scripts[0][1] != scripts[1][1] {
		t.Fatal("both runs hand on the same printed text")
	}
	if decision := EvaluateShellCommand("echo \"\\$(echo 'ex''po start')\" > s.sh; sh s.sh"); !decision.Block {
		t.Fatal("a file that is a lone $(echo …) runs what it prints")
	}
}

// MARK: - tmux command lists

func TestTmuxCommandsSplitLikeTmux(t *testing.T) {
	for _, row := range []struct {
		arguments []string
		want      [][]string
	}{
		{nil, nil},
		{[]string{"new-window", "x"}, [][]string{{"new-window", "x"}}},
		{[]string{"select-pane", "-t", "1", ";", "send-keys", "x"}, [][]string{{"select-pane", "-t", "1"}, {"send-keys", "x"}}},
		{[]string{"select-pane", "-t", "1;", "send-keys", "x"}, [][]string{{"select-pane", "-t", "1"}, {"send-keys", "x"}}},
		{[]string{"a;", "b"}, [][]string{{"a"}, {"b"}}},
		{[]string{"a", ";", ";", "b"}, [][]string{{"a"}, {"b"}}},
		{[]string{"a", ";"}, [][]string{{"a"}}},
		{[]string{";", "a"}, [][]string{{"a"}}},
		{[]string{`a\;`, "b"}, [][]string{{"a;", "b"}}},
		{[]string{"send-keys", `echo hi\;`, "Enter"}, [][]string{{"send-keys", "echo hi;", "Enter"}}},
		{[]string{"send-keys", "echo hi;", "Enter"}, [][]string{{"send-keys", "echo hi"}, {"Enter"}}},
	} {
		if got := tmuxCommands(row.arguments); !reflect.DeepEqual(got, row.want) {
			t.Errorf("tmuxCommands(%q) = %q, want %q", row.arguments, got, row.want)
		}
	}
}

func TestHookFollowsEachCommandOfATmuxList(t *testing.T) {
	// tmux runs the commands of a list joined by ;, which the shell hands it as
	// an argument of just ";" (written \;) or as the end of the word before.
	wantDeclined(t, []verdictRow{
		{`tmux select-pane -t 1 \; send-keys 'ex''po start' Enter`, "Metro", "passed"},
		{`tmux new-session -d -s dev \; send-keys 'ex''po start' Enter`, "Metro", "passed"},
		{`tmux select-pane -t 1 ';' send-keys 'ex''po start' Enter`, "Metro", "passed"},
		{`tmux select-pane -t 1\; send-keys 'ex''po start' Enter`, "Metro", "passed"},
		{`tmux select-pane -t 1 ';' split-window -h 'ex''po start'`, "Metro", "passed"},
		{`tmux rename-window dev \; select-pane -t 1 \; send-keys -t 1 'ex''po start' Enter`, "Metro", "passed"},
		{`tmux -L sock select-pane -t 1 \; new-window 'ex''po start'`, "Metro", "passed"},
		{`tmux display-message hi \; run-shell 'ex''po start'`, "Metro", "passed"},
		{`tmux send-keys 'ex''po start' Enter \; select-pane -t 0`, "Metro", "passed"},
	})
	wantRunning(t, []runningRow{
		{`tmux select-pane -t 1 \; send-keys 'echo hi' Enter`, "passed"},
		{`tmux rename-window 'expo start' \; select-pane -t 1`, "passed"},
		{`tmux send-keys -t 1 'echo hi\;' Enter`, "passed"},
		{`tmux select-pane -t 1 \; display-message 'expo start'`, "passed"},
		{`tmux set -g status-right 'expo start' \; refresh-client`, "passed"},
	})
}

// MARK: - Commands the word rules read by their launchers and groups

func TestHookLooksThroughNohupAndGroupsAndSubstitutionsInTheCommandsPlace(t *testing.T) {
	// Each of these hides the steered text from the text rule and relies on one
	// entry of the word rules.
	wantDeclined(t, []verdictRow{
		{`echo 'ex''po start' | nohup bash`, "Metro", "passed"},
		{`nohup bash <<< 'ex''po start'`, "Metro", "passed"},
		{`(echo 'ex''po start') | bash`, "Metro", "passed"},
		{`{ echo 'ex''po start'; } | bash`, "Metro", "passed"},
		{`$(echo 'ex''po start')`, "Metro", "passed"},
		{`$(echo 'ex''po start') --port 8081`, "Metro", "passed"},
		{`bash -c "$(echo 'ex''po start')"`, "Metro", "passed"},
		{`eval "$(echo 'ex''po start')"`, "Metro", "passed"},
	})
}
