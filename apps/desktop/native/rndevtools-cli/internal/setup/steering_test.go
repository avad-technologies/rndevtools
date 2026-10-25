package setup

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// steeringSample is the file the desktop writes (supabaseSteeringFile).
const steeringSample = `{"version":1,"writtenAt":1760000000000,"desktopPid":12345,` +
	`"supabase":{"enabled":true,"roots":[{"worktreeRoot":"/Users/dev/example-app-wt/feat-a",` +
	`"projectRoot":"/Users/dev/example-app-wt/feat-a","mode":"managed","branchContext":"refs/heads/feat-a",` +
	`"stackReady":true,"runner":"pnpm exec supabase"}]}}`

func TestParseSteeringAcceptsTheDesktopsFile(t *testing.T) {
	state, ok := parseSteering([]byte(steeringSample))
	if !ok {
		t.Fatal("the desktop's own file must parse")
	}
	if !state.enabled || !state.writtenAt.Equal(time.UnixMilli(1760000000000)) {
		t.Fatalf("state %+v", state)
	}
	if len(state.roots) != 1 {
		t.Fatalf("roots %+v", state.roots)
	}
	root := state.roots[0]
	if root.worktreeRoot != "/Users/dev/example-app-wt/feat-a" || root.projectRoot != root.worktreeRoot ||
		root.branchContext != "refs/heads/feat-a" || !root.stackReady || root.runner != "pnpm exec supabase" {
		t.Fatalf("root %+v", root)
	}
	disabled, ok := parseSteering([]byte(`{"version":1,"writtenAt":0,"desktopPid":1,"supabase":{"enabled":false,"roots":[]}}`))
	if !ok || disabled.enabled || len(disabled.roots) != 0 {
		t.Fatalf("a disabled file parses with no roots: %+v %v", disabled, ok)
	}
}

func TestParseSteeringIsStrictV1(t *testing.T) {
	root := `{"worktreeRoot":"/w","projectRoot":"/w","mode":"managed","branchContext":"refs/heads/a","stackReady":true,"runner":"npx supabase"}`
	file := func(version, writtenAt, pid, supabase string) string {
		return `{"version":` + version + `,"writtenAt":` + writtenAt + `,"desktopPid":` + pid + `,"supabase":` + supabase + `}`
	}
	supabase := func(enabled, roots string) string { return `{"enabled":` + enabled + `,"roots":` + roots + `}` }
	valid := file("1", "1760000000000", "12345", supabase("true", "["+root+"]"))
	if _, ok := parseSteering([]byte(valid)); !ok {
		t.Fatal("the reference file must parse")
	}
	for name, raw := range map[string]string{
		"empty":                "",
		"not an object":        `[]`,
		"null":                 `null`,
		"trailing value":       valid + ` {}`,
		"trailing garbage":     valid + `x`,
		"unknown key":          strings.Replace(valid, `"version":1`, `"version":1,"extra":true`, 1),
		"key in another case":  strings.Replace(valid, `"version"`, `"Version"`, 1),
		"missing key":          `{"version":1,"writtenAt":1,"supabase":` + supabase("true", "[]") + `}`,
		"version 2":            file("2", "1", "1", supabase("true", "[]")),
		"version as a string":  file(`"1"`, "1", "1", supabase("true", "[]")),
		"fractional time":      file("1", "1.5", "1", supabase("true", "[]")),
		"negative time":        file("1", "-1", "1", supabase("true", "[]")),
		"no pid":               file("1", "1", "0", supabase("true", "[]")),
		"huge pid":             file("1", "1", "4294967296", supabase("true", "[]")),
		"null supabase":        file("1", "1", "1", "null"),
		"enabled as a string":  file("1", "1", "1", supabase(`"true"`, "[]")),
		"null roots":           file("1", "1", "1", supabase("true", "null")),
		"roots not an array":   file("1", "1", "1", supabase("true", "{}")),
		"supabase extra key":   file("1", "1", "1", `{"enabled":true,"roots":[],"backends":true}`),
		"observed root":        file("1", "1", "1", supabase("true", "["+strings.Replace(root, `"managed"`, `"observed"`, 1)+"]")),
		"relative root":        file("1", "1", "1", supabase("true", "["+strings.Replace(root, `"worktreeRoot":"/w"`, `"worktreeRoot":"w"`, 1)+"]")),
		"control character":    file("1", "1", "1", supabase("true", "["+strings.Replace(root, `"/w","mode"`, `"/w\n","mode"`, 1)+"]")),
		"empty runner":         file("1", "1", "1", supabase("true", "["+strings.Replace(root, `"npx supabase"`, `""`, 1)+"]")),
		"missing stack ready":  file("1", "1", "1", supabase("true", "["+strings.Replace(root, `,"stackReady":true`, ``, 1)+"]")),
		"root extra key":       file("1", "1", "1", supabase("true", "["+strings.Replace(root, `{`, `{"pid":1,`, 1)+"]")),
		"too many roots":       file("1", "1", "1", supabase("true", "["+strings.TrimSuffix(strings.Repeat(root+",", steeringMaxRoots+1), ",")+"]")),
		"the backends key":     `{"version":1,"writtenAt":1,"desktopPid":1,"backends":` + supabase("true", "[]") + `}`,
		"stack ready a string": file("1", "1", "1", supabase("true", "["+strings.Replace(root, `"stackReady":true`, `"stackReady":"true"`, 1)+"]")),
	} {
		if _, ok := parseSteering([]byte(raw)); ok {
			t.Errorf("%s: accepted %s", name, raw)
		}
	}
}

func TestSteeringFreshnessWindow(t *testing.T) {
	written := time.UnixMilli(1760000000000)
	state := steeringState{writtenAt: written}
	for offset, want := range map[time.Duration]bool{
		0:                                   true,
		steeringFreshFor:                    true,
		steeringFreshFor + time.Millisecond: false,
		-30 * time.Second:                   true,
		-2 * time.Minute:                    false,
	} {
		if got := state.fresh(written.Add(offset)); got != want {
			t.Errorf("age %v: fresh %v, want %v", offset, got, want)
		}
	}
}

// privateSteeringDirectory is a 0700 directory with a valid 0600 file.
func privateSteeringDirectory(t *testing.T) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "agent")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, steeringFileName), []byte(steeringSample), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestReadSteeringValidatesTheFileLikeTheSocket(t *testing.T) {
	if _, ok := readSteering(privateSteeringDirectory(t)); !ok {
		t.Fatal("a private, valid file must be read")
	}
	for name, prepare := range map[string]func(t *testing.T, directory string){
		"missing file": func(t *testing.T, directory string) {
			if err := os.Rename(filepath.Join(directory, steeringFileName), filepath.Join(directory, "moved.json")); err != nil {
				t.Fatal(err)
			}
		},
		"symlinked file": func(t *testing.T, directory string) {
			target := filepath.Join(directory, "real.json")
			if err := os.Rename(filepath.Join(directory, steeringFileName), target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(directory, steeringFileName)); err != nil {
				t.Fatal(err)
			}
		},
		"group-writable file": func(t *testing.T, directory string) {
			if err := os.Chmod(filepath.Join(directory, steeringFileName), 0o660); err != nil {
				t.Fatal(err)
			}
		},
		"world-writable file": func(t *testing.T, directory string) {
			if err := os.Chmod(filepath.Join(directory, steeringFileName), 0o602); err != nil {
				t.Fatal(err)
			}
		},
		"group-writable directory": func(t *testing.T, directory string) {
			if err := os.Chmod(directory, 0o770); err != nil {
				t.Fatal(err)
			}
		},
		"oversized file": func(t *testing.T, directory string) {
			padded := strings.Replace(steeringSample, `"pnpm exec supabase"`, `"pnpm exec supabase`+strings.Repeat(" ", steeringMaxBytes)+`"`, 1)
			if err := os.WriteFile(filepath.Join(directory, steeringFileName), []byte(padded), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"garbage": func(t *testing.T, directory string) {
			if err := os.WriteFile(filepath.Join(directory, steeringFileName), []byte("{not json"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"directory in its place": func(t *testing.T, directory string) {
			if err := os.Rename(filepath.Join(directory, steeringFileName), filepath.Join(directory, "moved.json")); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(directory, steeringFileName), 0o700); err != nil {
				t.Fatal(err)
			}
		},
		"fifo in its place": func(t *testing.T, directory string) {
			// Opening a FIFO without a writer would block the hook.
			if err := os.Rename(filepath.Join(directory, steeringFileName), filepath.Join(directory, "moved.json")); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Mkfifo(filepath.Join(directory, steeringFileName), 0o600); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			directory := privateSteeringDirectory(t)
			prepare(t, directory)
			if _, ok := readSteering(directory); ok {
				t.Fatal("must be ignored")
			}
		})
	}
	// A symlinked directory is refused too.
	directory := privateSteeringDirectory(t)
	link := filepath.Join(t.TempDir(), "agent-link")
	if err := os.Symlink(directory, link); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSteering(link); ok {
		t.Fatal("a symlinked directory must be ignored")
	}
}
