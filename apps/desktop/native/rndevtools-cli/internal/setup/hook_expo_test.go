package setup

import (
	"strings"
	"testing"
)

// steerBlocked checks that each line is declined, with its wanted phrase in
// the reason, on a Mac whose local Supabase is off.
func steerBlocked(t *testing.T, lines map[string]string) {
	t.Helper()
	for line, want := range lines {
		decision := judgeQuietly(line)
		if !decision.Block || !strings.Contains(decision.Reason, want) {
			t.Errorf("%q should be blocked with %q, got %+v", line, want, decision)
		}
	}
}

// steerPassing checks that each line runs, on a Mac whose local Supabase is
// off.
func steerPassing(t *testing.T, lines []string) {
	t.Helper()
	for _, line := range lines {
		if decision := judgeQuietly(line); decision.Block {
			t.Errorf("%q should pass, got %q", line, decision.Reason)
		}
	}
}

func TestHookReadsTheExpoProgramAsExpoCLIDoes(t *testing.T) {
	// Expo CLI's default command is start (@expo/cli build/bin/cli): an expo
	// with no operand, with only options, or with a project directory starts
	// Metro without naming start.
	steerBlocked(t, map[string]string{
		"npx expo":                            "Metro",
		"npx expo --port 8082":                "Metro",
		"npx expo --dev-client":               "Metro",
		"npx expo ./app":                      "Metro",
		"npx expo .":                          "Metro",
		"npx expo -c":                         "Metro",
		"npx expo --clear --ios":              "Metro",
		"npx expo --non-interactive":          "Metro",
		"npx expo whatever":                   "Metro",
		"npx expo --port 8082 start":          "Metro",
		"npx expo -- --port 8082":             "Metro",
		"npx expo@latest --port 8082":         "Metro",
		"npx --yes expo":                      "Metro",
		"pnpm exec expo":                      "Metro",
		"pnpm expo --dev-client":              "Metro",
		"pnpm dlx expo":                       "Metro",
		"yarn expo":                           "Metro",
		"bunx expo":                           "Metro",
		"bun x expo --port 8082":              "Metro",
		"npm exec expo":                       "Metro",
		"npm exec -- expo --dev-client":       "Metro",
		"./node_modules/.bin/expo":            "Metro",
		"node_modules/.bin/expo --dev-client": "Metro",
		"timeout 600 npx expo":                "Metro",
		"nohup npx expo > metro.log 2>&1 &":   "Metro",
		"> metro.log npx expo":                "Metro",
		"CI=1 npx expo":                       "Metro",
		"env CI=1 npx expo --port 8082":       "Metro",
		"sudo -u me npx expo":                 "Metro",
		"exec npx expo":                       "Metro",
		"cd apps/mobile && npx expo":          "Metro",
		// Also in the scripts a command hands on.
		"bash -c 'npx expo --port 8082'":                "Metro",
		"echo 'npx expo' | bash":                        "Metro",
		"concurrently 'npx expo --dev-client' 'tsc -w'": "Metro",
	})
	steerPassing(t, []string{
		// The other subcommands.
		"npx expo install expo-camera",
		"npx expo add expo-image",
		"npx expo prebuild --clean",
		"npx expo export --platform ios",
		"npx expo export:embed",
		"npx expo config --json",
		"npx expo customize metro.config.js",
		"npx expo lint",
		"npx expo login",
		"npx expo whoami",
		"npx expo serve",
		"npx expo run:android",
		"npx expo -- install expo-camera",
		"npx expo --non-interactive install expo-camera",
		// Its version and its help.
		"npx expo --version",
		"npx expo -v",
		"npx expo --help",
		"npx expo -h",
		"npx expo -vh",
		"npx expo install --help",
		// Retired names, which Expo answers with their replacement.
		"npx expo doctor",
		"npx expo upgrade",
		"npx expo eject",
		"npx expo init example-app",
		"npx expo web",
		"npx expo publish",
		"npx expo send",
		// expo as something other than the program a command runs.
		"npx expo-doctor",
		"npx create-expo-app example-app",
		"pnpm add expo",
		"yarn add expo@~57.0.0",
		"npm install expo",
		"pnpm --filter mobile add expo",
		"cd expo",
		"ls node_modules/expo",
		"mkdir -p expo",
		"git add expo",
		"command -v expo",
		"which expo",
		"type expo",
		"grep -rn expo src",
		`git commit -m "document npx expo --port"`,
	})
}

func TestHookBlocksExpoRunIOSThatStartsItsOwnMetro(t *testing.T) {
	// expo run:ios starts Metro (8081 unless --port names another) unless
	// --no-bundler is given, and an explicit --configuration Debug starts it
	// even then (@expo/cli build/src/run/ios/options/resolveOptions.js).
	udid := "727CE7B2-CCBA-47A5-8803-1D61DCEBCF44"
	for _, line := range []string{
		"npx expo run:ios",
		"npx expo run:ios --device " + udid,
		"npx expo run:ios -d " + udid,
		"npx expo run:ios --port 8101",
		"npx expo run:ios --configuration Release",
		"npx expo run:ios --no-bundler --configuration Debug",
		"npx expo run:ios --configuration=Debug --no-bundler",
		"npx expo run:ios --no-bundler --configuration Release --configuration Debug",
		"npx expo run:ios --device --no-bundler --configuration Debug",
		"npx expo run ios",
		"npx expo run ios --no-bundler --configuration Debug",
		"yarn expo run:ios",
		"pnpm exec expo run:ios --device " + udid,
		"bash -c 'npx expo run:ios'",
	} {
		decision := judgeQuietly(line)
		for _, want := range []string{
			"Blocked `expo run:ios`", "`--no-bundler`", "`--configuration Debug`",
			"`rndevtools native --operation plan --worktree <app directory> --udid <UDID>`",
			"`rndevtools native --operation install --worktree <app directory> --udid <UDID>`",
			"`rndevtools lane --operation up --worktree <app directory> --launch=false`",
			// The build native plan gives names no port: Expo CLI refuses
			// --port with --no-bundler, and the restart re-points the app.
			"`npx expo run:ios --device <UDID> --no-bundler`",
			"add no `--port`: Expo CLI refuses it with `--no-bundler`",
			// The launch after the build is the one the plan quotes: with
			// restart only for a lane that has a bundle identifier, and with
			// the dev client's full URL for a lane that has no scheme.
			"run the launch the plan quotes, exactly as quoted",
			"`rndevtools lane --operation launch --worktree <app directory> --restart`",
			"Only a lane started with an `ios.bundleIdentifier` in `app.json` takes `--restart`",
			"the plan leaves the flag out and says how to quit the app first",
			"A lane started without a `scheme` in `app.json` opens its dev client only by its full URL",
			"`--url '<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<port>&disableOnboarding=1&disableAutoLaunch=1'`",
		} {
			if !decision.Block || !strings.Contains(decision.Reason, want) {
				t.Errorf("%q should be blocked with %q, got %+v", line, want, decision)
			}
		}
	}
	steerPassing(t, []string{
		// Builds that start no Metro, as native plan recommends them.
		"npx expo run:ios --device " + udid + " --no-bundler",
		"npx expo run:ios --configuration Release --device " + udid + " --no-bundler",
		"npx expo run:ios --no-bundler",
		// Expo CLI refuses --port with --no-bundler before it starts anything.
		"npx expo run:ios --device " + udid + " --port 8101 --no-bundler",
		"npx expo run:ios --no-bundler --configuration Debug --configuration Release",
		// Expo compares the configuration with Debug exactly.
		"npx expo run:ios --no-bundler --configuration debug",
		"npx expo run:ios --device --no-bundler",
		"npx expo run ios --no-bundler",
		// A build-only generic device and the help start no Metro.
		"npx expo run:ios --configuration Release --device generic --output ./build",
		"npx expo run:ios --device=generic",
		"npx expo run:ios --help",
		"npx expo run:ios -h",
		"npx expo run ios --help",
		// run takes its platform from its first argument only, and Android has
		// no lane to go to.
		"npx expo run",
		"npx expo run --no-bundler ios",
		"npx expo run android",
		"npx expo run:android --device emulator-5554",
	})
}

func TestExpoCommandReadsTheGlobalsAsExpoCLIDoes(t *testing.T) {
	// The globals are --version, --help, --non-interactive, -v, and -h, read
	// with arg in permissive mode: a cluster of letters splits (-xv is -x and
	// -v), any other option stays among the operands, and the first operand
	// names the command when it is one.
	for _, row := range []struct {
		arguments string
		command   string
		rest      []string
		runs      bool
	}{
		{"", "start", []string{}, true},
		{"--port 8082", "start", []string{"--port", "8082"}, true},
		{"--port=8082 start", "start", []string{"--port=8082", "start"}, true},
		{"-xy ./app", "start", []string{"-x", "-y", "./app"}, true},
		{"--non-interactive install expo-camera", "install", []string{"expo-camera"}, true},
		{"-- install", "install", []string{}, true},
		{"-- --version", "start", []string{"--version"}, true},
		{"run:ios --no-bundler", "run:ios", []string{"--no-bundler"}, true},
		{"run ios --configuration=Debug", "run", []string{"ios", "--configuration=Debug"}, true},
		{"start --version", "", nil, false},
		{"-xv", "", nil, false},
		{"--help=1", "", nil, false},
		{"doctor", "", nil, false},
		{"send", "", nil, false},
	} {
		command, rest, runs := expoCommand(strings.Fields(row.arguments))
		if command != row.command || runs != row.runs || strings.Join(rest, " ") != strings.Join(row.rest, " ") || (rest == nil) != (row.rest == nil) {
			t.Errorf("expoCommand(%q) = %q %q %v, want %q %q %v", row.arguments, command, rest, runs, row.command, row.rest, row.runs)
		}
	}
	for _, row := range []struct {
		arguments string
		want      bool
	}{
		{"", true},
		{"--no-bundler", false},
		{"--no-bundler=false", false},
		{"--no-bundler --configuration Debug", true},
		{"--no-bundler --configuration=Debug", true},
		{"--no-bundler --configuration Debug --configuration Release", false},
		{"--device generic", false},
		{"-d=generic", false},
		{"--device --no-bundler", false},
		{"--help", false},
		{"--port 8101", true},
	} {
		if got := runIOSStartsMetro(strings.Fields(row.arguments)); got != row.want {
			t.Errorf("runIOSStartsMetro(%q) = %v, want %v", row.arguments, got, row.want)
		}
	}
}
