package simulator

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
)

// Opt-in, read-only qualification against one already-booted disposable target.
// This exercises the real fixed runner, including its executable allowlist.
func TestReadOnlySimulatorProcessIdentity(t *testing.T) {
	udid := os.Getenv("RNDEVTOOLS_SIMULATOR_IT_UDID")
	if runtime.GOOS != "darwin" || udid == "" {
		t.Skip("set RNDEVTOOLS_SIMULATOR_IT_UDID to a booted test Simulator")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client := NewClient("integration-test", strings.Repeat("a", 40))
	device, err := client.findDevice(ctx, udid)
	if err != nil || device.State != "Booted" {
		t.Fatalf("test target must already be booted: %v", err)
	}
	desired, err := catalog.DesiredServiceIDs("rndevtools-development")
	if err != nil {
		t.Fatal(err)
	}
	names, err := client.CaptureRunningServiceProcesses(ctx, udid, desired)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Bound %d running managed service identities: %v", len(names), names)
}

// Set the expected profile explicitly only after applying it through the desktop.
// This check reads actual overrides and both launchd domains; it mutates nothing.
func TestReadOnlySimulatorAppliedProfile(t *testing.T) {
	udid := os.Getenv("RNDEVTOOLS_SIMULATOR_IT_UDID")
	profile := os.Getenv("RNDEVTOOLS_SIMULATOR_IT_PROFILE")
	if runtime.GOOS != "darwin" || udid == "" || profile == "" {
		t.Skip("set RNDEVTOOLS_SIMULATOR_IT_UDID and RNDEVTOOLS_SIMULATOR_IT_PROFILE for an already-applied test Simulator")
	}
	desired, err := catalog.DesiredServiceIDs(profile)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	client := NewClient("integration-test", strings.Repeat("a", 40))
	device, err := client.findDevice(ctx, udid)
	if err != nil || device.State != "Booted" {
		t.Fatalf("test target must already be booted: %v", err)
	}
	evidence, err := client.VerifyManagedState(ctx, udid, desired, nil)
	if err != nil || !evidence.Verified {
		t.Fatalf("profile not verified: %#v, %v", evidence, err)
	}
	t.Logf("Verified %d exact disabled overrides and absent launchd registrations", len(desired))
}
