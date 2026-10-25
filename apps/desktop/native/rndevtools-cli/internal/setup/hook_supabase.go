package setup

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
)

// Supabase steering. While the user has local Supabase turned on in RN
// Devtools (steering.json says so), the PreToolUse hook judges every supabase
// command and every process-kill command of a Bash line, one segment at a
// time, in one of two modes:
//
//   - managed: RN Devtools runs this worktree's stack. The file is at most
//     three minutes old, the desktop answers on its socket, and the command
//     runs inside a managed root whose project it would use. Lifecycle
//     commands are redirected to `rndevtools supabase`, and commands that
//     would create a stack or a shadow database wait for the branch's stack.
//   - fallback: otherwise, in projects that opted into the stack backend.
//     Agents start their own stack, and only the native runtime is allowed.
//
// The rules that protect other agents' stacks apply in both modes. Every
// rule fails open: a command the hook cannot read, in a directory it cannot
// place, runs. The hook is advisory; the desktop's native stacks and
// exposure checks are the real controls.

// supabaseEnvironment is what the rules read besides the command. Nothing is
// read until a rule needs it, and tests replace every part.
type supabaseEnvironment struct {
	steering  func() (steeringState, bool)
	reachable func() bool
	now       func() time.Time
	home      func() string
	getenv    func(string) string
}

func defaultSupabaseEnvironment() supabaseEnvironment {
	return supabaseEnvironment{
		steering: func() (steeringState, bool) {
			directory, _, err := steeringDirectory()
			if err != nil {
				return steeringState{}, false
			}
			return readSteering(directory)
		},
		reachable: func() bool {
			_, socket, err := steeringDirectory()
			return err == nil && client.Reachable(socket, desktopProbeTimeout)
		},
		now: time.Now,
		home: func() string {
			home, err := os.UserHomeDir()
			if err != nil || !filepath.IsAbs(home) {
				return ""
			}
			return home
		},
		getenv: os.Getenv,
	}
}

// supabaseRules judges one Bash call. It loads steering.json and probes the
// desktop at most once, and only when a command needs them.
type supabaseRules struct {
	environment supabaseEnvironment
	loaded      bool
	state       *steeringState
	reachable   *bool
	home        *string
	nesting     int
	// scripts meters the scripts the rules follow (see handedScripts).
	scripts scriptLedger
}

func (rules *supabaseRules) enabled() bool {
	if !rules.loaded {
		rules.loaded = true
		if state, ok := rules.environment.steering(); ok {
			rules.state = &state
		}
	}
	return rules.state != nil && rules.state.enabled
}

// desktopManaging is the liveness half of managed mode: a fresh file and a
// desktop that accepts a connection. A crash leaves both files behind.
func (rules *supabaseRules) desktopManaging() bool {
	if rules.state == nil || !rules.state.fresh(rules.environment.now()) {
		return false
	}
	if rules.reachable == nil {
		reachable := rules.environment.reachable()
		rules.reachable = &reachable
	}
	return *rules.reachable
}

func (rules *supabaseRules) homeDirectory() string {
	if rules.home == nil {
		home := rules.environment.home()
		rules.home = &home
	}
	return *rules.home
}

// judge walks a line's segments in the order they run, following each
// scope's working directory: a `cd` changes it for the segments after it
// unless it runs in a pipeline or in the background.
func (rules *supabaseRules) judge(line shellLine, cwd string) HookDecision {
	directories := map[int]string{}
	var directoryOf func(scope int) string
	directoryOf = func(scope int) string {
		if directory, known := directories[scope]; known {
			return directory
		}
		directory := ""
		if parent := line.parents[scope]; parent >= 0 {
			directory = directoryOf(parent)
		} else if filepath.IsAbs(cwd) {
			directory = filepath.Clean(cwd)
		}
		directories[scope] = directory
		return directory
	}
	for index, segment := range line.segments {
		directory := directoryOf(segment.scope)
		_, words := segment.commandWords()
		program := ""
		if len(words) > 0 {
			program = baseName(words[0])
		}
		switch program {
		case "cd", "pushd":
			if changesDirectory(segment.terminator) {
				directories[segment.scope] = rules.changeDirectory(directory, words[1:])
			}
			continue
		case "popd":
			if changesDirectory(segment.terminator) {
				directories[segment.scope] = ""
			}
			continue
		case "rndevtools":
			// RN Devtools' own CLI may name these commands in its arguments.
			continue
		}
		if decision := rules.judgeSegment(line, index, directory); decision.Block {
			return decision
		}
	}
	return HookDecision{}
}

// changesDirectory reports whether a `cd` ended by terminator affects the
// segments after it: a pipeline element or a background job runs in a
// subshell of its own.
func changesDirectory(terminator string) bool {
	return terminator != "|" && terminator != "|&" && terminator != "&"
}

func (rules *supabaseRules) changeDirectory(current string, arguments []string) string {
	for len(arguments) > 0 && strings.HasPrefix(arguments[0], "-") && arguments[0] != "-" {
		if arguments[0] == "--" {
			arguments = arguments[1:]
			break
		}
		arguments = arguments[1:]
	}
	if len(arguments) == 0 {
		return rules.homeDirectory()
	}
	return rules.resolveDirectory(current, arguments[0])
}

// maxPathLength bounds the directories the rules follow: no path of a real
// directory is longer, and a line of 1 MiB can nest ( cd a; groups a hundred
// thousand deep, each building a longer path than the one before.
const maxPathLength = 4096

// resolveDirectory places target the way the shell would from base, or
// returns "" (unknown) when it depends on something the hook cannot see.
func (rules *supabaseRules) resolveDirectory(base string, target string) string {
	if resolved := rules.placeDirectory(base, target); len(resolved) <= maxPathLength {
		return resolved
	}
	return ""
}

func (rules *supabaseRules) placeDirectory(base string, target string) string {
	for _, variable := range []string{"$HOME", "${HOME}"} {
		if target == variable || strings.HasPrefix(target, variable+"/") {
			target = "~" + strings.TrimPrefix(target, variable)
		}
	}
	for _, variable := range []string{"$PWD", "${PWD}"} {
		if target == variable || strings.HasPrefix(target, variable+"/") {
			if base == "" {
				return ""
			}
			target = base + strings.TrimPrefix(target, variable)
		}
	}
	switch {
	case target == "" || target == "-" || strings.ContainsAny(target, "$`*?[{"):
		return ""
	case target == "~" || strings.HasPrefix(target, "~/"):
		home := rules.homeDirectory()
		if home == "" {
			return ""
		}
		return filepath.Join(home, strings.TrimPrefix(target, "~"))
	case strings.HasPrefix(target, "~"):
		return ""
	case filepath.IsAbs(target):
		return filepath.Clean(target)
	case base == "":
		return ""
	}
	return filepath.Join(base, target)
}

func (rules *supabaseRules) judgeSegment(line shellLine, index int, directory string) HookDecision {
	if !rules.scripts.exhausted() {
		for _, script := range handedScripts(line, index) {
			if decision := rules.nested(line, script, directory); decision.Block {
				return decision
			}
		}
	}
	assignments, words := line.segments[index].commandWords()
	if len(words) == 0 {
		// Only launchers, whose own command strings are judged above.
		return HookDecision{}
	}
	program := baseName(words[0])
	if shellPrograms[program] || program == "eval" {
		// The rest is the shell's own: options, script, and parameters.
		return HookDecision{}
	}
	if command, kills := killsStackProcesses(line, index, program, words); kills {
		if !rules.enabled() {
			return HookDecision{}
		}
		return blocked(killReason(command))
	}
	invocation, ok := parseSupabaseInvocation(words, assignments)
	if !ok || invocation.args.help || !rules.enabled() {
		return HookDecision{}
	}
	return rules.judgeSupabase(line, index, invocation, directory)
}

// nested judges a script that a command of line hands on (see handedScripts)
// from directory.
func (rules *supabaseRules) nested(line shellLine, script handedScript, directory string) HookDecision {
	if rules.nesting >= maxNestedScripts || !rules.scripts.follow(script, directory, rules.nesting) {
		return HookDecision{}
	}
	rules.nesting++
	defer func() { rules.nesting-- }()
	return rules.judge(line.parseScript(script.text), directory)
}

func blocked(reason string) HookDecision {
	return HookDecision{Block: true, Reason: reason}
}

// MARK: - Which supabase command a segment runs

// supabaseBinaryPattern matches the program a runner launches: a supabase
// binary on PATH or by path, optionally a versioned package (supabase@2.1).
var supabaseBinaryPattern = regexp.MustCompile(`(?:^|/)supabase(?:@[\w.^~-]+)?$`)

// supabaseInvocation is one segment that runs the Supabase CLI.
type supabaseInvocation struct {
	// launcher is the words up to and including the binary, as written.
	launcher []string
	binary   string
	// versioned names a supabase@<version> package; downloads is a runner
	// that always fetches the CLI from the registry.
	versioned bool
	downloads bool
	// chdir is a runner's directory option (pnpm -C, yarn --cwd, bun --cwd).
	chdir       string
	assignments map[string]string
	// assignmentWords are the segment's FOO=bar prefixes, as written.
	assignmentWords []string
	arguments       []string
	args            supabaseArguments
}

// runnerOptions describes a runner's own options before the program.
type runnerOptions struct {
	// values take the next word unless written as --name=value.
	values map[string]bool
	// packages name the package to fetch.
	packages map[string]bool
	// chdir change the directory the program runs in.
	chdir map[string]bool
	// shell run a shell string instead of a program; the hook cannot judge it.
	shell map[string]bool
}

var (
	npxOptions = runnerOptions{
		values:   names("-p", "--package", "-w", "--workspace", "--cache", "--userconfig"),
		packages: names("-p", "--package"),
		shell:    names("-c", "--call"),
	}
	pnpmOptions = runnerOptions{
		values: names("-C", "--dir", "-F", "--filter", "--loglevel", "--reporter"),
		chdir:  names("-C", "--dir"),
	}
	pnpmRunOptions = runnerOptions{
		values:   names("--package", "-F", "--filter"),
		packages: names("--package"),
		shell:    names("-c", "--shell-mode"),
	}
	yarnOptions = runnerOptions{
		values: names("--cwd"),
		chdir:  names("--cwd"),
	}
	yarnDlxOptions = runnerOptions{
		values:   names("-p", "--package"),
		packages: names("-p", "--package"),
	}
	bunOptions = runnerOptions{
		values: names("--cwd"),
		chdir:  names("--cwd"),
	}
	bunxOptions = runnerOptions{
		values:   names("-p", "--package"),
		packages: names("-p", "--package"),
	}
	npmOptions = runnerOptions{
		values: names("--prefix", "-w", "--workspace", "--loglevel"),
	}
	npmExecOptions = runnerOptions{
		values:   names("--package", "-w", "--workspace"),
		packages: names("--package"),
		shell:    names("-c", "--call"),
	}
)

func names(values ...string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

// parseSupabaseInvocation strips a runner (npx, pnpm exec/dlx, yarn [dlx],
// bunx, bun x, npm exec) and reports the Supabase CLI command it runs, or
// false when the segment runs something else.
func parseSupabaseInvocation(words []string, assignmentWords []string) (supabaseInvocation, bool) {
	invocation := supabaseInvocation{assignmentWords: assignmentWords, assignments: map[string]string{}}
	for _, word := range assignmentWords {
		name, value, _ := strings.Cut(word, "=")
		invocation.assignments[name] = value
	}
	rest := words
	take := func(count int) {
		invocation.launcher = append(invocation.launcher, rest[:count]...)
		rest = rest[count:]
	}
	options := func(set runnerOptions) bool {
		for len(rest) > 0 {
			word := rest[0]
			if word == "--" {
				take(1)
				return true
			}
			if !strings.HasPrefix(word, "-") || word == "-" {
				return true
			}
			name, value, inline := strings.Cut(word, "=")
			if set.shell[name] {
				return false
			}
			count := 1
			if !inline && set.values[name] && len(rest) > 1 {
				value, count = rest[1], 2
			}
			if set.packages[name] && strings.HasPrefix(value, "supabase@") {
				invocation.versioned = true
			}
			if set.chdir[name] {
				invocation.chdir = value
			}
			take(count)
		}
		return true
	}
	// subcommand takes the runner word (or its exec, dlx, x subcommand) and
	// then that word's own options.
	subcommand := func(set runnerOptions) bool {
		take(1)
		return options(set)
	}
	valid := true
	switch baseName(rest[0]) {
	case "npx":
		valid = subcommand(npxOptions)
	case "pnpx":
		invocation.downloads = true
		valid = subcommand(pnpmRunOptions)
	case "bunx":
		valid = subcommand(bunxOptions)
	case "pnpm":
		take(1)
		valid = options(pnpmOptions) && len(rest) > 0
		if valid {
			switch rest[0] {
			case "exec":
				valid = subcommand(pnpmRunOptions)
			case "dlx":
				invocation.downloads = true
				valid = subcommand(pnpmRunOptions)
			}
		}
	case "yarn":
		take(1)
		valid = options(yarnOptions) && len(rest) > 0
		if valid {
			switch rest[0] {
			case "dlx":
				invocation.downloads = true
				valid = subcommand(yarnDlxOptions)
			case "exec", "run":
				valid = subcommand(runnerOptions{})
			}
		}
	case "bun":
		take(1)
		valid = options(bunOptions) && len(rest) > 0 && (rest[0] == "x" || rest[0] == "run")
		if valid {
			valid = subcommand(bunxOptions)
		}
	case "npm":
		take(1)
		valid = options(npmOptions) && len(rest) > 0 && (rest[0] == "exec" || rest[0] == "x")
		if valid {
			valid = subcommand(npmExecOptions)
		}
	}
	if !valid || len(rest) == 0 || !supabaseBinaryPattern.MatchString(rest[0]) {
		return supabaseInvocation{}, false
	}
	invocation.binary = rest[0]
	if strings.Contains(baseName(rest[0]), "@") {
		invocation.versioned = true
	}
	take(1)
	invocation.arguments = rest
	invocation.args = parseSupabaseArguments(rest)
	return invocation, true
}

// supabaseArguments is what the rules need from a supabase command line.
type supabaseArguments struct {
	// verbs are the leading positional words: the command path.
	verbs []string
	// verbEnd is the index in the arguments just past the last verb.
	verbEnd int
	// flags maps a flag name without dashes to its values, "" for a bare
	// boolean.
	flags map[string][]string
	// redirects are this segment's output redirection targets.
	redirects []string
	help      bool
}

// Flags that take the next word as their value: the CLI's globals and the
// command options that may come before a verb.
var (
	supabaseValueFlags = names(
		"workdir", "output", "output-format", "profile", "agent", "network-id", "dns-resolver",
		"runtime", "stack", "stack-id", "project-id", "project-ref", "exclude", "preparation",
		"db-url", "schema", "file", "version", "last", "sql-paths", "service", "tail", "since",
		"password", "lang", "env-file", "import-map",
	)
	supabaseShortValueFlags = names("o", "x", "s", "f", "p")
	redirectPattern         = regexp.MustCompile(`^([0-9]+|&)?(>>?\|?|<<?<?)(.*)$`)
)

func parseSupabaseArguments(arguments []string) supabaseArguments {
	parsed := supabaseArguments{flags: map[string][]string{}}
	positionalOnly := false
	for index := 0; index < len(arguments); index++ {
		word := arguments[index]
		if operator, target, ok := redirection(word); ok {
			if target == "" && index+1 < len(arguments) {
				index++
				target = arguments[index]
			}
			if strings.HasPrefix(operator, ">") {
				parsed.redirects = append(parsed.redirects, target)
			}
			continue
		}
		// `--env>.env` is a flag and a redirection in one word.
		if cut := strings.IndexByte(word, '>'); cut > 0 && !positionalOnly {
			if _, target, ok := redirection(word[cut:]); ok {
				if target == "" && index+1 < len(arguments) {
					index++
					target = arguments[index]
				}
				parsed.redirects = append(parsed.redirects, target)
				word = word[:cut]
			}
		}
		switch {
		case positionalOnly:
		case word == "--":
			positionalOnly = true
		case strings.HasPrefix(word, "--") && len(word) > 2:
			name, value, inline := strings.Cut(word[2:], "=")
			if !inline && supabaseValueFlags[name] && index+1 < len(arguments) {
				if _, _, isRedirect := redirection(arguments[index+1]); !isRedirect {
					index++
					value = arguments[index]
				}
			}
			parsed.flags[name] = append(parsed.flags[name], value)
		case strings.HasPrefix(word, "-") && len(word) > 1:
			name, value := word[1:2], strings.TrimPrefix(word[2:], "=")
			if value == "" && supabaseShortValueFlags[name] && index+1 < len(arguments) {
				index++
				value = arguments[index]
			}
			parsed.flags[name] = append(parsed.flags[name], value)
		case len(parsed.verbs) < 4:
			parsed.verbs = append(parsed.verbs, word)
			parsed.verbEnd = index + 1
		}
	}
	parsed.help = parsed.has("help") || parsed.has("h") || (len(parsed.verbs) > 0 && parsed.verbs[0] == "help")
	return parsed
}

// redirection splits a redirection word (>, >>, 2>, &>, >|, <, …) into its
// operator and the target written in the same word.
func redirection(word string) (operator string, target string, ok bool) {
	_, operator, target, ok = splitRedirection(word)
	return operator, target, ok
}

// splitRedirection is redirection plus the file descriptor the operator
// names: "2" in 2>&1, "&" in &>, "" when it names none.
func splitRedirection(word string) (descriptor string, operator string, target string, ok bool) {
	match := redirectPattern.FindStringSubmatch(word)
	if match == nil {
		return "", "", "", false
	}
	return match[1], match[2], match[3], true
}

func (args supabaseArguments) has(name string) bool {
	_, present := args.flags[name]
	return present
}

// on reports a boolean flag that is present and not set to false.
func (args supabaseArguments) on(name string) bool {
	values, present := args.flags[name]
	return present && values[len(values)-1] != "false"
}

// last is a flag's final value, which is the one the CLI uses.
func (args supabaseArguments) last(name string) (string, bool) {
	values, present := args.flags[name]
	if !present {
		return "", false
	}
	return values[len(values)-1], true
}

// supabaseCommandKind classifies a command path for the rules.
type supabaseCommandKind int

const (
	supabaseOther supabaseCommandKind = iota
	supabaseStart
	supabasePrepare
	supabaseRestart
	supabaseStop
	supabaseDestroy
	supabaseStatus
	supabaseDev
	supabaseDatabaseStart
	supabaseDeclarative
	supabaseShadow
)

// kind classifies the command and returns how many verbs name it.
func (args supabaseArguments) kind() (supabaseCommandKind, int) {
	verbs := args.verbs
	if len(verbs) == 0 {
		return supabaseOther, 0
	}
	switch verbs[0] {
	case "start":
		return supabaseStart, 1
	case "stop":
		return supabaseStop, 1
	case "status":
		return supabaseStatus, 1
	case "dev":
		return supabaseDev, 1
	case "stack", "local":
		if len(verbs) < 2 {
			return supabaseOther, 1
		}
		switch verbs[1] {
		case "start":
			return supabaseStart, 2
		case "prepare":
			return supabasePrepare, 2
		case "restart":
			return supabaseRestart, 2
		case "stop":
			return supabaseStop, 2
		case "destroy":
			return supabaseDestroy, 2
		case "status":
			return supabaseStatus, 2
		}
		return supabaseOther, 2
	case "db":
		switch {
		case len(verbs) >= 2 && verbs[1] == "start":
			return supabaseDatabaseStart, 2
		case len(verbs) >= 2 && (verbs[1] == "diff" || verbs[1] == "pull"):
			return supabaseShadow, 2
		case len(verbs) >= 4 && verbs[1] == "schema" && verbs[2] == "declarative" && (verbs[3] == "generate" || verbs[3] == "sync"):
			return supabaseDeclarative, 4
		}
	case "migration":
		if len(verbs) >= 2 && verbs[1] == "squash" {
			return supabaseShadow, 2
		}
	}
	// Name other commands by their group and subcommand (migration up).
	return supabaseOther, min(len(verbs), 2)
}

// nativeRuntime reports an explicit --runtime native.
func (args supabaseArguments) nativeRuntime() bool {
	runtime, present := args.last("runtime")
	return present && runtime == "native"
}

// envOutput reports `status --env` or `-o env`, which print every key,
// secret ones included, as dotenv lines.
func (args supabaseArguments) envOutput() bool {
	if args.on("env") {
		return true
	}
	for _, name := range []string{"o", "output"} {
		if value, present := args.last(name); present && value == "env" {
			return true
		}
	}
	return false
}

// targetsLocal reports a database command aimed at the local stack, which
// is the CLI's default when no target is named.
func (args supabaseArguments) targetsLocal() bool {
	if args.has("local") {
		return args.on("local")
	}
	return !args.has("linked") && !args.has("db-url")
}

// workdir is the project directory the command names, if any: --workdir,
// else SUPABASE_WORKDIR, which the CLI honours the same way.
func (invocation supabaseInvocation) workdir() (string, bool) {
	if value, present := invocation.args.last("workdir"); present {
		return value, true
	}
	value, present := invocation.assignments["SUPABASE_WORKDIR"]
	return value, present
}

// command is the command path as the agent would recognise it.
func (invocation supabaseInvocation) command() string {
	_, count := invocation.args.kind()
	return strings.Join(append([]string{"supabase"}, invocation.args.verbs[:count]...), " ")
}

// cli is how this segment launches the CLI, for example `pnpm exec supabase`.
func (invocation supabaseInvocation) cli() string {
	return shellJoin(invocation.launcher)
}

// withNativeRuntime is the segment's own command with `--runtime native` in
// place of any runtime it named.
func (invocation supabaseInvocation) withNativeRuntime() string {
	words := append(append([]string{}, invocation.assignmentWords...), invocation.launcher...)
	appendWithoutRuntime := func(arguments []string) {
		for index := 0; index < len(arguments); index++ {
			switch {
			case arguments[index] == "--runtime":
				index++
			case strings.HasPrefix(arguments[index], "--runtime="):
			default:
				words = append(words, arguments[index])
			}
		}
	}
	end := invocation.args.verbEnd
	appendWithoutRuntime(invocation.arguments[:end])
	words = append(words, "--runtime", "native")
	appendWithoutRuntime(invocation.arguments[end:])
	return shellJoin(words)
}

var (
	safeShellWord = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./~^-]+$`)
	// descriptorCopy is the target of a redirection like 2>&1.
	descriptorCopy = regexp.MustCompile(`^&[0-9-]*$`)
)

// shellJoin quotes words for a command the agent can paste back.
// Redirections stay operators, so `> start.log 2>&1` still redirects.
func shellJoin(words []string) string {
	quoted := make([]string, 0, len(words))
	for _, word := range words {
		if _, target, ok := redirection(word); ok {
			if target == "" || descriptorCopy.MatchString(target) {
				quoted = append(quoted, word)
			} else {
				quoted = append(quoted, word[:len(word)-len(target)]+shellQuote(target))
			}
			continue
		}
		quoted = append(quoted, shellQuote(word))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(word string) string {
	switch {
	case word != "" && safeShellWord.MatchString(word):
		return word
	case strings.Contains(word, "$") && !strings.ContainsAny(word, "\"`\\"):
		// Keep the expansion the agent wrote.
		return `"` + word + `"`
	}
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

// MARK: - Rules

func (rules *supabaseRules) judgeSupabase(line shellLine, index int, invocation supabaseInvocation, directory string) HookDecision {
	args := invocation.args
	kind, _ := args.kind()
	command := invocation.command()
	// The CLI runs where the runner puts it and reads the project its
	// --workdir names, or the nearest one above where it runs.
	runDirectory := directory
	if invocation.chdir != "" {
		runDirectory = rules.resolveDirectory(directory, invocation.chdir)
	}
	projectDirectory, exact := runDirectory, false
	if workdir, present := invocation.workdir(); present {
		projectDirectory, exact = rules.resolveDirectory(runDirectory, workdir), true
	}

	// Always on: commands that reach other agents' stacks.
	switch kind {
	case supabaseStop:
		switch {
		case args.on("all"):
			return blocked(fmt.Sprintf("Blocked `%s --all`: it stops every agent's local Supabase stack on this Mac, not just yours. %s", command, stopOwnStack(projectDirectory, "with no --all")))
		case args.has("stack-id") || args.has("project-id"):
			return blocked(fmt.Sprintf("Blocked `%s` by stack or project id: it may stop another agent's stack. %s", command, stopOwnStack(projectDirectory, "without --stack-id or --project-id")))
		case exact && !insideCurrentWorktree(runDirectory, projectDirectory):
			return blocked(fmt.Sprintf("Blocked `%s --workdir %s`: that directory is outside this worktree, so it may stop another agent's stack. %s", command, displayPath(projectDirectory), stopOwnStack(runDirectory, "without --workdir")))
		}
	case supabaseDestroy:
		return blocked(fmt.Sprintf("Blocked `%s`: it deletes a local database for good, and the stack may be another agent's. Ask the user instead: they can destroy it in RN Devtools › Supabase, or file the request with the rndevtools `supabase` tool (operation destroy, with a note). To start this worktree's database fresh, run `%s db reset --local` (or the `supabase` tool, operation reset).", command, invocation.cli()))
	case supabaseStatus:
		if args.envOutput() {
			if file, writes := writesEnvFile(line, index, args.redirects); writes {
				return blocked(fmt.Sprintf("Blocked writing `%s` output into %s: it carries SECRET_KEY, SERVICE_ROLE_KEY, and DB_URL, and Expo bundles .env files into the app. Lanes already pass the URL and publishable key to Metro; for the public values, call the rndevtools `supabase` tool (operation env) and keep secrets out of files.", command, displayPath(file)))
			}
		}
	}

	if root, managed := rules.managedRoot(projectDirectory, exact); managed {
		return rules.judgeManaged(invocation, kind, command, root, runDirectory)
	}
	if !rules.optedIn(invocation, projectDirectory, exact) {
		return HookDecision{}
	}
	switch kind {
	case supabaseStart, supabasePrepare:
		if !args.nativeRuntime() {
			return blocked(fmt.Sprintf("Blocked `%s` without `--runtime native`: a new stack picks Docker when Docker answers, and Docker stacks listen on every network interface with public default credentials. Run `%s` instead; the runtime is saved, so later starts stay native. If it reports that the existing stack uses docker, ask the user before replacing it.", command, invocation.withNativeRuntime()))
		}
	case supabaseDatabaseStart:
		return blocked(fmt.Sprintf("Blocked `%s`: it cannot choose a runtime and creates a Docker stack whenever Docker answers. Run `%s start --runtime native` from the worktree instead.", command, invocation.cli()))
	case supabaseDeclarative:
		if args.targetsLocal() && !chainedAfterNativeStart(line, index) {
			return blocked(fmt.Sprintf("Blocked `%s`: when this branch has no running local stack, it creates one with automatic runtime selection, which picks Docker when Docker answers. Run `%s start --runtime native && %s` instead; start returns at once when the stack already runs.", command, invocation.cli(), strings.TrimSpace(line.segments[index].text)))
		}
	}
	return HookDecision{}
}

// judgeManaged applies the rules for a worktree RN Devtools runs.
func (rules *supabaseRules) judgeManaged(invocation supabaseInvocation, kind supabaseCommandKind, command string, root steeringRoot, runDirectory string) HookDecision {
	worktree := displayPath(root.worktreeRoot)
	upHint := fmt.Sprintf("the rndevtools `supabase` tool (operation up, worktree %s) or `rndevtools supabase --operation up --worktree %s`", worktree, shellJoin([]string{root.worktreeRoot}))
	switch kind {
	case supabaseStart, supabaseRestart, supabasePrepare, supabaseDev:
		return blocked(fmt.Sprintf("Blocked `%s`: RN Devtools runs this worktree's local Supabase. Use %s instead; lane up does it for a lane. Your `%s … --local` commands (migration up, db reset, gen types) keep working against it.", command, upHint, root.runner))
	case supabaseStop:
		return blocked(fmt.Sprintf("Blocked `%s`: RN Devtools runs this worktree's local Supabase. Release it with the rndevtools `supabase` tool (operation down, worktree %s) or `rndevtools supabase --operation down --worktree %s`; it stops once nobody else uses it, and its data is kept.", command, worktree, shellJoin([]string{root.worktreeRoot})))
	case supabaseDatabaseStart:
		return blocked(fmt.Sprintf("Blocked `%s`: RN Devtools runs this worktree's local Supabase. Use %s instead.", command, upHint))
	}
	if invocation.args.has("runtime") {
		return blocked(fmt.Sprintf("Blocked `%s --runtime`: RN Devtools chooses this worktree's stack runtime, always native. Use %s to start it.", command, upHint))
	}
	if rules.foreignBinary(invocation, root, runDirectory) {
		return blocked(fmt.Sprintf("Blocked `%s`: a local stack only answers the CLI build that started it, and this one is downloaded or from outside the worktree. Run `%s` from this worktree instead (cli.run in the supabase up result).", shellJoin(invocation.launcher), root.runner))
	}
	createsShadow := kind == supabaseShadow || (kind == supabaseDeclarative && invocation.args.targetsLocal())
	if createsShadow && !rules.stackReady(root) {
		return blocked(fmt.Sprintf("Blocked `%s`: this branch has no running local stack yet, and the command would create one with automatic runtime selection, which picks Docker when Docker answers. Call %s first, then run it again.", command, upHint))
	}
	return HookDecision{}
}

func stopOwnStack(directory string, without string) string {
	worktree := "<this worktree's absolute path>"
	if directory != "" {
		if root := gitWorktreeRoot(directory); root != "" {
			directory = root
		}
		worktree = displayPath(directory)
	}
	return fmt.Sprintf("Stop only this worktree's stack: the rndevtools `supabase` tool (operation down, worktree %s) when RN Devtools manages it, otherwise `supabase stop` from the worktree, %s.", worktree, without)
}

func killReason(command string) string {
	return fmt.Sprintf("Blocked `%s`: native Supabase stacks share this Mac's process table, so this kills every agent's database. Stop only this worktree's stack: the rndevtools `supabase` tool (operation down) when RN Devtools manages it, otherwise `supabase stop` from the worktree.", command)
}

// displayPath bounds a path for a reason and strips anything unprintable.
func displayPath(path string) string {
	if path == "" {
		return "that directory"
	}
	var builder strings.Builder
	for _, character := range path {
		if character < 0x20 || character == 0x7f || character == '`' {
			continue
		}
		builder.WriteRune(character)
	}
	text := builder.String()
	if len(text) > 200 {
		text = "…" + text[len(text)-199:]
	}
	return text
}

// insideCurrentWorktree reports whether target lies in the worktree that
// contains base (or in base, outside git). An unknown directory passes.
func insideCurrentWorktree(base string, target string) bool {
	if base == "" || target == "" {
		return true
	}
	worktree := gitWorktreeRoot(base)
	if worktree == "" {
		worktree = base
	}
	return withinPath(worktree, target)
}

// managedRoot is the managed root a command in directory belongs to: the
// innermost root containing it, whose Supabase project is the one the CLI
// would use from there, while the desktop is live.
func (rules *supabaseRules) managedRoot(directory string, exact bool) (steeringRoot, bool) {
	if directory == "" || rules.state == nil {
		return steeringRoot{}, false
	}
	var best *steeringRoot
	for index := range rules.state.roots {
		root := &rules.state.roots[index]
		if withinPath(root.worktreeRoot, directory) && (best == nil || len(root.worktreeRoot) > len(best.worktreeRoot)) {
			best = root
		}
	}
	if best == nil {
		return steeringRoot{}, false
	}
	project, found := findSupabaseProject(directory, exact)
	if !found || canonicalPath(project) != canonicalPath(best.projectRoot) {
		return steeringRoot{}, false
	}
	if !rules.desktopManaging() {
		return steeringRoot{}, false
	}
	return *best, true
}

// stackReady reports whether the branch's stack exists and runs: the
// desktop says so, and the worktree is still on that branch.
func (rules *supabaseRules) stackReady(root steeringRoot) bool {
	if !root.stackReady {
		return false
	}
	head, known := readBranchContext(root.worktreeRoot)
	return !known || head == root.branchContext
}

// optedIn reports whether the CLI routes this command to the stack backend:
// the segment's SUPABASE_EXPERIMENTAL_STACK, else the hook's own, else the
// project's [experimental] stack setting.
func (rules *supabaseRules) optedIn(invocation supabaseInvocation, directory string, exact bool) bool {
	if value, present := invocation.assignments["SUPABASE_EXPERIMENTAL_STACK"]; present {
		return value == "1"
	}
	switch rules.environment.getenv("SUPABASE_EXPERIMENTAL_STACK") {
	case "1":
		return true
	case "0":
		return false
	}
	if directory == "" {
		return false
	}
	project, found := findSupabaseProject(directory, exact)
	return found && projectOptedIn(project)
}

// foreignBinary reports a CLI the managed stack would not answer: a
// downloaded or versioned package, or a binary by path outside the worktree
// and its repository's main checkout. A bare `supabase` is a PATH lookup the
// hook cannot place, so it passes.
func (rules *supabaseRules) foreignBinary(invocation supabaseInvocation, root steeringRoot, runDirectory string) bool {
	if invocation.versioned || invocation.downloads {
		return true
	}
	if !strings.Contains(invocation.binary, "/") {
		return false
	}
	path := rules.resolveDirectory(runDirectory, invocation.binary)
	if path == "" {
		return false
	}
	for _, allowed := range []string{root.worktreeRoot, root.projectRoot, repositoryCheckout(root.worktreeRoot)} {
		if allowed != "" && withinPath(allowed, path) {
			return false
		}
	}
	return true
}

// chainedAfterNativeStart reports a native start earlier in the same `&&`
// chain, which leaves a running native stack for the command after it.
func chainedAfterNativeStart(line shellLine, index int) bool {
	steps := 0
	for previous := previousInScope(line, index); previous >= 0 && steps < maxChainSteps && line.segments[previous].terminator == "&&"; previous, steps = previousInScope(line, previous), steps+1 {
		assignments, words := line.segments[previous].commandWords()
		if len(words) == 0 {
			continue
		}
		invocation, ok := parseSupabaseInvocation(words, assignments)
		if !ok {
			continue
		}
		if kind, _ := invocation.args.kind(); kind == supabaseStart && invocation.args.nativeRuntime() {
			return true
		}
	}
	return false
}

// writesEnvFile reports a redirection into a .env file, by the segment
// itself or by a later command of its pipeline (tee .env, … > .env).
func writesEnvFile(line shellLine, index int, redirects []string) (string, bool) {
	for _, target := range redirects {
		if isEnvFile(target) {
			return target, true
		}
	}
	for current, steps := index, 0; isPipe(line.segments[current].terminator) && steps < maxChainSteps; steps++ {
		next := nextInScope(line, current)
		if next < 0 {
			break
		}
		_, words := line.segments[next].commandWords()
		if len(words) > 0 && baseName(words[0]) == "tee" {
			for _, word := range words[1:] {
				if !strings.HasPrefix(word, "-") && isEnvFile(word) {
					return word, true
				}
			}
		}
		for _, target := range redirectTargets(line.segments[next].words) {
			if isEnvFile(target) {
				return target, true
			}
		}
		current = next
	}
	return "", false
}

func redirectTargets(words []string) []string {
	var targets []string
	for index := 0; index < len(words); index++ {
		operator, target, ok := redirection(words[index])
		if !ok || !strings.HasPrefix(operator, ">") {
			continue
		}
		if target == "" && index+1 < len(words) {
			index++
			target = words[index]
		}
		targets = append(targets, target)
	}
	return targets
}

func isEnvFile(target string) bool {
	return strings.HasPrefix(baseName(strings.TrimSpace(target)), ".env")
}

func isPipe(terminator string) bool {
	return terminator == "|" || terminator == "|&"
}

// maxChainSteps bounds how many commands of an && chain or a pipeline a rule
// reads before or after one command: a line of 1 MiB can chain tens of
// thousands, and each of them would read all the others.
const maxChainSteps = 32

// previousInScope and nextInScope are the segments just before and after the
// one at index in its own command list, -1 when it is the first or the last.
func previousInScope(line shellLine, index int) int {
	return line.before[index]
}

func nextInScope(line shellLine, index int) int {
	return line.after[index]
}

// MARK: - Killing stack processes

// stackProcessNames are the processes a native stack runs. Killing them by
// name kills every agent's stack, since they share one process table.
var (
	stackProcessNames = []string{
		"postgres", "postmaster", "postgrest", "gotrue", "realtime", "edge-runtime",
		"supabase", "supavisor", "mailpit", "imgproxy", "storage-api", "beam.smp",
	}
	// authProcessPattern matches the auth service by name without catching
	// oauth or authd.
	authProcessPattern = regexp.MustCompile(`(?:^|[^a-z0-9])auth(?:$|[^a-z0-9])`)
)

func namesStackProcess(word string) bool {
	lower := strings.ToLower(word)
	for _, name := range stackProcessNames {
		if strings.Contains(lower, name) {
			return true
		}
	}
	return authProcessPattern.MatchString(lower)
}

// killsStackProcesses recognises pkill/killall by name, kill of what pgrep
// or pidof finds, a pipeline into xargs kill, and pg_ctl stop, and returns
// a short form of the command for the reason.
func killsStackProcesses(line shellLine, index int, program string, words []string) (string, bool) {
	short := func() string {
		text := strings.Join(words, " ")
		if len(text) > 80 {
			text = text[:79] + "…"
		}
		return displayPath(text)
	}
	switch program {
	case "pkill", "killall":
		for _, word := range words[1:] {
			if namesStackProcess(word) {
				return short(), true
			}
		}
	case "kill":
		for _, word := range words[1:] {
			lower := strings.ToLower(word)
			if (strings.Contains(lower, "pgrep") || strings.Contains(lower, "pidof")) && namesStackProcess(word) {
				return short(), true
			}
		}
	case "xargs":
		if !containsProgram(words[1:], "kill", "pkill", "killall") {
			return "", false
		}
		steps := 0
		for previous := previousInScope(line, index); previous >= 0 && steps < maxChainSteps && isPipe(line.segments[previous].terminator); previous, steps = previousInScope(line, previous), steps+1 {
			for _, word := range line.segments[previous].words {
				if namesStackProcess(word) {
					return displayPath(strings.TrimSpace(line.segments[previous].text)) + " | " + short(), true
				}
			}
		}
	case "pg_ctl", "pg_ctlcluster":
		if containsProgram(words[1:], "stop", "kill", "restart") {
			return short(), true
		}
	}
	return "", false
}

func containsProgram(words []string, programs ...string) bool {
	for _, word := range words {
		for _, program := range programs {
			if baseName(word) == program {
				return true
			}
		}
	}
	return false
}

// MARK: - Files the rules read

// maxConfigBytes bounds a config.toml or config.json read, like the desktop.
const maxConfigBytes = 256 << 10

// findSupabaseProject is the project the CLI would use from directory: the
// directory itself with --workdir (exact), else the nearest directory at or
// above it holding supabase/config.toml or supabase/config.json.
func findSupabaseProject(directory string, exact bool) (string, bool) {
	current := filepath.Clean(directory)
	for step := 0; step < 64; step++ {
		if isRegularFile(filepath.Join(current, "supabase", "config.toml")) || isRegularFile(filepath.Join(current, "supabase", "config.json")) {
			return current, true
		}
		parent := filepath.Dir(current)
		if exact || parent == current {
			return "", false
		}
		current = parent
	}
	return "", false
}

// projectOptedIn reads the project's `[experimental] stack` setting the way
// the CLI routes: config.json when it exists, else config.toml. Anything
// unreadable, absent, or not literally true counts as not opted in.
func projectOptedIn(project string) bool {
	if path := filepath.Join(project, "supabase", "config.json"); isRegularFile(path) {
		raw, ok := readBoundedFile(path, maxConfigBytes)
		if !ok {
			return false
		}
		var config struct {
			Experimental struct {
				Stack *bool `json:"stack"`
			} `json:"experimental"`
		}
		return json.Unmarshal(raw, &config) == nil && config.Experimental.Stack != nil && *config.Experimental.Stack
	}
	raw, ok := readBoundedFile(filepath.Join(project, "supabase", "config.toml"), maxConfigBytes)
	return ok && tomlStackEnabled(string(raw))
}

// tomlStackEnabled finds `stack = true` in the [experimental] table, as a
// dotted `experimental.stack` key, or in an inline `experimental = {…}`
// table. It is a bounded line scan, not a TOML parser: it skips multi-line
// strings and comments, and treats a repeated key as not opted in, as the
// CLI would refuse the file.
func tomlStackEnabled(text string) bool {
	table := ""
	closing := ""
	matches := 0
	enabled := false
	record := func(value string) {
		matches++
		enabled = value == "true"
	}
	for _, rawLine := range strings.Split(text, "\n") {
		if closing != "" {
			if strings.Contains(rawLine, closing) {
				closing = ""
			}
			continue
		}
		line := strings.TrimSpace(stripTomlComment(rawLine))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			if strings.HasPrefix(line, "[[") {
				table = "\x00"
			} else {
				table = tomlKey(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			}
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		for _, delimiter := range []string{`"""`, `'''`} {
			if strings.HasPrefix(value, delimiter) && strings.Count(value, delimiter) == 1 {
				closing = delimiter
			}
		}
		path := tomlKey(key)
		if table != "" {
			path = table + "." + path
		}
		switch path {
		case "experimental.stack":
			record(value)
		case "experimental":
			if strings.HasPrefix(value, "{") && strings.HasSuffix(value, "}") {
				for _, entry := range strings.Split(strings.Trim(value, "{}"), ",") {
					if name, inline, ok := strings.Cut(entry, "="); ok && tomlKey(name) == "stack" {
						record(strings.TrimSpace(inline))
					}
				}
			}
		}
	}
	return matches == 1 && enabled
}

// tomlKey normalises a bare, quoted, or dotted key to dotted form.
func tomlKey(key string) string {
	parts := strings.Split(key, ".")
	for index, part := range parts {
		parts[index] = strings.Trim(strings.TrimSpace(part), `"'`)
	}
	return strings.Join(parts, ".")
}

func stripTomlComment(line string) string {
	quote := byte(0)
	for index := 0; index < len(line); index++ {
		character := line[index]
		switch {
		case quote != 0:
			if character == '\\' && quote == '"' {
				index++
			} else if character == quote {
				quote = 0
			}
		case character == '"' || character == '\'':
			quote = character
		case character == '#':
			return line[:index]
		}
	}
	return line
}

// gitWorktreeRoot is the nearest directory at or above directory with a
// .git entry, or "" outside git.
func gitWorktreeRoot(directory string) string {
	current := filepath.Clean(directory)
	for step := 0; step < 64; step++ {
		if _, err := os.Lstat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
	return ""
}

// gitMetadataLimit bounds .git, HEAD, and commondir reads, like the desktop.
const gitMetadataLimit = 4 << 10

// gitDirectory is the worktree's own git directory: .git itself, or the
// directory a .git file names.
func gitDirectory(worktreeRoot string) (string, bool) {
	entry := filepath.Join(worktreeRoot, ".git")
	info, err := os.Lstat(entry)
	if err != nil {
		return "", false
	}
	if info.IsDir() {
		return entry, true
	}
	raw, ok := readBoundedFile(entry, gitMetadataLimit)
	if !ok {
		return "", false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if len(line) > len("gitdir:") && strings.EqualFold(line[:len("gitdir:")], "gitdir:") {
			target := strings.TrimSpace(line[len("gitdir:"):])
			if !filepath.IsAbs(target) {
				target = filepath.Join(worktreeRoot, target)
			}
			return filepath.Clean(target), true
		}
	}
	return "", false
}

var (
	gitObjectID = regexp.MustCompile(`^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$`)
	gitFullRef  = regexp.MustCompile(`^refs/.+$`)
)

// readBranchContext reads a worktree's HEAD the way the CLI's stack identity
// does: the full ref, or `detached` for a commit.
func readBranchContext(worktreeRoot string) (string, bool) {
	gitDir, ok := gitDirectory(worktreeRoot)
	if !ok {
		return "", false
	}
	raw, ok := readBoundedFile(filepath.Join(gitDir, "HEAD"), gitMetadataLimit)
	if !ok {
		return "", false
	}
	head := strings.TrimSpace(string(raw))
	if ref, symbolic := strings.CutPrefix(head, "ref:"); symbolic {
		ref = strings.TrimSpace(ref)
		return ref, gitFullRef.MatchString(ref)
	}
	if gitObjectID.MatchString(head) {
		return "detached", true
	}
	return "", false
}

// repositoryCheckout is the main checkout of the repository a linked
// worktree belongs to (whose node_modules a worktree may share), or the
// worktree itself for a main checkout.
func repositoryCheckout(worktreeRoot string) string {
	gitDir, ok := gitDirectory(worktreeRoot)
	if !ok {
		return ""
	}
	common := gitDir
	if raw, ok := readBoundedFile(filepath.Join(gitDir, "commondir"), gitMetadataLimit); ok {
		if target := strings.TrimSpace(string(raw)); target != "" {
			if !filepath.IsAbs(target) {
				target = filepath.Join(gitDir, target)
			}
			common = filepath.Clean(target)
		}
	}
	if filepath.Base(common) != ".git" {
		return ""
	}
	return filepath.Dir(common)
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// readBoundedFile reads a regular file of at most limit bytes without
// blocking on a FIFO.
func readBoundedFile(path string, limit int64) ([]byte, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, false
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, false
	}
	return raw, true
}

// withinPath reports whether path is root or inside it, comparing the
// paths as written and with symlinks resolved, so /tmp and /private/tmp
// agree.
func withinPath(root string, path string) bool {
	return within(filepath.Clean(root), filepath.Clean(path)) || within(canonicalPath(root), canonicalPath(path))
}

func within(root string, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, "../") && !filepath.IsAbs(relative)
}

// canonicalPath resolves symlinks in the longest existing prefix of path,
// so a directory a command is about to create still compares correctly.
func canonicalPath(path string) string {
	path = filepath.Clean(path)
	suffix := ""
	for current, step := path, 0; step < 64; step++ {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(resolved, suffix)
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		suffix = filepath.Join(filepath.Base(current), suffix)
		current = parent
	}
	return path
}
