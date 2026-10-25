package simulator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	if err == nil || err.Error() != "native command timed out" {
		t.Fatalf("timed-out command returned %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("timed-out command waited %s for the orphan holding its output", elapsed)
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
