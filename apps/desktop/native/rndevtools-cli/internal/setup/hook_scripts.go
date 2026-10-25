package setup

import (
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Scripts a command hands on. A script is one quoted word of a line, so the
// word rules would take the string of `bash -c '…'` for one word of text.
// handedScripts finds the scripts a command passes to something that runs
// them, and the simctl, Metro, and Supabase rules judge each one as a line of
// its own (the Simulator rules with the text rule too), up to maxNestedScripts
// deep and maxFollowedScriptBytes in all. Everything else quoted stays text
// to the word rules: a grep pattern, a commit message, a file written with
// cat <<'EOF'.

// maxNestedScripts bounds how deep handed-on scripts are followed.
const maxNestedScripts = 4

// maxFollowedScriptBytes bounds the scripts one rule follows in one hook
// call, in total. Past it the rule stops following scripts, and only the
// text and the words of the line itself are judged: a hook that is slow
// would stall the agent until its timeout lets the command through.
const maxFollowedScriptBytes = 256 << 10

// shellPrograms are the shells whose scripts the rules follow.
var shellPrograms = names("bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh")

// stringRunners run each of their own string arguments as a shell command
// (concurrently 'npx expo start', watch '…', su me -c '…'), so every
// argument they get is judged as a script. tmux is not one: only some of its
// commands carry a shell command (see tmuxScripts).
var stringRunners = names("concurrently", "watch", "nodemon", "watchexec", "entr", "parallel", "su")

// handedScript is a script a command hands on to be run.
type handedScript struct {
	text string
	// file identifies the version of a file the line wrote that text was
	// read from, so that the text is judged once however often the line runs
	// the file; it is the zero value for any other script. printed marks what
	// a lone $(echo …) in that file prints, which is a script of its own.
	file    fileVersion
	printed bool
}

// scriptLedger meters the scripts one rule follows in one hook call: it
// stops at maxFollowedScriptBytes, and it judges the text of a written file
// once from each directory, however many commands run the file.
type scriptLedger struct {
	followed int
	full     bool
	// files holds, for each version of a written file followed from a
	// directory, the shallowest nesting it was followed at.
	files map[fileFollow]int
}

type fileFollow struct {
	file      fileVersion
	printed   bool
	directory string
}

// exhausted reports that the rule has stopped following scripts, so that it
// need not build them.
func (ledger *scriptLedger) exhausted() bool {
	return ledger.full
}

// follow reports whether the rule is to judge script, reached at nesting
// and run from directory ("" when the rule does not care). It is not when
// the same version of a written file was already judged from there at
// least as deep, or when the scripts followed so far have reached the cap.
func (ledger *scriptLedger) follow(script handedScript, directory string, nesting int) bool {
	if ledger.full || script.text == "" {
		return false
	}
	key := fileFollow{file: script.file, printed: script.printed, directory: directory}
	if script.file != (fileVersion{}) {
		if depth, followed := ledger.files[key]; followed && depth <= nesting {
			return false
		}
	}
	if ledger.followed+len(script.text) > maxFollowedScriptBytes {
		ledger.full = true
		return false
	}
	ledger.followed += len(script.text)
	if script.file != (fileVersion{}) {
		if ledger.files == nil {
			ledger.files = map[fileFollow]int{}
		}
		ledger.files[key] = nesting
	}
	return true
}

// handedScripts are the scripts the segment at index hands on to be run:
//
//   - eval's arguments, and a shell's -c string (bash -c, fish --command),
//     also when another command runs the shell (timeout 60 sh -c, xargs -I{}
//     sh -c, find . -exec sh -c, sudo -u me bash -c); a shell given -n only
//     parses its script, and runs none;
//   - what a shell reads on standard input when it is the command, run
//     directly or through the launchers below (sudo -u me, env -u NAME,
//     timeout 60, nice -n 10, …): a here-string, a here-document, or what
//     echo or printf pipes into it, also through cat, tee, or a ( … ) or
//     { …; } group;
//   - a script file the line itself wrote before running it (echo 'cmd' >
//     run.sh && sh run.sh, also source, . and ./run.sh);
//   - what xargs builds a shell's -c string from (xargs -I{} sh -c '{}'),
//     where an input line that fills in part of the string is one quoted
//     word of it;
//   - the command strings of tools that run them: env -S, script -c, the
//     shell modes of npx -c, npm exec --call, pnpm exec -c, yarn exec, and
//     bun exec, every argument of the stringRunners, the shell command and
//     keys of the tmux commands that take them, and the do shell script
//     strings of osascript;
//   - and what a lone $(echo …) prints in the place of any of these, or of
//     the command itself.
//
// A word that only names a shell gets nothing on standard input: in
// grep sh <<< 'text' the here-string is grep's.
func handedScripts(line shellLine, index int) []handedScript {
	io := line.segments[index].io()
	words := skipPrefixWords(io.words)
	var scripts []handedScript
	add := func(script string) {
		scripts = append(scripts, handedScript{text: script})
		if printed, ok := printedBy(line, strings.TrimSpace(script)); ok {
			scripts = append(scripts, handedScript{text: printed})
		}
	}
	// addFile hands on the text of a file the line wrote, and what a lone
	// $(echo …) in it prints, which the line works out once per version.
	addFile := func(text string, file fileVersion) {
		scripts = append(scripts, handedScript{text: text, file: file})
		if printed, ok := line.files.printed(file); ok {
			scripts = append(scripts, handedScript{text: printed, file: file, printed: true})
		}
	}
	run := launchOf(words)
	for _, script := range run.scripts {
		add(script)
	}
	if run.program >= 0 {
		program, arguments := words[run.program], words[run.program+1:]
		switch name := commandName(program); {
		case name == "eval":
			add(strings.Join(arguments, " "))
		case shellPrograms[name]:
			switch script, from := shellScript(arguments); from {
			case shellInline:
				add(script)
			case shellStdin:
				if text, ok := stdinText(line, index, io, 0); ok {
					add(text)
				}
			case shellFile:
				if text, file, ok := writtenScript(line, index, script); ok {
					addFile(text, file)
				}
			}
		case name == "source" || name == ".":
			if len(arguments) > 0 {
				if text, file, ok := writtenScript(line, index, arguments[0]); ok {
					addFile(text, file)
				}
			}
		case name == "xargs":
			if text, ok := stdinText(line, index, io, 0); ok {
				for _, script := range xargsScripts(arguments, text) {
					add(script)
				}
			}
		case name == "tmux":
			for _, script := range tmuxScripts(arguments) {
				add(script)
			}
		case name == "osascript":
			// Its AppleScript is in -e arguments, or on standard input.
			sources := append([]string{}, arguments...)
			if text, ok := stdinText(line, index, io, 0); ok {
				sources = append(sources, text)
			}
			for _, script := range appleScriptCommands(sources) {
				add(script)
			}
		case stringRunners[name]:
			for _, argument := range arguments {
				add(argument)
			}
		default:
			if printed, ok := printedBy(line, program); ok {
				// $(echo 'cmd') in the command's place runs what it prints.
				add(strings.Join(append([]string{printed}, arguments...), " "))
			} else if strings.Contains(program, "/") {
				// ./run.sh, a script the line may have just written.
				if text, file, ok := writtenScript(line, index, program); ok {
					addFile(text, file)
				}
			}
		}
	}
	for at, word := range words {
		if at == run.program || !shellPrograms[commandName(word)] {
			continue
		}
		// Another word naming a shell may be one the command runs (find
		// -exec sh -c, docker exec box sh -c), so its -c string is followed.
		if script, from := shellScript(words[at+1:]); from == shellInline {
			add(script)
		}
	}
	return scripts
}

// skipPrefixWords drops the assignments and the grouping words and keywords
// ({, !, then, do) before a command.
func skipPrefixWords(words []string) []string {
	for len(words) > 0 && (isShellAssignment(words[0]) || shellKeywords[words[0]]) {
		words = words[1:]
	}
	return words
}

// MARK: - What a command runs

// launch is what a command runs once the commands that only start another
// one (sudo, timeout 60, npx) are set aside.
type launch struct {
	// program is the index of the program among the words, -1 when no
	// program is left.
	program int
	// scripts are the command strings a launcher runs itself: env -S,
	// script -c, and a package runner's shell mode (npx -c, pnpm exec -c).
	scripts []string
}

// launcherOptions is how a command that runs another reads its own words
// before the program.
type launcherOptions struct {
	// values take the next word, or the rest of a cluster of single-letter
	// options, as their value (-u me, -ume, --user=me).
	values map[string]bool
	// scripts take a command line as their value (env -S, script -c).
	scripts map[string]bool
	// queries mean the launcher runs nothing (command -v bash, sudo -l).
	queries map[string]bool
	// shells make it start a shell, which reads what follows as its commands
	// (sudo -s, sudo -i).
	shells map[string]bool
	// operands is how many words follow the options before the program:
	// timeout's duration, script's log file.
	operands int
	// assignments are the NAME=value words it sets before the program.
	assignments bool
	// wholeWords means each single-dash option is a whole word (arch -arm64,
	// arch -arch arm64), not a cluster of letters.
	wholeWords bool
}

var (
	timeoutOptions = launcherOptions{values: names("-s", "-k", "--signal", "--kill-after"), operands: 1}
	stdbufOptions  = launcherOptions{values: names("-i", "-o", "-e", "--input", "--output", "--error")}
	// launchers are the commands that run the program named after their own
	// words, passing it their standard input.
	launchers = map[string]launcherOptions{
		"sudo": {
			values: names("-u", "-g", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "-R", "--user", "--group", "--prompt",
				"--close-from", "--chdir", "--role", "--type", "--command-timeout", "--other-user", "--host", "--chroot"),
			queries:     names("-l", "-v", "-V", "-K", "-e", "--list", "--validate", "--version", "--remove-timestamp", "--edit"),
			shells:      names("-s", "-i", "--shell", "--login"),
			assignments: true,
		},
		"doas":         {values: names("-u", "-C")},
		"env":          {values: names("-u", "-C", "-P", "-L", "--unset", "--chdir"), scripts: names("-S", "--split-string"), assignments: true},
		"command":      {queries: names("-v", "-V")},
		"exec":         {values: names("-a")},
		"builtin":      {},
		"time":         {values: names("-f", "-o", "--format", "--output")},
		"nohup":        {},
		"timeout":      timeoutOptions,
		"gtimeout":     timeoutOptions,
		"nice":         {values: names("-n", "--adjustment")},
		"caffeinate":   {values: names("-t", "-w")},
		"stdbuf":       stdbufOptions,
		"gstdbuf":      stdbufOptions,
		"arch":         {values: names("-arch", "-d", "-e"), wholeWords: true},
		"script":       {values: names("-t", "-T", "-o", "-I", "-O", "-B", "--log-in", "--log-out", "--log-io", "--log-timing", "--output-limit"), scripts: names("-c", "--command"), operands: 1},
		"sandbox-exec": {values: names("-f", "-n", "-p", "-D")},
		"taskpolicy":   {values: names("-c", "-d", "-g", "-t", "-l", "-p")},
		"setsid":       {},
		"unbuffer":     {},
		"chronic":      {},
		"ionice":       {values: names("-c", "-n", "-p", "--class", "--classdata", "--pid")},
		"noglob":       {},
		"nocorrect":    {},
	}
)

// launchOf follows words through launchers and package runners to the
// program they run.
func launchOf(words []string) launch {
	var scripts []string
	at := 0
	for at < len(words) {
		if options, isLauncher := launchers[commandName(words[at])]; isLauncher {
			skipped := options.skip(words, at+1)
			if !skipped.runs {
				return launch{program: -1, scripts: append(scripts, skipped.scripts...)}
			}
			at = skipped.next
			continue
		}
		if next, own, isRunner := skipRunner(words, at); isRunner {
			if next < 0 {
				return launch{program: -1, scripts: append(scripts, own...)}
			}
			at = next
			continue
		}
		return launch{program: at, scripts: scripts}
	}
	return launch{program: -1, scripts: scripts}
}

// launchSkip is what a launcher's own words say.
type launchSkip struct {
	// next is the index of the word after them: the program it runs, when
	// runs.
	next int
	// scripts are a command string of its own (env -S 'cmd', script -c
	// 'cmd').
	scripts []string
	// runs is false when no program follows them: a query (command -v), or a
	// command string of its own.
	runs bool
	// shell reports a shell option (sudo -s, -i), and assigned a NAME=value
	// word set before the program (env FOO=1 git).
	shell, assigned bool
}

// skip reads a launcher's own words from words[at:].
func (options launcherOptions) skip(words []string, at int) launchSkip {
	skipped := launchSkip{}
	takeValue := func(option string, value string, hasValue bool) ([]string, bool) {
		if options.scripts[option] {
			if hasValue {
				return []string{value}, true
			}
			return nil, true
		}
		return nil, false
	}
	for at < len(words) {
		word := words[at]
		if word == "--" {
			at++
			break
		}
		if word != "-" && (len(word) < 2 || word[0] != '-') {
			break
		}
		at++
		name, value, inline := strings.Cut(word, "=")
		if options.queries[name] {
			return launchSkip{next: at}
		}
		if strings.HasPrefix(word, "--") || options.wholeWords || word == "-" {
			// --name, --name=value, or a whole-word option such as -arch.
			skipped.shell = skipped.shell || options.shells[name]
			if !inline && (options.values[name] || options.scripts[name]) && at < len(words) {
				value, inline = words[at], true
				at++
			}
			if own, isScript := takeValue(name, value, inline); isScript {
				return launchSkip{next: at, scripts: own}
			}
			continue
		}
		// A cluster of single-letter options: -E, -nu me, -ume.
		for position := 1; position < len(word); position++ {
			option := "-" + word[position:position+1]
			if options.queries[option] {
				return launchSkip{next: at}
			}
			skipped.shell = skipped.shell || options.shells[option]
			if !options.values[option] && !options.scripts[option] {
				continue
			}
			value, hasValue := word[position+1:], position+1 < len(word)
			if !hasValue && at < len(words) {
				value, hasValue = words[at], true
				at++
			}
			if own, isScript := takeValue(option, value, hasValue); isScript {
				return launchSkip{next: at, scripts: own}
			}
			break
		}
	}
	for options.assignments && at < len(words) && isShellAssignment(words[at]) {
		skipped.assigned = true
		at++
	}
	skipped.next, skipped.runs = min(at+options.operands, len(words)), true
	return skipped
}

// skipRunner reads a package runner at words[at] (npx, pnpm exec, yarn,
// bunx, bun x, npm exec, …) with its options, and returns the index of the
// program it runs: -1 when it runs a package script or a shell string
// instead, whose strings it returns. isRunner is false for anything else.
func skipRunner(words []string, at int) (next int, scripts []string, isRunner bool) {
	rest := at + 1
	// options skips a runner's options from words[rest:]. A shell-mode option
	// (npx -c, pnpm exec --shell-mode) makes the strings after it, and its
	// own value, the scripts.
	options := func(set runnerOptions) bool {
		for rest < len(words) {
			word := words[rest]
			if word == "--" {
				rest++
				return false
			}
			if !strings.HasPrefix(word, "-") || word == "-" {
				return false
			}
			rest++
			name, value, inline := strings.Cut(word, "=")
			if set.shell[name] {
				if inline {
					scripts = append(scripts, value)
				}
				scripts = append(scripts, words[rest:]...)
				return true
			}
			if !inline && set.values[name] && rest < len(words) {
				rest++
			}
		}
		return false
	}
	shellString := func() (int, []string, bool) { return -1, scripts, true }
	program := func() (int, []string, bool) { return rest, nil, true }
	switch commandName(words[at]) {
	case "npx":
		if options(npxOptions) {
			return shellString()
		}
		return program()
	case "pnpx":
		if options(pnpmRunOptions) {
			return shellString()
		}
		return program()
	case "bunx":
		if options(bunxOptions) {
			return shellString()
		}
		return program()
	case "pnpm":
		options(pnpmOptions)
		if rest < len(words) && (words[rest] == "exec" || words[rest] == "dlx" || words[rest] == "run") {
			rest++
			if options(pnpmRunOptions) {
				return shellString()
			}
		}
		return program()
	case "yarn":
		options(yarnOptions)
		if rest < len(words) {
			switch words[rest] {
			case "exec":
				// Yarn runs exec's arguments as a script in its own shell.
				return -1, words[rest+1:], true
			case "dlx":
				rest++
				options(yarnDlxOptions)
			case "run":
				rest++
			}
		}
		return program()
	case "bun":
		options(bunOptions)
		if rest < len(words) {
			switch words[rest] {
			case "exec":
				// bun exec runs its argument as a Bun Shell script.
				return -1, words[rest+1:], true
			case "x", "run":
				rest++
				options(bunxOptions)
			}
		}
		return program()
	case "npm":
		options(npmOptions)
		if rest >= len(words) || (words[rest] != "exec" && words[rest] != "x") {
			// npm start, npm run: a package script, not a program.
			return -1, nil, true
		}
		rest++
		if options(npmExecOptions) {
			return shellString()
		}
		return program()
	}
	return 0, nil, false
}

// MARK: - Where a shell's script comes from

// shellInput is where a shell reads the script it runs.
type shellInput int

const (
	// shellFile is a script file, whose path shellScript returns.
	shellFile shellInput = iota
	// shellInline is -c's command string, in the arguments.
	shellInline
	// shellStdin is standard input.
	shellStdin
	// shellAwaiting is -c without its command string, which xargs may
	// append (xargs -0 sh -c).
	shellAwaiting
	// shellParses is a shell told only to parse its script (-n, -o noexec),
	// which runs none of it.
	shellParses
)

// shellScript reads a shell's arguments, its redirections removed, for
// where the script it runs comes from: -c's command string (also in
// clusters such as -lc or -ec, and fish's --command), standard input (no
// operands, or -s), or a script file, whose path it returns.
func shellScript(arguments []string) (string, shellInput) {
	command, fromStdin, endOfOptions, parses := false, false, false, false
	// from reports where the script comes from, unless the shell only parses
	// it.
	from := func(script string, input shellInput) (string, shellInput) {
		if parses {
			return "", shellParses
		}
		return script, input
	}
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch {
		case !endOfOptions && (argument == "-o" || argument == "+o" || argument == "-O" || argument == "+O" ||
			argument == "--rcfile" || argument == "--init-file"):
			// An option with a value, such as -o pipefail or -O extglob.
			if argument == "-o" && index+1 < len(arguments) && arguments[index+1] == "noexec" {
				parses = true
			}
			index++
		case !endOfOptions && argument == "--command":
			if index+1 < len(arguments) {
				return from(arguments[index+1], shellInline)
			}
			return from("", shellAwaiting)
		case !endOfOptions && strings.HasPrefix(argument, "--command="):
			return from(strings.TrimPrefix(argument, "--command="), shellInline)
		case !endOfOptions && (argument == "--" || argument == "-"):
			endOfOptions = true
		case !endOfOptions && strings.HasPrefix(argument, "--"):
			// A long option such as --norc or --login.
			parses = parses || argument == "--no-execute"
		case !endOfOptions && (strings.HasPrefix(argument, "-") || strings.HasPrefix(argument, "+")):
			command = command || strings.ContainsRune(argument[1:], 'c')
			fromStdin = fromStdin || strings.ContainsRune(argument[1:], 's')
			parses = parses || (argument[0] == '-' && strings.ContainsRune(argument[1:], 'n'))
		case command:
			// The first operand is -c's command string.
			return from(argument, shellInline)
		case !fromStdin:
			return from(argument, shellFile)
		}
		// With -s, operands are the script's positional parameters.
	}
	if command {
		return from("", shellAwaiting)
	}
	return from("", shellStdin)
}

// segmentIO is a segment's words without its redirections, and what those
// redirections say about its standard input and output.
type segmentIO struct {
	words []string
	// inputRedirected is any redirection of standard input; input is its
	// text when the hook can know it (inputKnown): a here-string or a
	// here-document, not a file.
	inputRedirected bool
	inputKnown      bool
	input           string
	// outputRedirected is standard output sent elsewhere (> file, >&2), so
	// a pipe after the segment gets none of it; outputs are the files it
	// goes to.
	outputRedirected bool
	outputs          []outputFile
}

// outputFile is a file a command's standard output is written to.
type outputFile struct {
	path    string
	appends bool
}

func (segment shellSegment) io() segmentIO {
	var io segmentIO
	for index := 0; index < len(segment.words); index++ {
		word := segment.words[index]
		descriptor, operator, target, ok := splitRedirection(word)
		if !ok {
			io.words = append(io.words, word)
			continue
		}
		body, isDocument := segment.document(index)
		if !isDocument && target == "" && index+1 < len(segment.words) {
			index++
			target = segment.words[index]
		}
		switch {
		case strings.HasPrefix(operator, "<") && (descriptor == "" || descriptor == "0"):
			io.inputRedirected, io.inputKnown, io.input = true, false, ""
			switch {
			case operator == "<<<":
				io.inputKnown, io.input = true, target
			case isDocument:
				io.inputKnown, io.input = true, body
			}
		case strings.HasPrefix(operator, ">") && (descriptor == "" || descriptor == "1" || descriptor == "&"):
			io.outputRedirected = true
			if target != "" && !strings.HasPrefix(target, "&") {
				io.outputs = append(io.outputs, outputFile{path: target, appends: operator == ">>"})
			}
		}
	}
	return io
}

// maxPipeDepth bounds how far back a pipeline is followed for its text.
const maxPipeDepth = 8

// stdinText is the text the segment at index reads on standard input, when
// the hook can know it: its own here-string or here-document, else what the
// command before it in its pipeline prints.
func stdinText(line shellLine, index int, io segmentIO, depth int) (string, bool) {
	if io.inputRedirected {
		return io.input, io.inputKnown
	}
	if group := line.segments[index].pipedGroup; group > 0 {
		return scopeText(line, group, depth+1)
	}
	previous := previousInScope(line, index)
	if previous < 0 || !isPipe(line.segments[previous].terminator) {
		return "", false
	}
	return printedText(line, previous, depth+1)
}

// maxGroupReads bounds the reading of groups for their text in one hook call,
// in all, counted in words (and one for each command): the line and the
// scripts it hands on share it. A line of 1 MiB can hold a hundred thousand
// groups nested in each other, each of which would read the commands of the
// ones inside it, and a command of a hundred thousand words that each of them
// reads again; past the bound a group reads as unknown.
const maxGroupReads = 1 << 18

// spendGroupRead counts the reading of a command of the given number of words
// for the text of a group, and reports false once the line has used up
// maxGroupReads.
func (line shellLine) spendGroupRead(words int) bool {
	if *line.groupReads >= maxGroupReads {
		return false
	}
	*line.groupReads += 1 + words
	return true
}

// inOrder joins texts, which were collected last to first, with newlines.
func inOrder(texts []string) string {
	slices.Reverse(texts)
	return strings.Join(texts, "\n")
}

// scopeText is what the commands of the ( … ) group at scope, which has
// closed, print to its output, as far as the hook can know it. It reads the
// group's own commands, last to first.
func scopeText(line shellLine, scope int, depth int) (string, bool) {
	var texts []string
	for member := line.last[scope]; member >= 0 && line.spendGroupRead(len(line.segments[member].words)); member = line.before[member] {
		if isPipe(line.segments[member].terminator) {
			continue
		}
		if text, ok := printedText(line, member, depth); ok {
			texts = append(texts, text)
		}
	}
	return inOrder(texts), len(texts) > 0
}

var (
	// echoOptions are the option words echo takes before its text.
	echoOptions = regexp.MustCompile(`^-[neE]+$`)
	// textEscapes are the escapes echo -e and printf expand that matter to a
	// script: they split it into its commands.
	textEscapes = strings.NewReplacer(`\n`, "\n", `\t`, "\t")
)

// printedText is what the segment at index writes to the pipe after it, when
// the hook can know it: what echo or printf prints, what cat (reading no
// file) or tee passes on from its own input, and what a { …; } group of
// those prints.
func printedText(line shellLine, index int, depth int) (string, bool) {
	io := line.segments[index].io()
	if io.outputRedirected {
		return "", false
	}
	return commandText(line, index, io, depth)
}

// commandText is what the command of the segment at index prints, wherever
// its output goes (see printedText).
func commandText(line shellLine, index int, io segmentIO, depth int) (string, bool) {
	if depth > maxPipeDepth {
		return "", false
	}
	if closesGroup(io) {
		return groupText(line, index, depth)
	}
	words := skipPrefixWords(io.words)
	run := launchOf(words)
	if run.program < 0 {
		return "", false
	}
	arguments := words[run.program+1:]
	switch commandName(words[run.program]) {
	case "echo":
		for len(arguments) > 0 && echoOptions.MatchString(arguments[0]) {
			arguments = arguments[1:]
		}
		return textEscapes.Replace(strings.Join(arguments, " ")), true
	case "printf":
		return textEscapes.Replace(strings.Join(arguments, " ")), true
	case "cat":
		for _, argument := range arguments {
			if !strings.HasPrefix(argument, "-") {
				// It prints a file the hook does not read.
				return "", false
			}
		}
		return stdinText(line, index, io, depth)
	case "tee":
		return stdinText(line, index, io, depth)
	}
	return "", false
}

// groupText is what the { …; } group that the segment at index closes
// prints: the known text of each of its commands that prints to the group's
// output. It reads back to the { that matches, through the groups inside it:
// their commands print to this group's output too, unless the output of the
// inner group goes elsewhere (} > file, } | cat). A { is a word, so one
// segment can open several groups ({ { echo a), and a command inside an inner
// group is read once, not again for each } it is inside of.
func groupText(line shellLine, index int, depth int) (string, bool) {
	var texts []string
	// closed is, for each group closed since the walk back began and not
	// opened yet, whether its output goes elsewhere; away counts those.
	var closed []bool
	away := 0
	for member := previousInScope(line, index); member >= 0 && line.spendGroupRead(len(line.segments[member].words)); member = previousInScope(line, member) {
		segment := line.segments[member]
		io := segment.io()
		if closesGroup(io) {
			elsewhere := io.outputRedirected || isPipe(segment.terminator)
			closed = append(closed, elsewhere)
			if elsewhere {
				away++
			}
			continue
		}
		if away == 0 && !io.outputRedirected && !isPipe(segment.terminator) {
			if text, ok := commandText(line, member, io, depth+1); ok {
				texts = append(texts, text)
			}
		}
		for opened := opensGroups(segment.words); opened > 0; opened-- {
			if len(closed) == 0 {
				return inOrder(texts), len(texts) > 0
			}
			if closed[len(closed)-1] {
				away--
			}
			closed = closed[:len(closed)-1]
		}
	}
	return "", false
}

// closesGroup reports a segment that is just the } that closes a { group
// (with the redirections that apply to the group).
func closesGroup(io segmentIO) bool {
	return len(io.words) == 1 && io.words[0] == "}"
}

// opensGroups is how many { groups a segment opens: the { words before its
// command, and before it only keywords and assignments.
func opensGroups(words []string) int {
	opened := 0
	for _, word := range words {
		switch {
		case word == "{":
			opened++
		case !shellKeywords[word] && !isShellAssignment(word):
			return opened
		}
	}
	return opened
}

// lineFiles indexes, by cleaned path, the commands of a line that write each
// file, in the order they run, and keeps the text each version of a file had.
type lineFiles struct {
	built  bool
	writes map[string][]outputWrite
	texts  map[fileVersion]writtenText
	// pieces counts the writes read for those texts.
	pieces int
}

// fileVersion names the contents a file has at some point of a line: the
// write, among the line's writes to it, that was the last before then. owner
// is the line, because a script the line hands on is a line of its own with
// files of its own, and its s.sh is not the s.sh of the line around it.
type fileVersion struct {
	owner *lineFiles
	path  string
	last  int
}

// writtenText is the text of one version of a file, when the hook can know
// it, and what a lone $(echo …) in that text prints (see printedBy).
type writtenText struct {
	text      string
	ok        bool
	printed   string
	printedOK bool
}

// outputWrite is one command that writes a file: by redirection, or as a
// file tee copies its input into.
type outputWrite struct {
	segment int
	appends bool
}

// printed is what a lone $(echo …) in the text of a version of a file
// prints, as read when writtenScript built the text.
func (files *lineFiles) printed(version fileVersion) (string, bool) {
	known := files.texts[version]
	return known.printed, known.printedOK
}

// fileWrites are the commands of the line that write the file at path.
func (line shellLine) fileWrites(path string) []outputWrite {
	if line.files == nil {
		return nil
	}
	if !line.files.built {
		line.files.built = true
		line.files.writes = map[string][]outputWrite{}
		for index, segment := range line.segments {
			io := segment.io()
			targets := io.outputs
			words := skipPrefixWords(io.words)
			if run := launchOf(words); run.program >= 0 && commandName(words[run.program]) == "tee" {
				appends := false
				for _, argument := range words[run.program+1:] {
					switch {
					case argument == "-a" || argument == "--append":
						appends = true
					case !strings.HasPrefix(argument, "-"):
						targets = append(targets, outputFile{path: argument, appends: appends})
					}
				}
			}
			for _, target := range targets {
				clean := filepath.Clean(target.path)
				line.files.writes[clean] = append(line.files.writes[clean], outputWrite{segment: index, appends: target.appends})
			}
		}
	}
	return line.files.writes[filepath.Clean(path)]
}

// maxScriptWrites bounds how many writes to one file are read for the script
// in it, and maxScriptPieces how many writes a line's files are read in all:
// a line of 1 MiB can run a file it appends to thousands of times, and each
// run reads a different version of it.
const (
	maxScriptWrites = 64
	maxScriptPieces = 1 << 14
)

// writtenScript is the text the commands before index in the line write to
// the file at path (echo 'cmd' > run.sh, cat > run.sh <<'EOF', … | tee
// run.sh), which a command that runs that file runs as its script: the last
// write that replaced the file and the appends after it. It also returns the
// version of the file that text is, which stays the same however often the
// line runs the file, and the text is built once. A file the line did not
// write is not read.
func writtenScript(line shellLine, index int, path string) (string, fileVersion, bool) {
	writes := line.fileWrites(path)
	last := sort.Search(len(writes), func(at int) bool { return writes[at].segment >= index }) - 1
	if last < 0 {
		return "", fileVersion{}, false
	}
	version := fileVersion{owner: line.files, path: filepath.Clean(path), last: last}
	if known, cached := line.files.texts[version]; cached {
		return known.text, version, known.ok
	}
	var texts []string
	for at := last; at >= 0 && last-at < maxScriptWrites && line.files.pieces < maxScriptPieces; at-- {
		write := writes[at]
		line.files.pieces++
		if text, ok := commandText(line, write.segment, line.segments[write.segment].io(), 0); ok {
			texts = append([]string{text}, texts...)
		}
		if !write.appends {
			break
		}
	}
	known := writtenText{text: strings.Join(texts, "\n"), ok: len(texts) > 0}
	if known.ok {
		known.printed, known.printedOK = printedBy(line, strings.TrimSpace(known.text))
	}
	if line.files.texts == nil {
		line.files.texts = map[fileVersion]writtenText{}
	}
	line.files.texts[version] = known
	return known.text, version, known.ok
}

// printedBy is what a word that is exactly one command substitution prints,
// when each command in it prints a known text: in bash -c "$(echo 'cmd')"
// the shell runs cmd. The word is read for the commands of parent's line.
func printedBy(parent shellLine, word string) (string, bool) {
	substitution := (strings.HasPrefix(word, "$(") && strings.HasSuffix(word, ")")) ||
		(len(word) > 1 && strings.HasPrefix(word, "`") && strings.HasSuffix(word, "`"))
	if !substitution {
		return "", false
	}
	line := parent.parseScript(word)
	last := len(line.segments) - 1
	if last < 1 || line.segments[last].scope != 0 || len(line.segments[last].words) != 1 || line.segments[last].words[0] != word {
		return "", false
	}
	var texts []string
	for index, segment := range line.segments[:last] {
		// Scope 1 holds the substitution's own commands; a deeper one is a
		// substitution inside them, whose output is already in their text.
		if segment.scope != 1 || isPipe(segment.terminator) {
			continue
		}
		text, ok := printedText(line, index, 0)
		if !ok {
			return "", false
		}
		texts = append(texts, text)
	}
	return strings.Join(texts, "\n"), len(texts) > 0
}

// MARK: - Tools that build or carry commands

// xargsValues are the xargs options that take a value.
var xargsValues = names("-I", "-J", "-L", "-n", "-P", "-E", "-d", "-s", "-a", "-R", "-S",
	"--max-args", "--max-procs", "--delimiter", "--eof", "--arg-file", "--max-lines", "--max-chars", "--process-slot-var")

// xargsScripts are the scripts xargs builds for a shell from text, its
// input: the shell's -c string with the replacement string filled in from
// each input line (xargs -I{} sh -c '{}', see xargsFill), or, when the
// shell's -c has no string of its own, each delimited input item as that
// string (xargs -0 sh -c). Without -0 or -d, xargs splits its input at
// blanks, so a -c string it supplies is a single word, which runs no steered
// command.
func xargsScripts(arguments []string, text string) []string {
	replace, whole, delimited := "", false, false
	at := 0
options:
	for ; at < len(arguments); at++ {
		argument := arguments[at]
		name, value, inline := strings.Cut(argument, "=")
		switch {
		case argument == "--":
			at++
			break options
		case !strings.HasPrefix(argument, "-") || argument == "-":
			break options
		case name == "--arg-file" || strings.HasPrefix(argument, "-a"):
			// The input comes from a file, not the text.
			return nil
		case argument == "-0" || argument == "--null":
			whole = true
		case name == "--replace":
			replace = "{}"
			if inline {
				replace = value
			}
		case strings.HasPrefix(argument, "--"):
			delimited = delimited || name == "--delimiter"
			if !inline && xargsValues[name] {
				at++
			}
		case argument[1] == 'i':
			// GNU xargs -i[replace], whose replacement string defaults to {}.
			replace = "{}"
			if len(argument) > 2 {
				replace = argument[2:]
			}
		case xargsValues[argument[:2]]:
			delimited = delimited || argument[1] == 'd'
			value := argument[2:]
			if value == "" && at+1 < len(arguments) {
				at++
				value = arguments[at]
			}
			if argument[1] == 'I' || argument[1] == 'J' {
				replace = value
			}
		}
	}
	utility := arguments[min(at, len(arguments)):]
	run := launchOf(utility)
	if run.program < 0 || !shellPrograms[commandName(utility[run.program])] {
		return nil
	}
	items := strings.Split(text, "\n")
	if whole {
		items = []string{text}
	}
	var scripts []string
	switch script, from := shellScript(utility[run.program+1:]); {
	case from == shellInline && replace != "" && strings.Contains(script, replace):
		scripts = xargsFill(script, replace, items)
	case from == shellAwaiting && replace == "" && (whole || delimited):
		scripts = append(scripts, items...)
	}
	return scripts
}

// xargsFill is script with each of items in place of its replacement
// string. An item fills in a quoted word, which is what the command around
// it sees (sh -c 'echo {}' prints the line), except when it is the whole
// script (sh -c '{}'), where it is the command line itself. The scripts stop
// at maxFollowedScriptBytes in all, counted before each is built, so a long
// script and many input lines do not cost one copy per line.
func xargsFill(script string, replace string, items []string) []string {
	whole := strings.TrimSpace(script) == replace
	occurrences := strings.Count(script, replace)
	var filled []string
	total := 0
	for _, item := range items {
		word := item
		if !whole {
			word = shellQuote(item)
		}
		if total += len(script) + occurrences*(len(word)-len(replace)); total > maxFollowedScriptBytes {
			break
		}
		filled = append(filled, strings.ReplaceAll(script, replace, word))
	}
	return filled
}

// tmuxOptions are tmux's own options before its command: -c carries a shell
// command of its own.
var tmuxOptions = launcherOptions{values: names("-f", "-L", "-S", "-T"), scripts: names("-c")}

// tmuxCarriers are the tmux commands that take a shell command or keys to
// type into a pane (and their aliases), with the options of each that take a
// value, whose values are names and directories, not commands. Every other
// tmux command (rename-window, display-message, set, …) only handles text.
var tmuxCarriers = map[string]string{
	"new-session": "cefFnstxy", "new": "cefFnstxy",
	"new-window": "ceFnt", "neww": "ceFnt",
	"split-window": "ceFlt", "splitw": "ceFlt",
	"respawn-pane": "cet", "respawnp": "cet",
	"respawn-window": "cet", "respawnw": "cet",
	"run-shell": "cdt", "run": "cdt",
	"if-shell": "t", "if": "t",
	"pipe-pane": "t", "pipep": "t",
	"display-popup": "bcdehsSTtwxy", "popup": "bcdehsSTtwxy",
	"send-keys": "cNt", "send": "cNt",
}

// tmuxScripts are the shell commands and keys that a tmux command line
// hands on: tmux -c's string, or the arguments of a carrier command that are
// not options or their values, in each command of a list (tmux select-pane
// -t 1 \; send-keys 'cmd' Enter).
func tmuxScripts(arguments []string) []string {
	skipped := tmuxOptions.skip(arguments, 0)
	if !skipped.runs {
		return skipped.scripts
	}
	var scripts []string
	for _, command := range tmuxCommands(arguments[skipped.next:]) {
		scripts = append(scripts, tmuxCarried(command)...)
	}
	return scripts
}

// tmuxCommands splits tmux's arguments into the commands of its list, the way
// tmux does: an argument that ends in a semicolon ends the command there (the
// shell hands tmux a bare ";" for \;), and one that ends in a backslash and a
// semicolon is a literal semicolon.
func tmuxCommands(arguments []string) [][]string {
	var commands [][]string
	var command []string
	for _, argument := range arguments {
		ends := false
		if strings.HasSuffix(argument, ";") {
			argument = argument[:len(argument)-1]
			if strings.HasSuffix(argument, `\`) {
				argument = argument[:len(argument)-1] + ";"
			} else {
				ends = true
			}
		}
		if !ends || argument != "" {
			command = append(command, argument)
		}
		if ends && len(command) > 0 {
			commands = append(commands, command)
			command = nil
		}
	}
	if len(command) > 0 {
		commands = append(commands, command)
	}
	return commands
}

// tmuxCarried is what one tmux command (its name, then its arguments) hands
// on: nothing unless it is one of tmuxCarriers.
func tmuxCarried(command []string) []string {
	values, carries := tmuxCarriers[command[0]]
	if !carries {
		return nil
	}
	var scripts []string
	rest := command[1:]
	for index := 0; index < len(rest); index++ {
		argument := rest[index]
		switch {
		case argument == "--":
			return append(scripts, rest[index+1:]...)
		case len(argument) > 1 && argument[0] == '-':
			for position := 1; position < len(argument); position++ {
				if strings.IndexByte(values, argument[position]) >= 0 {
					// The value is the rest of the word, or the next word.
					if position+1 == len(argument) {
						index++
					}
					break
				}
			}
		default:
			scripts = append(scripts, argument)
		}
	}
	return scripts
}

var (
	// appleScriptCommand matches the shell commands an AppleScript runs: do
	// shell script "…", Terminal's do script "…", and iTerm's write text "…".
	appleScriptCommand = regexp.MustCompile(`\b(?:do\s+(?:shell\s+)?script|write\s+text)\s+"((?:[^"\\]|\\.)*)"`)
	appleScriptEscapes = strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n", `\t`, "\t")
)

// appleScriptCommands are the shell commands the AppleScript in arguments
// runs.
func appleScriptCommands(arguments []string) []string {
	var scripts []string
	for _, argument := range arguments {
		for _, match := range appleScriptCommand.FindAllStringSubmatch(argument, -1) {
			scripts = append(scripts, appleScriptEscapes.Replace(match[1]))
		}
	}
	return scripts
}
