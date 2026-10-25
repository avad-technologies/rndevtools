package simulator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/mobai-app/simslim"
)

const (
	commandTimeout     = 15 * time.Second
	maxStdoutBytes     = 4 * 1024 * 1024
	maxStderrBytes     = 16 * 1024
	maxDevices         = 512
	maxRuntimes        = 100
	maximumManagedIDs  = 256
	maxLaunchdServices = 4096
	xcrunExecutable    = "/usr/bin/xcrun"
	swVersExecutable   = "/usr/bin/sw_vers"
	sysctlExecutable   = "/usr/sbin/sysctl"
)

var (
	bootTimeout          = simslim.BootTimeout
	commandWaitDelay     = 2 * time.Second
	UDIDPattern          = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
	runtimePattern       = regexp.MustCompile(`^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9.-]{1,80}$`)
	deviceTypePattern    = regexp.MustCompile(`^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]{1,96}$`)
	buildLinePattern     = regexp.MustCompile(`(?m)^Build version ([A-Za-z0-9.]{2,32})\s*$`)
	coreSimulatorPattern = regexp.MustCompile(`(?m)PROJECT:CoreSimulator-([A-Za-z0-9.]{2,32})\s*$`)
	launchdLabelPattern  = regexp.MustCompile(`^[^\s]{1,512}$`)
	ProcessNamePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)
)

type Device struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	State                string `json:"state"`
	RuntimeIdentifier    string `json:"runtimeIdentifier"`
	DeviceTypeIdentifier string `json:"deviceTypeIdentifier"`
	Available            bool   `json:"available"`
}

type Status struct {
	Device                    Device   `json:"device"`
	ManagedDisabledServiceIDs []string `json:"managedDisabledServiceIds"`
	ManagedDisabledCount      int      `json:"managedDisabledCount"`
	ManagedServiceCount       int      `json:"managedServiceCount"`
	MatchingProfileIDs        []string `json:"matchingProfileIds"`
}

type ManagedState struct {
	ManagedDisabledServiceIDs []string `json:"managedDisabledServiceIds"`
	Count                     int      `json:"count"`
}

// DiskCleanupPlan and DiskCleanupResult deliberately preserve the pinned
// SimSlim library's public, allowlisted model. This helper wraps their
// JSON field names at its own protocol boundary.
type DiskCleanupPlan = simslim.DiskCleanupPlan
type DiskCleanupResult = simslim.DiskCleanupResult
type DiskCleanupCategoryMeasurement = simslim.DiskCleanupCategoryMeasurement
type DiskStorageMeasurement = simslim.DiskStorageMeasurement

type MutationPreparation struct {
	Device            Device
	OriginalBootState string
	TemporarilyBooted bool
	State             ManagedState
	Tuple             compatibility.Tuple
}

type Verification struct {
	Verified                                   bool     `json:"verified"`
	CurrentManagedDisabledIDs                  []string `json:"currentManagedDisabledServiceIds"`
	DesiredManagedDisabledIDs                  []string `json:"desiredManagedDisabledServiceIds"`
	OverridesMatch                             bool     `json:"overridesMatch"`
	MissingDisabledServiceIDs                  []string `json:"missingDisabledServiceIds"`
	UnexpectedDisabledServiceIDs               []string `json:"unexpectedDisabledServiceIds"`
	DisabledLaunchdJobRegistrationsAbsent      bool     `json:"disabledLaunchdJobRegistrationsAbsent"`
	CheckedDisabledLaunchdJobRegistrationCount int      `json:"checkedDisabledLaunchdJobRegistrationCount"`
	RegisteredDisabledLaunchdJobIDs            []string `json:"registeredDisabledLaunchdJobIds"`
	ObservedPreMutationProcessesAbsent         bool     `json:"observedPreMutationProcessesAbsent"`
	CheckedObservedProcessNames                []string `json:"checkedObservedProcessNames"`
	PresentObservedProcessNames                []string `json:"presentObservedProcessNames"`
}

type VerificationError struct {
	Evidence Verification
	Reason   string
}

func (failure *VerificationError) Error() string {
	return failure.Reason
}

type Backend interface {
	List(context.Context) ([]Device, error)
	Clone(context.Context, string, string) (string, string, error)
	PlanDiskCleanup(context.Context, string) (DiskCleanupPlan, error)
	CleanDisk(context.Context, string, []string) (DiskCleanupResult, error)
	Status(context.Context, string) (Status, error)
	Compatibility(context.Context, string) (compatibility.Tuple, error)
	PrepareMutation(context.Context, string) (MutationPreparation, error)
	CaptureRunningServiceProcesses(context.Context, string, []string) ([]string, error)
	ApplyManagedState(context.Context, string, []string) (bool, error)
	VerifyManagedState(context.Context, string, []string, []string) (Verification, error)
	RestoreBootState(context.Context, string, string) (string, error)
}

type Client struct {
	runner            commandRunner
	helperVersion     string
	helperBuildCommit string
	measureProcesses  func(context.Context, string) ([]simslim.Process, error)
}

type commandResult struct {
	stdout   []byte
	stderr   []byte
	exitCode int
}

type commandRunner interface {
	Run(context.Context, time.Duration, string, ...string) (commandResult, error)
}

type fixedRunner struct{}

func NewClient(helperVersion, helperBuildCommit string) *Client {
	return &Client{
		runner:            fixedRunner{},
		helperVersion:     helperVersion,
		helperBuildCommit: helperBuildCommit,
		measureProcesses:  simslim.MeasureProcesses,
	}
}

func (client *Client) List(ctx context.Context) ([]Device, error) {
	if runtime.GOOS != "darwin" {
		return nil, errors.New("iOS Simulator discovery is available only on macOS")
	}
	result, err := client.runXcrun(ctx, commandTimeout, "simctl", "list", "devices", "available", "--json")
	if err != nil {
		return nil, fmt.Errorf("list simulators: %w", err)
	}
	if result.exitCode != 0 {
		return nil, errors.New("list simulators: simctl exited unsuccessfully")
	}
	return parseDeviceList(result.stdout)
}

func (client *Client) Clone(ctx context.Context, simulatorID, name string) (string, string, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return "", "", errors.New("simulator ID is not a canonical UDID")
	}
	normalizedName, err := simslim.NormalizeSimulatorName(name)
	if err != nil {
		return "", "", errors.New("simulator name is invalid")
	}
	cloneID, err := simslim.CloneDevice(ctx, simulatorID, normalizedName)
	if err != nil {
		return "", "", errors.New("pinned SimSlim could not safely prepare the clone")
	}
	if !UDIDPattern.MatchString(cloneID) {
		return "", "", errors.New("pinned SimSlim returned an invalid clone ID")
	}
	return cloneID, normalizedName, nil
}

func (client *Client) PlanDiskCleanup(ctx context.Context, simulatorID string) (DiskCleanupPlan, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return DiskCleanupPlan{}, errors.New("simulator ID is not a canonical UDID")
	}
	plan, err := simslim.PlanDiskCleanup(ctx, simulatorID)
	if err != nil {
		return DiskCleanupPlan{}, errors.New("pinned SimSlim could not inspect the exact simulator disk")
	}
	if !strings.EqualFold(plan.UDID, simulatorID) {
		return DiskCleanupPlan{}, errors.New("pinned SimSlim returned a mismatched simulator disk plan")
	}
	return plan, nil
}

func (client *Client) CleanDisk(ctx context.Context, simulatorID string, categoryIDs []string) (DiskCleanupResult, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return DiskCleanupResult{}, errors.New("simulator ID is not a canonical UDID")
	}
	validated, err := simslim.ValidateDiskCleanupSelection(categoryIDs)
	if err != nil {
		return DiskCleanupResult{}, errors.New("disk cleanup selection is not in the pinned SimSlim allowlist")
	}
	result, err := simslim.CleanDeviceDisk(ctx, simulatorID, validated, true)
	if err != nil {
		return DiskCleanupResult{}, errors.New("pinned SimSlim could not safely clean the exact simulator disk")
	}
	if !strings.EqualFold(result.UDID, simulatorID) {
		return DiskCleanupResult{}, errors.New("pinned SimSlim returned a mismatched simulator cleanup result")
	}
	if result.WasBooted && !result.BootStateRestored {
		return DiskCleanupResult{}, errors.New("pinned SimSlim did not restore the simulator boot state")
	}
	return result, nil
}

func (client *Client) Status(ctx context.Context, simulatorID string) (Status, error) {
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return Status{}, err
	}
	if device.State == "Booted" {
		return client.statusForBootedDevice(ctx, device)
	}
	if device.State != "Shutdown" {
		return Status{}, fmt.Errorf("simulator is in transient state %s", device.State)
	}

	preparation, err := client.PrepareMutation(ctx, simulatorID)
	if err != nil {
		return Status{}, err
	}
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), bootTimeout)
	defer cancel()
	if _, err := client.RestoreBootState(cleanupContext, simulatorID, device.State); err != nil {
		return Status{}, fmt.Errorf("could not restore simulator boot state after inspection: %w", err)
	}
	return Status{
		Device:                    device,
		ManagedDisabledServiceIDs: preparation.State.ManagedDisabledServiceIDs,
		ManagedDisabledCount:      preparation.State.Count,
		ManagedServiceCount:       len(catalog.ManagedServiceIDs()),
	}, nil
}

func (client *Client) Compatibility(ctx context.Context, simulatorID string) (compatibility.Tuple, error) {
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return compatibility.Tuple{}, err
	}
	return client.compatibilityTuple(ctx, device.RuntimeIdentifier)
}

func (client *Client) PrepareMutation(ctx context.Context, simulatorID string) (MutationPreparation, error) {
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return MutationPreparation{}, err
	}
	if device.State != "Booted" && device.State != "Shutdown" {
		return MutationPreparation{}, fmt.Errorf("simulator is in transient state %s", device.State)
	}
	preparation := MutationPreparation{
		Device:            device,
		OriginalBootState: device.State,
		TemporarilyBooted: device.State == "Shutdown",
	}
	cleanupOnError := func(cause error) (MutationPreparation, error) {
		if preparation.TemporarilyBooted {
			cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), bootTimeout)
			defer cancel()
			cleanupErr := client.ensureShutdown(cleanupContext, device.ID)
			if cleanupErr != nil {
				return MutationPreparation{}, fmt.Errorf("%w; temporary boot cleanup also failed", cause)
			}
		}
		return MutationPreparation{}, cause
	}
	if preparation.TemporarilyBooted {
		if err := client.boot(ctx, device.ID); err != nil {
			return cleanupOnError(err)
		}
	}

	bootedDevice, err := client.findDevice(ctx, device.ID)
	if err != nil {
		return cleanupOnError(err)
	}
	if bootedDevice.State != "Booted" {
		return cleanupOnError(errors.New("simulator did not reach Booted state"))
	}
	status, err := client.statusForBootedDevice(ctx, bootedDevice)
	if err != nil {
		return cleanupOnError(err)
	}
	tuple, err := client.compatibilityTuple(ctx, bootedDevice.RuntimeIdentifier)
	if err != nil {
		return cleanupOnError(err)
	}
	preparation.Device = bootedDevice
	preparation.State = managedState(status.ManagedDisabledServiceIDs)
	preparation.Tuple = tuple
	return preparation, nil
}

// CaptureRunningServiceProcesses binds a mutation to the executable names of
// jobs that are actually running in this exact Simulator before their launchd
// labels are disabled. It never reads process environments. Missing/on-demand
// jobs contribute no process name; ambiguous launchd/PID mappings fail closed.
func (client *Client) CaptureRunningServiceProcesses(ctx context.Context, simulatorID string, serviceIDs []string) ([]string, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return nil, errors.New("simulator ID is not a canonical UDID")
	}
	if err := validateManagedIDs(serviceIDs); err != nil {
		return nil, err
	}
	if len(serviceIDs) == 0 {
		return []string{}, nil
	}
	services, err := client.launchdServices(ctx, simulatorID)
	if err != nil {
		return nil, errors.New("could not inspect the Simulator launchd service domains")
	}
	type runningJob struct {
		label string
		pid   int
	}
	runningJobs := make([]runningJob, 0, len(serviceIDs))
	for _, serviceID := range serviceIDs {
		pid, registered := services[serviceID]
		if registered && pid > 0 {
			runningJobs = append(runningJobs, runningJob{label: serviceID, pid: pid})
		}
	}
	if len(runningJobs) == 0 {
		return []string{}, nil
	}
	processes, err := client.measureProcesses(ctx, simulatorID)
	if err != nil {
		return nil, errors.New("could not inspect the exact Simulator process tree")
	}
	processByPID := make(map[int]string, len(processes))
	processNameCounts := make(map[string]int, len(processes))
	for _, process := range processes {
		if process.PID <= 0 || !ProcessNamePattern.MatchString(process.Command) {
			return nil, errors.New("the Simulator process tree contained invalid identity data")
		}
		if _, duplicatePID := processByPID[process.PID]; duplicatePID {
			return nil, errors.New("the Simulator process tree contained a duplicate PID")
		}
		processByPID[process.PID] = process.Command
		processNameCounts[process.Command]++
	}
	names := make([]string, 0, len(runningJobs))
	boundPIDs := make(map[int]bool, len(runningJobs))
	for _, job := range runningJobs {
		command, found := processByPID[job.pid]
		if !found {
			return nil, fmt.Errorf(
				"launchd job %s (pid %d) did not match the exact Simulator process tree",
				job.label,
				job.pid,
			)
		}
		// Naming the label and executable turns a transient fail-closed into
		// something a person can act on instead of a sentence they can only retry.
		if boundPIDs[job.pid] || processNameCounts[command] != 1 {
			return nil, fmt.Errorf(
				"running launchd job %s (pid %d, executable %s) was not unique in the exact Simulator process tree: %d processes share that executable name",
				job.label,
				job.pid,
				command,
				processNameCounts[command],
			)
		}
		boundPIDs[job.pid] = true
		names = append(names, command)
	}
	return sortedUniqueCopy(names), nil
}

func (client *Client) ApplyManagedState(ctx context.Context, simulatorID string, desired []string) (bool, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return false, errors.New("simulator ID is not a canonical UDID")
	}
	if err := validateManagedIDs(desired); err != nil {
		return false, err
	}
	device, err := simslim.FindDevice(ctx, simulatorID, "default")
	if err != nil {
		return false, errors.New("pinned SimSlim could not resolve the exact simulator")
	}
	if len(desired) == 0 {
		return simslim.DisableSlim(ctx, device.Set, device.UDID, nil)
	}
	profile, err := catalog.UpstreamProfileForDesired(desired)
	if err != nil {
		return false, err
	}
	return simslim.EnableSlim(ctx, device.Set, device.UDID, profile, nil)
}

func (client *Client) VerifyManagedState(ctx context.Context, simulatorID string, desired, observedProcessNames []string) (evidence Verification, resultErr error) {
	desired = sortedUniqueCopy(desired)
	if err := validateManagedIDs(desired); err != nil {
		return Verification{}, err
	}
	observedProcessNames = sortedUniqueCopy(observedProcessNames)
	for _, processName := range observedProcessNames {
		if !ProcessNamePattern.MatchString(processName) {
			return Verification{}, errors.New("observed process name is invalid")
		}
	}
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return Verification{}, err
	}
	var status Status
	if device.State == "Shutdown" {
		preparation, preparationErr := client.PrepareMutation(ctx, simulatorID)
		if preparationErr != nil {
			return Verification{}, preparationErr
		}
		status = Status{
			Device:                    device,
			ManagedDisabledServiceIDs: preparation.State.ManagedDisabledServiceIDs,
			ManagedDisabledCount:      preparation.State.Count,
			ManagedServiceCount:       len(catalog.ManagedServiceIDs()),
		}
		defer func() {
			cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), bootTimeout)
			defer cancel()
			if _, restoreErr := client.RestoreBootState(cleanupContext, simulatorID, "Shutdown"); restoreErr != nil {
				evidence.Verified = false
				reason := "could not restore the Simulator shutdown state after verification"
				if resultErr != nil {
					reason = resultErr.Error() + "; " + reason
				}
				resultErr = &VerificationError{Evidence: evidence, Reason: reason}
			}
		}()
	} else if device.State == "Booted" {
		status, err = client.statusForBootedDevice(ctx, device)
		if err != nil {
			return Verification{}, err
		}
	} else {
		return Verification{}, fmt.Errorf("simulator is in transient state %s", device.State)
	}
	current := sortedUniqueCopy(status.ManagedDisabledServiceIDs)
	currentSet := sliceSet(current)
	desiredSet := sliceSet(desired)
	evidence = Verification{
		CurrentManagedDisabledIDs:       current,
		DesiredManagedDisabledIDs:       desired,
		MissingDisabledServiceIDs:       setDifference(desiredSet, currentSet),
		UnexpectedDisabledServiceIDs:    setDifference(currentSet, desiredSet),
		RegisteredDisabledLaunchdJobIDs: []string{},
		CheckedObservedProcessNames:     observedProcessNames,
		PresentObservedProcessNames:     []string{},
	}
	evidence.OverridesMatch = len(evidence.MissingDisabledServiceIDs) == 0 && len(evidence.UnexpectedDisabledServiceIDs) == 0

	if len(desired) > 0 {
		services, servicesErr := client.launchdServices(ctx, simulatorID)
		if servicesErr != nil {
			return evidence, &VerificationError{Evidence: evidence, Reason: "could not prove disabled launchd job registrations were absent"}
		}
		for _, serviceID := range desired {
			evidence.CheckedDisabledLaunchdJobRegistrationCount++
			if _, registered := services[serviceID]; registered {
				evidence.RegisteredDisabledLaunchdJobIDs = append(evidence.RegisteredDisabledLaunchdJobIDs, serviceID)
			}
		}
	}
	evidence.DisabledLaunchdJobRegistrationsAbsent = len(evidence.RegisteredDisabledLaunchdJobIDs) == 0
	if len(observedProcessNames) > 0 {
		processes, processErr := client.measureProcesses(ctx, simulatorID)
		if processErr != nil {
			return evidence, &VerificationError{Evidence: evidence, Reason: "could not inspect the exact Simulator process tree"}
		}
		runningNames := make(map[string]bool, len(processes))
		for _, process := range processes {
			runningNames[process.Command] = true
		}
		for _, processName := range observedProcessNames {
			if runningNames[processName] {
				evidence.PresentObservedProcessNames = append(evidence.PresentObservedProcessNames, processName)
			}
		}
	}
	evidence.ObservedPreMutationProcessesAbsent = len(evidence.PresentObservedProcessNames) == 0
	evidence.Verified = evidence.OverridesMatch && evidence.DisabledLaunchdJobRegistrationsAbsent && evidence.ObservedPreMutationProcessesAbsent
	return evidence, nil
}

// launchdServices snapshots the only two launchd domains used by Simulator
// system daemons and mobile user agents. A single bounded snapshot per domain
// avoids one subprocess per managed service and lets verification prove the
// registration state in the domain where the jobs actually live.
func (client *Client) launchdServices(ctx context.Context, simulatorID string) (map[string]int, error) {
	services := make(map[string]int)
	for _, domain := range []string{"user/501", "system"} {
		result, err := client.runXcrun(
			ctx,
			commandTimeout,
			"simctl",
			"spawn",
			simulatorID,
			"launchctl",
			"print",
			domain,
		)
		if err != nil || result.exitCode != 0 {
			return nil, errors.New("launchctl domain snapshot failed")
		}
		domainServices, err := parseLaunchdServices(result.stdout)
		if err != nil {
			return nil, err
		}
		for label, pid := range domainServices {
			if _, duplicate := services[label]; duplicate {
				return nil, errors.New("launchctl label appeared in multiple service domains")
			}
			services[label] = pid
		}
	}
	return services, nil
}

func parseLaunchdServices(output []byte) (map[string]int, error) {
	services := make(map[string]int)
	inServices := false
	foundServices := false
	for _, rawLine := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(rawLine)
		if !inServices {
			if line != "services = {" {
				continue
			}
			if foundServices {
				return nil, errors.New("launchctl snapshot contained multiple services blocks")
			}
			foundServices = true
			inServices = true
			continue
		}
		if line == "}" {
			inServices = false
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 || !launchdLabelPattern.MatchString(fields[2]) {
			return nil, errors.New("launchctl services block was malformed")
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid < 0 {
			return nil, errors.New("launchctl service PID was invalid")
		}
		if _, duplicate := services[fields[2]]; duplicate {
			return nil, errors.New("launchctl services block contained a duplicate label")
		}
		services[fields[2]] = pid
		if len(services) > maxLaunchdServices {
			return nil, errors.New("launchctl services block exceeded the service limit")
		}
	}
	if !foundServices || inServices {
		return nil, errors.New("launchctl snapshot did not contain one complete services block")
	}
	return services, nil
}

func (client *Client) RestoreBootState(ctx context.Context, simulatorID, desiredState string) (string, error) {
	if desiredState != "Booted" && desiredState != "Shutdown" {
		return "Unknown", errors.New("original boot state is invalid")
	}
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return "Unknown", err
	}
	if device.State == desiredState {
		return desiredState, nil
	}
	switch {
	case desiredState == "Booted" && device.State == "Shutdown":
		err = client.boot(ctx, device.ID)
	case desiredState == "Shutdown" && device.State == "Booted":
		err = client.shutdown(ctx, device.ID)
	default:
		err = fmt.Errorf("simulator is in transient state %s", device.State)
	}
	if err != nil {
		return "Unknown", err
	}
	device, err = client.findDevice(ctx, simulatorID)
	if err != nil || device.State != desiredState {
		return "Unknown", errors.New("could not prove the original simulator boot state was restored")
	}
	return device.State, nil
}

func (client *Client) statusForBootedDevice(ctx context.Context, device Device) (Status, error) {
	result, err := client.runXcrun(ctx, commandTimeout, "simctl", "spawn", device.ID, "launchctl", "print-disabled", "system")
	if err != nil || result.exitCode != 0 {
		return Status{}, errors.New("read simulator service state: launchctl failed")
	}
	disabled := simslim.ParseDisabledOutput(string(result.stdout))
	managedSet := sliceSet(catalog.ManagedServiceIDs())
	managedDisabled := make([]string, 0)
	for serviceID, isDisabled := range disabled {
		if _, managed := managedSet[serviceID]; managed && isDisabled {
			managedDisabled = append(managedDisabled, serviceID)
		}
	}
	sort.Strings(managedDisabled)

	matchingProfiles := make([]string, 0)
	for _, profile := range catalog.Profiles() {
		desired, desiredErr := catalog.DesiredServiceIDs(profile.ID)
		if desiredErr == nil && slices.Equal(desired, managedDisabled) {
			matchingProfiles = append(matchingProfiles, profile.ID)
		}
	}
	return Status{
		Device:                    device,
		ManagedDisabledServiceIDs: managedDisabled,
		ManagedDisabledCount:      len(managedDisabled),
		ManagedServiceCount:       len(managedSet),
		MatchingProfileIDs:        matchingProfiles,
	}, nil
}

func (client *Client) findDevice(ctx context.Context, simulatorID string) (Device, error) {
	if !UDIDPattern.MatchString(simulatorID) {
		return Device{}, errors.New("simulator ID is not a canonical UDID")
	}
	devices, err := client.List(ctx)
	if err != nil {
		return Device{}, err
	}
	for _, device := range devices {
		if strings.EqualFold(device.ID, simulatorID) {
			return device, nil
		}
	}
	return Device{}, errors.New("simulator was not found in the current default device set")
}

func (client *Client) compatibilityTuple(ctx context.Context, runtimeIdentifier string) (compatibility.Tuple, error) {
	macResult, err := client.runner.Run(ctx, commandTimeout, swVersExecutable, "-buildVersion")
	if err != nil || macResult.exitCode != 0 {
		return compatibility.Tuple{}, errors.New("could not read the macOS build")
	}
	macBuild := strings.TrimSpace(string(macResult.stdout))
	if !buildLineValue(macBuild) {
		return compatibility.Tuple{}, errors.New("macOS returned an invalid build identifier")
	}
	xcodeResult, err := client.runXcrun(ctx, commandTimeout, "xcodebuild", "-version")
	if err != nil || xcodeResult.exitCode != 0 {
		return compatibility.Tuple{}, errors.New("could not read the Xcode build")
	}
	match := buildLinePattern.FindSubmatch(xcodeResult.stdout)
	if len(match) != 2 {
		return compatibility.Tuple{}, errors.New("Xcode returned an invalid build identifier")
	}
	coreSimulatorResult, err := client.runXcrun(ctx, commandTimeout, "simctl", "--version")
	if err != nil || coreSimulatorResult.exitCode != 0 {
		return compatibility.Tuple{}, errors.New("could not read the CoreSimulator build")
	}
	coreSimulatorMatch := coreSimulatorPattern.FindSubmatch(coreSimulatorResult.stdout)
	if len(coreSimulatorMatch) != 2 {
		return compatibility.Tuple{}, errors.New("simctl returned an invalid CoreSimulator build")
	}
	runtimeBuild, err := client.runtimeBuild(ctx, runtimeIdentifier)
	if err != nil {
		return compatibility.Tuple{}, err
	}
	architectureResult, err := client.runner.Run(ctx, commandTimeout, sysctlExecutable, "-n", "hw.optional.arm64")
	if err != nil || architectureResult.exitCode != 0 {
		return compatibility.Tuple{}, errors.New("could not determine the native host architecture")
	}
	architecture := "x64"
	switch strings.TrimSpace(string(architectureResult.stdout)) {
	case "1":
		architecture = "arm64"
	case "0":
	default:
		return compatibility.Tuple{}, errors.New("sysctl returned an invalid native host architecture")
	}
	return compatibility.Tuple{
		MacOSBuild:         macBuild,
		XcodeBuild:         string(match[1]),
		CoreSimulatorBuild: string(coreSimulatorMatch[1]),
		RuntimeIdentifier:  runtimeIdentifier,
		RuntimeBuild:       runtimeBuild,
		HostArchitecture:   architecture,
		HelperVersion:      client.helperVersion,
		HelperBuildCommit:  client.helperBuildCommit,
		CatalogVersion:     catalog.Version,
	}, nil
}

func (client *Client) runtimeBuild(ctx context.Context, runtimeIdentifier string) (string, error) {
	result, err := client.runXcrun(ctx, commandTimeout, "simctl", "list", "runtimes", "--json")
	if err != nil || result.exitCode != 0 {
		return "", errors.New("could not read installed Simulator runtimes")
	}
	var payload struct {
		Runtimes []struct {
			Identifier   string `json:"identifier"`
			BuildVersion string `json:"buildversion"`
			Available    bool   `json:"isAvailable"`
		} `json:"runtimes"`
	}
	decoder := json.NewDecoder(bytes.NewReader(result.stdout))
	if err := decoder.Decode(&payload); err != nil || len(payload.Runtimes) > maxRuntimes {
		return "", errors.New("simctl returned invalid runtime JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", errors.New("simctl returned invalid runtime JSON")
	}
	for _, candidate := range payload.Runtimes {
		if candidate.Identifier == runtimeIdentifier && candidate.Available {
			if !buildLineValue(candidate.BuildVersion) {
				return "", errors.New("simctl returned an invalid runtime build")
			}
			return candidate.BuildVersion, nil
		}
	}
	return "", errors.New("the exact Simulator runtime build was not found")
}

func (client *Client) boot(ctx context.Context, simulatorID string) error {
	result, err := client.runXcrun(ctx, bootTimeout, "simctl", "boot", simulatorID)
	if err != nil || result.exitCode != 0 {
		diagnostic := strings.ToLower(strings.TrimSpace(string(append(append([]byte(nil), result.stdout...), result.stderr...))))
		if !strings.Contains(diagnostic, "already booted") && !strings.Contains(diagnostic, "current state: booted") {
			return errors.New("simctl could not boot the exact simulator")
		}
	}
	result, err = client.runXcrun(ctx, bootTimeout, "simctl", "bootstatus", simulatorID, "-b")
	if err != nil || result.exitCode != 0 {
		return errors.New("simctl could not prove the exact simulator finished booting")
	}
	return nil
}

func (client *Client) shutdown(ctx context.Context, simulatorID string) error {
	result, err := client.runXcrun(ctx, simslim.ShutdownTimeout, "simctl", "shutdown", simulatorID)
	if err != nil || result.exitCode != 0 {
		diagnostic := strings.ToLower(strings.TrimSpace(string(append(append([]byte(nil), result.stdout...), result.stderr...))))
		if !strings.Contains(diagnostic, "current state: shutdown") {
			return errors.New("simctl could not shut down the exact simulator")
		}
	}
	deadline := time.NewTimer(simslim.ShutdownTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		device, findErr := client.findDevice(ctx, simulatorID)
		if findErr != nil {
			return findErr
		}
		if device.State == "Shutdown" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("timed out waiting for the exact simulator to shut down")
		case <-ticker.C:
		}
	}
}

func (client *Client) ensureShutdown(ctx context.Context, simulatorID string) error {
	device, err := client.findDevice(ctx, simulatorID)
	if err != nil {
		return err
	}
	if device.State == "Shutdown" {
		return nil
	}
	return client.shutdown(ctx, simulatorID)
}

func (client *Client) runXcrun(ctx context.Context, timeout time.Duration, args ...string) (commandResult, error) {
	return client.runner.Run(ctx, timeout, xcrunExecutable, args...)
}

func validateManagedIDs(values []string) error {
	if len(values) > maximumManagedIDs {
		return errors.New("managed service set exceeds its safety limit")
	}
	allowlist := sliceSet(catalog.ManagedServiceIDs())
	seen := make(map[string]struct{}, len(values))
	for _, serviceID := range values {
		if _, allowed := allowlist[serviceID]; !allowed {
			return errors.New("managed service set contains a non-catalog label")
		}
		if _, duplicate := seen[serviceID]; duplicate {
			return errors.New("managed service set contains a duplicate label")
		}
		seen[serviceID] = struct{}{}
	}
	return nil
}

type simctlList struct {
	Devices map[string][]struct {
		UDID                 string `json:"udid"`
		Name                 string `json:"name"`
		State                string `json:"state"`
		Available            bool   `json:"isAvailable"`
		DeviceTypeIdentifier string `json:"deviceTypeIdentifier"`
	} `json:"devices"`
}

func parseDeviceList(data []byte) ([]Device, error) {
	var payload simctlList
	// simctl adds fields to individual device records between Xcode versions, so
	// decode the stable projection separately rather than rejecting those fields.
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&payload); err != nil {
		return nil, errors.New("simctl returned invalid device JSON")
	}
	devices := make([]Device, 0)
	for runtimeID, runtimeDevices := range payload.Devices {
		if !runtimePattern.MatchString(runtimeID) {
			continue
		}
		for _, device := range runtimeDevices {
			if len(devices) >= maxDevices {
				break
			}
			name, validName := boundedText(device.Name, 128)
			if !device.Available || !UDIDPattern.MatchString(device.UDID) || !validName {
				continue
			}
			deviceType := ""
			if deviceTypePattern.MatchString(device.DeviceTypeIdentifier) {
				deviceType = device.DeviceTypeIdentifier
			}
			devices = append(devices, Device{
				ID:                   device.UDID,
				Name:                 name,
				State:                normalizedState(device.State),
				RuntimeIdentifier:    runtimeID,
				DeviceTypeIdentifier: deviceType,
				Available:            true,
			})
		}
	}
	sort.Slice(devices, func(i, j int) bool {
		if devices[i].RuntimeIdentifier != devices[j].RuntimeIdentifier {
			return devices[i].RuntimeIdentifier > devices[j].RuntimeIdentifier
		}
		if devices[i].Name != devices[j].Name {
			return devices[i].Name < devices[j].Name
		}
		return devices[i].ID < devices[j].ID
	})
	return devices, nil
}

func boundedText(value string, maximumLength int) (string, bool) {
	value = strings.TrimSpace(value)
	return value, value != "" && len(value) <= maximumLength
}

func normalizedState(value string) string {
	switch value {
	case "Booted", "Shutdown", "Booting", "Shutting Down", "Creating":
		return value
	default:
		return "Unknown"
	}
}

func (fixedRunner) Run(parent context.Context, timeout time.Duration, executable string, args ...string) (commandResult, error) {
	if executable != xcrunExecutable && executable != swVersExecutable && executable != sysctlExecutable {
		return commandResult{}, errors.New("executable is not allowlisted")
	}
	return runBounded(parent, timeout, executable, args...)
}

func runBounded(parent context.Context, timeout time.Duration, executable string, args ...string) (commandResult, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.Env = allowedEnvironment()
	// Killing simctl does not close the output pipes it handed to a process
	// inside the Simulator (simctl spawn), so an unbounded Wait would block
	// until that process exits on its own, past both the timeout and FD 4
	// cancellation. WaitDelay closes the pipes shortly after the kill or exit.
	command.WaitDelay = commandWaitDelay
	stdout := &limitedBuffer{limit: maxStdoutBytes}
	stderr := &limitedBuffer{limit: maxStderrBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	result := commandResult{stdout: stdout.Bytes(), stderr: stderr.Bytes(), exitCode: 0}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return commandResult{}, errors.New("native command timed out")
	}
	if errors.Is(err, exec.ErrWaitDelay) {
		return commandResult{}, errors.New("native command exited but a process it started kept its output open")
	}
	if stdout.overflow || stderr.overflow {
		return commandResult{}, errors.New("native command output exceeded its safety limit")
	}
	if err == nil {
		return result, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.exitCode = exitError.ExitCode()
		return result, nil
	}
	return commandResult{}, errors.New("native command failed to start")
}

type limitedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (buffer *limitedBuffer) Write(data []byte) (int, error) {
	if buffer.buffer.Len()+len(data) > buffer.limit {
		buffer.overflow = true
		return 0, errors.New("output limit exceeded")
	}
	return buffer.buffer.Write(data)
}

func (buffer *limitedBuffer) Bytes() []byte {
	return buffer.buffer.Bytes()
}

func allowedEnvironment() []string {
	allowed := map[string]struct{}{
		"DEVELOPER_DIR": {},
		"HOME":          {},
		"LOGNAME":       {},
		"PATH":          {},
		"TMPDIR":        {},
		"USER":          {},
	}
	environment := make([]string, 0, len(allowed))
	for _, entry := range os.Environ() {
		name, _, found := strings.Cut(entry, "=")
		if _, ok := allowed[name]; found && ok {
			environment = append(environment, entry)
		}
	}
	// Verification recognizes one exact launchctl diagnostic. Force the C
	// locale so a localized host cannot turn absence into an ambiguous result.
	environment = append(environment, "LANG=C", "LC_ALL=C")
	return environment
}

func buildLineValue(value string) bool {
	if len(value) < 2 || len(value) > 32 {
		return false
	}
	for _, character := range value {
		if (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') && character != '.' {
			return false
		}
	}
	return true
}

func managedState(values []string) ManagedState {
	values = sortedUniqueCopy(values)
	return ManagedState{ManagedDisabledServiceIDs: values, Count: len(values)}
}

func sortedUniqueCopy(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return slices.Compact(out)
}

func sliceSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set
}

func setDifference(left, right map[string]struct{}) []string {
	values := make([]string, 0)
	for value := range left {
		if _, exists := right[value]; !exists {
			values = append(values, value)
		}
	}
	sort.Strings(values)
	return values
}

var _ io.Writer = (*limitedBuffer)(nil)
