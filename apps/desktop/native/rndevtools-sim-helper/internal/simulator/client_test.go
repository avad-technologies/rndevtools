package simulator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/mobai-app/simslim"
)

const testUDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"

func launchdSnapshot(entries string) []byte {
	return []byte("domain = test\nservices = {\n" + entries + "}\ndisabled services = {\n}\n")
}

func TestParseDeviceListProjectsAvailableIOSSimulators(t *testing.T) {
	devices, err := parseDeviceList([]byte(`{
		"devices": {
			"com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{
				"udid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
				"name": "iPhone 16",
				"state": "Booted",
				"isAvailable": true,
				"deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
				"lastBootedAt": "ignored"
			}],
			"com.apple.CoreSimulator.SimRuntime.tvOS-18-5": [{
				"udid": "11111111-2222-3333-4444-555555555555",
				"name": "Apple TV",
				"state": "Shutdown",
				"isAvailable": true,
				"deviceTypeIdentifier": "tv"
			}]
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != testUDID {
		t.Fatalf("unexpected devices: %#v", devices)
	}
}

func TestCommandEnvironmentDropsInjectionVariablesAndForcesStableLocale(t *testing.T) {
	t.Setenv("DYLD_INSERT_LIBRARIES", "/tmp/untrusted.dylib")
	t.Setenv("LC_ALL", "fr_FR.UTF-8")
	environment := allowedEnvironment()
	if slices.ContainsFunc(environment, func(entry string) bool { return strings.HasPrefix(entry, "DYLD_INSERT_LIBRARIES=") }) {
		t.Fatal("dynamic-loader injection variable reached native command")
	}
	if !slices.Contains(environment, "LANG=C") || !slices.Contains(environment, "LC_ALL=C") {
		t.Fatalf("stable locale missing: %#v", environment)
	}
}

func TestCompatibilityTupleBindsExactRuntimeToolchainHelperAndNativeHost(t *testing.T) {
	client := &Client{
		helperVersion:     "0.1.0",
		helperBuildCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
			switch {
			case executable == swVersExecutable && slices.Equal(args, []string{"-buildVersion"}):
				return commandResult{stdout: []byte("25G88\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"xcodebuild", "-version"}):
				return commandResult{stdout: []byte("Xcode 17.4\nBuild version 17G42\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "--version"}):
				return commandResult{stdout: []byte("@(#)PROGRAM:simctl  PROJECT:CoreSimulator-1051.55\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "list", "runtimes", "--json"}):
				return commandResult{stdout: []byte(`{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","buildversion":"23F77","isAvailable":true}]}`)}, nil
			case executable == sysctlExecutable && slices.Equal(args, []string{"-n", "hw.optional.arm64"}):
				// The helper binary can be x64 under Rosetta; this native-host probe
				// must still bind the tuple to Apple Silicon.
				return commandResult{stdout: []byte("1\n")}, nil
			default:
				t.Fatalf("unexpected compatibility command: %s %#v", executable, args)
				return commandResult{}, errors.New("unexpected")
			}
		}),
	}
	tuple, err := client.compatibilityTuple(context.Background(), "com.apple.CoreSimulator.SimRuntime.iOS-26-5")
	if err != nil {
		t.Fatal(err)
	}
	if tuple.CoreSimulatorBuild != "1051.55" || tuple.RuntimeBuild != "23F77" ||
		tuple.HostArchitecture != "arm64" || tuple.HelperVersion != "0.1.0" ||
		tuple.HelperBuildCommit != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("incomplete compatibility tuple: %#v", tuple)
	}
}

func TestPinnedForkParsesDisabledOverridesAndPIDOnlySimulatorProcessOutput(t *testing.T) {
	disabled := simslim.ParseDisabledOutput(`disabled services = {
		"com.apple.apsd" => true
		"com.apple.swcd" => disabled
		"com.apple.storekitd" => false
		"bad label with spaces" => true
	}`)
	if !disabled["com.apple.apsd"] || !disabled["com.apple.swcd"] || disabled["com.apple.storekitd"] {
		t.Fatalf("unexpected pinned parser projection: %#v", disabled)
	}
	pids := simslim.SimulatorProcessTreePIDsFromPS(42, `  PID  PPID %CPU COMM
42 1 0.0 /sbin/launchd_sim
43 42 0.0 /usr/libexec/backboardd
44 43 0.0 /System/Library/CoreServices/SpringBoard.app/SpringBoard
99 1 0.0 /Applications/Unrelated.app/Contents/MacOS/Unrelated`)
	if !slices.Equal(pids, []int{42, 43, 44}) {
		t.Fatalf("unrelated host process entered Simulator tree: %#v", pids)
	}
}

func TestUDIDValidationRejectsArgumentInjection(t *testing.T) {
	badValues := []string{"booted", testUDID + ";delete", "--set", "../../devices"}
	if slices.ContainsFunc(badValues, UDIDPattern.MatchString) {
		t.Fatal("unsafe simulator identifier passed validation")
	}
}

func TestStatusTemporarilyBootsShutdownTargetAndRestoresOriginalState(t *testing.T) {
	state := "Shutdown"
	commands := make([]string, 0)
	client := &Client{
		helperVersion:     "0.1.0",
		helperBuildCommit: strings.Repeat("a", 40),
		runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
			commands = append(commands, executable+" "+strings.Join(args, " "))
			switch {
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
				return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"` + state + `","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}`)}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "boot", testUDID}):
				state = "Booted"
				return commandResult{}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "bootstatus", testUDID, "-b"}):
				return commandResult{}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print-disabled", "system"}):
				return commandResult{stdout: []byte(`"com.apple.apsd" => true`)}, nil
			case executable == swVersExecutable && slices.Equal(args, []string{"-buildVersion"}):
				return commandResult{stdout: []byte("25G88\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"xcodebuild", "-version"}):
				return commandResult{stdout: []byte("Xcode 17.4\nBuild version 17G42\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "--version"}):
				return commandResult{stdout: []byte("@(#)PROGRAM:simctl  PROJECT:CoreSimulator-1051.55\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "list", "runtimes", "--json"}):
				return commandResult{stdout: []byte(`{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","buildversion":"23F77","isAvailable":true}]}`)}, nil
			case executable == sysctlExecutable && slices.Equal(args, []string{"-n", "hw.optional.arm64"}):
				return commandResult{stdout: []byte("1\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "shutdown", testUDID}):
				state = "Shutdown"
				return commandResult{}, nil
			default:
				t.Fatalf("unexpected status command: %s %#v", executable, args)
				return commandResult{}, errors.New("unexpected")
			}
		}),
	}
	status, err := client.Status(context.Background(), testUDID)
	if err != nil {
		t.Fatal(err)
	}
	if state != "Shutdown" || status.Device.State != "Shutdown" {
		t.Fatalf("original shutdown state was not restored: state=%s status=%#v", state, status)
	}
	if !slices.Equal(status.ManagedDisabledServiceIDs, []string{"com.apple.apsd"}) {
		t.Fatalf("managed state was not inspected: %#v", status)
	}
	bootIndex := slices.IndexFunc(commands, func(command string) bool { return strings.Contains(command, "simctl boot ") })
	shutdownIndex := slices.IndexFunc(commands, func(command string) bool { return strings.Contains(command, "simctl shutdown ") })
	if bootIndex < 0 || shutdownIndex <= bootIndex {
		t.Fatalf("temporary boot was not restored in order: %#v", commands)
	}
}

func TestPrepareMutationRestoresShutdownAfterPartialBootFailureOrCancellation(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		cancelBoot bool
	}{
		{name: "bootstatus failure"},
		{name: "bootstatus cancellation", cancelBoot: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			state := "Shutdown"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cleanupUsedIndependentContext := false
			client := &Client{
				runner: runnerFunc(func(commandContext context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
					if executable != xcrunExecutable {
						t.Fatalf("unexpected partial-boot executable: %s", executable)
					}
					switch {
					case slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
						if state != "Shutdown" && commandContext.Err() == nil {
							cleanupUsedIndependentContext = true
						}
						return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"` + state + `","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}`)}, nil
					case slices.Equal(args, []string{"simctl", "boot", testUDID}):
						state = "Booting"
						return commandResult{}, nil
					case slices.Equal(args, []string{"simctl", "bootstatus", testUDID, "-b"}):
						if testCase.cancelBoot {
							cancel()
							return commandResult{}, context.Canceled
						}
						return commandResult{exitCode: 1}, nil
					case slices.Equal(args, []string{"simctl", "shutdown", testUDID}):
						if commandContext.Err() != nil {
							t.Fatal("partial-boot cleanup inherited the cancelled request context")
						}
						cleanupUsedIndependentContext = true
						state = "Shutdown"
						return commandResult{}, nil
					default:
						t.Fatalf("unexpected partial-boot command: %#v", args)
						return commandResult{}, errors.New("unexpected")
					}
				}),
			}

			if _, err := client.PrepareMutation(ctx, testUDID); err == nil {
				t.Fatal("partial boot unexpectedly prepared a mutation")
			}
			if state != "Shutdown" || !cleanupUsedIndependentContext {
				t.Fatalf("partial boot was not independently restored: state=%s independent=%v", state, cleanupUsedIndependentContext)
			}
		})
	}
}

func TestVerificationKeepsShutdownTargetBootedForEntireProbeThenRestoresIt(t *testing.T) {
	state := "Shutdown"
	client := &Client{
		helperVersion:     "0.1.0",
		helperBuildCommit: strings.Repeat("a", 40),
		runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
			switch {
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
				return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"` + state + `","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}`)}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "boot", testUDID}):
				state = "Booted"
				return commandResult{}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "bootstatus", testUDID, "-b"}):
				return commandResult{}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print-disabled", "system"}):
				if state != "Booted" {
					t.Fatal("managed overrides were probed while the target was shutdown")
				}
				return commandResult{stdout: []byte(`"com.apple.apsd" => true`)}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "user/501"}):
				if state != "Booted" {
					t.Fatal("launchd registration was probed after premature shutdown")
				}
				return commandResult{stdout: launchdSnapshot("")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "system"}):
				return commandResult{stdout: launchdSnapshot("")}, nil
			case executable == swVersExecutable && slices.Equal(args, []string{"-buildVersion"}):
				return commandResult{stdout: []byte("25G88\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"xcodebuild", "-version"}):
				return commandResult{stdout: []byte("Xcode 17.4\nBuild version 17G42\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "--version"}):
				return commandResult{stdout: []byte("@(#)PROGRAM:simctl  PROJECT:CoreSimulator-1051.55\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "list", "runtimes", "--json"}):
				return commandResult{stdout: []byte(`{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","buildversion":"23F77","isAvailable":true}]}`)}, nil
			case executable == sysctlExecutable && slices.Equal(args, []string{"-n", "hw.optional.arm64"}):
				return commandResult{stdout: []byte("1\n")}, nil
			case executable == xcrunExecutable && slices.Equal(args, []string{"simctl", "shutdown", testUDID}):
				state = "Shutdown"
				return commandResult{}, nil
			default:
				t.Fatalf("unexpected shutdown verification command: %s %#v", executable, args)
				return commandResult{}, errors.New("unexpected")
			}
		}),
	}
	verification, err := client.VerifyManagedState(
		context.Background(),
		testUDID,
		[]string{"com.apple.apsd"},
		nil,
	)
	if err != nil || !verification.Verified || state != "Shutdown" {
		t.Fatalf("shutdown verification did not finish and restore safely: verification=%#v state=%s err=%v", verification, state, err)
	}
}

type runnerFunc func(context.Context, time.Duration, string, ...string) (commandResult, error)

func (run runnerFunc) Run(ctx context.Context, timeout time.Duration, executable string, args ...string) (commandResult, error) {
	return run(ctx, timeout, executable, args...)
}

func TestVerificationRequiresExactOverridesAndConclusiveLaunchdRegistrationAbsence(t *testing.T) {
	for name, probeResult := range map[string]commandResult{
		"absent":    {stdout: launchdSnapshot("")},
		"present":   {stdout: launchdSnapshot("42 (jt) com.apple.apsd\n")},
		"ambiguous": {exitCode: 1, stderr: []byte(`Operation not permitted`)},
	} {
		t.Run(name, func(t *testing.T) {
			domainProbes := 0
			client := &Client{runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
				if executable != xcrunExecutable {
					t.Fatalf("unexpected executable: %s", executable)
				}
				switch {
				case slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
					return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}`)}, nil
				case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print-disabled", "system"}):
					return commandResult{stdout: []byte(`"com.apple.apsd" => true`)}, nil
				case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "user/501"}):
					domainProbes++
					return probeResult, nil
				case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "system"}):
					domainProbes++
					return commandResult{stdout: launchdSnapshot("")}, nil
				default:
					t.Fatalf("unexpected args: %#v", args)
					return commandResult{}, errors.New("unexpected")
				}
			})}
			verification, err := client.VerifyManagedState(context.Background(), testUDID, []string{"com.apple.apsd"}, nil)
			if domainProbes > 2 {
				t.Fatalf("verification launched too many domain probes: %d", domainProbes)
			}
			switch name {
			case "absent":
				if err != nil || !verification.Verified {
					t.Fatalf("conclusive absence did not verify: %#v, %v", verification, err)
				}
			case "present":
				if err != nil || verification.Verified || !slices.Equal(verification.RegisteredDisabledLaunchdJobIDs, []string{"com.apple.apsd"}) {
					t.Fatalf("present launchd job registration was not reported: %#v, %v", verification, err)
				}
			case "ambiguous":
				var verificationError *VerificationError
				if !errors.As(err, &verificationError) || verification.Verified {
					t.Fatalf("ambiguous probe was accepted: %#v, %v", verification, err)
				}
			}
		})
	}
}

func TestCaptureRunningServiceProcessesRequiresExactLaunchdAndSimulatorTreeMapping(t *testing.T) {
	client := &Client{
		runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
			if executable != xcrunExecutable || len(args) != 6 || args[0] != "simctl" || args[1] != "spawn" || args[2] != testUDID {
				t.Fatalf("unexpected process mapping command: %s %#v", executable, args)
			}
			switch args[5] {
			case "user/501":
				return commandResult{stdout: launchdSnapshot("42 (jt) com.apple.apsd\n0 - com.apple.swcd\n")}, nil
			case "system":
				return commandResult{stdout: launchdSnapshot("")}, nil
			default:
				t.Fatalf("unexpected service: %s", args[5])
				return commandResult{}, errors.New("unexpected")
			}
		}),
		measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
			return []simslim.Process{
				{PID: 42, Command: "apsd"},
				{PID: 99, Command: "unrelated"},
			}, nil
		},
	}
	names, err := client.CaptureRunningServiceProcesses(
		context.Background(),
		testUDID,
		[]string{"com.apple.apsd", "com.apple.swcd"},
	)
	if err != nil || !slices.Equal(names, []string{"apsd"}) {
		t.Fatalf("exact process mapping failed: names=%#v err=%v", names, err)
	}

	client.measureProcesses = func(context.Context, string) ([]simslim.Process, error) {
		return []simslim.Process{{PID: 43, Command: "apsd"}}, nil
	}
	if _, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, []string{"com.apple.apsd"}); err == nil {
		t.Fatal("launchd PID outside the exact Simulator tree was accepted")
	}

	client.measureProcesses = func(context.Context, string) ([]simslim.Process, error) {
		return []simslim.Process{
			{PID: 42, Command: "apsd"},
			{PID: 43, Command: "apsd"},
		}, nil
	}
	if _, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, []string{"com.apple.apsd"}); err == nil {
		t.Fatal("a non-unique executable basename was accepted as process identity")
	}
}

func TestCaptureRunningServiceProcessesRejectsAmbiguousRunningJobIdentity(t *testing.T) {
	for name, output := range map[string]string{
		"missing pid":     "services = {\n- (jt) com.apple.apsd\n}\n",
		"missing label":   "services = {\n42 (jt)\n}\n",
		"duplicate label": "services = {\n42 (jt) com.apple.apsd\n43 (jt) com.apple.apsd\n}\n",
	} {
		t.Run(name, func(t *testing.T) {
			client := &Client{
				runner: runnerFunc(func(_ context.Context, _ time.Duration, _ string, _ ...string) (commandResult, error) {
					return commandResult{stdout: []byte(output)}, nil
				}),
				measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
					return []simslim.Process{{PID: 42, Command: "apsd"}}, nil
				},
			}
			if _, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, []string{"com.apple.apsd"}); err == nil {
				t.Fatal("ambiguous running launchd identity was accepted")
			}
		})
	}
}

func TestCaptureRunningServiceProcessesWaitsForLauncherToExec(t *testing.T) {
	delays := processMappingRetryDelays
	processMappingRetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { processMappingRetryDelays = delays })
	for _, settles := range []bool{true, false} {
		calls := 0
		client := &Client{
			runner: runnerFunc(func(_ context.Context, _ time.Duration, _ string, args ...string) (commandResult, error) {
				if args[5] == "system" {
					return commandResult{stdout: launchdSnapshot("")}, nil
				}
				return commandResult{stdout: launchdSnapshot("42 (jt) com.apple.apsd\n")}, nil
			}),
			measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
				calls++
				command := "xpcproxy_sim"
				if settles && calls > 1 {
					command = "apsd"
				}
				return []simslim.Process{{PID: 42, Command: command}}, nil
			},
		}
		names, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, []string{"com.apple.apsd"})
		if settles && (err != nil || calls != 2 || !slices.Equal(names, []string{"apsd"})) {
			t.Fatalf("did not bind the settled executable: names=%v calls=%d err=%v", names, calls, err)
		}
		if !settles && (!errors.Is(err, errProcessLaunching) || calls != 3 || len(names) != 0) {
			t.Fatalf("accepted a launcher or retried without a bound: names=%v calls=%d err=%v", names, calls, err)
		}
	}
}

func TestCaptureRunningServiceProcessesRechecksUnresolvedNames(t *testing.T) {
	delays := processMappingRetryDelays
	processMappingRetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { processMappingRetryDelays = delays })
	for _, mode := range []string{"settles", "persistent", "cancelled", "invalid-pid"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls, domainReads := 0, 0
			client := &Client{
				runner: runnerFunc(func(_ context.Context, _ time.Duration, _ string, args ...string) (commandResult, error) {
					domainReads++
					if args[5] == "system" {
						return commandResult{stdout: launchdSnapshot("")}, nil
					}
					return commandResult{stdout: launchdSnapshot("42 (jt) com.apple.apsd\n")}, nil
				}),
				measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
					calls++
					processes := []simslim.Process{{PID: 42, Command: "apsd"}}
					if mode == "settles" && calls > 1 {
						return processes, nil
					}
					if mode == "invalid-pid" {
						return append(processes, simslim.Process{PID: -1, Command: "invalid"}), nil
					}
					if mode == "cancelled" {
						cancel()
					}
					return append(processes, simslim.Process{PID: 99, Command: "<exiting>"}), nil
				},
			}
			names, err := client.CaptureRunningServiceProcesses(ctx, testUDID, []string{"com.apple.apsd"})
			if mode == "settles" {
				if err != nil || calls != 2 || domainReads != 4 || !slices.Equal(names, []string{"apsd"}) {
					t.Fatalf("did not bind a fresh complete snapshot: names=%v calls=%d reads=%d err=%v", names, calls, domainReads, err)
				}
				return
			}
			if err == nil || len(names) != 0 {
				t.Fatalf("accepted unresolved identity data: names=%v err=%v", names, err)
			}
			if mode == "persistent" && (!errors.Is(err, errProcessNameChanging) || calls != 3 || domainReads != 6) {
				t.Fatalf("unbounded retry: calls=%d reads=%d err=%v", calls, domainReads, err)
			}
			if mode == "cancelled" && (!errors.Is(err, context.Canceled) || calls != 1) {
				t.Fatalf("retried after cancellation: calls=%d err=%v", calls, err)
			}
			if mode == "invalid-pid" && calls != 1 {
				t.Fatal("retried structurally invalid PID data")
			}
		})
	}
}

func TestProcessIdentitySnapshotIsBoundedAndExcludesOtherSimulators(t *testing.T) {
	client := NewClient("test", strings.Repeat("a", 40))
	rootOutput := "42\n"
	rootCommand := "/sbin/launchd_sim"
	changeRoot := false
	rootReads := 0
	client.runner = runnerFunc(func(_ context.Context, timeout time.Duration, executable string, args ...string) (commandResult, error) {
		if timeout != commandTimeout {
			t.Fatalf("unbounded identity command: %v", timeout)
		}
		switch executable {
		case pgrepExecutable:
			if !slices.Equal(args, []string{"-f", testUDID + "/data/var/run/launchd_bootstrap"}) {
				t.Fatalf("wrong root selector: %v", args)
			}
			rootReads++
			if changeRoot && rootReads > 1 {
				return commandResult{stdout: []byte("99\n")}, nil
			}
			return commandResult{stdout: []byte(rootOutput)}, nil
		case psExecutable:
			if !slices.Equal(args, []string{"-axo", "pid,ppid,%cpu,comm"}) {
				t.Fatalf("unexpected process fields: %v", args)
			}
			return commandResult{stdout: []byte("PID PPID %CPU COMM\n42 1 0 " + rootCommand + "\n43 42 0 /path with spaces/apsd\n99 1 0 /other/apsd\n")}, nil
		default:
			t.Fatalf("unexpected identity command: %s", executable)
			return commandResult{}, errors.New("unexpected")
		}
	})
	processes, err := client.measureProcesses(context.Background(), testUDID)
	if err != nil || len(processes) != 2 || processes[1].PID != 43 || processes[1].Command != "apsd" {
		t.Fatalf("wrong exact-device projection: %v %v", processes, err)
	}
	rootOutput = "42\n99\n"
	if _, err := client.measureProcesses(context.Background(), testUDID); err == nil {
		t.Fatal("accepted an ambiguous launchd root")
	}
	rootOutput = "42\n"
	rootCommand = "/unrelated/reused-pid"
	if _, err := client.measureProcesses(context.Background(), testUDID); err == nil {
		t.Fatal("accepted a reused root PID")
	}
	rootCommand = "launchd_sim"
	changeRoot, rootReads = true, 0
	if _, err := client.measureProcesses(context.Background(), testUDID); err == nil {
		t.Fatal("accepted a root that changed during the snapshot")
	}
}

func TestCaptureBindsSharedLaunchersToExactJobLabels(t *testing.T) {
	delays := processMappingRetryDelays
	processMappingRetryDelays = nil
	t.Cleanup(func() { processMappingRetryDelays = delays })
	client := NewClient("test", strings.Repeat("a", 40))
	launcherOutput := "42 xpcproxy_sim com.apple.apsd\n43 xpcproxy_sim com.apple.swcd\n"
	client.runner = runnerFunc(func(_ context.Context, timeout time.Duration, executable string, args ...string) (commandResult, error) {
		if timeout != commandTimeout {
			t.Fatal("unbounded launcher command")
		}
		switch executable {
		case xcrunExecutable:
			if args[5] == "system" {
				return commandResult{stdout: launchdSnapshot("")}, nil
			}
			return commandResult{stdout: launchdSnapshot("42 (jt) com.apple.apsd\n43 (jt) com.apple.swcd\n")}, nil
		case pgrepExecutable:
			return commandResult{stdout: []byte("40\n")}, nil
		case psExecutable:
			if slices.Equal(args, []string{"-axo", "pid,ppid,%cpu,comm"}) {
				return commandResult{stdout: []byte("40 1 0 launchd_sim\n42 40 0 xpcproxy_sim\n43 40 0 xpcproxy_sim\n99 1 0 xpcproxy_sim\n")}, nil
			}
			if !slices.Equal(args, []string{"-p", "42,43", "-o", "pid=,args="}) {
				t.Fatalf("read argv outside the exact Simulator launcher PIDs: %v", args)
			}
			return commandResult{stdout: []byte(launcherOutput)}, nil
		default:
			t.Fatalf("unexpected command: %s", executable)
			return commandResult{}, errors.New("unexpected")
		}
	})
	services := []string{"com.apple.apsd", "com.apple.swcd"}
	names, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, services)
	if err != nil || !slices.Equal(names, []string{"xpcproxy_sim+com.apple.apsd", "xpcproxy_sim+com.apple.swcd"}) {
		t.Fatalf("shared launchers were not bound separately: %v %v", names, err)
	}
	for _, invalid := range []string{
		"42 xpcproxy_sim com.apple.swcd\n43 xpcproxy_sim com.apple.apsd\n",
		"42 xpcproxy_sim com.apple.apsd extra-argument\n43 xpcproxy_sim com.apple.swcd\n",
		"42 xpcproxy_sim com.apple.apsd\n42 xpcproxy_sim com.apple.swcd\n",
		"99 xpcproxy_sim com.apple.apsd\n43 xpcproxy_sim com.apple.swcd\n",
	} {
		launcherOutput = invalid
		if _, err := client.CaptureRunningServiceProcesses(context.Background(), testUDID, services); err == nil {
			t.Fatal("accepted ambiguous, changed, or out-of-tree launcher identity")
		}
	}
}

func TestVerificationRejectsSurvivingOrUnresolvedLaunchers(t *testing.T) {
	for _, command := range []string{"xpcproxy_sim+com.apple.apsd", "xpcproxy_sim", "xpcproxy_sim+com.apple.swcd"} {
		client := &Client{
			runner: runnerFunc(func(_ context.Context, _ time.Duration, _ string, args ...string) (commandResult, error) {
				switch {
				case slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
					return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"Booted","isAvailable":true}]}}`)}, nil
				case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print-disabled", "system"}):
					return commandResult{stdout: []byte(`"com.apple.apsd" => true`)}, nil
				default:
					return commandResult{stdout: launchdSnapshot("")}, nil
				}
			}),
			measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
				return []simslim.Process{{PID: 42, Command: command}}, nil
			},
		}
		proof, err := client.VerifyManagedState(context.Background(), testUDID, []string{"com.apple.apsd"}, []string{"xpcproxy_sim+com.apple.apsd"})
		if command == "xpcproxy_sim+com.apple.swcd" {
			if err != nil || !proof.Verified {
				t.Fatalf("unrelated proven launcher blocked verification: %v %v", proof, err)
			}
		} else if proof.Verified {
			t.Fatalf("surviving or unresolved launcher was accepted: %s", command)
		}
	}
}

func TestFixedRunnerPermitsBoundedProcessIdentityCommands(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS process tools")
	}
	runner := fixedRunner{}
	result, err := runner.Run(context.Background(), commandTimeout, psExecutable, "-p", strconv.Itoa(os.Getpid()), "-o", "pid,ppid,%cpu,comm")
	if err != nil || result.exitCode != 0 || !strings.Contains(string(result.stdout), strconv.Itoa(os.Getpid())) {
		t.Fatalf("fixed runner could not sample process identities: exit=%d err=%v", result.exitCode, err)
	}
	// An impossible process selector must reach pgrep and return its documented
	// no-match status, rather than being rejected by our executable allowlist.
	result, err = runner.Run(context.Background(), commandTimeout, pgrepExecutable, "-f", "rndevtools-impossible-process-"+testUDID)
	if err != nil || result.exitCode != 1 {
		t.Fatalf("fixed runner could not resolve process roots: exit=%d err=%v", result.exitCode, err)
	}
	if _, err := runner.Run(context.Background(), commandTimeout, "/bin/sh", "-c", "true"); err == nil {
		t.Fatal("fixed runner accepted an arbitrary executable")
	}
}

func TestParseLaunchdServicesRequiresOneBoundedUnambiguousBlock(t *testing.T) {
	services, err := parseLaunchdServices(launchdSnapshot(
		"42 (jt) com.apple.apsd\n0 - com.apple.swcd\n",
	))
	if err != nil || len(services) != 2 || services["com.apple.apsd"] != 42 || services["com.apple.swcd"] != 0 {
		t.Fatalf("valid launchd snapshot was not parsed exactly: services=%#v err=%v", services, err)
	}

	for name, output := range map[string][]byte{
		"missing block":    []byte("domain = test\n"),
		"unclosed block":   []byte("services = {\n42 (jt) com.apple.apsd\n"),
		"multiple blocks":  []byte("services = {\n}\nservices = {\n}\n"),
		"duplicate label":  []byte("services = {\n42 - com.apple.apsd\n43 - com.apple.apsd\n}\n"),
		"negative pid":     []byte("services = {\n-1 - com.apple.apsd\n}\n"),
		"malformed record": []byte("services = {\n42 com.apple.apsd\n}\n"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseLaunchdServices(output); err == nil {
				t.Fatal("ambiguous launchd snapshot was accepted")
			}
		})
	}
}

func TestLaunchdServicesRejectsTheSameLabelAcrossDomains(t *testing.T) {
	client := &Client{runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
		if executable != xcrunExecutable || len(args) != 6 || args[5] != "user/501" && args[5] != "system" {
			t.Fatalf("unexpected domain snapshot command: %s %#v", executable, args)
		}
		return commandResult{stdout: launchdSnapshot("42 - com.apple.apsd\n")}, nil
	})}
	if _, err := client.launchdServices(context.Background(), testUDID); err == nil {
		t.Fatal("a label registered in multiple launchd domains was accepted")
	}
}

func TestVerificationRejectsAnObservedToDisableProcessThatSurvives(t *testing.T) {
	client := &Client{
		runner: runnerFunc(func(_ context.Context, _ time.Duration, executable string, args ...string) (commandResult, error) {
			if executable != xcrunExecutable {
				t.Fatalf("unexpected executable: %s", executable)
			}
			switch {
			case slices.Equal(args, []string{"simctl", "list", "devices", "available", "--json"}):
				return commandResult{stdout: []byte(`{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"` + testUDID + `","name":"iPhone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16"}]}}`)}, nil
			case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print-disabled", "system"}):
				return commandResult{stdout: []byte(`"com.apple.apsd" => true`)}, nil
			case slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "user/501"}),
				slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "system"}):
				return commandResult{stdout: launchdSnapshot("")}, nil
			default:
				t.Fatalf("unexpected verification args: %#v", args)
				return commandResult{}, errors.New("unexpected")
			}
		}),
		measureProcesses: func(context.Context, string) ([]simslim.Process, error) {
			return []simslim.Process{{PID: 42, Command: "apsd"}}, nil
		},
	}
	verification, err := client.VerifyManagedState(
		context.Background(),
		testUDID,
		[]string{"com.apple.apsd"},
		[]string{"apsd"},
	)
	if err != nil || verification.Verified || verification.ObservedPreMutationProcessesAbsent ||
		!slices.Equal(verification.PresentObservedProcessNames, []string{"apsd"}) {
		t.Fatalf("surviving observed process was not rejected: %#v, %v", verification, err)
	}
}

func TestManagedStateValidationRejectsLabelsOutsidePinnedSimSlim(t *testing.T) {
	if err := validateManagedIDs([]string{"com.apple.apsd", "com.apple.swcd"}); err != nil {
		t.Fatalf("pinned SimSlim labels were rejected: %v", err)
	}
	if err := validateManagedIDs([]string{"com.example.raw"}); err == nil {
		t.Fatal("non-SimSlim label passed mutation validation")
	}
	if err := validateManagedIDs([]string{"com.apple.apsd", "com.apple.apsd"}); err == nil {
		t.Fatal("duplicate label passed mutation validation")
	}
}

func TestBoundedCommandCapturesOutputAndExitCode(t *testing.T) {
	result, err := runBounded(context.Background(), 5*time.Second, "/bin/sh", "-c", "echo out; echo err >&2; exit 3")
	if err != nil || string(result.stdout) != "out\n" || string(result.stderr) != "err\n" || result.exitCode != 3 {
		t.Fatalf("unexpected command result: %#v, %v", result, err)
	}
}

// runWithOrphanHoldingOutput runs script after starting a background sleep that
// inherits the command's stdout and stderr, as a process that simctl starts
// inside the Simulator does, and kills that orphan when the test ends.
func runWithOrphanHoldingOutput(t *testing.T, timeout time.Duration, script string) (time.Duration, error) {
	t.Helper()
	previousWaitDelay := commandWaitDelay
	commandWaitDelay = 100 * time.Millisecond
	t.Cleanup(func() { commandWaitDelay = previousWaitDelay })
	pidFile := filepath.Join(t.TempDir(), "orphan.pid")
	t.Cleanup(func() {
		data, err := os.ReadFile(pidFile)
		if err != nil {
			return
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	started := time.Now()
	_, err := runBounded(
		context.Background(),
		timeout,
		"/bin/sh", "-c", `/bin/sleep 30 & echo $! > "$1"; `+script, "sh", pidFile,
	)
	return time.Since(started), err
}

func TestBoundedCommandTimesOutWhileAnOrphanHoldsItsOutput(t *testing.T) {
	elapsed, err := runWithOrphanHoldingOutput(t, 200*time.Millisecond, "wait")
	if !errors.Is(err, errCommandTimeout) {
		t.Fatalf("timed-out command returned %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("timed-out command waited %s for the orphan holding its output", elapsed)
	}
}

func TestLaunchctlReadsRetryOnlyTimeoutsWithinABoundedBudget(t *testing.T) {
	for _, test := range []struct {
		name   string
		first  commandResult
		err    error
		cancel bool
		calls  int
	}{
		{name: "deadline", err: errCommandTimeout, calls: 2},
		{name: "simctl timeout", first: commandResult{exitCode: 60}, calls: 2},
		{name: "success", first: commandResult{stdout: launchdSnapshot("")}, calls: 1},
		{name: "permission denied", first: commandResult{exitCode: 1}, calls: 1},
		{name: "output limit", err: errors.New("native command output exceeded its safety limit"), calls: 1},
		{name: "cancelled timeout", err: errCommandTimeout, cancel: true, calls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			client := &Client{runner: runnerFunc(func(_ context.Context, budget time.Duration, executable string, args ...string) (commandResult, error) {
				calls++
				if executable != xcrunExecutable || !slices.Equal(args, []string{"simctl", "spawn", testUDID, "launchctl", "print", "system"}) {
					t.Fatalf("retry changed target or command: %s %v", executable, args)
				}
				if budget != time.Duration(calls)*commandTimeout {
					t.Fatalf("unexpected bounded attempt budget: %s", budget)
				}
				if calls == 1 {
					if test.cancel {
						cancel()
					}
					return test.first, test.err
				}
				return commandResult{stdout: launchdSnapshot("")}, nil
			})}
			result, err := client.readLaunchctl(ctx, testUDID, "print", "system")
			if calls != test.calls {
				t.Fatalf("got %d calls, want %d", calls, test.calls)
			}
			if test.calls == 2 && (err != nil || string(result.stdout) != string(launchdSnapshot(""))) {
				t.Fatalf("fresh retry evidence was not returned: %#v %v", result, err)
			}
			if test.cancel && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
		})
	}
}

func TestLaunchctlReadRetryExhaustionAndInvalidRequestsFailClosed(t *testing.T) {
	calls := 0
	client := &Client{runner: runnerFunc(func(context.Context, time.Duration, string, ...string) (commandResult, error) {
		calls++
		return commandResult{}, errCommandTimeout
	})}
	if _, err := client.readLaunchctl(context.Background(), testUDID, "print-disabled", "system"); !errors.Is(err, errCommandTimeout) || calls != 2 {
		t.Fatalf("read did not stop after two failed attempts: calls=%d err=%v", calls, err)
	}
	for _, args := range [][3]string{{testUDID, "disable", "system"}, {testUDID, "print", "system/arbitrary"}, {"-invalid", "print", "system"}} {
		if _, err := client.readLaunchctl(context.Background(), args[0], args[1], args[2]); err == nil {
			t.Fatal("accepted non-read or unbound launchctl request")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.readLaunchctl(ctx, testUDID, "print", "system"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled read started: %v", err)
	}
	if calls != 2 {
		t.Fatal("invalid or cancelled request reached runner")
	}
}

func TestBoundedCommandFailsWhenAnOrphanKeepsItsOutputOpenAfterExit(t *testing.T) {
	elapsed, err := runWithOrphanHoldingOutput(t, 20*time.Second, "exit 0")
	if err == nil || !strings.Contains(err.Error(), "kept its output open") {
		t.Fatalf("exited command returned %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("exited command waited %s for the orphan holding its output", elapsed)
	}
}
