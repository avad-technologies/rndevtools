package setup

import (
	"reflect"
	"strings"
	"testing"
)

func segmentWords(line string) [][]string {
	var words [][]string
	for _, segment := range splitShell(line) {
		words = append(words, segment.words)
	}
	return words
}

func TestSplitShellBreaksOnControlOperatorsOutsideQuotes(t *testing.T) {
	for line, want := range map[string][][]string{
		"rndevtools doctor; expo start":          {{"rndevtools", "doctor"}, {"expo", "start"}},
		"a && b || c | d |& e & f":               {{"a"}, {"b"}, {"c"}, {"d"}, {"e"}, {"f"}},
		"a\nb":                                   {{"a"}, {"b"}},
		"(cd app; expo start)":                   {{"cd", "app"}, {"expo", "start"}},
		`echo "a; b && c" 'd | e'`:               {{"echo", "a; b && c", "d | e"}},
		`echo a\;b`:                              {{"echo", "a;b"}},
		"expo start > log 2>&1 &":                {{"expo", "start", ">", "log", "2>&1"}},
		"cmd &> log":                             {{"cmd", "&>", "log"}},
		"npx expo \\\nstart":                     {{"npx", "expo", "start"}},
		"git status # expo start\nls":            {{"git", "status"}, {"ls"}},
		"curl http://example.com/#top":           {{"curl", "http://example.com/#top"}},
		`printf ''`:                              {{"printf", ""}},
		"  ;; ;":                                 nil,
		`echo "unterminated; still quoted`:       {{"echo", "unterminated; still quoted"}},
		`'/Applications/RN Devtools.app/x' hook`: {{"/Applications/RN Devtools.app/x", "hook"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestSplitShellGivesSubstitutionsTheirOwnSegments(t *testing.T) {
	for line, want := range map[string][][]string{
		"rndevtools claim --note $(xcrun simctl boot X)": {
			{"xcrun", "simctl", "boot", "X"},
			{"rndevtools", "claim", "--note", "$(xcrun simctl boot X)"},
		},
		`rndevtools claim --note "$(expo start)"`: {
			{"expo", "start"},
			{"rndevtools", "claim", "--note", "$(expo start)"},
		},
		"echo `expo start`": {{"expo", "start"}, {"echo", "`expo start`"}},
		"diff <(a) >(b)":    {{"a"}, {"b"}, {"diff", "<(a)", ">(b)"}},
		"echo $(a $(b) (c))": {
			{"b"}, {"a", "$(b)"}, {"c"}, {"echo", "$(a $(b) (c))"},
		},
		`echo '$(not run)'`: {{"echo", "$(not run)"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
	// Pathological nesting is bounded rather than followed forever.
	deep := strings.Repeat("$(", 10_000) + "expo start" + strings.Repeat(")", 10_000)
	if segments := splitShell(deep); len(segments) > maxShellDepth+1 {
		t.Fatalf("followed %d nested substitutions", len(segments))
	}
}

func TestParseShellLineRecordsTerminatorsAndScopes(t *testing.T) {
	type shape struct {
		program    string
		terminator string
		scope      int
	}
	for line, want := range map[string][]shape{
		"cd a && b; c | d & e || f |& g\nh": {
			{"cd", "&&", 0}, {"b", ";", 0}, {"c", "|", 0}, {"d", "&", 0}, {"e", "||", 0}, {"f", "|&", 0}, {"g", "\n", 0}, {"h", "", 0},
		},
		"(cd x; y) && z":          {{"cd", ";", 1}, {"y", "", 1}, {"z", "", 0}},
		"echo $(cd x; y) && z":    {{"cd", ";", 1}, {"y", "", 1}, {"echo", "&&", 0}, {"z", "", 0}},
		"(a) ; (b)":               {{"a", "", 1}, {"b", "", 2}},
		`x "$(y)" ` + "`z`":       {{"y", "", 1}, {"z", "", 2}, {"x", "", 0}},
		"supabase status >| .env": {{"supabase", "", 0}},
	} {
		parsed := parseShellLine(line)
		var got []shape
		for _, segment := range parsed.segments {
			got = append(got, shape{segment.program(), segment.terminator, segment.scope})
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %+v, want %+v", line, got, want)
		}
		if parsed.parents[0] != -1 {
			t.Errorf("%q: the line's own scope has no parent", line)
		}
	}
	nested := parseShellLine("a $(b $(c))")
	if !reflect.DeepEqual(nested.parents, []int{-1, 0, 1}) {
		t.Fatalf("substitution scopes nest: %v", nested.parents)
	}
	if words := segmentWords("supabase status >| .env"); !reflect.DeepEqual(words, [][]string{{"supabase", "status", ">|", ".env"}}) {
		t.Fatalf(">| is a redirection, not a pipe: %q", words)
	}
	assignments, words := splitShell("env FOO=1 sudo -E BAR=2 supabase start")[0].commandWords()
	if !reflect.DeepEqual(assignments, []string{"FOO=1", "BAR=2"}) || !reflect.DeepEqual(words, []string{"supabase", "start"}) {
		t.Fatalf("commandWords: %q %q", assignments, words)
	}
}

func TestSplitShellSkipsHereDocumentBodies(t *testing.T) {
	for line, want := range map[string][][]string{
		"cat > notes.md <<'EOF'\nsupabase stop --all\nxcrun simctl boot X\nEOF\nsupabase start": {
			{"cat", ">", "notes.md", "<<'EOF'"}, {"supabase", "start"},
		},
		"cat <<EOF > a; echo b\nline one\nEOF\nnext": {
			{"cat", "<<EOF", ">", "a"}, {"echo", "b"}, {"next"},
		},
		"cat <<-\"END\"\n\tpkill postgres\n\tEND\ndone": {{"cat", `<<-"END"`}, {"done"}},
		"cat <<A <<B\nfirst\nA\nsecond\nB\nafter":       {{"cat", "<<A", "<<B"}, {"after"}},
		"cat <<EOF\nnever closed\nsupabase stop --all":  {{"cat", "<<EOF"}},
		"git commit -m \"$(cat <<'EOF'\nfix: supabase stop --all\nEOF\n)\" && git push": {
			{"cat", "<<'EOF'"}, {"git", "commit", "-m", "$(cat <<'EOF'\nfix: supabase stop --all\nEOF\n)"}, {"git", "push"},
		},
		"grep -c x <<< \"supabase start\"": {{"grep", "-c", "x", "<<<", "supabase start"}},
		"echo $(( 1 << 2 ))\nnext":         {{"1", "<<", "2"}, {"echo", "$(( 1 << 2 ))"}, {"next"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
	// Substitutions run as their own segments, so the text the pattern rules
	// read for the command around them holds only a placeholder.
	segments := splitShell("git commit -m \"$(cat <<'EOF'\nxcrun simctl boot X\nEOF\n)\"")
	if text := segments[len(segments)-1].text; text != `git commit -m "$(…)"` {
		t.Fatalf("text %q", text)
	}
}

func TestSplitShellKeepsTheSourceTextTheTextRuleReads(t *testing.T) {
	// The text rule matches a segment's source text, so what that text holds
	// is part of its verdict: the command as written, quotes and blanks
	// included, a placeholder for each substitution body, and neither a
	// here-document body nor a comment. These are the texts the splitter made
	// before the word rules existed; the rows were taken from that version.
	for line, want := range map[string][]string{
		"echo \"a; b\" 'c | d'": {"echo \"a; b\" 'c | d'"},
		"git commit -m \"$(cat <<'EOF'\nxcrun simctl boot X\nEOF\n)\" && git push": {"cat <<'EOF'", "git commit -m \"$(…)\" ", " git push"},
		"bash<<<'npx expo start'": {"bash<<<'npx expo start'"},
		"cat > notes.md <<'EOF'\nxcrun simctl shutdown all\nEOF\nnpx expo start": {"cat > notes.md <<'EOF'", "npx expo start"},
		"echo 'x' # npx expo start\nls":                                          {"echo 'x' ", "ls"},
		"npx expo \\\nstart":                                                     {"npx expo start"},
		"echo a\\;b":                                                             {"echo a\\;b"},
		"x=$(npx expo start) y":                                                  {"npx expo start", "x=$(…) y"},
		"ls | grep \"npx expo start\"":                                           {"ls ", " grep \"npx expo start\""},
		"sh -c \"echo $(date) && npx expo start\"":                               {"date", "sh -c \"echo $(…) && npx expo start\""},
		"cat <(npx expo start) > out":                                            {"npx expo start", "cat <(…) > out"},
		"echo `xcrun simctl boot X` | tee log":                                   {"xcrun simctl boot X", "echo `…` ", " tee log"},
		"(cd app; npx expo start) &":                                             {"cd app", " npx expo start"},
		"nohup npx expo start > metro.log 2>&1 &":                                {"nohup npx expo start > metro.log 2>&1 "},
	} {
		var got []string
		for _, segment := range splitShell(line) {
			got = append(got, segment.text)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: texts %q, want %q", line, got, want)
		}
	}
}

func TestSplitShellStartsAWordAtAnInputOperator(t *testing.T) {
	for line, want := range map[string][][]string{
		"bash<<<'npx expo start'":   {{"bash", "<<<npx expo start"}},
		`sh -s<<<"cmd"`:             {{"sh", "-s", "<<<cmd"}},
		"bash 0<<<'cmd'":            {{"bash", "0<<<cmd"}},
		"bash 0<<< 'cmd'":           {{"bash", "0<<<", "cmd"}},
		"cat<<EOF\nbody\nEOF\nnext": {{"cat", "<<EOF"}, {"next"}},
		"cat 3<<EOF\nbody\nEOF":     {{"cat", "3<<EOF"}},
		"echo $(( 1<<2 ))":          {{"1<<2"}, {"echo", "$(( 1<<2 ))"}},
		`echo 'a<<<b' "c<<d"`:       {{"echo", "a<<<b", "c<<d"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestParseShellLineNotesTheGroupPipedIntoACommand(t *testing.T) {
	for line, want := range map[string][]int{
		"(echo a) | sh":                   {0, 1},
		"( echo a; echo b ) |& sh":        {0, 0, 1},
		"(echo a) || sh":                  {0, 0},
		"(echo a) > f | sh":               {0, 0, 0},
		"(echo a) | (sh)":                 {0, 1},
		"echo a | sh":                     {0, 0},
		"ls; (echo a) | sh -c \"$(cat)\"": {0, 0, 0, 1},
	} {
		var got []int
		for _, segment := range splitShell(line) {
			got = append(got, segment.pipedGroup)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: piped groups %v, want %v", line, got, want)
		}
	}
}

func TestSplitShellKeepsHereDocumentBodiesForTheCommandThatReadsThem(t *testing.T) {
	type body struct {
		segment, word int
		body          string
	}
	for line, want := range map[string][]body{
		"cat <<'EOF' | bash\nnpx expo start\nEOF\nnext":                {{0, 1, "npx expo start\n"}},
		"bash<<EOF\na\nb\nEOF":                                         {{0, 1, "a\nb\n"}},
		"cat <<A <<B\nfirst\nA\nsecond\nB\nafter":                      {{0, 1, "first\n"}, {0, 2, "second\n"}},
		"cat <<'EOF' > a.md; cat <<X | sh\nnotes\nEOF\nscript\nX":      {{0, 1, "notes\n"}, {1, 1, "script\n"}},
		"sh <<-EOF\n\tcmd\n\tEOF":                                      {{0, 1, "cmd\n"}},
		"cat <<EOF\nnever closed\nlast":                                {{0, 1, "never closed\nlast\n"}},
		"git commit -m \"$(cat <<'EOF'\nmessage\nEOF\n)\" && git push": {{0, 1, "message\n"}},
	} {
		var got []body
		for index, segment := range splitShell(line) {
			for _, document := range segment.documents {
				got = append(got, body{index, document.word, document.body})
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %+v, want %+v", line, got, want)
		}
	}
}

func TestSegmentProgramSkipsAssignmentsKeywordsAndWrappers(t *testing.T) {
	for line, want := range map[string]string{
		"rndevtools doctor":                                "rndevtools",
		"~/.local/bin/rndevtools doctor":                   "rndevtools",
		`"/Applications/RN Devtools.app/bin/rndevtools" x`: "rndevtools",
		"FOO=1 BAR_2=x rndevtools doctor":                  "rndevtools",
		"env -i PATH=/bin rndevtools doctor":               "rndevtools",
		"time nohup rndevtools doctor":                     "rndevtools",
		"{ rndevtools doctor":                              "rndevtools",
		"then rndevtools doctor":                           "rndevtools",
		"! rndevtools doctor":                              "rndevtools",
		"echo rndevtools":                                  "echo",
		"rndevtools-dev doctor":                            "rndevtools-dev",
		"1FOO=bar rndevtools":                              "1FOO=bar",
		"sudo -u root rndevtools":                          "root",
		"FOO=1":                                            "",
	} {
		segments := splitShell(line)
		if len(segments) != 1 {
			t.Fatalf("%q: %d segments", line, len(segments))
		}
		if got := segments[0].program(); got != want {
			t.Errorf("%q: program %q, want %q", line, got, want)
		}
	}
}

func TestSplitShellSplitsOutTheSubstitutionsOfAnUnquotedHereDocument(t *testing.T) {
	type shape struct {
		words [][]string
		scope []int
	}
	// The shell expands the body of a here-document whose delimiter has no
	// quoting, so its $( ) and backtick substitutions are commands: segments of
	// their own, in a scope nested in the command that reads the body.
	for line, want := range map[string]shape{
		"cat <<EOF\nRun $(npx expo start) now\nEOF": {
			[][]string{{"cat", "<<EOF"}, {"npx", "expo", "start"}}, []int{0, 1},
		},
		"cat <<EOF\nRun `npx expo start` now\nEOF": {
			[][]string{{"cat", "<<EOF"}, {"npx", "expo", "start"}}, []int{0, 1},
		},
		"cat <<EOF\n$(a)\n$(b)\nEOF\necho after": {
			[][]string{{"cat", "<<EOF"}, {"a"}, {"b"}, {"echo", "after"}}, []int{0, 1, 2, 0},
		},
		"(cat <<EOF\n$(a)\nEOF\n)": {
			[][]string{{"cat", "<<EOF"}, {"a"}}, []int{1, 2},
		},
		"cat <<EOF\n$(a $(b))\nEOF": {
			[][]string{{"cat", "<<EOF"}, {"b"}, {"a", "$(b)"}}, []int{0, 2, 1},
		},
		"cat <<EOF\n$(cd app\nnpx expo start)\nEOF": {
			[][]string{{"cat", "<<EOF"}, {"cd", "app"}, {"npx", "expo", "start"}}, []int{0, 1, 1},
		},
		"cat <<EOF\n$(cat <<INNER\n$(deep)\nINNER\n)\nEOF": {
			[][]string{{"cat", "<<EOF"}, {"cat", "<<INNER"}, {"deep"}}, []int{0, 1, 2},
		},
		"cat <<-EOF\n\t$(a)\n\tEOF": {
			[][]string{{"cat", "<<-EOF"}, {"a"}}, []int{0, 1},
		},
		"cat <<'A' <<B\n$(literal)\nA\n$(runs)\nB": {
			[][]string{{"cat", "<<'A'", "<<B"}, {"runs"}}, []int{0, 1},
		},
		"cat <<A; cat <<B\n$(first)\nA\n$(second)\nB": {
			[][]string{{"cat", "<<A"}, {"cat", "<<B"}, {"first"}, {"second"}}, []int{0, 0, 1, 2},
		},
		// A quoted delimiter, however it is quoted, leaves the body as text; so
		// does a backslash before the $ or the backtick.
		"cat <<'EOF'\n$(a) `b`\nEOF":        {[][]string{{"cat", "<<'EOF'"}}, []int{0}},
		"cat <<\"EOF\"\n$(a) `b`\nEOF":      {[][]string{{"cat", "<<\"EOF\""}}, []int{0}},
		"cat <<\\EOF\n$(a) `b`\nEOF":        {[][]string{{"cat", "<<\\EOF"}}, []int{0}},
		"cat <<E\"O\"F\n$(a) `b`\nEOF":      {[][]string{{"cat", "<<E\"O\"F"}}, []int{0}},
		"cat <<EOF\n\\$(a) \\`b\\` $x\nEOF": {[][]string{{"cat", "<<EOF"}}, []int{0}},
		"cat <<EOF\n$((1 + 2)) ${x}\nEOF":   {[][]string{{"cat", "<<EOF"}, {"1", "+", "2"}}, []int{0, 2}},
	} {
		parsed := parseShellLine(line)
		var words [][]string
		var scopes []int
		for _, segment := range parsed.segments {
			words = append(words, segment.words)
			scopes = append(scopes, segment.scope)
		}
		if !reflect.DeepEqual(words, want.words) || !reflect.DeepEqual(scopes, want.scope) {
			t.Errorf("%q: words %q scopes %v, want %q %v", line, words, scopes, want.words, want.scope)
		}
	}
	// Both the body and the substitutions of a document stay with the command
	// that reads it.
	parsed := parseShellLine("cat <<EOF\nRun $(a) now\nEOF\nnext")
	if got := parsed.segments[0].documents; len(got) != 1 || got[0].body != "Run $(a) now\n" {
		t.Fatalf("documents %+v", got)
	}
	if !reflect.DeepEqual(parsed.parents, []int{-1, 0}) {
		t.Fatalf("parents %v", parsed.parents)
	}
}

func TestSplitShellJoinsALineContinuationInAHereDocumentDelimiter(t *testing.T) {
	// The shell removes a backslash and a newline before it reads the words, so
	// <<EOF followed by a continuation and hi is the delimiter EOFhi, and the
	// rest of that line is a command line like any other.
	parsed := parseShellLine("echo <<EOF\\\nhi 2>&1 && echo ran\nbody\nEOFhi\necho after")
	var words [][]string
	for _, segment := range parsed.segments {
		words = append(words, segment.words)
	}
	want := [][]string{{"echo", "<<EOFhi", "2>&1"}, {"echo", "ran"}, {"echo", "after"}}
	if !reflect.DeepEqual(words, want) {
		t.Fatalf("words %q, want %q", words, want)
	}
	if got := parsed.segments[0].documents; len(got) != 1 || got[0].body != "body\n" {
		t.Fatalf("documents %+v", got)
	}
	// A continuation in the middle of the delimiter, or before it, as well.
	for _, line := range []string{
		"cat <<E\\\nOF\nbody\nEOF\necho after",
		"cat <<\\\nEOF\nbody\nEOF\necho after",
		"cat << \\\nEOF\nbody\nEOF\necho after",
		"cat <<EOF\\\n\nbody\nEOF\necho after",
	} {
		parsed := parseShellLine(line)
		last := parsed.segments[len(parsed.segments)-1]
		if last.text != "echo after" {
			t.Errorf("%q: the last command is %q, want the one after the body", line, last.text)
		}
		for _, segment := range parsed.segments {
			if strings.Contains(strings.Join(segment.words, " "), "body") {
				t.Errorf("%q: the body is read as a command: %q", line, segment.words)
			}
		}
	}
}

func TestSplitShellReadsTheLinesOfAnExpandedHereDocumentBodyAsTheShellDoes(t *testing.T) {
	// In the body of a document whose delimiter is unquoted, a backslash and a
	// newline join two lines, so EOF\ and an empty line is the delimiter line,
	// and the command after it runs; a delimiter line that follows a line
	// ending in a backslash is not one. A quoted delimiter leaves every line as
	// it is.
	for _, row := range []struct {
		line string
		body string
		// next is the command after the body, "" when the body has no end.
		next string
	}{
		{"cat <<EOF\nEOF\\\n\necho after", "", "echo after"},
		{"cat <<EOF\nbody\nEOF\\\n\necho after", "body\n", "echo after"},
		{"cat <<-EOF\n\tbody\n\tEOF\\\n\necho after", "body\n", "echo after"},
		{"cat <<EOF\nEO\\\nF\necho after", "", "echo after"},
		{"cat <<EOF\na\\\nEOF\nb\nEOF\necho after", "aEOF\nb\n", "echo after"},
		{"cat <<EOF\nx\\\\\nEOF\necho after", "x\\\\\n", "echo after"},
		{"cat <<EOF\nx\\\\\\\nEOF\n\nEOF\necho after", "x\\\\EOF\n\n", "echo after"},
		{"cat <<EOF\nx\\$y\\\nz\nEOF\necho after", "x\\$yz\n", "echo after"},
		{"cat <<'EOF'\nEOF\\\n\necho after", "EOF\\\n\necho after\n", ""},
		{"cat <<\"EOF\"\nEOF\\\n\necho after", "EOF\\\n\necho after\n", ""},
		{"cat <<\\EOF\nEOF\\\n\necho after", "EOF\\\n\necho after\n", ""},
		{"cat <<'EOF'\na\\\nEOF\necho after", "a\\\n", "echo after"},
		{"cat <<EOF\nbody\\", "body\\\n", ""},
		{"cat <<EOF\nbody\\\n", "body\n", ""},
	} {
		parsed := parseShellLine(row.line)
		documents := parsed.segments[0].documents
		if len(documents) != 1 || documents[0].body != row.body {
			t.Errorf("%q: documents %+v, want one with the body %q", row.line, documents, row.body)
			continue
		}
		var texts []string
		for _, segment := range parsed.segments[1:] {
			texts = append(texts, segment.text)
		}
		switch {
		case row.next == "" && len(texts) != 0:
			t.Errorf("%q: the commands %q follow, want the body to run to the end", row.line, texts)
		case row.next != "" && !reflect.DeepEqual(texts, []string{row.next}):
			t.Errorf("%q: the commands after the body are %q, want %q", row.line, texts, row.next)
		}
	}
}

func TestSplitShellReadsABackslashAtTheEndOfTheLineAndAnOpenDelimiterQuote(t *testing.T) {
	// A backslash with nothing after it is itself.
	if got := segmentWords("echo hi \\"); !reflect.DeepEqual(got, [][]string{{"echo", "hi", `\`}}) {
		t.Fatalf("words %q", got)
	}
	// A quote that never closes in the delimiter makes it no delimiter, and
	// leaves the line partial: the rest is a quoted string.
	for _, line := range []string{"cat <<'EOF\nbody\nEOF", "cat <<\"EOF\nbody\nEOF"} {
		parsed := parseShellLine(line)
		if !parsed.partial || len(parsed.segments[0].documents) != 0 {
			t.Errorf("%q: partial %v, documents %+v", line, parsed.partial, parsed.segments[0].documents)
		}
	}
}

func TestSplitShellKeepsEachBatchOfHereDocumentsWithItsCommand(t *testing.T) {
	// Operators on one line wait for the end of it; each command that
	// completes claims the ones read since the last, and the next line starts
	// afresh.
	type body struct {
		segment, word int
		body          string
	}
	for line, want := range map[string][]body{
		"cat <<A\none\nA\ncat <<B\ntwo\nB\ncat <<C <<D\nthree\nC\nfour\nD": {
			{0, 1, "one\n"}, {1, 1, "two\n"}, {2, 1, "three\n"}, {2, 2, "four\n"},
		},
		"cat <<A; cat <<B <<C; echo; cat <<D\n1\nA\n2\nB\n3\nC\n4\nD\nlast": {
			{0, 1, "1\n"}, {1, 1, "2\n"}, {1, 2, "3\n"}, {3, 1, "4\n"},
		},
		"(cat <<A) | (cat <<B)\nx\nA\ny\nB": {
			{0, 1, "x\n"}, {1, 1, "y\n"},
		},
	} {
		var got []body
		for index, segment := range splitShell(line) {
			for _, document := range segment.documents {
				got = append(got, body{index, document.word, document.body})
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %+v, want %+v", line, got, want)
		}
	}
}

func TestParseShellLineMarksALinePartialWhenItCannotReadAllOfIt(t *testing.T) {
	for line, want := range map[string]bool{
		"echo hi":                                            false,
		`echo 'a' "b" $(c) ` + "`d`":                         false,
		"echo 'abc":                                          true,
		`echo "abc`:                                          true,
		"echo $(abc":                                         true,
		"echo `abc":                                          true,
		"echo <(abc":                                         true,
		`echo "$(abc"`:                                       true,
		"cat <<EOF\nnever closed":                            false,
		"cat <<EOF\n$(never closed\nEOF":                     true,
		"cat <<EOF\n`never closed\nEOF":                      true,
		"cat <<'EOF'\n$(not run\nEOF":                        false,
		"echo $(a) # 'not a quote":                           false,
		"cat <<EOF\n'not a quote\nEOF":                       false,
		nested(16, "a", "echo $(", ")"):                      false,
		nested(17, "a", "echo $(", ")"):                      true,
		nested(16, "a", "cat <(", ")"):                       false,
		nested(17, "a", "cat <(", ")"):                       true,
		nested(17, "a", "echo \"$(", ")\""):                  true,
		"cat <<EOF\n" + nested(17, "a", "$(", ")") + "\nEOF": true,
		// A ( group that never closes is a syntax error to bash and a pattern to
		// zsh, which reads the lines after it as part of that word.
		"echo a (":                      true,
		"(echo a":                       true,
		"(echo a; (echo b)":             true,
		"echo 'a'(\nb":                  true,
		"true <<END && echo a(\nEND\nb": true,
		"(echo a); (echo b)":            false,
		"(echo a; (echo b))":            false,
		"echo $(echo a; (echo b))":      false,
		"echo a)":                       false,
	} {
		if got := parseShellLine(line).partial; got != want {
			t.Errorf("%q: partial %v, want %v", line, got, want)
		}
	}
	if parsed := parseShellLine("echo $'a'"); parsed.source != "echo $'a'" {
		t.Fatalf("source %q", parsed.source)
	}
}

func TestParseShellLineLinksTheSegmentsOfAScope(t *testing.T) {
	// before and after are the neighbours of a segment in its own scope, last
	// the final segment of each scope, so that a rule need not scan the
	// segments in between.
	for line, want := range map[string]struct{ before, after, last []int }{
		"a; (b; c); d": {
			[]int{-1, -1, 1, 0}, []int{3, 2, -1, -1}, []int{3, 2},
		},
		"echo $(x) $(y); z": {
			[]int{-1, -1, -1, 2}, []int{-1, -1, 3, -1}, []int{3, 0, 1},
		},
		"a | b | (c) | d": {
			[]int{-1, 0, -1, 1}, []int{1, 3, -1, -1}, []int{3, 2},
		},
		"cat <<EOF; echo b\n$(x)\nEOF": {
			[]int{-1, 0, -1}, []int{1, -1, -1}, []int{1, 2},
		},
		"": {
			[]int{}, []int{}, []int{-1},
		},
	} {
		parsed := parseShellLine(line)
		if !reflect.DeepEqual(parsed.before, want.before) || !reflect.DeepEqual(parsed.after, want.after) || !reflect.DeepEqual(parsed.last, want.last) {
			t.Errorf("%q: before %v after %v last %v, want %v %v %v", line, parsed.before, parsed.after, parsed.last, want.before, want.after, want.last)
		}
	}
	parsed := parseShellLine("a; (b; c); d")
	if previousInScope(parsed, 3) != 0 || previousInScope(parsed, 0) != -1 || nextInScope(parsed, 1) != 2 || nextInScope(parsed, 2) != -1 {
		t.Fatal("previousInScope and nextInScope read the links")
	}
}

func TestSplitShellEndsACommandAtAPipeOrAmpersandAfterAnEscapedOperator(t *testing.T) {
	// A > or < that the shell reads as an operator takes the | or & right after
	// it along (>|, >&, <&). One that a backslash or a quote makes an ordinary
	// character does not, whatever the character before the | or & is: the
	// | or & is a control operator, and the next command a segment of its own.
	for line, want := range map[string][][]string{
		`echo a >| f`:      {{"echo", "a", ">|", "f"}},
		`echo a>| f`:       {{"echo", "a>|", "f"}},
		`echo a 2>&1 | b`:  {{"echo", "a", "2>&1"}, {"b"}},
		`echo a >&2`:       {{"echo", "a", ">&2"}},
		`echo a <&3 & b`:   {{"echo", "a", "<&3"}, {"b"}},
		`echo a &> f`:      {{"echo", "a", "&>", "f"}},
		`echo \>| b`:       {{"echo", ">"}, {"b"}},
		`echo \>& b`:       {{"echo", ">"}, {"b"}},
		`echo hi \<& b`:    {{"echo", "hi", "<"}, {"b"}},
		`echo hi \<| b`:    {{"echo", "hi", "<"}, {"b"}},
		`echo '>'| b`:      {{"echo", ">"}, {"b"}},
		`echo ">"& b`:      {{"echo", ">"}, {"b"}},
		`echo "a>"| b`:     {{"echo", "a>"}, {"b"}},
		`echo 'a'>| f`:     {{"echo", "a>|", "f"}},
		`echo \\>| f`:      {{"echo", `\>|`, "f"}},
		`echo $(a \>| b)`:  {{"a", ">"}, {"b"}, {"echo", `$(a \>| b)`}},
		`echo \>|b -c 'x'`: {{"echo", ">"}, {"b", "-c", "x"}},
	} {
		if got := segmentWords(line); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
}

func TestSplitShellTakesAnEscapedCharacterOfAHereDocumentDelimiterAsPartOfIt(t *testing.T) {
	// The shell reads \x in a delimiter word as x, so <<E\ F is the delimiter
	// "E F", which is no name: the << is left alone, and the lines after it are
	// commands, as the shell runs the ones after the body.
	for _, line := range []string{
		"cat <<E\\ F\nE F\necho after",
		"cat <<E\\\tF\nE\tF\necho after",
		"cat <<EOF\\\\\nEOF\\\n\necho after",
		"cat <<E\\\\F\nE\\F\necho after",
		"cat <<O\\>\nO>\necho after",
		"cat <<E\\;F\nE;F\necho after",
		"cat <<E\\|F\nE|F\necho after",
		"cat <<E\\&F\nE&F\necho after",
		"cat <<E\\(F\nE(F\necho after",
		"cat <<E\\<F\nE<F\necho after",
		"cat <<-E\\ F\nE F\necho after",
		"cat <<EOF\\",
	} {
		parsed := parseShellLine(line)
		for index, segment := range parsed.segments {
			if len(segment.documents) != 0 {
				t.Errorf("%q: segment %d reads a here-document: %+v", line, index, segment.documents)
			}
		}
		if last := parsed.segments[len(parsed.segments)-1]; !strings.HasPrefix(line, "cat <<EOF\\") || strings.Contains(line, "\n") {
			if last.text != "echo after" {
				t.Errorf("%q: the last command is %q, want the one after the lines", line, last.text)
			}
		}
	}
	// A backslash before a letter only quotes the delimiter, which stays a
	// name; a continuation joins the lines and does not quote it.
	for _, row := range []struct {
		line      string
		delimiter string
		quoted    bool
	}{
		{`<<EOF`, "EOF", false},
		{`<<\EOF`, "EOF", true},
		{`<<E\OF`, "EOF", true},
		{`<<EO\F`, "EOF", true},
		{`<<-\EOF`, "EOF", true},
		{`<<'EO'F`, "EOF", true},
		{`<<E\'OF`, "", false},
		{"<<E\\\nOF", "EOF", false},
		{"<<EOF\\\n", "EOF", false},
		{`<<E\ F`, "", false},
		{`<<EOF\\`, "", false},
		{`<<E\\F`, "", false},
		{`<<O\>`, "", false},
		{`<<E\;F`, "", false},
		{`<<EOF\`, "", false},
	} {
		_, document, ok := readHereDocument(row.line, 0)
		switch {
		case row.delimiter == "" && ok:
			t.Errorf("%q: read the delimiter %q, want the << left alone", row.line, document.delimiter)
		case row.delimiter != "" && (!ok || document.delimiter != row.delimiter || document.quoted != row.quoted):
			t.Errorf("%q: read %+v (ok %v), want the delimiter %q (quoted %v)", row.line, document, ok, row.delimiter, row.quoted)
		}
	}
}

func TestParseShellLineNotesAnUnquotedGlob(t *testing.T) {
	// glob is set by an *, ? or [ that the shell may expand: one outside any
	// quote, escape, comment and here-document body, in a word of a command at
	// any depth.
	for line, want := range map[string]bool{
		"ls":                             false,
		"ls *":                           true,
		"echo a?":                        true,
		"ls [ab]*":                       true,
		"[ -f x ]":                       true,
		"echo a*b":                       true,
		"echo > *.txt":                   true,
		"cat < ?.txt":                    true,
		"echo 'a' *":                     true,
		"echo '*' \"?\" '[x]' \"[y]\"":   false,
		"echo \\* \\? \\[":               false,
		"echo hi # * ? [":                false,
		"echo hi #* ?":                   false,
		"cat <<'EOF'\n* ? [\nEOF":        false,
		"cat <<EOF\n* ? [\nEOF":          false,
		"echo $(ls *)":                   true,
		"echo <(ls *)":                   true,
		"echo \"$(ls *)\"":               true,
		"echo `ls *`":                    true,
		"(ls *)":                         true,
		"cat <<EOF\n$(ls *)\nEOF":        true,
		"cat <<EOF\n`ls ?`\nEOF":         true,
		"cat <<'EOF'\n$(ls *)\nEOF":      false,
		"echo $(echo 'a*')":              false,
		"echo $((1 * 2))":                true,
		"git commit -m 'a?' && git push": false,
		"git commit -m 'a' && git push origin *x": true,
	} {
		if got := parseShellLine(line).glob; got != want {
			t.Errorf("%q: glob %v, want %v", line, got, want)
		}
	}
}

func TestParseShellLineCountsTheBackslashesInSingleQuotes(t *testing.T) {
	// A backslash in a single-quoted string the scan read is an ordinary
	// character and is counted as such. Every other backslash of the source
	// (outside quotes, in double quotes, in a comment, in the body of a
	// here-document) is left out of the count, so that the source holds more.
	for _, row := range []struct {
		line  string
		plain int
	}{
		{"echo hi", 0},
		{`printf '%s\n' x`, 1},
		{`grep 'a\|b\|c' f`, 2},
		{`echo 'a\' 'b\\'`, 3},
		{`echo "a\"b" 'c\d'`, 1},
		{`echo \> 'a\b'`, 1},
		{`echo a\ b`, 0},
		{`echo "a\\b"`, 0},
		{"echo hi # 'a\\b'", 0},
		{"cat <<'EOF'\n'a\\b'\nEOF", 0},
		{"cat <<EOF\n'a\\b'\nEOF", 0},
		{"echo <('a\\b') 'c\\d'", 2},
		{`echo 'a\b`, 0},
	} {
		parsed := parseShellLine(row.line)
		if parsed.plainBackslashes != row.plain {
			t.Errorf("%q: %d backslashes in single quotes, want %d", row.line, parsed.plainBackslashes, row.plain)
		}
		if plain, all := parsed.plainBackslashes, strings.Count(row.line, `\`); plain > all {
			t.Errorf("%q: %d in single quotes of %d", row.line, plain, all)
		}
	}
}
