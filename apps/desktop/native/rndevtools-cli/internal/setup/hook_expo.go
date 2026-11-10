package setup

import "strings"

// Expo CLI. The word rules read the arguments of the expo program a command
// runs the way Expo CLI reads them, because its default command is start:
// `npx expo`, `npx expo --port 8082`, `npx expo --dev-client`, and
// `npx expo ./app` all start Metro, and none of them names start. The lists
// and the parsing follow @expo/cli 57 (build/bin/cli, which reads its globals
// with arg in permissive mode, and build/src/run/ios for run:ios).

var (
	// expoCommands are Expo CLI's subcommands. Only start runs Metro by
	// itself; run:ios, and run with the ios platform, start one too unless
	// told not to (see runIOSStartsMetro).
	expoCommands = names("run", "run:ios", "run:android", "start", "prebuild", "config", "export", "export:web",
		"export:embed", "serve", "install", "add", "customize", "lint", "login", "logout", "register", "whoami")
	// expoRetiredCommands are the names Expo CLI answers with a pointer to
	// their replacement, exiting 1 without running anything (its migrationMap
	// and its deprecated commands). Any other first operand is a project
	// directory for start.
	expoRetiredCommands = names("init", "eject", "web", "start:web", "build:ios", "build:android",
		"client:install:ios", "client:install:android", "doctor", "upgrade", "customize:web", "publish",
		"publish:set", "publish:rollback", "publish:history", "publish:details", "build:web",
		"credentials:manager", "fetch:ios:certs", "fetch:android:keystore", "fetch:android:hashes",
		"fetch:android:upload-cert", "push:android:upload", "push:android:show", "push:android:clear", "url",
		"url:ipa", "url:apk", "webhooks", "webhooks:add", "webhooks:remove", "webhooks:update",
		"build:status", "upload:android", "upload:ios", "send", "client:ios")
)

// expoProgramArguments are the arguments the expo program of a segment gets,
// when expo is the program the segment runs past its launchers and package
// runners (npx expo, pnpm exec expo, timeout 60 yarn expo,
// ./node_modules/.bin/expo), its redirections set aside. ok is false for any
// other program: in `cd expo` or `pnpm add expo` the word names a directory
// or a package.
func expoProgramArguments(segment shellSegment) (arguments []string, ok bool) {
	words := skipPrefixWords(segment.io().words)
	run := launchOf(words)
	if run.program < 0 || commandName(words[run.program]) != "expo" {
		return nil, false
	}
	return words[run.program+1:], true
}

// expoCommand is the command Expo CLI runs for arguments, and the arguments
// that command gets. runs is false when it only prints its version or its
// help (--version, -v, --help, -h anywhere before --, also in a cluster such
// as -vh), or answers a retired name. Its own globals are taken out; any
// other option stays where it is, among the operands, so that the first of
// those decides: a subcommand, else start, with all of them as its
// arguments. That is why `expo --port 8082 start` starts Metro too.
func expoCommand(arguments []string) (command string, rest []string, runs bool) {
	operands := make([]string, 0, len(arguments))
	for index, argument := range arguments {
		if argument == "--" {
			operands = append(operands, arguments[index+1:]...)
			break
		}
		if len(argument) < 2 || argument[0] != '-' {
			operands = append(operands, argument)
			continue
		}
		parts := []string{argument}
		if argument[1] != '-' && len(argument) > 2 {
			// A cluster of single letters: -vh is -v and -h.
			parts = parts[:0]
			for _, letter := range argument[1:] {
				parts = append(parts, "-"+string(letter))
			}
		}
		for _, part := range parts {
			name := part
			if strings.HasPrefix(part, "--") {
				name, _, _ = strings.Cut(part, "=")
			}
			switch name {
			case "--version", "-v", "--help", "-h":
				return "", nil, false
			case "--non-interactive":
			default:
				operands = append(operands, part)
			}
		}
	}
	switch {
	case len(operands) > 0 && expoCommands[operands[0]]:
		return operands[0], operands[1:], true
	case len(operands) > 0 && expoRetiredCommands[operands[0]]:
		return "", nil, false
	}
	return "start", operands, true
}

// expoDecision judges what Expo CLI does with arguments: start declines the
// line, and so does run:ios (or run ios) when it would start its own Metro.
func expoDecision(arguments []string) HookDecision {
	command, rest, runs := expoCommand(arguments)
	switch {
	case !runs:
	case command == "start":
		return metroDecision()
	case command == "run:ios" && runIOSStartsMetro(rest):
		return runIOSDecision()
	case command == "run" && len(rest) > 0 && rest[0] == "ios" && runIOSStartsMetro(rest[1:]):
		// expo run takes its platform from its first argument only.
		return runIOSDecision()
	}
	return HookDecision{}
}

// runIOSValues are the run:ios options whose value the rules read.
var runIOSValues = names("--configuration", "--device", "-d")

// runIOSStartsMetro reports whether `expo run:ios` with arguments starts its
// own Metro: it does unless --no-bundler is given, and even with it when
// --configuration Debug is passed (resolveOptions.js starts the bundler for an
// explicit Debug, whatever --no-bundler says), but never for --help or for a
// build-only --device generic, which returns before the bundler starts. A
// value is the word after its option, or after = (--configuration=Debug),
// unless that word is an option itself; the last one counts.
func runIOSStartsMetro(arguments []string) bool {
	noBundler, debug, generic := false, false, false
	for index := 0; index < len(arguments); index++ {
		name, value, inline := strings.Cut(arguments[index], "=")
		if !inline && runIOSValues[name] && index+1 < len(arguments) && !strings.HasPrefix(arguments[index+1], "-") {
			index++
			value = arguments[index]
		}
		switch name {
		case "--help", "-h":
			return false
		case "--no-bundler":
			noBundler = true
		case "--configuration":
			debug = value == "Debug"
		case "--device", "-d":
			generic = value == "generic"
		}
	}
	return !generic && (!noBundler || debug)
}

// runIOSDecision steers an `expo run:ios` that would start Metro to the
// native plan, which says whether a build is needed at all and gives the
// build command for the lane, and to a restart on the lane afterward: the
// build names no port, since Expo CLI refuses --port with --no-bundler, and
// opens the app against 8081 as soon as it installs it.
func runIOSDecision() HookDecision {
	return HookDecision{
		Block: true,
		Reason: "Blocked `expo run:ios`: unless `--no-bundler` is given it starts its own Metro on a port other agents share " +
			"(8081 unless `--port` names another), and `--configuration Debug` starts one even with `--no-bundler`. Ask RN Devtools first: " +
			"`rndevtools native --operation plan --worktree " + appDirectory + " --udid <UDID>` says whether this native build is installed, cached, or must be built, " +
			"and `rndevtools native --operation install --worktree " + appDirectory + " --udid <UDID>` installs a cached build in seconds. " +
			"When it must be built, reserve the lane with `rndevtools lane --operation up --worktree " + appDirectory + " --launch=false` " +
			"and run `rndevtools native --operation plan` again: once the lane's Metro is ready it gives the build, `npx expo run:ios --device <UDID> --no-bundler` " +
			"(add no `--port`: Expo CLI refuses it with `--no-bundler`; and leave out `--configuration Debug`: Debug is the default). " +
			"The build opens the app against port 8081, so after it run `rndevtools lane --operation launch --worktree " + appDirectory + " --restart`, " +
			"which starts the app fresh with the lane's Metro alone.",
	}
}
