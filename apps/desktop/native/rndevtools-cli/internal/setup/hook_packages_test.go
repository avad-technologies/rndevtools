package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// packageFixture is a Mac with an Expo app (app, with a src directory
// inside), and packages whose start script is not Metro (plain), cannot be
// read (broken, big), or runs through a workspace filter (workspace), and a
// directory with no package.json above it (none).
type packageFixture struct {
	app, src, plain, broken, big, workspace, none string
}

func newPackageFixture(t *testing.T) packageFixture {
	t.Helper()
	base := t.TempDir()
	fixture := packageFixture{
		app:       filepath.Join(base, "app"),
		src:       filepath.Join(base, "app", "src"),
		plain:     filepath.Join(base, "plain"),
		broken:    filepath.Join(base, "broken"),
		big:       filepath.Join(base, "big"),
		workspace: filepath.Join(base, "workspace"),
		none:      filepath.Join(base, "none"),
	}
	write(t, filepath.Join(fixture.app, "package.json"), `{"name":"example-app","scripts":{`+
		`"start":"expo start","dev":"expo --dev-client","bare":"expo","web":"expo start --web",`+
		`"rn":"react-native start","ios":"expo run:ios","build:ios":"expo run:ios --no-bundler",`+
		`"chain":"npm run dev","loop":"npm run loop","lint":"eslint .","test":"jest",`+
		`"install-deps":"expo install","add":"expo start","count":3}}`)
	write(t, filepath.Join(fixture.src, "index.ts"), "")
	write(t, filepath.Join(fixture.plain, "package.json"), `{"scripts":{"start":"node server.js"}}`)
	write(t, filepath.Join(fixture.broken, "package.json"), `{"scripts":{"start":"expo start"`)
	write(t, filepath.Join(fixture.big, "package.json"), `{"scripts":{"start":"expo start"},"pad":"`+strings.Repeat("x", 256<<10)+`"}`)
	write(t, filepath.Join(fixture.workspace, "package.json"), `{"scripts":{"start":"pnpm --filter mobile start"}}`)
	if err := os.MkdirAll(fixture.none, 0o755); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// judgeIn applies the steering rules to command run from cwd, on a Mac whose
// local Supabase is off.
func judgeIn(cwd string, command string) HookDecision {
	return evaluateShellCallWith(shellCall{command: command, cwd: cwd}, quietSupabaseEnvironment())
}

func TestHookReadsThePackageScriptsALineRuns(t *testing.T) {
	// In an Expo app `npm start` is often `expo start`, a bare `expo`, or
	// `expo run:ios`: Metro on a shared port, which the line itself never
	// names.
	fixture := newPackageFixture(t)
	manifest := filepath.Join(fixture.app, "package.json")
	lane := "`rndevtools lane --operation up --worktree " + fixture.app + "`"
	metro := []string{"Blocked starting Metro by hand", lane}
	for _, row := range []struct {
		cwd, command string
		wants        []string
	}{
		{fixture.app, "npm start", append([]string{"`npm start` runs the `start` script of " + manifest + ": `expo start`."}, metro...)},
		{fixture.app, "npm run start", metro},
		{fixture.app, "npm run-script start", metro},
		{fixture.app, "npm run start -- --port 8082", metro},
		{fixture.app, "pnpm start", metro},
		{fixture.app, "pnpm run start", metro},
		{fixture.app, "yarn start", metro},
		{fixture.app, "yarn run start", metro},
		{fixture.app, "bun start", metro},
		{fixture.app, "bun run start", metro},
		{fixture.app, "n''pm start", metro},
		{fixture.app, "npm run dev", append([]string{"`npm run dev` runs the `dev` script of " + manifest + ": `expo --dev-client`."}, metro...)},
		{fixture.app, "npm run bare", metro},
		{fixture.app, "npm run web", metro},
		{fixture.app, "npm run rn", metro},
		{fixture.app, "npm run ios", []string{"`npm run ios` runs the `ios` script", "Blocked `expo run:ios`", "`rndevtools native --operation plan --worktree " + fixture.app + " --udid <UDID>`"}},
		{fixture.app, "npm run ios -- --device X", []string{"Blocked `expo run:ios`"}},
		// yarn and pnpm run a script named without run, unless the name is one
		// of their own commands.
		{fixture.app, "yarn ios", []string{"`yarn ios` runs the `ios` script of " + manifest + ": `expo run:ios`.", "Blocked `expo run:ios`"}},
		{fixture.app, "pnpm ios", []string{"`pnpm ios` runs the `ios` script", "Blocked `expo run:ios`"}},
		{fixture.app, "yarn ios --device X", []string{"Blocked `expo run:ios`"}},
		{fixture.app, "yarn dev", metro},
		{fixture.app, "pnpm dev", metro},
		{fixture.app, "pnpm bare", metro},
		{fixture.src, "yarn web", metro},
		{fixture.plain, "yarn --cwd " + fixture.app + " ios", []string{"Blocked `expo run:ios`"}},
		{fixture.plain, "pnpm -C " + fixture.app + " dev", metro},
		{fixture.app, "timeout 600 pnpm dev", metro},
		// A script that runs another is followed into it.
		{fixture.app, "npm run chain", []string{"`npm run chain` runs the `chain` script", "`npm run dev` runs the `dev` script", "Blocked starting Metro by hand"}},
		// The nearest package.json, from wherever the command runs.
		{fixture.src, "npm start", metro},
		{fixture.plain, "cd " + fixture.app + " && npm start", metro},
		{fixture.plain, "cd " + fixture.src + " && pnpm start", metro},
		{fixture.plain, "npm --prefix " + fixture.app + " start", metro},
		{fixture.plain, "npm -C " + fixture.app + " run start", metro},
		{fixture.plain, "npm start --prefix " + fixture.app, metro},
		{fixture.plain, "pnpm -C " + fixture.app + " start", metro},
		{fixture.plain, "pnpm --dir=" + fixture.app + " run start", metro},
		{fixture.plain, "yarn --cwd " + fixture.app + " start", metro},
		{fixture.plain, "bun --cwd " + fixture.app + " run start", metro},
		{fixture.src, "pnpm -C .. start", metro},
		// Behind launchers, and in the scripts a command hands on.
		{fixture.app, "timeout 600 npm start", metro},
		{fixture.app, "nohup npm start > metro.log 2>&1 &", metro},
		{fixture.app, "CI=1 npm start", metro},
		{fixture.app, "env CI=1 npm start", metro},
		{fixture.app, "sudo -u me npm start", metro},
		{fixture.app, "bash -c 'npm start'", metro},
		{fixture.app, "echo 'npm run ios' | bash", []string{"Blocked `expo run:ios`"}},
		{fixture.plain, "bash -c 'cd " + fixture.app + " && yarn start'", metro},
	} {
		decision := judgeIn(row.cwd, row.command)
		if !decision.Block {
			t.Errorf("%q (in %s) should be blocked", row.command, row.cwd)
			continue
		}
		for _, want := range row.wants {
			if !strings.Contains(decision.Reason, want) {
				t.Errorf("%q (in %s): reason %q lacks %q", row.command, row.cwd, decision.Reason, want)
			}
		}
	}
	for _, row := range []struct{ cwd, command string }{
		// Scripts that start no Metro, or none at all.
		{fixture.app, "npm run build:ios"},
		{fixture.app, "npm run ios -- --no-bundler"},
		{fixture.app, "pnpm run ios --no-bundler"},
		{fixture.app, "npm run ios -- --help"},
		{fixture.app, "npm run lint"},
		{fixture.app, "npm test"},
		{fixture.app, "pnpm test"},
		{fixture.app, "npm run install-deps"},
		{fixture.app, "npm run"},
		{fixture.app, "npm run missing"},
		{fixture.app, "npm run count"},
		// A script that runs itself is followed only so deep.
		{fixture.app, "npm run loop"},
		// Workspaces the rule cannot place.
		{fixture.app, "pnpm --filter mobile start"},
		{fixture.app, "pnpm -r run start"},
		{fixture.app, "pnpm -w start"},
		{fixture.app, "npm -w mobile start"},
		{fixture.app, "npm start --workspace=mobile"},
		{fixture.app, "npm run start --workspaces"},
		{fixture.app, "yarn workspace mobile start"},
		{fixture.app, "bun run --filter mobile start"},
		{fixture.app, "pnpm -r ios"},
		// A manager's own command runs, not a script of that name; npm runs no
		// script named without run, and bun's way of doing so is not read.
		{fixture.app, "yarn add expo"},
		{fixture.app, "pnpm add expo"},
		{fixture.app, "yarn install"},
		{fixture.app, "pnpm install"},
		{fixture.app, "npm ios"},
		{fixture.app, "bun ios"},
		// A script named without run that starts no Metro, or none at all.
		{fixture.app, "yarn ios --no-bundler"},
		{fixture.app, "pnpm lint"},
		{fixture.app, "yarn missing"},
		{fixture.app, "pnpm count"},
		// Mentions, and RN Devtools' own CLI.
		{fixture.app, "echo 'npm start'"},
		{fixture.app, "git commit -m 'npm start runs expo start'"},
		{fixture.app, "rndevtools lane --operation up --worktree . --udid X --note 'npm start'"},
		// A package.json that is not Metro's, or that the rule cannot read.
		{fixture.plain, "npm start"},
		{fixture.broken, "npm start"},
		{fixture.big, "npm start"},
		{fixture.workspace, "npm start"},
		{fixture.none, "npm start"},
		// A directory the rule cannot place.
		{"", "npm start"},
		{"app", "npm start"},
		{fixture.plain, "cd $APP && npm start"},
		{fixture.plain, "cd " + fixture.app + " | npm start"},
	} {
		if decision := judgeIn(row.cwd, row.command); decision.Block {
			t.Errorf("%q (in %s) should pass, got %q", row.command, row.cwd, decision.Reason)
		}
	}
}

func TestParsePackageScriptReadsTheManagersOwnWords(t *testing.T) {
	for _, row := range []struct {
		command   string
		name      string
		arguments []string
		chdir     string
	}{
		{"npm start", "start", nil, ""},
		{"npm run ios", "ios", nil, ""},
		{"npm run-script ios", "ios", nil, ""},
		{"npm --prefix app start", "start", nil, "app"},
		{"npm -C app run start", "start", nil, "app"},
		{"npm start --prefix=app", "start", nil, "app"},
		{"npm run start -- --port 8082", "start", []string{"--port", "8082"}, ""},
		{"npm run start ./app --silent", "start", []string{"./app"}, ""},
		{"pnpm start --port 8082", "start", []string{"--port", "8082"}, ""},
		{"pnpm run start -- --port 8082", "start", []string{"--port", "8082"}, ""},
		{"pnpm -C app start", "start", nil, "app"},
		{"pnpm --dir=app run start", "start", nil, "app"},
		{"yarn --cwd app start", "start", nil, "app"},
		{"yarn run ios --no-bundler", "ios", []string{"--no-bundler"}, ""},
		{"yarn ios", "ios", nil, ""},
		{"yarn ios --no-bundler", "ios", []string{"--no-bundler"}, ""},
		{"yarn --cwd app ios -- --device X", "ios", []string{"--device", "X"}, "app"},
		{"pnpm ios", "ios", nil, ""},
		{"pnpm --dir app dev --port 8082", "dev", []string{"--port", "8082"}, "app"},
		{"bun --cwd app run start", "start", nil, "app"},
		{"timeout 60 npm start", "start", nil, ""},
		{"sudo -u me npm start", "start", nil, ""},
		{"env CI=1 npm start", "start", nil, ""},
		{"npm start > metro.log 2>&1", "start", nil, ""},
	} {
		invocation, ok := parsePackageScript(strings.Fields(row.command))
		if !ok || invocation.name != row.name || invocation.chdir != row.chdir || strings.Join(invocation.arguments, " ") != strings.Join(row.arguments, " ") {
			t.Errorf("parsePackageScript(%q) = %+v %v, want %q %q in %q", row.command, invocation, ok, row.name, row.arguments, row.chdir)
		}
	}
	for _, command := range []string{
		"npm", "npm test", "npm install", "npm run", "npm run --silent", "npm -w app start",
		"npm run start --workspace=app", "pnpm --filter app start", "pnpm -r start", "pnpm -w start",
		"yarn workspace app start", "bun run --filter app start", "npx expo start",
		"command -v npm", "npm run -- start",
		// Own commands of yarn and pnpm, and the managers that run no script
		// named without run here.
		"yarn add expo", "pnpm add expo", "yarn install", "pnpm i", "yarn dlx expo", "pnpm dlx expo",
		"yarn exec expo", "pnpm exec expo", "yarn create expo-app", "pnpm why expo", "pnpm -r ios",
		"yarn", "pnpm", "yarn -- ios", "npm ios", "bun ios",
	} {
		if invocation, ok := parsePackageScript(strings.Fields(command)); ok {
			t.Errorf("parsePackageScript(%q) = %+v, want no package script", command, invocation)
		}
	}
}

func TestPackageRulesReadOnlyLinesThatNameAPackageManager(t *testing.T) {
	// The rules read files, so they run only for a line that may need them.
	for line, want := range map[string]bool{
		"npm start":         true,
		"pnpm run ios":      true,
		"yarn start":        true,
		"bun run start":     true,
		"n''pm start":       true,
		`n"p"m start`:       true,
		"np\\\nm start":     true,
		"npx expo start":    false,
		"expo start":        false,
		"ls -la":            false,
		"git commit -m 'x'": false,
	} {
		if got := namesPackageManager(line); got != want {
			t.Errorf("namesPackageManager(%q) = %v, want %v", line, got, want)
		}
	}
}

func TestPackageRulesLookUpAtMostMaxManifestLookupsDirectories(t *testing.T) {
	fixture := newPackageFixture(t)
	if maxManifestBytes != 256<<10 {
		t.Fatalf("the fixture's big package.json assumes a 256 KiB bound, not %d", maxManifestBytes)
	}
	var line strings.Builder
	for index := 0; index < maxManifestLookups; index++ {
		line.WriteString("npm --prefix " + filepath.Join(fixture.none, string(rune('a'+index))) + " start; ")
	}
	// The app's start script is the seventeenth directory: past the bound.
	late := line.String() + "npm --prefix " + fixture.app + " start"
	rules := packageRules{home: func() string { return "/Users/example" }}
	if decision := rules.judge(parseShellLine(late), fixture.plain); decision.Block {
		t.Fatalf("a directory past the bound was looked up: %q", decision.Reason)
	}
	if rules.lookups != maxManifestLookups || len(rules.manifests) != maxManifestLookups {
		t.Fatalf("%d lookups of %d directories, want %d", rules.lookups, len(rules.manifests), maxManifestLookups)
	}
	// The same directory twice is one lookup, and the app found early blocks.
	if !judgeIn(fixture.plain, "npm --prefix "+fixture.app+" run lint; "+late).Block {
		t.Fatal("the app's start script within the bound must be read")
	}
}

func TestPackageRulesStayFastOnLongLines(t *testing.T) {
	fixture := newPackageFixture(t)
	budget, quarter := 5*time.Second, 1
	if raceDetector {
		budget, quarter = 30*time.Second, 4
	}
	repeat := func(unit string, count int) string { return strings.Repeat(unit, count/quarter) }
	for name, line := range map[string]string{
		// A script read from a package.json once, and followed until the
		// rule's scripts are spent.
		"a package script run 60,000 times": repeat("npm run lint; ", 60_000),
		// A directory each, which grows past a path and past the lookups.
		"a package script in 50,000 directories": repeat("cd d; npm run lint; ", 50_000),
		// One script handed 500,000 words, more than the rule follows.
		"a package script with 500,000 arguments": "npm run lint -- " + repeat("x ", 500_000),
		// Scripts handed to a shell, each running a package script.
		"20,000 shells running a package script": repeat("sh -c 'npm run lint'; ", 20_000),
		// Lines of TestHookStaysFastOnLinesNearTheLimit that name a package
		// manager, so that these rules follow what they hand on as well.
		"substitutions that each run a package script":                    "echo " + repeat("$(npm run lint) ", 60_000),
		"nested groups, each piped into a shell, around a package script": repeat("( ", 116_000) + "npm run lint" + repeat(") | sh ", 116_000),
		"a file written once and run tens of thousands of times":          "echo '" + repeat("npm run lint; ", 20_000) + "' > s.sh" + repeat("; sh s.sh", 60_000),
	} {
		if len(line) > 1<<20 {
			t.Fatalf("%s: the line is %d bytes, over the payload limit", name, len(line))
		}
		started := time.Now()
		answer := make(chan HookDecision, 1)
		go func() { answer <- judgeIn(fixture.app, line) }()
		select {
		case decision := <-answer:
			if decision.Block {
				t.Errorf("%s: declined, %q", name, decision.Reason)
			}
		case <-time.After(budget):
			t.Errorf("%s: no answer within %s", name, budget)
		}
		t.Logf("%s: %d bytes in %s", name, len(line), time.Since(started).Round(time.Millisecond))
	}
}
