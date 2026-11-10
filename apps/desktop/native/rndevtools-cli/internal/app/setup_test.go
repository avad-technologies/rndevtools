package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSetupDryRunLeavesTheRepairHistoryAsItIs(t *testing.T) {
	// --dry-run changes nothing, RN Devtools' own repair history included:
	// the agent checks setup runs before and after the plan only read it,
	// even what a later preview will prune.
	home := t.TempDir()
	history := filepath.Join(home, "Library", "Application Support", "RN Devtools", "agent-check")
	if err := os.MkdirAll(history, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	names := []string{"check-0123456789abcdef0123456789abcdef.json", ".rndevtools-setup-123456"}
	for _, name := range names {
		path := filepath.Join(history, name)
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	var stdout, stderr bytes.Buffer
	code := Run(Config{
		Arguments:  []string{"setup", "--dry-run", "--no-doctor", "--no-link", "--agents", "claude,codex", "--config-home", home, "--executable", "/opt/rndevtools"},
		Stdin:      strings.NewReader(""),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: filepath.Join(t.TempDir(), "missing.sock"),
		Lookup:     func(string) string { return "" },
	})
	if code != ExitSuccess {
		t.Fatalf("exit %d; stderr %s", code, stderr.String())
	}
	for _, name := range names {
		if _, err := os.Lstat(filepath.Join(history, name)); err != nil {
			t.Errorf("setup --dry-run deleted %s from the repair history", name)
		}
	}
}

func TestSetupSkipsItsClosingDoctorOnRequest(t *testing.T) {
	// A test that isolates the configuration home still has setup's doctor
	// dial the socket under the real home. --no-doctor leaves the socket alone
	// and says so in the report.
	home := t.TempDir()
	var stdout, stderr bytes.Buffer
	code := Run(Config{
		Arguments:  []string{"setup", "--dry-run", "--no-doctor", "--agents", "claude", "--config-home", home, "--executable", "/opt/rndevtools"},
		Stdin:      strings.NewReader(""),
		Stdout:     &stdout,
		Stderr:     &stderr,
		SocketPath: filepath.Join(t.TempDir(), "missing.sock"),
		Lookup:     func(string) string { return "" },
	})
	if code != ExitSuccess {
		t.Fatalf("exit %d; stderr %s", code, stderr.String())
	}
	var report struct {
		Doctor map[string]any `json:"doctor"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("report is not JSON: %s", stdout.String())
	}
	if report.Doctor["skipped"] != true || report.Doctor["ok"] != false {
		t.Fatalf("doctor: %v", report.Doctor)
	}
	stdout.Reset()
	if Run(Config{Arguments: []string{"setup", "--help"}, Stdout: &stdout, Stderr: &stderr}) != ExitSuccess || !strings.Contains(stdout.String(), "--no-doctor") {
		t.Fatalf("setup --help must describe --no-doctor:\n%s", stdout.String())
	}
}
