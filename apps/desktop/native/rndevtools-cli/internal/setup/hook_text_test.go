package setup

import (
	"strings"
	"testing"
)

// MARK: - What the excuse refuses

// Each table row below is a line that only looks text-only: the original hook
// declined it and the excuse let it through, or the original hook passed it
// although the shell runs a steered command. A row carries the verdict of the
// original hook, the version that matched each command's text with a regular
// expression and nothing else: no excuse, no here-document expansion, and
// only the first command of a tmux list. The rows keep the rules honest in
// both directions: a "declined" row for the original hook is a line that must
// not pass again, and a "passed" row is a steered command the original hook
// never saw. The rows under "Where the excuse turns itself off" keep out five
// more classes of such lines.

// verdictRow is a line, the phrase the reason has to hold, and the original
// hook's verdict ("declined" or "passed").
type verdictRow struct {
	line, want, original string
}

// runningRow is a line the hook runs, and the original hook's verdict.
type runningRow struct {
	line, original string
}

// wantDeclined checks that each line is declined, with its phrase.
func wantDeclined(t *testing.T, rows []verdictRow) {
	t.Helper()
	for _, row := range rows {
		decision := EvaluateShellCommand(row.line)
		if !decision.Block || !strings.Contains(decision.Reason, row.want) {
			t.Errorf("%q should be declined with %q (the original hook %s), got %+v", row.line, row.want, row.original, decision)
		}
	}
}

// wantRunning checks that each line runs.
func wantRunning(t *testing.T, rows []runningRow) {
	t.Helper()
	for _, row := range rows {
		if decision := EvaluateShellCommand(row.line); decision.Block {
			t.Errorf("%q should run (the original hook %s), got %q", row.line, row.original, decision.Reason)
		}
	}
}

// nested wraps inner in depth levels of open … close.
func nested(depth int, inner string, open string, close string) string {
	return strings.Repeat(open, depth) + inner + strings.Repeat(close, depth)
}

func TestHookExcuseIsOffForExpansionsAndForALineTheSplitterCannotFinish(t *testing.T) {
	// A $ or a backtick anywhere, an ANSI-C quote the splitter ends early, a
	// quote that never closes, and a substitution too deep to split are each
	// a place where the splitter and the shell may disagree about where the
	// commands are, so nothing on such a line is excused.
	wantDeclined(t, []verdictRow{
		{`echo $'a\'b'; npx expo start`, "Metro", "declined"},
		{`git commit -m $'it\'s' && npx expo start`, "Metro", "declined"},
		{`echo $'\'' ; npx expo start`, "Metro", "declined"},
		{nested(16, "npx expo start", "echo $(", ")"), "Metro", "declined"},
		{nested(17, "npx expo start", "echo $(", ")"), "Metro", "declined"},
		{nested(40, "npx expo start", "echo $(", ")"), "Metro", "declined"},
		{nested(20, "xcrun simctl boot X", "echo $(", ")"), "simctl boot", "declined"},
		{nested(20, `npx expo start`, `echo "$(`, `)"`), "Metro", "declined"},
		// Process substitution has no $, so only the depth limit refuses it.
		{nested(20, "npx expo start", "cat <(", ")"), "Metro", "declined"},
		{nested(17, "npx expo start", "cat <(", ")"), "Metro", "declined"},
		{`echo 'npx expo start`, "Metro", "declined"},
		{`echo "npx expo start`, "Metro", "declined"},
		{`echo $(echo npx expo start`, "Metro", "declined"},
		{`git commit -m 'costs $5: npx expo start'`, "Metro", "declined"},
		{"git commit -m 'see `npx expo start`'", "Metro", "declined"},
		{"git commit -m \"see `npx expo start`\"", "Metro", "declined"},
		{`echo ${HOME} 'npx expo start'`, "Metro", "declined"},
		// A ( group that never closes: bash calls it a syntax error, and zsh reads
		// a pattern that takes in the lines after it.
		{"true <<END && git log -S 'npx expo start'(\n END\nend\nwc -l {a,b}; npx expo start", "Metro", "declined"},
		{"git log -S 'npx expo start'(\nwc -l {a,b}; npx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start' (", "Metro", "declined"},
		{"(git commit -m 'npx expo start'", "Metro", "declined"},
		{"(git commit -m 'npx expo start'; (echo b)", "Metro", "declined"},
	})
	// Within the splitter's depth, the same process substitution is split and
	// its commands are read.
	wantRunning(t, []runningRow{
		{nested(16, "echo 'npx expo start'", "cat <(", ")"), "declined"},
	})
}

func TestHookMatchesALineThatCannotBeReadToItsEndAsWritten(t *testing.T) {
	// A shell calls a ( that never closes a syntax error, and zsh carries on with
	// the lines after the one that has it, as if the here-document they follow
	// had never been opened. So the text a splitter took for a body can run, and
	// the line is matched as written.
	wantDeclined(t, []verdictRow{
		{"wc -l <<\\\nA | head (( -n 1\na\na\\\n\tA\ntrue ; npx expo start", "Metro", "declined"},
		{"wc -l <<A | head (( -n 1\na\ntrue ; npx expo start", "Metro", "passed"},
		{"wc -l <<A | head ( -n 1\na\na\\\n\tA\ntrue ; npx expo start", "Metro", "passed"},
		{"git log <<A (\nnpx expo start\nA", "Metro", "passed"},
		{"cat <<'EOF'\nnpx expo start\nEOF\n(", "Metro", "passed"},
		{"cat <<'EOF'\nxcrun simctl boot X\nEOF\n(echo a", "simctl boot", "passed"},
		{"# npx expo start\n(echo a", "Metro", "passed"},
		// Arithmetic that has a # or a << in it: the splitter takes a comment for
		// the rest of the line and leaves a group open.
		{"(( # 1 )) && echo hi; npx expo start", "Metro", "passed"},
		{"echo $((1)#); npx expo start", "Metro", "passed"},
		{"(( <<EOF\n1 )) && cat; npx expo start", "Metro", "passed"},
		{"cat <<'EOF'\nnpx expo start\nEOF\necho 'a", "Metro", "passed"},
		// The mention is whole once a continuation in double quotes is joined,
		// and not as written; the line ends inside a quote, so it is not excused.
		{"echo \"npx expo\\\n start\" 'x", "Metro", "declined"},
		{"git commit -m \"npx expo\\\n start\" (", "Metro", "declined"},
	})
	// The same text on a line that is read to its end is a body or a comment.
	wantRunning(t, []runningRow{
		{"cat <<'EOF'\nnpx expo start\nEOF\n(echo a)", "passed"},
		{"cat <<'EOF'\nnpx expo start\nEOF", "passed"},
		{"# npx expo start\n(echo a)", "passed"},
		{"cat <<'EOF'\nnpx expo start\nEOF\necho 'a'", "passed"},
	})
}

func TestHookExcuseSeesWhereAHereDocumentEnds(t *testing.T) {
	// A backslash and a newline join the delimiter to the next line's first
	// word (<<EOF and hi is the delimiter EOFhi), so a splitter that reads the
	// delimiter as EOF takes the rest of the line for a body, and with it the
	// command a text rule would have seen.
	wantDeclined(t, []verdictRow{
		{"printf '%s\\n' 'npx expo start' & echo hi > f\ncat ; echo <<EOF\\\nhi 2>&1 && npx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<EOF\\\nhi && npx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<E\\\nOF\nbody\nEOF\nnpx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<\\\nEOF\nbody\nEOF\nnpx expo start", "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<-EOF\\\n\nbody\nEOF\nnpx expo start", "Metro", "declined"},
	})
	// A continuation that leaves the delimiter alone is a backslash all the
	// same, and a backslash outside single quotes turns the excuse off.
	wantDeclined(t, []verdictRow{
		{"git commit -m 'npx expo start' \\\n  && cat <<EOF\nnote\nEOF", "Metro", "declined"},
		{"git commit \\\n  -m 'npx expo start'", "Metro", "declined"},
	})
}

// MARK: - Where the excuse turns itself off

// Five classes of line only look text-only. The original hook declined them
// and the excuse passed them while a shell ran the steered command, each from
// a place where the splitter and the shell read a line differently: an
// escaped redirection operator before a pipe, a << inside (( )), a glob that
// turns a file made on the line into an option, a value-taking option that
// swallows the --, and an escaped blank or metacharacter in a here-document
// delimiter. More would turn up, so the excuse no longer assumes that the
// splitter reads a line as the shell does. A backslash outside single quotes,
// a "((", an unquoted glob, or a dash word after a -- that the option policy
// cannot name turns it off, and the line gets the original hook's verdict, a
// text match on each command. Each condition has its rows below, the lines of
// the five classes among them.

func TestHookExcuseIsOffForABackslashOutsideSingleQuotes(t *testing.T) {
	// A backslash escapes, joins lines, or quotes a delimiter, and the splitter
	// may read what it escapes differently from the shell, so any backslash
	// turns the excuse off, here-document bodies and comments included. Only
	// inside single quotes on a command line it is an ordinary character in
	// every shell, and the scan has read it as one.
	wantDeclined(t, []verdictRow{
		// In double quotes, where it escapes some characters.
		{`grep "simctl boot\|simctl shutdown" device.log`, "simctl shutdown", "declined"},
		{`printf "%s\n" 'npx expo start' >> notes.md`, "Metro", "declined"},
		{`git commit -m "fix: run \"npx expo start\" by hand"`, "Metro", "declined"},
		{`echo "a\\b" 'npx expo start'`, "Metro", "declined"},
		// A line continuation, an escaped operator, a comment, a here-document
		// body that no command reads, and a backslash that ends the line.
		{"git commit -m 'npx expo start' \\\n  && git push", "Metro", "declined"},
		{`echo 'npx expo start' \> notes`, "Metro", "declined"},
		{`git commit -m 'npx expo start' # see C:\dir`, "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<'EOF'\na\\b\nEOF", "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<EOF\na\\b\nEOF", "Metro", "declined"},
		{`git commit -m 'npx expo start' && echo done \`, "Metro", "declined"},
		// Between single quotes in a comment or a here-document body is not on a
		// command line: the scan reads no quotes there, so the backslash counts.
		{`git commit -m 'npx expo start' # 'a\b'`, "Metro", "declined"},
		{"git commit -m 'npx expo start'; cat <<'EOF'\n'a\\b'\nEOF", "Metro", "declined"},
		// A backslash outside the quotes of a line that has quoted ones too.
		{`printf '%s\n' 'npx expo start' \> notes.md`, "Metro", "declined"},
		{`printf '%s\n' 'npx expo start' | grep a\ b`, "Metro", "declined"},
		{`echo 'a\' \; git commit -m 'npx expo start'`, "Metro", "declined"},
		// A quote that a backslash escapes opens nothing.
		{`echo \' 'npx expo start' \'`, "Metro", "declined"},
		{`echo 'npx expo start' \' 'x\y'`, "Metro", "declined"},
		// Lines that only look text-only: an escaped > or < before a pipe or an
		// ampersand made the splitter read the command after it as an argument
		// of echo, and the excuse passed all of it.
		{`echo \>| eval 'npx expo start'`, "Metro", "declined"},
		{`echo \>| bash -c 'npx expo start'`, "Metro", "declined"},
		{`echo hi \<& eval 'xcrun simctl boot X'`, "simctl boot", "declined"},
		{`echo \>| python3 -c "import os; os.system('npx expo start')"`, "Metro", "declined"},
		{`ls \>| source <(echo 'npx expo start')`, "Metro", "declined"},
	})
	// Inside single quotes a backslash is a character like any other: a regular
	// expression, a printf format.
	wantRunning(t, []runningRow{
		{`grep 'simctl boot\|simctl shutdown' device.log`, "declined"},
		{`printf '%s\n' 'npx expo start' >> notes.md`, "declined"},
		{`rg '\bnpx expo start\b' docs`, "declined"},
		{`git log --grep 'npx expo start\|expo start' --oneline`, "declined"},
		{`git commit -m 'npx expo start' -m 'a\b' && git push`, "declined"},
		// The same lines without the backslash.
		{`grep 'simctl boot|simctl shutdown' device.log`, "declined"},
		{"git commit -m 'npx expo start' && git push", "declined"},
		{`git commit -m 'npx expo start' # see the docs`, "declined"},
		{"git commit -m 'npx expo start'; cat <<'EOF'\na b\nEOF", "declined"},
	})
}

func TestHookExcuseIsOffForArithmetic(t *testing.T) {
	// In (( )) a << is a shift, but the splitter reads it as a here-document
	// and takes the lines after it for its body, so the shell runs commands the
	// splitter never sees. A "((" anywhere in the line, in a quote or not,
	// turns the excuse off; the text rule then declines a mention as the
	// original hook did.
	wantDeclined(t, []verdictRow{
		{"echo 'npx expo start' ; (( echo << y ))\nnpx expo start\ny", "Metro", "declined"},
		{"(( cat )) && echo 'npx expo start'", "Metro", "declined"},
		{"echo 'npx expo start'; ((true))", "Metro", "declined"},
		{"git commit -m 'fix: ((x)) breaks npx expo start'", "Metro", "declined"},
	})
	// Two groups with a blank between their parentheses are not arithmetic.
	wantRunning(t, []runningRow{
		{"echo 'npx expo start'; ( (echo a) )", "declined"},
		{"( echo 'npx expo start' ) && ( echo done )", "declined"},
	})
}

func TestHookExcuseIsOffForAnUnquotedGlob(t *testing.T) {
	// The shell expands *, ? and [ in a word into the names of files, and a
	// file made on the line can be named like an option (--pre=sh); the excuse
	// reads the words as written. The test program [ is no exception.
	wantDeclined(t, []verdictRow{
		{`touch -- '--upload-pack=npx expo start #'; git fetch ../b *`, "Metro", "declined"},
		{`echo 'npx expo start' > run.txt; touch -- --pre=sh; rg x *`, "Metro", "declined"},
		{`echo 'npx expo start' > run.txt; touch -- --pre=sh; rg [-]*`, "Metro", "declined"},
		{`echo 'npx expo start' > run.txt; touch -- --pre=sh; rg ?-* .`, "Metro", "declined"},
		{`git add *.md && git commit -m 'npx expo start'`, "Metro", "declined"},
		{`ls docs/*.md | grep 'npx expo start'`, "Metro", "declined"},
		{`echo 'npx expo start' > *.txt`, "Metro", "declined"},
		{`[ -n 'npx expo start' ] && echo yes`, "Metro", "declined"},
		{`test -f notes.md && echo 'npx expo start' [a]`, "Metro", "declined"},
		// In a process substitution, which the splitter reads as a line of its own.
		{`grep 'npx expo start' <(ls *.md)`, "Metro", "declined"},
	})
	// In quotes, in a comment, or in a here-document body, a glob is text.
	wantRunning(t, []runningRow{
		{`rg -n -g '*.md' 'npx expo start' docs`, "declined"},
		{`git branch -a --list 'feat/*' | grep 'npx expo start'`, "declined"},
		{`ls "docs/*" | grep 'npx expo start'`, "declined"},
		{`git log -S 'npx expo start' -- '*.md'`, "declined"},
		{`git commit -m 'npx expo start?'`, "declined"},
		{`git commit -m 'npx expo start [skip ci]'`, "declined"},
		{`echo "npx expo start*"`, "declined"},
		{`echo 'npx expo start' # why? [done] *`, "declined"},
		{"git commit -m 'npx expo start'; cat <<'EOF'\n* item?\n[x]\nEOF", "declined"},
	})
}

func TestHookExcuseReadsTheWordsAfterADoubleDashAsOptions(t *testing.T) {
	// An option that takes a value swallows a --, and what follows is an option
	// again: rg -e -- --pre=sh runs sh on each file, git push -o -- --receive-pack
	// runs the program it names.
	wantDeclined(t, []verdictRow{
		{`echo 'npx expo start' > run.txt; rg -e -- --pre=sh run.txt`, "Metro", "declined"},
		{`echo 'npx expo start' > run.txt; rg --regexp -- --pre=sh run.txt`, "Metro", "declined"},
		{`git push -o -- --receive-pack='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git fetch -o -- --upload-pack='npx expo start #' ../b`, "Metro", "declined"},
		{`git grep -e -- --open-files-in-pager='npx expo start #'`, "Metro", "declined"},
		{`echo 'npx expo start' > run.txt; sort -S1 -o -- --compress-program=sh run.txt`, "Metro", "declined"},
		{`git commit -m 'npx expo start' -- -c`, "Metro", "declined"},
		{`rg -e 'npx expo start' -- --unknown docs`, "Metro", "declined"},
		// gh hands everything after a -- to git, -c included.
		{`gh pr checkout 12 -- -c core.sshCommand='npx expo start #'`, "Metro", "declined"},
		{`gh pr checkout 12 -- 'npx expo start'`, "Metro", "declined"},
		// sort -o after a -- writes a file as well, and git runs hook files.
		{`echo 'npx expo start' | sort -k -- -o .git/hooks/pre-commit; git commit -m x`, "Metro", "declined"},
	})
	// What follows a -- is a path unless it starts with a dash.
	wantRunning(t, []runningRow{
		{`rg -C 2 -e 'npx expo start' -- docs`, "declined"},
		{`git log -S 'npx expo start' -- README.md`, "declined"},
		{`git log -S 'npx expo start' -- -n1`, "declined"},
		{`git checkout -- README.md && echo 'npx expo start'`, "declined"},
		{`echo 'npx expo start' | sort -k 1 -- notes.txt`, "declined"},
	})
}

func TestHookSplitsAtAPipeOrAmpersandAfterAnEscapedOperator(t *testing.T) {
	// A backslash makes a > or < an ordinary character, so a | or & after it is
	// a pipe or a background operator, and the command after that is a command
	// of its own. The word rules find a hidden one there; before, the splitter
	// kept it among the arguments of echo, and the original hook never read
	// words at all.
	wantDeclined(t, []verdictRow{
		{`echo \>| bash -c "ex''po start"`, "Metro", "passed"},
		{`echo hi \<& bash -c "ex''po start"`, "Metro", "passed"},
		{`echo \>& bash -c "ex''po start"`, "Metro", "passed"},
		{`ls \>|sh <<< "ex''po start"`, "Metro", "passed"},
		{`echo \>| eval "xcrun sim''ctl boot X"`, "simctl boot", "passed"},
	})
	// A >| or >& that is not escaped is one word with its operator.
	wantRunning(t, []runningRow{
		{`echo a >| f; echo b 2>&1 | cat`, "passed"},
		{`echo a >&2 | cat <&3`, "passed"},
	})
}

func TestHookLeavesAHereDocumentAloneWhenAnEscapeMakesItsDelimiterNoName(t *testing.T) {
	// The shell reads \x in a delimiter as x, a blank or a metacharacter
	// included (<<E\ F is the delimiter "E F"), and the body ends at the line
	// that holds exactly it. A splitter that stops the delimiter at the blank
	// takes the lines after it for the body, and the command that follows runs
	// unseen. Such a delimiter is no name, so the << is left alone and the
	// lines after it are read as commands.
	wantDeclined(t, []verdictRow{
		{"cat <<E\\ F\nE F\nex''po start", "Metro", "passed"},
		{"cat <<EOF\\\\\nEOF\\\n\nex''po start", "Metro", "passed"},
		{"cat <<E\\\\F\nE\\F\nex''po start", "Metro", "passed"},
		{"cat <<O\\>\nO>\nex''po start", "Metro", "passed"},
		{"cat <<E\\;F\nE;F\nex''po start", "Metro", "passed"},
		{"cat <<E\\|F\nE|F\nex''po start", "Metro", "passed"},
		// The same delimiters, with the mention in the text.
		{"echo 'npx expo start' >/dev/null; cat <<E\\ F\nE F\nnpx expo start", "Metro", "declined"},
		{"echo 'npx expo start' >/dev/null; cat <<EOF\\\\\nEOF\\\n\nnpx expo start", "Metro", "declined"},
		{"echo 'npx expo start' >/dev/null; cat <<E\\\\F\nE\\F\nnpx expo start", "Metro", "declined"},
		{"echo 'xcrun simctl boot X'; cat <<O\\>\nO>\nex''po start", "simctl boot", "declined"},
	})
	// A delimiter whose escapes leave a name still starts a here-document, and
	// its body is text.
	wantRunning(t, []runningRow{
		{"cat <<\\EOF\nex''po start\nEOF", "passed"},
		{"cat <<E\\OF\nex''po start\nEOF", "passed"},
		{"cat <<-\\EOF\n\tex''po start\n\tEOF", "passed"},
	})
}

func TestHookDeclinesLinesThatOnlyLookTextOnly(t *testing.T) {
	// The lines of each class, each one run exactly as written by bash and zsh
	// with stub programs, and each one declined by the original hook.
	wantDeclined(t, []verdictRow{
		// An escaped redirection operator before a pipe or an ampersand.
		{`echo \>| eval 'npx expo start'`, "Metro", "declined"},
		{`echo \>| bash -c 'npx expo start'`, "Metro", "declined"},
		{`echo hi \<& eval 'xcrun simctl boot X'`, "simctl boot", "declined"},
		{`echo \>| python3 -c "import os; os.system('npx expo start')"`, "Metro", "declined"},
		{`ls \>| source <(echo 'npx expo start')`, "Metro", "declined"},
		// A << inside (( )).
		{"echo 'npx expo start' ; (( echo << y ))\nnpx expo start\ny", "Metro", "declined"},
		// A glob that turns a file made on the line into an option.
		{`touch -- '--upload-pack=npx expo start #'; git fetch ../b *`, "Metro", "declined"},
		{"printf 'npx expo start\\n' > run.txt; touch -- --pre=sh; rg x *", "Metro", "declined"},
		{"printf 'npx expo start\\n' > run.txt; touch -- --pre=sh; rg [-]*", "Metro", "declined"},
		{"printf 'npx expo start\\n' > run.txt; touch -- --pre=sh; rg ?-* .", "Metro", "declined"},
		// A value-taking option that swallows the --.
		{"printf 'npx expo start\\n' > run.txt; rg -e -- --pre=sh run.txt", "Metro", "declined"},
		{"printf 'npx expo start\\n' > run.txt; rg --regexp -- --pre=sh run.txt", "Metro", "declined"},
		{`git push -o -- --receive-pack='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git fetch -o -- --upload-pack='npx expo start #' ../b`, "Metro", "declined"},
		{`git grep -e -- --open-files-in-pager='npx expo start #'`, "Metro", "declined"},
		{"printf 'npx expo start\\nnpx expo start\\n' > run.txt; sort -S1 -o -- --compress-program=sh run.txt", "Metro", "declined"},
		// Escapes in a here-document delimiter.
		{"echo 'npx expo start' >/dev/null; cat <<E\\ F\nE F\nnpx expo start", "Metro", "declined"},
		{"echo 'npx expo start' >/dev/null; cat <<EOF\\\\\nEOF\\\n\nnpx expo start", "Metro", "declined"},
		{"echo 'npx expo start' >/dev/null; cat <<E\\\\F\nE\\F\nnpx expo start", "Metro", "declined"},
		{"echo 'xcrun simctl boot X'; cat <<O\\>\nO>\nex''po start", "simctl boot", "declined"},
	})
}

func TestTextOnlyNamesEachConditionOfTheExcuse(t *testing.T) {
	// Each row holds only listed commands, so the one construct in it is what
	// decides; judgeText matches a line the splitter could not finish before it
	// asks, so a row for that condition is asked of textOnly directly.
	for _, row := range []struct {
		line string
		want bool
	}{
		{"echo hi", true},
		{"echo 'a b' \"c d\"", true},
		// A line the splitter could not read to its end.
		{"echo 'a", false},
		{`echo "a`, false},
		{"(echo a", false},
		{"echo a (", false},
		{"echo <(echo a", false},
		{nested(17, "echo a", "cat <(", ")"), false},
		{nested(16, "echo a", "cat <(", ")"), true},
		// A backslash anywhere but inside single quotes.
		{`echo 'a\b' 'c\|d'`, true},
		{`echo a\ b`, false},
		{`echo "a\b"`, false},
		{`echo 'a' \'`, false},
		{"echo a # \\", false},
		{"cat <<'EOF'\na\\b\nEOF", false},
		{"echo a \\\n b", false},
		// An expansion, arithmetic, and a glob.
		{"echo $x", false},
		{"echo `x`", false},
		{"echo 'a$b'", false},
		{"echo a; ((echo b))", false},
		{"echo a; ( (echo b) )", true},
		{"echo 'a((b'", false},
		{"ls *", false},
		{"ls a?", false},
		{"ls [ab]", false},
		{"ls '*' \"?\" '[ab]'", true},
		{"ls # *", true},
		{"cat <<'EOF'\n* ? [\nEOF", true},
		// An option the policy cannot name, also after a --.
		{"rg -e x", true},
		{"rg -e -- x", true},
		{"rg --pre=sh x", false},
		{"rg -e -- --pre=sh x", false},
		{"git log -- -c", false},
		{"git log -- docs", true},
		{"sort -k -- -o f", true},
	} {
		if got := textOnly(parseShellLine(row.line)); got != row.want {
			t.Errorf("textOnly(%q) = %v, want %v", row.line, got, row.want)
		}
	}
}

func TestHookExcuseStillPassesWhatAgentsWrite(t *testing.T) {
	// The conditions above cost the excuse nothing on the lines agents normally
	// write: a commit message, a PR body, a search pattern, a note, a mention
	// in the CLI's own arguments, and a quoted here-document.
	wantRunning(t, []runningRow{
		{`git commit -m 'fix: stop running npx expo start by hand'`, "declined"},
		{`git commit -m 'docs: never run xcrun simctl boot by hand' -m 'Use the lane tool.'`, "declined"},
		{`gh pr create --title 'Stop npx expo start' --body 'Replace npx expo start with lane up.' --base main`, "declined"},
		{`gh pr create --body 'Use the lane tool, not xcrun simctl boot.'`, "declined"},
		{`grep -rn "npx expo start" .`, "declined"},
		{`grep sh <<< 'npx expo start'`, "declined"},
		{`echo 'npx expo start' > notes.md`, "declined"},
		{`git log --oneline -n 20 --grep 'npx expo start'`, "declined"},
		{`rg -n -i --glob '!node_modules' 'xcrun simctl boot' apps`, "declined"},
		{`rndevtools claim --udid 727CE7B2 --note 'npx expo start hung; xcrun simctl boot it'`, "passed"},
		{`bash -n s.sh`, "passed"},
		{`tmux rename-window 'expo start'`, "passed"},
		{"gh pr create --body \"$(cat <<'EOF'\nTest plan: npx expo start\nxcrun simctl boot X\nEOF\n)\"", "passed"},
		// A script a shell reads from a here-document is a line of its own, one
		// that the original hook never read: a backslash inside single quotes,
		// as in a printf format or a regular expression, must not make the hook
		// decline what the original hook passed. A backslash in double quotes,
		// or an unquoted glob, does, and that cost has a test of its own (the
		// next one).
		{"bash <<'EOF'\nprintf '%s\\n' 'npx expo start' >> notes.md\nEOF", "passed"},
		{"bash <<'EOF'\ngrep -n 'xcrun simctl boot\\|xcrun simctl shutdown' README.md\nEOF", "passed"},
	})
}

func TestHookDeclinesAScriptItFollowsWhenAMentionSitsBesideABackslashOrAGlob(t *testing.T) {
	// The cost of the conditions, for the scripts the word rules follow. The
	// original hook never read a here-document body, so it passed whatever
	// script one fed to a shell. The hook judges that script as a line of its
	// own, and a script that holds a mention beside a backslash outside single
	// quotes or an unquoted glob gets no excuse. The README names this cost
	// under "The one excuse"; it is accepted, not an oversight.
	wantDeclined(t, []verdictRow{
		// A backslash in double quotes: a printf format, an echo with an escape,
		// a commit message.
		{"bash <<'EOF'\nprintf \"%s\\n\" 'npx expo start' >> notes.md\nEOF", "Metro", "passed"},
		{"bash <<'EOF'\necho \"Run npx expo start\\n\" >> notes.md\nEOF", "Metro", "passed"},
		{"bash <<'EOF'\nprintf \"%s\\n\" 'xcrun simctl boot X' > boot.log\nEOF", "simctl boot", "passed"},
		{"bash <<'EOF'\ngit commit -m \"docs: never run npx expo start\\n\"\nEOF", "Metro", "passed"},
		// An unquoted glob.
		{"bash <<'EOF'\nls *.md\necho 'Run npx expo start'\nEOF", "Metro", "passed"},
		{"sh <<'EOF'\ncat docs/*.md | grep 'npx expo start'\nEOF", "Metro", "passed"},
		{"bash <<'EOF'\ngrep -c 'npx expo start' [a-z]*.md\nEOF", "Metro", "passed"},
		// However the here-document reaches the shell: piped into it, filled in
		// by xargs, or written to a file the line runs.
		{"cat <<'EOF' | bash\nprintf \"%s\\n\" 'xcrun simctl boot X' > notes.md\nEOF", "simctl boot", "passed"},
		{"cat <<'EOF' | xargs -I% bash -c 'printf \"%s\\n\" % > notes.md'\nnpx expo start\nEOF", "Metro", "passed"},
		{"cat > s.sh <<'EOF'\necho \"npx expo start\\n\" >> notes.md\nEOF\nsh s.sh", "Metro", "passed"},
	})
	// The same scripts with the backslash in single quotes, or with neither the
	// backslash nor the glob, are text: the original hook passed them and so
	// does the hook.
	wantRunning(t, []runningRow{
		{"bash <<'EOF'\nprintf '%s\\n' 'npx expo start' >> notes.md\nEOF", "passed"},
		{"bash <<'EOF'\nprintf \"%s\" 'npx expo start' >> notes.md\nEOF", "passed"},
		{"bash <<'EOF'\nls '*.md'\necho 'Run npx expo start'\nEOF", "passed"},
		{"cat <<'EOF' | xargs -I% bash -c 'printf \"%s\" % > notes.md'\nnpx expo start\nEOF", "passed"},
		{"cat > s.sh <<'EOF'\necho 'npx expo start\\n' >> notes.md\nEOF\nsh s.sh", "passed"},
	})
}

func TestHookExcuseRefusesBuiltinsThatEvaluateOrAssign(t *testing.T) {
	// printf -v NAME assigns a variable (PATH, IFS), and zsh evaluates a
	// subscript in NAME; test -v looks one up and does the same.
	wantDeclined(t, []verdictRow{
		{`printf -v 'a[$(npx expo start)]' x`, "Metro", "declined"},
		{`printf -v 'a[$(xcrun simctl boot X)]' x`, "simctl boot", "declined"},
		{`printf -v PATH '/tmp'; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`printf -vPATH /tmp; echo 'npx expo start'`, "Metro", "declined"},
		{`[ -v 'a[$(npx expo start)]' ]`, "Metro", "declined"},
		{`[ -v 'a[b]' ] && echo 'npx expo start'`, "Metro", "declined"},
		{`test -v x && echo 'npx expo start'`, "Metro", "declined"},
	})
	wantRunning(t, []runningRow{
		{`printf '%s\n' 'npx expo start' >> notes.md`, "declined"},
		{`printf '%s -v\n' 'npx expo start'`, "declined"},
		{`test -n 'npx expo start' && echo yes`, "declined"},
		{`test -f notes.md && echo 'npx expo start'`, "declined"},
	})
}

func TestHookExcuseReadsTheOptionsOfGitGhRgAndSortInFull(t *testing.T) {
	// sort and most git commands accept a unique prefix of any long option
	// (--upl is --upload-pack), so an option counts only when it is spelled in
	// full and listed; a short option counts only when each letter is listed.
	wantDeclined(t, []verdictRow{
		{`git fetch --upl='npx expo start #' ../b`, "Metro", "declined"},
		{`git fetch --upload='npx expo start #' ../b`, "Metro", "declined"},
		{`git push --rece='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git push --exe='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git grep --open-files='npx expo start' x`, "Metro", "declined"},
		{`git grep --open-files-in-pager='npx expo start' x`, "Metro", "declined"},
		{`git grep --open-files-in-pager 'npx expo start' x`, "Metro", "declined"},
		{`git --config-e=core.pager=X log -S 'npx expo start'`, "Metro", "declined"},
		{`git --exec-p=/tmp/x log -S 'npx expo start'`, "Metro", "declined"},
		{`git fetch --upload-pack='npx expo start #' ../b`, "Metro", "declined"},
		{`git push --receive-pack='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git push --exec='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`git -c core.pager='npx expo start' log`, "Metro", "declined"},
		{`git log -c -S 'npx expo start'`, "Metro", "declined"},
		{`git commit -ac HEAD -m 'npx expo start'`, "Metro", "declined"},
		{`git grep -nO'npx expo start' x`, "Metro", "declined"},
		{`git log --ext-diff -S 'npx expo start'`, "Metro", "declined"},
		{`git log --textconv -S 'npx expo start'`, "Metro", "declined"},
		{`git log --unknown-option -S 'npx expo start'`, "Metro", "declined"},
		{`sort --comp='npx expo start' f`, "Metro", "declined"},
		{`sort --compress='npx expo start' f`, "Metro", "declined"},
		{`sort --compress-program='npx expo start' f`, "Metro", "declined"},
		{`sort -T /tmp --files0-from=f 'npx expo start'`, "Metro", "declined"},
		{`rg --pre='npx expo start' x`, "Metro", "declined"},
		{`rg --pre 'npx expo start' x`, "Metro", "declined"},
		{`rg --pre-glob='*.md' -z 'npx expo start'`, "Metro", "declined"},
		{`rg -z 'npx expo start' .`, "Metro", "declined"},
		{`rg --hostname-bin='npx expo start' x`, "Metro", "declined"},
		{`rg --unknown 'npx expo start'`, "Metro", "declined"},
		{`gh repo clone cli/cli -- -c core.sshCommand='npx expo start #'`, "Metro", "declined"},
		{`gh repo clone cli/cli -- --upload-pack='npx expo start #'`, "Metro", "declined"},
		{`gh repo clone cli/cli x -- --config core.fsmonitor='npx expo start'`, "Metro", "declined"},
		{`gh repo clone cli/cli 'npx expo start'`, "Metro", "declined"},
		{`gh repo delete cli/cli --yes 'npx expo start'`, "Metro", "declined"},
		{`gh repo --help 'npx expo start'`, "Metro", "declined"},
		{`gh pr checkout 12 -- --upload-pack='npx expo start'`, "Metro", "declined"},
		{`gh pr create --web --title 'npx expo start'`, "Metro", "declined"},
		{`gh pr create --editor --title 'npx expo start'`, "Metro", "declined"},
		{`gh pr create -w --title 'npx expo start'`, "Metro", "declined"},
	})
	// What agents write when they commit, search, and open pull requests.
	wantRunning(t, []runningRow{
		{`git commit -m 'fix: stop running npx expo start by hand' -m 'Use the lane tool.'`, "declined"},
		{`git commit --amend --no-edit -m 'docs: never run xcrun simctl boot'`, "declined"},
		{`git commit -am 'docs: npx expo start is blocked' && git push -u origin feat/hook`, "declined"},
		{`git commit --no-verify --allow-empty -m 'chore: npx expo start'`, "declined"},
		{`git commit --signoff --author='A B <a@example.com>' -m 'npx expo start'`, "declined"},
		{`git add -A && git commit -m 'docs: npx expo start' && git push --force-with-lease origin HEAD`, "declined"},
		{`git log --oneline -n 20 --grep 'npx expo start'`, "declined"},
		{`git log --oneline --since=2.weeks --author=me -S 'xcrun simctl boot' -- apps/desktop`, "declined"},
		{`git log -p -S 'npx expo start' -- README.md`, "declined"},
		{`git diff --stat HEAD~1 -- README.md && echo 'npx expo start'`, "declined"},
		{`git diff --cached --name-only | grep 'npx expo start'`, "declined"},
		{`git grep -n --color=never -e 'xcrun simctl boot' -- docs`, "declined"},
		{`git status -sb | grep 'npx expo start'`, "declined"},
		{`git branch -a --list '*expo*' | grep 'npx expo start'`, "declined"},
		{`git tag -a v1.0.0 -m 'npx expo start is blocked'`, "declined"},
		{`git stash push -m 'npx expo start experiment'`, "declined"},
		{`git blame -L 1,20 README.md | grep 'npx expo start'`, "declined"},
		{`git -C apps/desktop log --oneline -S 'npx expo start'`, "declined"},
		{`git --no-pager log -1 --format=%B | grep 'npx expo start'`, "declined"},
		{`git --git-dir ../.git log -S 'npx expo start'`, "declined"},
		{`git fetch origin main --prune && echo 'npx expo start'`, "declined"},
		{`gh pr create --title 'docs: npx expo start' --body 'Replace npx expo start with lane up.' --base main`, "declined"},
		{`gh pr create --draft --title 'x' --body 'npx expo start' --label bug --reviewer octocat`, "declined"},
		{`gh pr edit 12 --body 'now npx expo start is blocked' --add-label docs`, "declined"},
		{`gh pr view 12 --json body,title --jq .body | grep 'npx expo start'`, "declined"},
		{`gh pr list --search 'npx expo start' --state all --limit 50`, "declined"},
		{`gh issue create --title 'npx expo start hangs' --body 'Steps: run npx expo start' --label bug`, "declined"},
		{`gh release create v1.0.0 --title 'v1' --notes 'no more npx expo start' --draft`, "declined"},
		{`gh api -X POST repos/octocat/hello/issues/12/comments -f body='npx expo start'`, "declined"},
		{`gh search issues 'npx expo start' --repo octocat/hello --limit 10`, "declined"},
		{`gh repo view octocat/hello --json description | grep 'npx expo start'`, "declined"},
		{`rg -n -i --glob '!node_modules' 'xcrun simctl boot' apps`, "declined"},
		{`rg -l 'npx expo start' -g '*.md' | head -n 5`, "declined"},
		{`rg --no-heading --line-number 'xcrun simctl boot' | sort -u`, "declined"},
		{`rg -C 2 -e 'npx expo start' -- docs`, "declined"},
		{`sort -t: -k2,2 -nr data.txt | head -n 3 && echo 'npx expo start'`, "declined"},
		{`sort -u notes.txt | grep 'npx expo start'`, "declined"},
	})
}

func TestHookExcuseRefusesBraceExpansionAndZshShortForms(t *testing.T) {
	// {-c,x} is two words to the shell, one to the option rules; and zsh runs
	// the command in braces after if, while, and always.
	wantDeclined(t, []verdictRow{
		{`git {-c,core.pager=x} log -S 'npx expo start'`, "Metro", "declined"},
		{`git fetch {--upload-pack=,}'npx expo start #' ../b`, "Metro", "declined"},
		{`git push {--rece,x}ive-pack='npx expo start #' ../b HEAD`, "Metro", "declined"},
		{`echo {a,b} 'npx expo start'`, "Metro", "declined"},
		{`ls {src,docs} | grep 'npx expo start'`, "Metro", "declined"},
		{`echo {1..3} 'npx expo start'`, "Metro", "declined"},
		{`gh api repos/{owner}/{repo}/pulls -f body='npx expo start'`, "Metro", "declined"},
		{`if true { echo 'npx expo start' }`, "Metro", "declined"},
		{`{ echo a } always { echo 'npx expo start' }`, "Metro", "declined"},
		{`while true { echo 'npx expo start' }`, "Metro", "declined"},
	})
	// Braces in quotes, or as a group, are text. An escaped one holds a
	// backslash, which turns the excuse off.
	wantRunning(t, []runningRow{
		{`jq '{a: .b}' package.json | grep 'npx expo start'`, "declined"},
		{`git log --format='{%h}' -S 'npx expo start'`, "declined"},
		{`echo '{' 'npx expo start' '}'`, "declined"},
		{`echo "{a,b}" 'npx expo start'`, "declined"},
		{`{ echo 'npx expo start'; echo done; }`, "declined"},
		{"{ echo 'npx expo start'\n}", "declined"},
	})
	wantDeclined(t, []verdictRow{
		{`echo \{a,b\} 'npx expo start'`, "Metro", "declined"},
	})
}

func TestBraceWordsReadsOnlyUnquotedBraces(t *testing.T) {
	for _, row := range []struct {
		text       string
		expands    bool
		groupWords int
	}{
		{"echo hi", false, 0},
		{"{ echo hi", false, 1},
		{"}", false, 1},
		{"if true { echo hi }", false, 2},
		{"echo {a,b}", true, 0},
		{"echo a{b", true, 0},
		{"git {-c,x} log", true, 0},
		{"echo '{a,b}' \"{c,d}\"", false, 0},
		{`echo \{a,b\}`, false, 0},
		{`echo "a \" {b,c}"`, false, 0},
		{"echo '{' '}'", false, 0},
		{"echo 'it'\"'\"'s' {a,b}", true, 0},
		{"echo 'unterminated {a,b}", false, 0},
		{"echo {", false, 1},
		{`echo \`, false, 0},
	} {
		expands, groupWords := braceWords(row.text)
		if expands != row.expands || groupWords != row.groupWords {
			t.Errorf("braceWords(%q) = %v, %d, want %v, %d", row.text, expands, groupWords, row.expands, row.groupWords)
		}
	}
}

func TestHookExcuseCountsFilesWrittenWithoutARedirection(t *testing.T) {
	// git runs the hook files of a repository, so git and gh are text only
	// when nothing on the line writes a file: sort -o, uniq's second operand,
	// and any --output write one as a redirection does.
	wantDeclined(t, []verdictRow{
		{`echo 'npx expo start' | sort -o .git/hooks/pre-commit; git commit -m x`, "Metro", "declined"},
		{`sort -o .git/hooks/pre-commit in.txt; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`sort -no .git/hooks/pre-commit in.txt; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`sort --output=.git/hooks/pre-commit in.txt; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`sort -o.git/hooks/pre-commit in.txt; gh pr create --body 'npx expo start'`, "Metro", "declined"},
		{`uniq in.txt .git/hooks/pre-commit; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`uniq -c in.txt .git/hooks/pre-commit; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`uniq -f 1 in.txt out.txt; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`git log -S 'npx expo start' --output=.git/hooks/pre-commit`, "Metro", "declined"},
		{`git diff --output=.git/hooks/pre-commit; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`git show HEAD --output=f; git commit -m 'npx expo start'`, "Metro", "declined"},
	})
	// Without git or gh on the line, a file written is only a note.
	wantRunning(t, []runningRow{
		{`echo 'npx expo start' | sort -o notes.txt`, "declined"},
		{`sort -u -o notes.txt in.txt | cat; echo 'npx expo start'`, "declined"},
		{`uniq -c in.txt out.txt; echo 'npx expo start'`, "declined"},
		{`uniq -c in.txt | sort -rn | head -n 5; echo 'npx expo start'`, "declined"},
		{`uniq -f 1 in.txt; echo 'npx expo start'`, "declined"},
		{`sort -t: -k2,2 -n -r in.txt; echo 'npx expo start'`, "declined"},
		{`git log -S 'npx expo start' | sort -u | uniq -c`, "declined"},
	})
}

func TestSortAndUniqWriteTheirOutputFile(t *testing.T) {
	for _, row := range []struct {
		arguments []string
		want      bool
	}{
		{nil, false},
		{[]string{"in.txt"}, false},
		{[]string{"in.txt", "out.txt"}, true},
		{[]string{"-c", "in.txt", "out.txt"}, true},
		{[]string{"-f", "1", "in.txt"}, false},
		{[]string{"-f", "1", "in.txt", "out.txt"}, true},
		{[]string{"-s", "2", "-w", "3", "in.txt"}, false},
		{[]string{"-", "out.txt"}, true},
		{[]string{"-c", "--", "in.txt", "out.txt"}, true},
		{[]string{"-c", "--", "in.txt"}, false},
		{[]string{"-c", "--"}, false},
	} {
		if got := uniqWrites(row.arguments); got != row.want {
			t.Errorf("uniqWrites(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
	for _, row := range []struct {
		arguments []string
		want      bool
	}{
		{nil, false},
		{[]string{"-u", "in.txt"}, false},
		{[]string{"-o", "out.txt"}, true},
		{[]string{"-uo", "out.txt"}, true},
		{[]string{"-oout.txt"}, true},
		{[]string{"-t:", "-k2,2", "-n"}, false},
		{[]string{"--output=out.txt"}, false},
		// A -- does not end the search: an option that takes a value swallows it,
		// and a file named -o only makes the excuse stricter.
		{[]string{"--", "-o"}, true},
		{[]string{"-k", "--", "-o", "out.txt"}, true},
		{[]string{"-k", "--", "out.txt"}, false},
	} {
		if got := sortWrites(row.arguments); got != row.want {
			t.Errorf("sortWrites(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
	for _, row := range []struct {
		arguments []string
		want      bool
	}{
		{nil, false},
		{[]string{"--output"}, true},
		{[]string{"--output=f"}, true},
		{[]string{"--outputs"}, false},
		{[]string{"-o", "f"}, false},
	} {
		if got := hasOutputOption(row.arguments); got != row.want {
			t.Errorf("hasOutputOption(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
}

func TestHookExcuseSeesTheWordAfterAQuotedRedirectionOperator(t *testing.T) {
	// A quoted > or < is a word, but segment.io() reads it as a redirection
	// and drops the word after it; the option rules read every word.
	wantDeclined(t, []verdictRow{
		{`rg '>' --pre='npx expo start' x`, "Metro", "declined"},
		{`rg '<' --pre 'npx expo start' x`, "Metro", "declined"},
		{`rg ">>" --pre='npx expo start' x`, "Metro", "declined"},
		{`rg \> --pre='npx expo start' x`, "Metro", "declined"},
		{`git grep '>' -O'npx expo start' x`, "Metro", "declined"},
		{`sort '>' --compress-program='npx expo start' f`, "Metro", "declined"},
		{`git fetch '>' --upload-pack='npx expo start #' origin`, "Metro", "declined"},
		{`git log '<' -c core.pager='npx expo start'`, "Metro", "declined"},
	})
	wantRunning(t, []runningRow{
		{`rg '>' 'npx expo start' docs`, "declined"},
		{`git log -S '>' --oneline --grep 'npx expo start'`, "declined"},
		{`grep '>' notes.md | rg 'npx expo start'`, "declined"},
		// A real redirection before the command, or after it, is set aside.
		{`2>/dev/null git log -S 'npx expo start'`, "declined"},
		{`git log -S 'npx expo start' 2>&1 >/dev/null | head -n 3`, "declined"},
		{`>/dev/null 2>&1 echo 'npx expo start'`, "declined"},
	})
}

func TestLeadingRedirectionTakesTheOperatorAndItsTarget(t *testing.T) {
	for _, row := range []struct {
		words []string
		want  int
	}{
		{[]string{"git", "log"}, 0},
		{[]string{">", "out.txt", "echo"}, 2},
		{[]string{">out.txt", "echo"}, 1},
		{[]string{"2>&1", "echo"}, 1},
		{[]string{"2>", "/dev/null", "echo"}, 2},
		{[]string{"<<<", "text", "cat"}, 2},
		{[]string{"<<EOF", "cat"}, 1},
		{[]string{"&>/dev/null"}, 1},
		{[]string{">"}, 1},
	} {
		if got := leadingRedirection(row.words); got != row.want {
			t.Errorf("leadingRedirection(%q) = %d, want %d", row.words, got, row.want)
		}
	}
}

func TestHookExcuseRefusesACommandThatStartsWithAnAssignment(t *testing.T) {
	// X=/rndevtools names no program: its base name is not a command, and
	// FOO=1 git log can run what GIT_PAGER says.
	wantDeclined(t, []verdictRow{
		{`X=/rndevtools trap 'npx expo start' EXIT`, "Metro", "declined"},
		{`X=/a/rndevtools bash -c '"$@"' _ npx expo start`, "Metro", "declined"},
		{`X=/rndevtools sh -c 'exec "$@"' sh xcrun simctl boot X`, "simctl boot", "declined"},
		{`X=/rndevtools source <(echo 'npx expo start')`, "Metro", "declined"},
		{`X=/rndevtools echo 'npx expo start' | sh`, "Metro", "declined"},
		{`X=/rndevtools git commit -m 'npx expo start'`, "Metro", "declined"},
		{`X=1 trap 'npx expo start' EXIT`, "Metro", "declined"},
		{`FOO=1 git commit -m 'npx expo start'`, "Metro", "declined"},
		{`X=/rndevtools; git commit -m 'npx expo start'`, "Metro", "declined"},
		{`env X=/rndevtools git commit -m 'npx expo start'`, "Metro", "declined"},
		{`sudo X=/rndevtools git commit -m 'npx expo start'`, "Metro", "declined"},
		{`time X=/rndevtools git commit -m 'npx expo start'`, "Metro", "declined"},
	})
	// RN Devtools' own CLI is exempt from the text rule itself, with a
	// variable set or not, and also by its path.
	wantRunning(t, []runningRow{
		{`rndevtools claim --udid X --note 'npx expo start'`, "passed"},
		{`~/.local/bin/rndevtools claim --udid X --note 'npx expo start'`, "passed"},
		{`X=1 rndevtools claim --udid X --note 'npx expo start'`, "passed"},
		{`git log -S 'npx expo start' | ~/.local/bin/rndevtools claim --udid X --note 'npx expo start'`, "declined"},
	})
}

func TestHookExcuseLooksThroughLaunchersWithNothingAfterThem(t *testing.T) {
	// A launcher with no operand runs nothing.
	wantRunning(t, []runningRow{
		{`git commit -m 'npx expo start'; nice`, "declined"},
		{`git commit -m 'npx expo start'; nohup`, "declined"},
		{`git commit -m 'npx expo start'; time`, "declined"},
		{`git commit -m 'npx expo start' && sudo -u me`, "declined"},
		{`git commit -m 'npx expo start'; timeout 5`, "declined"},
	})
	wantDeclined(t, []verdictRow{
		{`git commit -m 'npx expo start'; nice sh`, "Metro", "declined"},
		{`git commit -m 'npx expo start'; sudo -s`, "Metro", "declined"},
	})
}

func TestHookExcuseLooksThroughShellKeywords(t *testing.T) {
	// The keywords before a command (if, then, else, elif, while, until, do,
	// !, and the braces of a group) are not commands.
	wantRunning(t, []runningRow{
		{`if grep -q 'npx expo start' notes.md; then echo yes; else echo no; fi`, "declined"},
		{`if ! grep -q 'npx expo start' notes.md; then echo 'npx expo start' >> notes.md; fi`, "declined"},
		{`! grep -q 'npx expo start' notes.md`, "declined"},
		{`{ echo 'npx expo start'; echo 'xcrun simctl boot X'; } > notes.md`, "declined"},
		{`while grep -q 'npx expo start' notes.md; do sleep 1; done`, "declined"},
		{`until grep -q 'npx expo start' notes.md; do sleep 1; done`, "declined"},
		{`if test -f notes.md; then grep -c 'npx expo start' notes.md; elif true; then echo none; fi`, "declined"},
	})
	// A command in the body is still a command; a loop or a case is not text.
	wantDeclined(t, []verdictRow{
		{`for f in a b; do echo 'npx expo start'; done`, "Metro", "declined"},
		{`case x in x) echo 'npx expo start';; esac`, "Metro", "declined"},
		{`if git commit -m 'npx expo start'; then pnpm test; fi`, "Metro", "declined"},
	})
}

func TestRedirectsToFileHonoursEscapesAndQuotes(t *testing.T) {
	for _, row := range []struct {
		text string
		want bool
	}{
		{"git log", false},
		{"git log > out.txt", true},
		{"git log >> out.txt", true},
		{"git log 2> err.txt", true},
		{"git log &> out.txt", true},
		{"git log >| out.txt", true},
		{"git log > /dev/null", false},
		{"git log >/dev/null 2>&1", false},
		{"git log >&2", false},
		// A quote that never closes hides the rest of the text from the scan.
		{"echo 'a > b", false},
		{`echo "a > b`, false},
		{"git log '>' out.txt", false},
		{`git log ">" out.txt`, false},
		{`git log "a\"> b" out.txt`, false},
		// A backslash quotes the character after it: not a redirection, and not
		// a quote either.
		{`git log \> out.txt`, false},
		{`git log \>out.txt`, false},
		{`echo \' > hook`, true},
		{`echo \" > hook`, true},
		{`echo a\\> hook`, true},
		{`echo \\\> hook`, false},
	} {
		if got := redirectsToFile(row.text); got != row.want {
			t.Errorf("redirectsToFile(%q) = %v, want %v", row.text, got, row.want)
		}
	}
	// The same through the hook: an escaped quote does not hide the redirection
	// after it, and an escaped > writes nothing but is a backslash, which turns
	// the excuse off all the same.
	wantDeclined(t, []verdictRow{
		{`git commit -m 'npx expo start' \> notes`, "Metro", "declined"},
		{`git log -S 'npx expo start' \>hook`, "Metro", "declined"},
		{`git commit -m 'npx expo start' && echo \' > hook`, "Metro", "declined"},
		{`echo \" > hook; git commit -m 'npx expo start'`, "Metro", "declined"},
	})
}

func TestOptionPolicyAllowsOnlyWhatItLists(t *testing.T) {
	policy := optionPolicy{short: "ab1", long: names("--name", "--no-name")}
	for option, want := range map[string]bool{
		"-a":          true,
		"-ab":         true,
		"-ab1":        true,
		"-c":          false,
		"-ac":         false,
		"-a1b":        true,
		"--name":      true,
		"--name=v":    true,
		"--name=a=b":  true,
		"--no-name":   true,
		"--nam":       false,
		"--names":     false,
		"--name-x=v":  false,
		"--other":     false,
		"--":          false,
		"--=x":        false,
		"-é":          false,
		"--Name":      false,
		"--name =v":   false,
		"--no-name=x": true,
	} {
		if got := policy.allows(option); got != want {
			t.Errorf("allows(%q) = %v, want %v", option, got, want)
		}
	}
	for _, row := range []struct {
		arguments    []string
		dashesHandOn bool
		want         bool
	}{
		{nil, false, true},
		{[]string{"word", "-a", "--name=v", "-"}, false, true},
		{[]string{"word", "-c"}, false, false},
		// The words after a -- are read too: an option that takes a value
		// swallows the --, and what follows is an option again.
		{[]string{"-a", "--", "-c", "--other"}, false, false},
		{[]string{"-a", "--", "-c"}, false, false},
		{[]string{"-a", "--", "--other=x"}, false, false},
		{[]string{"-a", "--", "-a1", "--name=v", "-", "word"}, false, true},
		{[]string{"-a", "--", "word"}, false, true},
		{[]string{"-a", "--"}, false, true},
		{[]string{"--", "-c"}, false, false},
		{[]string{"-a", "--", "-c"}, true, false},
		{[]string{"-a", "--"}, true, false},
		{[]string{"-c", "--"}, false, false},
	} {
		if got := policy.allowsAll(row.arguments, row.dashesHandOn); got != row.want {
			t.Errorf("allowsAll(%q, %v) = %v, want %v", row.arguments, row.dashesHandOn, got, row.want)
		}
	}
}

func TestGitReadsTextOnlyWithTheOptionsItCanName(t *testing.T) {
	for _, row := range []struct {
		arguments []string
		want      bool
	}{
		{[]string{"commit", "-m", "x"}, true},
		{[]string{"commit", "-am", "x"}, true},
		{[]string{"-C", "apps/mobile", "commit", "-m", "x"}, true},
		{[]string{"--git-dir", "../.git", "log"}, true},
		{[]string{"--git-dir=../.git", "log"}, true},
		{[]string{"--no-pager", "log", "--oneline"}, true},
		// The words after a -- are read too: an option that takes a value
		// swallows the --.
		{[]string{"log", "-S", "x", "--", "docs"}, true},
		{[]string{"log", "-S", "x", "--", "-n1"}, true},
		{[]string{"log", "-S", "x", "--", "-c"}, false},
		{[]string{"log", "--", "--upl=x"}, false},
		// A -- before the subcommand names none, whatever follows it.
		{[]string{"--", "log", "-S", "x"}, false},
		{[]string{"push", "-o", "--", "--receive-pack=x", "../b", "HEAD"}, false},
		{[]string{"fetch", "-o", "--", "--upload-pack=x", "../b"}, false},
		{[]string{"grep", "-e", "--", "--open-files-in-pager=x"}, false},
		{[]string{"-c", "core.pager=x", "log"}, false},
		{[]string{"commit", "-c", "HEAD"}, false},
		{[]string{"log", "--upl=x"}, false},
		{[]string{"grep", "-O", "x"}, false},
		{[]string{"-C", "-c", "log"}, true},
		{[]string{"-C"}, false},
		{[]string{"rebase", "-m", "x"}, false},
		{[]string{"config", "alias.x", "x"}, false},
		{[]string{"--"}, false},
		{nil, false},
		{[]string{"-", "log"}, false},
	} {
		if got := gitReadsText(row.arguments); got != row.want {
			t.Errorf("gitReadsText(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
}

func TestGhReadsTextOnlyForItsReadingCommands(t *testing.T) {
	for _, row := range []struct {
		arguments []string
		want      bool
	}{
		{[]string{"pr", "create", "--title", "x", "--body", "y"}, true},
		{[]string{"issue", "comment", "12", "-b", "x"}, true},
		{[]string{"api", "repos/o/r/issues", "-f", "title=x"}, true},
		{[]string{"repo", "view", "o/r", "--json", "name"}, true},
		{[]string{"repo", "list", "-L", "5"}, true},
		{[]string{"repo"}, false},
		{[]string{"repo", "clone", "o/r"}, false},
		{[]string{"repo", "delete", "o/r"}, false},
		{[]string{"pr", "checkout", "12", "--", "--upload-pack=x"}, false},
		// A -- ends the excuse for gh whatever follows it, -c included, which
		// gh's own letters allow.
		{[]string{"pr", "checkout", "12", "--", "-c", "core.sshCommand=x"}, false},
		{[]string{"pr", "checkout", "12", "--"}, false},
		{[]string{"pr", "create", "--web"}, false},
		{[]string{"pr", "create", "-w"}, false},
		{[]string{"pr", "create", "-e"}, false},
		{[]string{"pr", "create", "--editor"}, false},
		{[]string{"extension", "exec", "x"}, false},
		{[]string{"alias", "set", "x", "!y"}, false},
		{[]string{"run", "list"}, false},
		{nil, false},
	} {
		if got := ghReadsText(row.arguments); got != row.want {
			t.Errorf("ghReadsText(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
}
