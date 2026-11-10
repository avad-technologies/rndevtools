package setup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Package scripts. `npm start`, `yarn run ios`, and `yarn ios` run a script
// from the nearest package.json, and in an Expo app that script is often
// `expo start`, a bare `expo`, or `expo run:ios`: Metro on a shared port,
// which neither the text rule nor the word rules see in the line itself.
// packageRules reads the script and judges it as a line of its own, from the
// directory of its package.json, with the Simulator rules and with these
// rules again (a script may run another). Like the other rules they fail
// open: a command in a directory the hook cannot place or under a workspace
// option it cannot resolve, a package.json it cannot read, and a script it
// does not find all run.

const (
	// maxManifestBytes bounds a package.json read.
	maxManifestBytes = 256 << 10
	// maxManifestLookups bounds the directories one call looks a package.json
	// up from; each costs up to 64 stats and a read.
	maxManifestLookups = 16
)

// packageManagerOptions is how a package manager reads its own words around
// the script it runs.
type packageManagerOptions struct {
	// values take the next word as their value unless written --name=value.
	values map[string]bool
	// chdir run the script as if from the directory they name.
	chdir map[string]bool
	// workspaces pick other packages of a workspace by name or pattern, which
	// the rules cannot place.
	workspaces map[string]bool
	// run are the commands that name the script to run; start is one too.
	run map[string]bool
	// own, when set, are the manager's own commands: it runs a script named
	// without run (yarn ios, pnpm dev) by any other name.
	own map[string]bool
	// npm reads its own options anywhere before --, and hands the script only
	// its operands and what follows --. The others hand it every word after
	// its name.
	npm bool
}

var packageManagers = map[string]packageManagerOptions{
	"npm": {
		values:     names("--prefix", "-C", "-w", "--workspace", "--loglevel", "--userconfig", "--cache", "--registry"),
		chdir:      names("--prefix", "-C"),
		workspaces: names("-w", "--workspace", "--workspaces", "-ws"),
		run:        names("run", "run-script", "rum", "urn"),
		npm:        true,
	},
	"pnpm": {
		values:     names("-C", "--dir", "-F", "--filter", "--filter-prod", "--loglevel", "--reporter"),
		chdir:      names("-C", "--dir"),
		workspaces: names("-F", "--filter", "--filter-prod", "-r", "--recursive", "-w", "--workspace-root"),
		run:        names("run", "run-script"),
		// The commands pnpm 11 registers (lib/cmd/index.js, with their aliases
		// and the ones it names as not implemented). Its parseCliArgs runs any
		// other name as `pnpm run <name>` (fallbackCommand: "run").
		own: names("access", "add", "adduser", "approve-builds", "audit", "bin", "bugs", "c", "cache",
			"cat-file", "cat-index", "change", "ci", "clean", "clean-install", "completion", "completion-server",
			"config", "create", "dedupe", "deploy", "deprecate", "dislink", "dist-tag", "dist-tags", "dlx",
			"docs", "doctor", "edit", "env", "exec", "fetch", "find", "find-hash", "get", "help", "home", "i",
			"ic", "ignored-builds", "import", "info", "init", "install", "install-clean", "install-test",
			"issues", "it", "la", "lane", "licenses", "link", "list", "ll", "ln", "login", "logout", "ls", "m",
			"multi", "outdated", "owner", "owners", "pack", "pack-app", "patch", "patch-commit", "patch-remove",
			"peers", "ping", "pkg", "prefix", "profile", "prune", "publish", "purge", "rb", "rebuild",
			"recursive", "remove", "repo", "restart", "rm", "root", "rt", "run", "run-script", "runtime", "s",
			"sbom", "se", "search", "self-update", "set", "set-script", "setup", "show", "ss", "stage", "star",
			"stars", "store", "team", "token", "un", "undeprecate", "uni", "uninstall", "unlink", "unpublish",
			"unstar", "up", "update", "upgrade", "v", "version", "view", "whoami", "why", "with", "xmas"),
	},
	"yarn": {
		values: names("--cwd"),
		chdir:  names("--cwd"),
		run:    names("run"),
		// Yarn's own commands, Classic (1.x) and Berry (2 and later)
		// together. Yarn runs any other name as the script of that name.
		own: names("access", "add", "audit", "autoclean", "bin", "cache", "check", "config", "constraints",
			"create", "dedupe", "dlx", "exec", "explain", "generate-lock-entry", "global", "help", "import",
			"info", "init", "install", "licenses", "link", "list", "login", "logout", "node", "npm",
			"outdated", "owner", "pack", "patch", "patch-commit", "plugin", "policies", "publish", "rebuild",
			"remove", "run", "search", "set", "stage", "tag", "team", "unlink", "unplug", "up", "upgrade",
			"upgrade-interactive", "version", "versions", "why", "workspace", "workspaces"),
	},
	"bun": {
		values:     names("--cwd", "-F", "--filter"),
		chdir:      names("--cwd"),
		workspaces: names("-F", "--filter"),
		run:        names("run"),
	},
}

// packageScript is a command that runs a package script.
type packageScript struct {
	// name is the script, and arguments what the manager hands on to it.
	name      string
	arguments []string
	// chdir is the directory a chdir option names, "" for none.
	chdir string
	// command is the command as written, bounded, for a reason.
	command string
}

// withoutRedirections drops the redirections from a command's words: each
// operator, and the word after it when the operator holds no target.
func withoutRedirections(words []string) []string {
	kept := make([]string, 0, len(words))
	for index := 0; index < len(words); index++ {
		_, _, target, ok := splitRedirection(words[index])
		switch {
		case !ok:
			kept = append(kept, words[index])
		case target == "":
			index++
		}
	}
	return kept
}

// parsePackageScript reads a command's words for the package script it runs:
// npm, pnpm, yarn, or bun with start, or with a run command and the script's
// name (npm run ios, pnpm --dir app run start, yarn --cwd app start, bun run
// start), or yarn or pnpm with a script named without run (yarn ios, pnpm
// dev) that is none of their own commands, behind the launchers that only run
// their operand (timeout 60, env FOO=1), redirections aside. Other forms are
// not read: a workspace filter, npm test, and bun with a script named without
// run, whose rules for it the hook does not model.
func parsePackageScript(words []string) (packageScript, bool) {
	words = skipPrefixWords(withoutRedirections(words))
	at := 0
	for at < len(words) {
		options, isLauncher := launchers[commandName(words[at])]
		if !isLauncher {
			break
		}
		skipped := options.skip(words, at+1)
		if !skipped.runs {
			return packageScript{}, false
		}
		at = skipped.next
	}
	if at >= len(words) {
		return packageScript{}, false
	}
	manager, known := packageManagers[baseName(words[at])]
	if !known {
		return packageScript{}, false
	}
	invocation := packageScript{command: displayText(strings.Join(words[at:], " "), 80)}
	rest := words[at+1:]
	// options reads the manager's options off the front of rest; it is false
	// for a workspace option.
	options := func() bool {
		for len(rest) > 0 && len(rest[0]) > 1 && rest[0][0] == '-' && rest[0] != "--" {
			name, value, inline := strings.Cut(rest[0], "=")
			if manager.workspaces[name] {
				return false
			}
			if !inline && manager.values[name] && len(rest) > 1 {
				value, rest = rest[1], rest[1:]
			}
			if manager.chdir[name] {
				invocation.chdir = value
			}
			rest = rest[1:]
		}
		return true
	}
	if !options() || len(rest) == 0 {
		return packageScript{}, false
	}
	switch {
	case rest[0] == "start":
		invocation.name, rest = "start", rest[1:]
	case manager.run[rest[0]]:
		rest = rest[1:]
		if !options() || len(rest) == 0 || rest[0] == "--" {
			return packageScript{}, false
		}
		invocation.name, rest = rest[0], rest[1:]
	case manager.own != nil && !manager.own[rest[0]] && !strings.HasPrefix(rest[0], "-"):
		// A script named without run, which the manager hands its arguments
		// as run would.
		invocation.name, rest = rest[0], rest[1:]
	default:
		return packageScript{}, false
	}
	if !manager.npm {
		if len(rest) > 0 && rest[0] == "--" {
			rest = rest[1:]
		}
		invocation.arguments = rest
		return invocation, true
	}
	for index := 0; index < len(rest); index++ {
		word := rest[index]
		if word == "--" {
			invocation.arguments = append(invocation.arguments, rest[index+1:]...)
			break
		}
		if !strings.HasPrefix(word, "-") {
			invocation.arguments = append(invocation.arguments, word)
			continue
		}
		name, value, inline := strings.Cut(word, "=")
		if manager.workspaces[name] {
			return packageScript{}, false
		}
		if !inline && manager.values[name] && index+1 < len(rest) {
			index++
			value = rest[index]
		}
		if manager.chdir[name] {
			invocation.chdir = value
		}
	}
	return invocation, true
}

// packageRules judges the package scripts a line runs, each from the
// directory it runs in. It looks a package.json up once for each directory,
// and from at most maxManifestLookups directories in a call.
type packageRules struct {
	home      func() string
	homeCache *string
	manifests map[string]*packageManifest
	lookups   int
	nesting   int
	// scripts meters what these rules follow, the scripts a line hands on and
	// the package scripts it runs; simulator meters the scripts the Simulator
	// rules follow inside package scripts.
	scripts, simulator scriptLedger
}

func (rules *packageRules) homeDirectory() string {
	if rules.homeCache == nil {
		home := ""
		if rules.home != nil {
			home = rules.home()
		}
		rules.homeCache = &home
	}
	return *rules.homeCache
}

func (rules *packageRules) judge(line shellLine, cwd string) HookDecision {
	return walkDirectories(line, cwd, rules.homeDirectory, func(index int, directory string) HookDecision {
		return rules.judgeSegment(line, index, directory)
	})
}

func (rules *packageRules) judgeSegment(line shellLine, index int, directory string) HookDecision {
	if !rules.scripts.exhausted() {
		for _, script := range handedScripts(line, index) {
			if decision := rules.follow(line, script, directory, false); decision.Block {
				return decision
			}
		}
	}
	invocation, ok := parsePackageScript(line.segments[index].words)
	if !ok {
		return HookDecision{}
	}
	runs := directory
	if invocation.chdir != "" {
		runs = resolveDirectory(directory, invocation.chdir, rules.homeDirectory)
	}
	manifest := rules.manifest(runs)
	if manifest == nil {
		return HookDecision{}
	}
	script, found := manifest.scripts[invocation.name]
	if !found {
		return HookDecision{}
	}
	text := script
	if len(invocation.arguments) > 0 {
		text += " " + shellJoin(invocation.arguments)
	}
	decision := rules.follow(line, handedScript{text: text}, manifest.directory, true)
	if !decision.Block {
		return HookDecision{}
	}
	// The script's reason names the app's directory, which is the package's.
	reason := strings.ReplaceAll(decision.Reason, appDirectory, shellQuote(displayPath(manifest.directory)))
	return blocked(fmt.Sprintf("`%s` runs the `%s` script of %s: `%s`. %s",
		invocation.command, displayText(invocation.name, 64), displayPath(manifest.path), displayText(script, 160), reason))
}

// follow judges a script as a line of its own, from directory: one the line
// hands on with these rules, and a package script with the Simulator rules
// as well, which judged every other script already.
func (rules *packageRules) follow(line shellLine, script handedScript, directory string, packaged bool) HookDecision {
	if rules.nesting >= maxNestedScripts || !rules.scripts.follow(script, directory, rules.nesting) {
		return HookDecision{}
	}
	rules.nesting++
	defer func() { rules.nesting-- }()
	parsed := line.parseScript(script.text)
	if packaged {
		if decision := judgeSimulatorRules(parsed, rules.nesting, &rules.simulator); decision.Block {
			return decision
		}
	}
	return rules.judge(parsed, directory)
}

// packageManifest is a package.json the rules read: where it is, and its
// scripts.
type packageManifest struct {
	path, directory string
	scripts         map[string]string
}

// manifest is the package.json nearest to directory, nil when there is none
// the rules can read or the directory is unknown.
func (rules *packageRules) manifest(directory string) *packageManifest {
	if directory == "" {
		return nil
	}
	if manifest, known := rules.manifests[directory]; known {
		return manifest
	}
	if rules.lookups >= maxManifestLookups {
		return nil
	}
	rules.lookups++
	manifest := nearestManifest(directory)
	if rules.manifests == nil {
		rules.manifests = map[string]*packageManifest{}
	}
	rules.manifests[directory] = manifest
	return manifest
}

// nearestManifest reads the package.json at or above directory, the nearest
// one, as the package managers find it. One that is not a regular file of at
// most maxManifestBytes, or does not parse, ends the search with nothing; a
// script that is not a string is left out.
func nearestManifest(directory string) *packageManifest {
	current := filepath.Clean(directory)
	for step := 0; step < 64; step++ {
		path := filepath.Join(current, "package.json")
		if _, err := os.Stat(path); err == nil {
			raw, ok := readBoundedFile(path, maxManifestBytes)
			if !ok {
				return nil
			}
			var document struct {
				Scripts map[string]json.RawMessage `json:"scripts"`
			}
			if json.Unmarshal(raw, &document) != nil {
				return nil
			}
			manifest := &packageManifest{path: path, directory: current, scripts: map[string]string{}}
			for name, value := range document.Scripts {
				var text string
				if json.Unmarshal(value, &text) == nil {
					manifest.scripts[name] = text
				}
			}
			return manifest
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
	return nil
}

// namesPackageManager reports whether a line, its quotes, backslashes, and
// line breaks aside, names npm, yarn, or bun (pnpm has npm in it). The package
// rules read files, so they run only for a line that may need them, and every
// script a line hands on is made of its text.
func namesPackageManager(source string) bool {
	plain := strings.NewReplacer(`'`, "", `"`, "", `\`, "", "\n", "").Replace(source)
	return strings.Contains(plain, "npm") || strings.Contains(plain, "yarn") || strings.Contains(plain, "bun")
}

// quotable reports whether a reason may quote character from text that the
// repository or the command line controls: a graphic character (a letter,
// mark, number, punctuation, symbol, or space), except the backtick that
// quotes it there. Controls, format characters (bidi controls, zero-width
// marks, tag characters), line and paragraph separators, and private-use or
// unassigned characters can make quoted text read as something else, to the
// model and to a person.
func quotable(character rune) bool {
	return character != '`' && unicode.IsGraphic(character)
}

// displayText bounds text to limit bytes for a reason, at a whole character,
// and keeps only what is quotable.
func displayText(text string, limit int) string {
	var builder strings.Builder
	for _, character := range text {
		if !quotable(character) {
			continue
		}
		if builder.Len()+utf8.RuneLen(character) > limit {
			builder.WriteString("…")
			break
		}
		builder.WriteRune(character)
	}
	return builder.String()
}
