package app

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

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
