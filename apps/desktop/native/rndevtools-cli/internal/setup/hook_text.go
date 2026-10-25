package setup

import (
	"regexp"
	"strings"
)

// Match command text as well as parsed words so indirect invocations are
// steered too. textOnly exempts commands that only read or print text.

var (
	simctlPattern = regexp.MustCompile(`(?:^|[\s;&|(])(?:xcrun\s+)?simctl\s+([a-z_]+)`)
	metroPattern  = regexp.MustCompile(`(?:^|[\s;&|(])(?:npx\s+|yarn\s+|pnpm\s+(?:exec\s+)?|bunx?\s+)?(?:expo\s+start|react-native\s+start)\b`)
)

// judgeText applies the text rule to a line: it declines the line when the
// source text of one of its commands names a steered simctl verb or a Metro
// start, unless textOnly excuses the line. Here-document bodies are not read,
// but for the substitutions the shell expands in them: those are commands.
//
// A line the splitter could not read to its end is also matched as written.
// The shell may call it a syntax error, and zsh carries on with the lines
// after one, so what the splitter took for the body of a here-document or for
// a comment can be what runs.
func judgeText(line shellLine) HookDecision {
	if line.partial {
		if decision := textDecision(line.source); decision.Block {
			return decision
		}
	}
	for _, segment := range line.segments {
		// RN Devtools' own CLI may mention Metro or simctl in its arguments (a
		// claim note, a deep link) without running them. Only that command is
		// exempt; substitutions inside it are segments of their own.
		if segment.program() == "rndevtools" {
			continue
		}
		if decision := textDecision(segment.text); decision.Block {
			if textOnly(line) {
				return HookDecision{}
			}
			return decision
		}
	}
	return HookDecision{}
}

// textDecision is the text rule for the source text of one command.
func textDecision(text string) HookDecision {
	for _, match := range simctlPattern.FindAllStringSubmatch(text, -1) {
		if replacement, steered := steeredVerbs[match[1]]; steered {
			return simctlDecision(match[1], replacement)
		}
	}
	if metroPattern.MatchString(text) {
		return metroDecision()
	}
	return HookDecision{}
}

// MARK: - The excuse

var (
	// textPrograms only read and print text; none of them runs a program from
	// its arguments, with the exceptions textProgram checks (printf -v, test
	// -v, rg --pre, sort --compress-program, and the files sort, uniq, and
	// --output write).
	textPrograms = names("echo", "printf", "cat", "grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "sort",
		"uniq", "cut", "tr", "nl", "jq", "ls", "pwd", "cd", "mkdir", "touch", "test", "[", "true", "false", "sleep",
		"date", "basename", "dirname", "realpath", "which", "type")
	// textLaunchers only run their operand, so a line may look through them.
	// sudo and env stop being that with a shell (sudo -s, -i) or a command
	// string (env -S).
	textLaunchers = names("nice", "nohup", "time", "timeout", "gtimeout", "sudo", "env")
	// gitTextCommands and ghTextCommands are the subcommands a line may use
	// and still count as text: git and gh read and write repository data, and
	// git runs hook files, so they count only when nothing on the line writes
	// a file (see textOnly) and only with the options of gitOptions and
	// ghOptions.
	gitTextCommands = names("add", "commit", "log", "show", "diff", "status", "tag", "stash", "push", "fetch",
		"branch", "checkout", "switch", "restore", "rm", "mv", "grep", "blame", "describe", "rev-parse", "ls-files")
	ghTextCommands = names("pr", "issue", "release", "api", "repo", "label", "search")
)

// textOnly reports whether the line looks as if it can only read and print
// text, so that a steered command named in its text (a commit message, a grep
// pattern, a PR body) is taken for text, and the text rule's match is excused.
//
// It is a heuristic for the lines agents normally write. The splitter is not
// a shell, and the excuse does not rely on the two reading a line alike. It
// takes all of these; a line that fails one of them keeps the text rule's
// verdict, and only these conditions turn the excuse off:
//
//   - The line holds none of the constructs where a splitter and a shell are
//     most likely to part. In the line as written, here-document bodies and
//     comments included: no backslash (an escape, a line continuation) but
//     for those inside single quotes on a command line, where a backslash is
//     an ordinary character ('%s\n', 'a\|b'); one in a here-document body or
//     a comment is not exempt, between single quotes or not; no $ and no
//     backtick (an expansion, a substitution, an ANSI-C quote like $'a\'b');
//     and no "((" (arithmetic, where a << is a shift and not a
//     here-document). In its commands' words: no unquoted brace expansion,
//     and no unquoted *, ? or [ (a glob can turn a file made on the line into
//     an option; the test program [ is not excused either). And the splitter
//     read all of it: the scan ended outside any quote, substitution and (
//     group, and no <( ) body was too deep to split.
//   - Every command is one of textPrograms, a git or gh command of the lists,
//     or RN Devtools' own CLI, seen through the launchers that only run their
//     operand (nice, nohup, time, timeout, sudo, env). None sets a variable:
//     no NAME=value prefix, and no printf -v.
//   - The options of git, gh, rg and sort are ones the excuse can name (see
//     optionPolicy), in every word of the command, redirections included,
//     and after a -- as well, which an option that takes a value can swallow.
//   - git and gh are not on a line that writes a file, because git runs the
//     hook files of a repository.
//
// It fails on anything else: every shell, eval, source, exec, trap, xargs,
// find, sed, awk, an interpreter, tmux, a command named by a path (but for
// RN Devtools' own), and a command assembled by an expansion.
//
// Meeting the conditions is not a proof that nothing else runs. There is no
// data-flow analysis: the excuse does not know what the user's own git
// configuration, aliases, hooks or environment run, nor every option of every
// version of the programs it lists. Evading it on purpose is out of scope, as
// is a command assembled at run time, which the text rule never saw either.
func textOnly(line shellLine) bool {
	if line.partial || line.glob || strings.ContainsAny(line.source, "$`") || strings.Contains(line.source, "((") ||
		strings.Count(line.source, "\\") > line.plainBackslashes {
		return false
	}
	var hooks, writes bool
	for _, segment := range line.segments {
		use, ok := textUseOf(segment)
		if !ok {
			return false
		}
		hooks, writes = hooks || use.hooks, writes || use.writes
	}
	return !hooks || !writes
}

// textUse is what a text-only command does besides print: hooks is git or
// gh, which run the hook files of a repository, and writes is a command that
// writes a file.
type textUse struct {
	hooks, writes bool
}

// textUseOf reports whether the command of one segment is text only, and
// what it does.
func textUseOf(segment shellSegment) (use textUse, ok bool) {
	use.writes = redirectsToFile(segment.text)
	expands, groupWords := braceWords(segment.text)
	if expands {
		return use, false
	}
	// The words are the segment's own, redirections included: segment.io()
	// reads a quoted > or < as a redirection and drops the word after it,
	// and that could be an option the rules have to see. Only the keywords
	// and redirections before the command are set aside.
	words := segment.words
	opened := 0
	for len(words) > 0 {
		if shellKeywords[words[0]] {
			if words[0] == "{" || words[0] == "}" {
				opened++
			}
			words = words[1:]
		} else if skipped := leadingRedirection(words); skipped > 0 {
			words = words[skipped:]
		} else {
			break
		}
	}
	if groupWords > opened {
		// A { or } after the command: zsh's short forms, if true { cmd }, run
		// a command that no word before it names.
		return use, false
	}
	if len(words) == 0 {
		return use, true
	}
	for textLaunchers[words[0]] {
		skipped := launchers[words[0]].skip(words, 1)
		if !skipped.runs || skipped.shell || skipped.assigned {
			return use, false
		}
		if words = words[skipped.next:]; len(words) == 0 {
			return use, true
		}
	}
	name, arguments := words[0], words[1:]
	use.writes = use.writes || hasOutputOption(arguments)
	switch {
	case isShellAssignment(name):
		// FOO=1 git log: GIT_PAGER and the like run what the value says; and
		// X=/rndevtools would pass for RN Devtools' own CLI below.
		return use, false
	case name == "git":
		use.hooks = true
		return use, gitReadsText(arguments)
	case name == "gh":
		use.hooks = true
		return use, ghReadsText(arguments)
	case name == "command":
		// command -v bash only looks a name up.
		return use, len(arguments) > 0 && (arguments[0] == "-v" || arguments[0] == "-V")
	case textPrograms[name]:
		return textProgram(use, name, arguments)
	}
	// RN Devtools' own CLI, which the text rule never reads either.
	return use, baseName(name) == "rndevtools"
}

// leadingRedirection is how many words a redirection at the start of words
// takes up (2>&1, > file), 0 when it does not start with one.
func leadingRedirection(words []string) int {
	_, _, target, ok := splitRedirection(words[0])
	switch {
	case !ok:
		return 0
	case target == "" && len(words) > 1:
		return 2
	}
	return 1
}

// textProgram checks the arguments of a program of textPrograms: the options
// with which it runs a program or sets a variable, and the files it writes.
func textProgram(use textUse, name string, arguments []string) (textUse, bool) {
	switch name {
	case "printf":
		// printf -v NAME assigns a variable (PATH, IFS), and zsh evaluates a
		// subscript in NAME.
		if len(arguments) > 0 && strings.HasPrefix(arguments[0], "-v") {
			return use, false
		}
	case "test", "[":
		// test -v NAME looks a variable up, evaluating a subscript in NAME.
		for _, argument := range arguments {
			if argument == "-v" {
				return use, false
			}
		}
	case "rg":
		return use, rgOptions.allowsAll(arguments, false)
	case "sort":
		use.writes = use.writes || sortWrites(arguments)
		return use, sortOptions.allowsAll(arguments, false)
	case "uniq":
		use.writes = use.writes || uniqWrites(arguments)
	}
	return use, true
}

// braceWords reads the unquoted braces of a command's text. expands says
// that a word has one besides being the keyword { or } alone: the shell
// expands such a word ({-c,x} is two words), which would hide an option from
// the rules that read the words. groupWords counts the words that are
// exactly { or }.
func braceWords(text string) (expands bool, groupWords int) {
	start, inWord, braced := 0, false, false
	endWord := func(index int) {
		if inWord && braced {
			if word := text[start:index]; word == "{" || word == "}" {
				groupWords++
			} else {
				expands = true
			}
		}
		inWord, braced = false, false
	}
	for index := 0; index < len(text); index++ {
		character := text[index]
		if character == ' ' || character == '\t' || character == '\n' {
			endWord(index)
			continue
		}
		if !inWord {
			start, inWord = index, true
		}
		switch character {
		case '\\':
			index++
		case '\'':
			if end := strings.IndexByte(text[index+1:], '\''); end >= 0 {
				index += end + 1
			} else {
				index = len(text)
			}
		case '"':
			for index++; index < len(text) && text[index] != '"'; index++ {
				if text[index] == '\\' {
					index++
				}
			}
		case '{', '}':
			braced = true
		}
	}
	endWord(len(text))
	return expands, groupWords
}

// redirectsToFile reports a command text that redirects output into a file
// (> f, >> f, 2> f, &> f, >| f): an unquoted `>` other than the copy of a
// descriptor (2>&1, >&-) or a redirection to /dev/null. A file written by a
// redirection is what git could run as a hook.
func redirectsToFile(text string) bool {
	for index := 0; index < len(text); index++ {
		switch text[index] {
		case '\\':
			index++
		case '\'':
			end := strings.IndexByte(text[index+1:], '\'')
			if end < 0 {
				return false
			}
			index += end + 1
		case '"':
			for index++; index < len(text) && text[index] != '"'; index++ {
				if text[index] == '\\' {
					index++
				}
			}
		case '>':
			if !harmlessRedirection(text[index+1:]) {
				return true
			}
		}
	}
	return false
}

// harmlessRedirection reports what follows a `>` as the copy of a descriptor
// (>&2, >&-) or a redirection to /dev/null.
func harmlessRedirection(rest string) bool {
	rest = strings.TrimPrefix(strings.TrimPrefix(rest, ">"), "|")
	if strings.HasPrefix(rest, "&") {
		digits := 1
		for digits < len(rest) && (rest[digits] == '-' || (rest[digits] >= '0' && rest[digits] <= '9')) {
			digits++
		}
		return digits > 1 && (digits == len(rest) || strings.IndexByte(" \t;&|()<>", rest[digits]) >= 0)
	}
	rest = strings.TrimLeft(rest, " \t")
	if end := strings.IndexAny(rest, " \t;&|()<>"); end >= 0 {
		rest = rest[:end]
	}
	return strings.Trim(rest, `'"`) == "/dev/null"
}
