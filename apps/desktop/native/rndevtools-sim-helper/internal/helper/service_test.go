package helper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/authorization"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/simulator"
	"github.com/mobai-app/simslim"
)

const helperTestUDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"

type fakeBackend struct {
	device                  simulator.Device
	managed                 []string
	tuple                   compatibility.Tuple
	err                     error
	applyCalls              int
	rebootCalls             int
	verifyCalls             int
	restoreCalls            int
	captureProcessCalls     int
	failApplyCalls          map[int]bool
	failRebootCalls         map[int]bool
	inconclusiveVerifyCalls map[int]bool
	presentVerifyCalls      map[int]bool
	failRestoreCalls        map[int]bool
	failCaptureProcessCalls map[int]bool
	capturedProcesses       map[int][]string
	verifiedProcesses       map[int][]string
	cloneCalls              int
	diskPlanCalls           int
	diskCleanupCalls        int
	diskCleanupCategoryIDs  []string
}

func newFakeBackend(managed ...string) *fakeBackend {
	return &fakeBackend{
		device: simulator.Device{
			ID:                helperTestUDID,
			Name:              "iPhone Test",
			State:             "Booted",
			RuntimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
			Available:         true,
		},
		managed: canonicalManagedIDs(managed),
		tuple: compatibility.Tuple{
			MacOSBuild:         "25G88",
			XcodeBuild:         "17G42",
			CoreSimulatorBuild: "1051.55",
			RuntimeIdentifier:  "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
			RuntimeBuild:       "23F77",
			HostArchitecture:   "arm64",
			HelperVersion:      "0.1.0",
			HelperBuildCommit:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			CatalogVersion:     catalog.Version,
		},
		failApplyCalls:          map[int]bool{},
		failRebootCalls:         map[int]bool{},
		inconclusiveVerifyCalls: map[int]bool{},
		presentVerifyCalls:      map[int]bool{},
		failRestoreCalls:        map[int]bool{},
		failCaptureProcessCalls: map[int]bool{},
		capturedProcesses:       map[int][]string{},
		verifiedProcesses:       map[int][]string{},
	}
}

func (backend *fakeBackend) List(context.Context) ([]simulator.Device, error) {
	if backend.err != nil {
		return nil, backend.err
	}
	return []simulator.Device{backend.device}, nil
}

func (backend *fakeBackend) Clone(_ context.Context, simulatorID, name string) (string, string, error) {
	backend.cloneCalls++
	if backend.err != nil || simulatorID != backend.device.ID {
		return "", "", errors.New("clone failed")
	}
	return "BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF", name, nil
}

func (backend *fakeBackend) PlanDiskCleanup(context.Context, string) (simulator.DiskCleanupPlan, error) {
	backend.diskPlanCalls++
	if backend.err != nil {
		return simulator.DiskCleanupPlan{}, backend.err
	}
	return simulator.DiskCleanupPlan{
		UDID:           backend.device.ID,
		TotalBytes:     8_192,
		CleanableBytes: 4_096,
		Categories: []simslim.DiskCleanupCategoryMeasurement{{
			DiskCleanupCategory: simslim.DiskCleanupCategory{
				ID:              "caches",
				Name:            "System & App Caches",
				Description:     "Generated caches.",
				Downside:        "Next launches may be slower.",
				Recovery:        "Caches are rebuilt.",
				Risk:            "Lower risk",
				DefaultSelected: true,
				CanClean:        true,
			},
			Bytes:   4_096,
			Targets: 2,
		}},
		Storage: []simslim.DiskStorageMeasurement{{
			ID:          "documents",
			Name:        "Documents",
			Description: "Durable app documents.",
			Bytes:       2_048,
		}},
	}, nil
}

func (backend *fakeBackend) CleanDisk(_ context.Context, _ string, categoryIDs []string) (simulator.DiskCleanupResult, error) {
	backend.diskCleanupCalls++
	backend.diskCleanupCategoryIDs = append([]string(nil), categoryIDs...)
	if backend.err != nil {
		return simulator.DiskCleanupResult{}, backend.err
	}
	return simulator.DiskCleanupResult{
		UDID:              backend.device.ID,
		CategoryIDs:       append([]string(nil), categoryIDs...),
		BeforeBytes:       4_096,
		AfterBytes:        1_024,
		ReclaimedBytes:    3_072,
		WasBooted:         true,
		BootStateRestored: true,
	}, nil
}

func (backend *fakeBackend) Status(context.Context, string) (simulator.Status, error) {
	if backend.err != nil {
		return simulator.Status{}, backend.err
	}
	return simulator.Status{
		Device:                    backend.device,
		ManagedDisabledServiceIDs: canonicalManagedIDs(backend.managed),
		ManagedDisabledCount:      len(backend.managed),
		ManagedServiceCount:       len(catalog.ManagedServiceIDs()),
	}, nil
}

func (backend *fakeBackend) Compatibility(context.Context, string) (compatibility.Tuple, error) {
	return backend.tuple, backend.err
}

func (backend *fakeBackend) PrepareMutation(context.Context, string) (simulator.MutationPreparation, error) {
	if backend.err != nil {
		return simulator.MutationPreparation{}, backend.err
	}
	original := backend.device.State
	temporary := original == "Shutdown"
	backend.device.State = "Booted"
	state := simulator.ManagedState{ManagedDisabledServiceIDs: canonicalManagedIDs(backend.managed), Count: len(backend.managed)}
	return simulator.MutationPreparation{
		Device:            backend.device,
		OriginalBootState: original,
		TemporarilyBooted: temporary,
		State:             state,
		Tuple:             backend.tuple,
	}, nil
}

func (backend *fakeBackend) CaptureRunningServiceProcesses(context.Context, string, []string) ([]string, error) {
	backend.captureProcessCalls++
	if backend.failCaptureProcessCalls[backend.captureProcessCalls] {
		return nil, errors.New("injected process mapping failure")
	}
	return append([]string(nil), backend.capturedProcesses[backend.captureProcessCalls]...), nil
}

func (backend *fakeBackend) ApplyManagedState(_ context.Context, _ string, desired []string) (bool, error) {
	backend.applyCalls++
	current := canonicalManagedIDs(backend.managed)
	desired = canonicalManagedIDs(desired)
	toDisable := difference(stringSet(desired), stringSet(current))
	toEnable := difference(stringSet(current), stringSet(desired))
	if backend.failApplyCalls[backend.applyCalls] {
		if len(toEnable) > 0 {
			backend.remove(toEnable[0])
		} else if len(toDisable) > 0 {
			backend.add(toDisable[0])
		}
		return true, errors.New("injected apply failure")
	}
	backend.managed = desired
	backend.rebootCalls++
	if backend.failRebootCalls[backend.rebootCalls] {
		return true, errors.New("injected reboot failure")
	}
	backend.device.State = "Booted"
	return true, nil
}

func (backend *fakeBackend) VerifyManagedState(_ context.Context, _ string, desired, observedProcessNames []string) (simulator.Verification, error) {
	backend.verifyCalls++
	backend.verifiedProcesses[backend.verifyCalls] = append([]string(nil), observedProcessNames...)
	current := canonicalManagedIDs(backend.managed)
	desired = canonicalManagedIDs(desired)
	currentSet := stringSet(current)
	desiredSet := stringSet(desired)
	evidence := simulator.Verification{
		CurrentManagedDisabledIDs:                  current,
		DesiredManagedDisabledIDs:                  desired,
		OverridesMatch:                             slices.Equal(current, desired),
		MissingDisabledServiceIDs:                  difference(desiredSet, currentSet),
		UnexpectedDisabledServiceIDs:               difference(currentSet, desiredSet),
		DisabledLaunchdJobRegistrationsAbsent:      true,
		CheckedDisabledLaunchdJobRegistrationCount: len(desired),
		RegisteredDisabledLaunchdJobIDs:            []string{},
		ObservedPreMutationProcessesAbsent:         true,
		CheckedObservedProcessNames:                append([]string(nil), observedProcessNames...),
		PresentObservedProcessNames:                []string{},
	}
	if backend.presentVerifyCalls[backend.verifyCalls] && len(desired) > 0 {
		evidence.RegisteredDisabledLaunchdJobIDs = []string{desired[0]}
		evidence.DisabledLaunchdJobRegistrationsAbsent = false
	}
	evidence.Verified = evidence.OverridesMatch && evidence.DisabledLaunchdJobRegistrationsAbsent && evidence.ObservedPreMutationProcessesAbsent
	if backend.inconclusiveVerifyCalls[backend.verifyCalls] {
		return evidence, &simulator.VerificationError{Evidence: evidence, Reason: "injected inconclusive verification"}
	}
	return evidence, nil
}

func (backend *fakeBackend) RestoreBootState(_ context.Context, _ string, state string) (string, error) {
	backend.restoreCalls++
	if backend.failRestoreCalls[backend.restoreCalls] {
		return "Unknown", errors.New("injected boot restore failure")
	}
	backend.device.State = state
	return state, nil
}

func (backend *fakeBackend) add(serviceID string) {
	if !slices.Contains(backend.managed, serviceID) {
		backend.managed = append(backend.managed, serviceID)
		backend.managed = canonicalManagedIDs(backend.managed)
	}
}

func (backend *fakeBackend) remove(serviceID string) {
	backend.managed = slices.DeleteFunc(backend.managed, func(value string) bool { return value == serviceID })
}

func TestHandshakeDisclosesExperimentalSafetyContractAndPinnedSource(t *testing.T) {
	service := NewService(newFakeBackend(), "1.2.3", "abc123")
	result, apiError := service.Handle(context.Background(), request(protocol.OperationHandshake, `{}`))
	if apiError != nil {
		t.Fatal(apiError)
	}
	handshake := result.(HandshakeResult)
	if handshake.SigningTeamIdentifier != authorization.CompiledTeamIdentifier() {
		t.Fatal("handshake must report the actual compiled attestation pin")
	}
	if handshake.Capabilities.MutationMode != "signed_broker_compatibility_gated_experimental" ||
		handshake.Capabilities.VerifiedMutationTuples != 0 ||
		handshake.Capabilities.CheckpointTokenMaxBytes != MaxCheckpointTokenBytes ||
		handshake.Capabilities.RuntimeDownloads {
		t.Fatalf("unsafe capabilities: %#v", handshake.Capabilities)
	}
	if !slices.Equal(handshake.Capabilities.CompatibilityStates, []string{"verified", "limited", "unknown", "blocked"}) {
		t.Fatalf("compatibility states drifted: %#v", handshake.Capabilities.CompatibilityStates)
	}
	if len(handshake.CatalogSource.Commit) != 40 {
		t.Fatalf("catalog source is not pinned: %#v", handshake.CatalogSource)
	}
}

func TestCloneUsesTheBoundedPinnedLibraryAdapter(t *testing.T) {
	backend := newFakeBackend()
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationCloneSimulator,
		`{"simulatorId":"`+helperTestUDID+`","name":"Test Clone"}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	clone := result.(CloneResult)
	if backend.cloneCalls != 1 || clone.SourceSimulatorID != helperTestUDID || clone.SimulatorID == "" || clone.Name != "Test Clone" {
		t.Fatalf("clone did not use the exact adapter target: %#v backend=%#v", clone, backend)
	}

	_, apiError = service.Handle(context.Background(), request(
		protocol.OperationCloneSimulator,
		`{"simulatorId":"`+helperTestUDID+`","name":"Test Clone","args":["delete","all"]}`,
	))
	if apiError == nil || backend.cloneCalls != 1 {
		t.Fatalf("unbounded clone payload reached the adapter: %#v backend=%#v", apiError, backend)
	}
}

func TestDiskPlanProjectsOnlyPinnedSimSlimInventory(t *testing.T) {
	backend := newFakeBackend()
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationDiskCleanupPlan,
		`{"simulatorId":"`+helperTestUDID+`"}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	plan := result.(DiskCleanupPlanResult)
	if backend.diskPlanCalls != 1 || plan.SimulatorID != helperTestUDID || plan.TotalBytes != 8_192 || len(plan.Categories) != 1 || plan.Categories[0].ID != "caches" {
		t.Fatalf("disk plan did not preserve the bounded pinned-library projection: %#v backend=%#v", plan, backend)
	}
}

func TestDiskCleanupRequiresExactConfirmationAndBoundedUniqueSelection(t *testing.T) {
	backend := newFakeBackend()
	service := NewService(backend, "dev", "unknown")
	for _, payload := range []string{
		`{"simulatorId":"` + helperTestUDID + `","categoryIds":["caches"],"confirmation":""}`,
		`{"simulatorId":"` + helperTestUDID + `","categoryIds":[],"confirmation":"CLEAN_SIMULATOR_DISK"}`,
		`{"simulatorId":"` + helperTestUDID + `","categoryIds":["caches","caches"],"confirmation":"CLEAN_SIMULATOR_DISK"}`,
	} {
		if _, apiError := service.Handle(context.Background(), request(protocol.OperationDiskCleanup, payload)); apiError == nil {
			t.Fatalf("unsafe disk cleanup payload was accepted: %s", payload)
		}
	}
	if backend.diskCleanupCalls != 0 {
		t.Fatalf("unsafe disk cleanup reached the backend: %#v", backend)
	}

	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationDiskCleanup,
		`{"simulatorId":"`+helperTestUDID+`","categoryIds":["logs","caches"],"confirmation":"CLEAN_SIMULATOR_DISK"}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	cleanup := result.(DiskCleanupResult)
	if backend.diskCleanupCalls != 1 || !slices.Equal(backend.diskCleanupCategoryIDs, []string{"logs", "caches"}) || cleanup.SimulatorID != helperTestUDID || cleanup.ReclaimedBytes != 3_072 || !cleanup.BootStateRestored {
		t.Fatalf("disk cleanup did not use the exact bounded request: %#v backend=%#v", cleanup, backend)
	}
}

func TestPreviewReturnsOnlyCatalogDerivedDeltaAndCanonicalProfile(t *testing.T) {
	service := NewService(newFakeBackend("com.apple.apsd"), "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationPreviewProfile,
		`{"simulatorId":"`+helperTestUDID+`","profileId":"ui-automation"}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	plan := result.(Plan)
	if !plan.Executable || !plan.RequiresCheckpoint || plan.ProfileID != "rndevtools-ui-automation" ||
		plan.Compatibility.Status != "unknown" || len(plan.ToDisable) == 0 {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if len(plan.ToEnable) != 1 || plan.ToEnable[0] != "com.apple.apsd" {
		t.Fatalf("unexpected enable delta: %#v", plan.ToEnable)
	}
}

func TestSuccessfulMutationRestoresOriginalShutdownState(t *testing.T) {
	backend := newFakeBackend()
	backend.device.State = "Shutdown"
	service := NewService(backend, "dev", "unknown")
	payload := preparedApplyPayload(t, service, "rndevtools-development")
	if backend.device.State != "Shutdown" {
		t.Fatalf("prepare_mutation returned before restoring shutdown state: %#v", backend.device)
	}
	result, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, payload))
	if apiError != nil {
		t.Fatal(apiError)
	}
	evidence := result.(MutationEvidence)
	if !evidence.TemporarilyBooted || evidence.OriginalBootState != "Shutdown" || evidence.FinalBootState != "Shutdown" || backend.device.State != "Shutdown" {
		t.Fatalf("original boot state was not restored: %#v backend=%#v", evidence, backend.device)
	}
}

func TestCommitRecapturesFreshProcessRootsImmediatelyBeforeMutation(t *testing.T) {
	backend := newFakeBackend()
	backend.capturedProcesses[1] = []string{"prepare-only-root"}
	backend.capturedProcesses[2] = []string{"commit-root"}
	service := NewService(backend, "dev", "unknown")

	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		prepareApplyPayload("rndevtools-development"),
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	prepared := result.(MutationPreparationEvidence)
	checkpoint, err := decodeCheckpoint(prepared.CheckpointToken)
	if err != nil || !slices.Equal(checkpoint.ObservedRunningProcessNames, []string{"prepare-only-root"}) {
		t.Fatalf("preparation process evidence was not bound to the token: checkpoint=%#v err=%v", checkpoint, err)
	}
	payload, err := json.Marshal(applyProfilePayload{
		SimulatorID:     helperTestUDID,
		ProfileID:       "rndevtools-development",
		CheckpointToken: prepared.CheckpointToken,
		Confirmation:    "APPLY_EXPERIMENTAL_PROFILE",
		Acknowledgement: "EXPERIMENTAL",
	})
	if err != nil {
		t.Fatal(err)
	}
	mutationResult, apiError := service.Handle(
		context.Background(),
		request(protocol.OperationApplyProfile, string(payload)),
	)
	if apiError != nil {
		t.Fatal(apiError)
	}
	evidence := mutationResult.(MutationEvidence)
	if backend.captureProcessCalls != 2 ||
		!evidence.Verification.Verified ||
		!slices.Equal(evidence.Verification.CheckedObservedProcessNames, []string{"commit-root"}) ||
		!slices.Equal(backend.verifiedProcesses[3], []string{"commit-root"}) {
		t.Fatalf("commit did not use fresh process evidence: evidence=%#v backend=%#v", evidence.Verification, backend)
	}
}

func TestCommitFailsClosedWhenFreshProcessRootsCannotBeMapped(t *testing.T) {
	backend := newFakeBackend()
	backend.failCaptureProcessCalls[2] = true
	service := NewService(backend, "dev", "unknown")
	payload := preparedApplyPayload(t, service, "rndevtools-development")

	_, apiError := service.Handle(
		context.Background(),
		request(protocol.OperationApplyProfile, payload),
	)
	if apiError == nil || apiError.Code != "process_mapping_inconclusive" || backend.applyCalls != 0 {
		t.Fatalf("inconclusive commit-time process mapping reached mutation: error=%#v backend=%#v", apiError, backend)
	}
}

func TestApplySucceedsWithUnknownTupleAcknowledgementAndReturnsCheckpoint(t *testing.T) {
	backend := newFakeBackend()
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationApplyProfile,
		preparedApplyPayload(t, service, "rndevtools-development"),
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	evidence := result.(MutationEvidence)
	if !evidence.Changed || evidence.Compatibility.Status != "unknown" || evidence.CheckpointToken == "" ||
		evidence.Rollback.Attempted || !evidence.Verification.Verified {
		t.Fatalf("unexpected mutation evidence: %#v", evidence)
	}
	if backend.applyCalls != 1 || backend.rebootCalls != 1 || backend.verifyCalls != 3 {
		t.Fatalf("unexpected backend calls: apply=%d reboot=%d verify=%d", backend.applyCalls, backend.rebootCalls, backend.verifyCalls)
	}
	checkpoint, err := decodeCheckpoint(evidence.CheckpointToken)
	if err != nil || len(checkpoint.ManagedDisabledServiceIDs) != 0 {
		t.Fatalf("invalid before-state checkpoint: %#v, %v", checkpoint, err)
	}
}

func TestApplyIsIdempotentWithoutDeltaOrReboot(t *testing.T) {
	desired, err := catalog.DesiredServiceIDs("rndevtools-development")
	if err != nil {
		t.Fatal(err)
	}
	backend := newFakeBackend(desired...)
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, service, "rndevtools-development")))
	if apiError != nil {
		t.Fatal(apiError)
	}
	evidence := result.(MutationEvidence)
	if evidence.Changed || backend.applyCalls != 0 || backend.rebootCalls != 0 || backend.verifyCalls != 2 {
		t.Fatalf("idempotent apply performed work: %#v, backend=%#v", evidence, backend)
	}
}

func TestPreparedCheckpointCannotBeReplayedAcrossProfileOrOperation(t *testing.T) {
	backend := newFakeBackend()
	service := NewService(backend, "dev", "unknown")
	preparedResult, apiError := service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		prepareApplyPayload("rndevtools-development"),
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	token := preparedResult.(MutationPreparationEvidence).CheckpointToken
	for name, testCase := range map[string]struct {
		operation protocol.Operation
		payload   any
	}{
		"different profile": {
			operation: protocol.OperationApplyProfile,
			payload: applyProfilePayload{
				SimulatorID:     helperTestUDID,
				ProfileID:       "rndevtools-ui-automation",
				CheckpointToken: token,
				Confirmation:    "APPLY_EXPERIMENTAL_PROFILE",
				Acknowledgement: "EXPERIMENTAL",
			},
		},
		"different operation": {
			operation: protocol.OperationRestoreManaged,
			payload: restorePayload{
				SimulatorID:     helperTestUDID,
				CheckpointToken: token,
				Confirmation:    "RESTORE_ALL_MANAGED_SERVICES",
				Acknowledgement: "EXPERIMENTAL",
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			data, err := json.Marshal(testCase.payload)
			if err != nil {
				t.Fatal(err)
			}
			_, apiError := service.Handle(
				context.Background(),
				request(testCase.operation, string(data)),
			)
			if apiError == nil || apiError.Code != "checkpoint_intent_mismatch" {
				t.Fatalf("prepared token replay was accepted: %#v", apiError)
			}
		})
	}
	if backend.applyCalls != 0 {
		t.Fatalf("replayed token reached mutation: %#v", backend)
	}
}

func TestRestoreRepairsOverrideEvenWhenDisabledServiceIsStillPresent(t *testing.T) {
	backend := newFakeBackend("com.apple.apsd")
	backend.presentVerifyCalls[1] = true
	service := NewService(backend, "dev", "unknown")
	payload := preparedRestorePayload(t, service)
	result, apiError := service.Handle(context.Background(), request(protocol.OperationRestoreManaged, payload))
	if apiError != nil {
		t.Fatal(apiError)
	}
	evidence := result.(MutationEvidence)
	if !evidence.Changed || !evidence.Verification.Verified || len(backend.managed) != 0 {
		t.Fatalf("restore did not repair inconsistent state: %#v backend=%#v", evidence, backend)
	}
}

func TestMutationFailsClosedWhenExactCheckpointIsNotRepresentableByUpstream(t *testing.T) {
	backend := newFakeBackend("com.apple.sharingd")
	service := NewService(backend, "dev", "unknown")

	planResult, apiError := service.Handle(context.Background(), request(
		protocol.OperationPreviewProfile,
		`{"simulatorId":"`+helperTestUDID+`","profileId":"rndevtools-development"}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	plan := planResult.(Plan)
	if plan.Executable || plan.BlockedReason == "" {
		t.Fatalf("preview claimed an exact rollback was available: %#v", plan)
	}

	_, apiError = service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		prepareApplyPayload("rndevtools-development"),
	))
	if apiError == nil || apiError.Code != "checkpoint_not_representable" {
		t.Fatalf("restore-only checkpoint was accepted: %#v", apiError)
	}
	if backend.applyCalls != 0 || backend.verifyCalls != 0 {
		t.Fatalf("mutation work ran before representability preflight: %#v", backend)
	}
}

func TestVerificationFailureRollsBackAndProvesOriginalState(t *testing.T) {
	backend := newFakeBackend()
	backend.presentVerifyCalls[3] = true
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, service, "rndevtools-development")))
	if result != nil {
		t.Fatalf("failed mutation returned result: %#v", result)
	}
	if apiError == nil || apiError.Code != "mutation_failed_rolled_back" {
		t.Fatalf("unexpected error: %#v", apiError)
	}
	evidence := apiError.Details.(MutationEvidence)
	if !evidence.Rollback.Attempted || !evidence.Rollback.Succeeded || evidence.Rollback.Verification == nil ||
		!evidence.Rollback.Verification.Verified || len(backend.managed) != 0 {
		t.Fatalf("rollback was not proven: %#v backend=%#v", evidence.Rollback, backend)
	}
}

func TestPartialApplyFailureRollsBackExactObservedDelta(t *testing.T) {
	backend := newFakeBackend()
	backend.failApplyCalls[1] = true
	service := NewService(backend, "dev", "unknown")
	_, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, service, "rndevtools-development")))
	if apiError == nil || apiError.Code != "mutation_failed_rolled_back" || len(backend.managed) != 0 {
		t.Fatalf("partial failure was not rolled back: error=%#v managed=%#v", apiError, backend.managed)
	}
	evidence := apiError.Details.(MutationEvidence)
	if evidence.After.Count != 1 || evidence.Rollback.Before == nil || evidence.Rollback.Before.Count != 1 {
		t.Fatalf("partial state evidence was not captured: %#v", evidence)
	}
	if backend.applyCalls != 2 || backend.rebootCalls != 1 {
		t.Fatalf("rollback did not apply only observed delta: %#v", backend)
	}
}

func TestRollbackFailureReturnsNeedsAttentionWithEvidence(t *testing.T) {
	backend := newFakeBackend()
	backend.failApplyCalls[1] = true
	backend.failApplyCalls[2] = true
	service := NewService(backend, "dev", "unknown")
	_, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, service, "rndevtools-development")))
	if apiError == nil || apiError.Code != "mutation_failed_needs_attention" {
		t.Fatalf("rollback failure was not surfaced: %#v", apiError)
	}
	evidence, ok := apiError.Details.(MutationEvidence)
	if !ok || evidence.FailureCode != "apply_delta_failed" || evidence.Rollback.ErrorCode != "rollback_delta_failed" {
		t.Fatalf("rollback failure evidence drifted: %#v", apiError.Details)
	}
	if evidence.FailureDetail == "" {
		t.Fatalf("the apply layer's own failure reason was dropped from the evidence: %#v", evidence)
	}
}

func TestBlockedTupleCannotBeOverriddenAndUnknownNeedsExactAcknowledgement(t *testing.T) {
	for name, configure := range map[string]func(*fakeBackend){
		"blocked": func(backend *fakeBackend) {
			backend.tuple.RuntimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
		},
		"unknown without acknowledgement": func(*fakeBackend) {},
	} {
		t.Run(name, func(t *testing.T) {
			backend := newFakeBackend()
			configure(backend)
			service := NewService(backend, "dev", "unknown")
			prepared, apiError := service.Handle(context.Background(), request(
				protocol.OperationPrepareMutation,
				prepareApplyPayload("rndevtools-development"),
			))
			if name == "blocked" {
				if apiError == nil || apiError.Code != "mutation_policy_blocked" || backend.applyCalls != 0 {
					t.Fatalf("policy escaped: error=%#v backend=%#v", apiError, backend)
				}
				return
			}
			if apiError != nil {
				t.Fatalf("policy escaped: error=%#v backend=%#v", apiError, backend)
			}
			checkpoint := prepared.(MutationPreparationEvidence).CheckpointToken
			payload, _ := json.Marshal(applyProfilePayload{
				SimulatorID:     helperTestUDID,
				ProfileID:       "rndevtools-development",
				CheckpointToken: checkpoint,
				Confirmation:    "APPLY_EXPERIMENTAL_PROFILE",
			})
			_, apiError = service.Handle(context.Background(), request(protocol.OperationApplyProfile, string(payload)))
			if apiError == nil || apiError.Code != "experimental_acknowledgement_required" || backend.applyCalls != 0 {
				t.Fatalf("commit policy escaped: error=%#v backend=%#v", apiError, backend)
			}
		})
	}
}

func TestVerifyProfileFailsClosedOnAmbiguousLaunchctlProbe(t *testing.T) {
	backend := newFakeBackend()
	backend.inconclusiveVerifyCalls[1] = true
	service := NewService(backend, "dev", "unknown")
	_, apiError := service.Handle(context.Background(), request(
		protocol.OperationVerifyProfile,
		`{"simulatorId":"`+helperTestUDID+`","profileId":"rndevtools-development"}`,
	))
	if apiError == nil || apiError.Code != "verification_inconclusive" {
		t.Fatalf("ambiguous verification was accepted: %#v", apiError)
	}
}

func TestUndoSurvivesNewHelperProcessUsingOpaqueCheckpoint(t *testing.T) {
	backend := newFakeBackend()
	firstService := NewService(backend, "dev", "unknown")
	result, apiError := firstService.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, firstService, "rndevtools-development")))
	if apiError != nil {
		t.Fatal(apiError)
	}
	checkpointToken := result.(MutationEvidence).CheckpointToken

	secondService := NewService(backend, "dev", "unknown")
	undoPayload := preparedUndoPayload(t, secondService, checkpointToken)
	undoResult, apiError := secondService.Handle(context.Background(), request(protocol.OperationUndoLast, undoPayload))
	if apiError != nil {
		t.Fatal(apiError)
	}
	undo := undoResult.(MutationEvidence)
	if !undo.Changed || len(backend.managed) != 0 || !undo.Verification.Verified || undo.CheckpointToken == "" {
		t.Fatalf("undo did not restore the checkpoint: %#v backend=%#v", undo, backend)
	}
}

func TestUndoKeepsTheBootStateTheSimulatorHasWhenUndoStarts(t *testing.T) {
	backend := newFakeBackend()
	backend.device.State = "Shutdown"
	firstService := NewService(backend, "dev", "unknown")
	result, apiError := firstService.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, firstService, "rndevtools-development")))
	if apiError != nil {
		t.Fatal(apiError)
	}
	checkpointToken := result.(MutationEvidence).CheckpointToken
	if backend.device.State != "Shutdown" {
		t.Fatalf("apply did not restore the shutdown state: %#v", backend.device)
	}
	// A lane boots the Simulator for use after the change was applied.
	backend.device.State = "Booted"

	secondService := NewService(backend, "dev", "unknown")
	undoResult, apiError := secondService.Handle(context.Background(), request(protocol.OperationUndoLast, preparedUndoPayload(t, secondService, checkpointToken)))
	if apiError != nil {
		t.Fatal(apiError)
	}
	undo := undoResult.(MutationEvidence)
	if !undo.Changed || undo.OriginalBootState != "Booted" || undo.FinalBootState != "Booted" || backend.device.State != "Booted" {
		t.Fatalf("undo shut down a Simulator that was booted when it started: %#v backend=%#v", undo, backend.device)
	}
}

func TestNoChangeUndoKeepsTheCurrentBootState(t *testing.T) {
	backend := newFakeBackend()
	target, err := encodePreparedCheckpoint(helperTestUDID, "Shutdown", backend.tuple, []string{}, protocol.OperationRestoreManaged, "", []string{}, []string{})
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(protocol.OperationUndoLast, preparedUndoPayload(t, service, target)))
	if apiError != nil {
		t.Fatal(apiError)
	}
	undo := result.(MutationEvidence)
	if undo.Changed || backend.applyCalls != 0 || undo.FinalBootState != "Booted" || backend.device.State != "Booted" {
		t.Fatalf("a no-change undo changed the boot state: %#v backend=%#v", undo, backend.device)
	}
}

func TestUndoRejectsCheckpointAfterCompatibilityTupleChanges(t *testing.T) {
	backend := newFakeBackend()
	firstService := NewService(backend, "dev", "unknown")
	result, apiError := firstService.Handle(context.Background(), request(protocol.OperationApplyProfile, preparedApplyPayload(t, firstService, "rndevtools-development")))
	if apiError != nil {
		t.Fatal(apiError)
	}
	checkpointToken := result.(MutationEvidence).CheckpointToken
	applyCalls := backend.applyCalls
	backend.tuple.XcodeBuild = "17G99"
	secondService := NewService(backend, "dev", "unknown")
	payload := preparedUndoPayload(t, secondService, checkpointToken)
	_, apiError = secondService.Handle(context.Background(), request(protocol.OperationUndoLast, payload))
	if apiError == nil || apiError.Code != "checkpoint_tuple_mismatch" || backend.applyCalls != applyCalls {
		t.Fatalf("tuple-mismatched checkpoint was accepted: error=%#v backend=%#v", apiError, backend)
	}
}

func TestCheckpointRejectsTamperingAndNonCatalogLabels(t *testing.T) {
	backend := newFakeBackend()
	token, err := encodePreparedCheckpoint(helperTestUDID, "Booted", backend.tuple, []string{}, protocol.OperationRestoreManaged, "", []string{}, []string{})
	if err != nil {
		t.Fatal(err)
	}
	// The random preparation ID makes the digest random, so pick a final
	// character that always differs from the real one.
	tampered := token[:len(token)-1] + "A"
	if tampered == token {
		tampered = token[:len(token)-1] + "E"
	}
	if _, err := decodeCheckpoint(tampered); err == nil {
		t.Fatal("tampered checkpoint passed integrity validation")
	}
	payload := checkpointPayload{
		SchemaVersion:               checkpointSchemaVersion,
		CatalogVersion:              catalog.Version,
		CatalogSourceCommit:         catalog.UpstreamCommit,
		CatalogPatchSet:             catalog.PatchSet,
		VendoredSourceManifestHash:  catalog.VendoredSourceManifestSHA256,
		CompatibilityMatrixVersion:  compatibility.Version,
		SimulatorID:                 helperTestUDID,
		Tuple:                       backend.tuple,
		OriginalBootState:           "Booted",
		ManagedDisabledServiceIDs:   []string{"com.example.not-allowlisted"},
		Purpose:                     checkpointPurposePrepared,
		PreparationID:               "preparation-0123456789abcdef0123456789abcdef",
		PreparedOperation:           protocol.OperationRestoreManaged,
		PreparedDesiredServiceIDs:   []string{},
		ObservedRunningProcessNames: []string{},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := checkpointDigest(data)
	forged := base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString(digest[:])
	if _, err := decodeCheckpoint(forged); err == nil {
		t.Fatal("integrity-valid non-catalog checkpoint was accepted")
	}
}

func TestCheckpointContainingEntireManagedCatalogFitsProtocolBound(t *testing.T) {
	backend := newFakeBackend()
	token, err := encodePreparedCheckpoint(helperTestUDID, "Booted", backend.tuple, catalog.ManagedServiceIDs(), protocol.OperationRestoreManaged, "", []string{}, []string{})
	if err != nil {
		t.Fatal(err)
	}
	if len(token) > MaxCheckpointTokenBytes {
		t.Fatalf("checkpoint bytes = %d, max = %d", len(token), MaxCheckpointTokenBytes)
	}
	decoded, err := decodeCheckpoint(token)
	if err != nil || !slices.Equal(decoded.ManagedDisabledServiceIDs, catalog.ManagedServiceIDs()) {
		t.Fatalf("full checkpoint did not round trip: %v", err)
	}
}

func TestDoctorUsesOnlyKnownCapabilityMappings(t *testing.T) {
	managed := stringSet(catalog.ManagedServiceIDs())
	for capabilityID := range doctorFeatureIDs {
		definition, err := resolveDoctorFeature(capabilityID)
		if err != nil {
			t.Fatalf("doctor capability %q did not resolve upstream: %v", capabilityID, err)
		}
		for _, serviceID := range definition.Labels {
			if _, ok := managed[serviceID]; !ok {
				t.Fatalf("doctor capability %q references non-catalog service %q", capabilityID, serviceID)
			}
		}
	}
	backend := newFakeBackend("com.apple.apsd", "com.apple.swcd")
	service := NewService(backend, "dev", "unknown")
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationDoctor,
		`{"simulatorId":"`+helperTestUDID+`","requiredCapabilities":["push-notifications","storekit","universal-links"]}`,
	))
	if apiError != nil {
		t.Fatal(apiError)
	}
	doctor := result.(DoctorResult)
	if doctor.Healthy || doctor.Capabilities[0].Available || !doctor.Capabilities[1].Available || doctor.Capabilities[2].Available {
		t.Fatalf("unexpected doctor result: %#v", doctor)
	}
	if doctor.Capabilities[1].BlockedByServiceIDs == nil {
		t.Fatalf("available capability blockers must be an empty array, not nil: %#v", doctor.Capabilities[1])
	}
	encoded, err := json.Marshal(protocol.Success("doctor-array-contract", doctor))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(`"blockedByServiceIds":null`)) || !bytes.Contains(encoded, []byte(`"blockedByServiceIds":[]`)) {
		t.Fatalf("doctor response violated the stable array contract: %s", encoded)
	}
	_, apiError = service.Handle(context.Background(), request(
		protocol.OperationDoctor,
		`{"simulatorId":"`+helperTestUDID+`","requiredCapabilities":["raw-launchd-label"]}`,
	))
	if apiError == nil || apiError.Code != "invalid_capabilities" {
		t.Fatalf("unknown capability was accepted: %#v", apiError)
	}
}

func TestApplyRejectsUnknownFieldsConfirmationAndAcknowledgement(t *testing.T) {
	service := NewService(newFakeBackend(), "dev", "unknown")
	for name, payload := range map[string]string{
		"unknown field":       `{"simulatorId":"` + helperTestUDID + `","profileId":"rndevtools-development","confirmation":"APPLY_EXPERIMENTAL_PROFILE","acknowledgement":"EXPERIMENTAL","labels":["com.apple.apsd"]}`,
		"bad confirmation":    `{"simulatorId":"` + helperTestUDID + `","profileId":"rndevtools-development","confirmation":"yes","acknowledgement":"EXPERIMENTAL"}`,
		"bad acknowledgement": `{"simulatorId":"` + helperTestUDID + `","profileId":"rndevtools-development","confirmation":"APPLY_EXPERIMENTAL_PROFILE","acknowledgement":"experimental"}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, apiError := service.Handle(context.Background(), request(protocol.OperationApplyProfile, payload))
			if apiError == nil {
				t.Fatal("unsafe apply payload was accepted")
			}
		})
	}
}

func TestPlanUsesEmptyArraysInsteadOfNull(t *testing.T) {
	plan := buildPlan(helperTestUDID, "", nil, nil)
	if plan.CurrentDisabled == nil || plan.DesiredDisabled == nil || plan.ToDisable == nil || plan.ToEnable == nil {
		t.Fatalf("plan must use stable empty arrays: %#v", plan)
	}
}

func prepareApplyPayload(profileID string) string {
	data, _ := json.Marshal(prepareMutationPayload{
		SimulatorID: helperTestUDID,
		Operation:   protocol.OperationApplyProfile,
		ProfileID:   profileID,
	})
	return string(data)
}

func preparedApplyPayload(t *testing.T, service *Service, profileID string) string {
	t.Helper()
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		prepareApplyPayload(profileID),
	))
	if apiError != nil {
		t.Fatalf("prepare apply: %#v", apiError)
	}
	prepared := result.(MutationPreparationEvidence)
	data, err := json.Marshal(applyProfilePayload{
		SimulatorID:     helperTestUDID,
		ProfileID:       profileID,
		CheckpointToken: prepared.CheckpointToken,
		Confirmation:    "APPLY_EXPERIMENTAL_PROFILE",
		Acknowledgement: "EXPERIMENTAL",
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func preparedRestorePayload(t *testing.T, service *Service) string {
	t.Helper()
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		`{"simulatorId":"`+helperTestUDID+`","operation":"restore_managed","profileId":""}`,
	))
	if apiError != nil {
		t.Fatalf("prepare restore: %#v", apiError)
	}
	prepared := result.(MutationPreparationEvidence)
	data, err := json.Marshal(restorePayload{
		SimulatorID:     helperTestUDID,
		CheckpointToken: prepared.CheckpointToken,
		Confirmation:    "RESTORE_ALL_MANAGED_SERVICES",
		Acknowledgement: "EXPERIMENTAL",
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func preparedUndoPayload(t *testing.T, service *Service, targetCheckpoint string) string {
	t.Helper()
	prepareData, err := json.Marshal(prepareMutationPayload{
		SimulatorID:     helperTestUDID,
		Operation:       protocol.OperationUndoLast,
		CheckpointToken: targetCheckpoint,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, apiError := service.Handle(context.Background(), request(
		protocol.OperationPrepareMutation,
		string(prepareData),
	))
	if apiError != nil {
		t.Fatalf("prepare undo: %#v", apiError)
	}
	prepared := result.(MutationPreparationEvidence)
	data, err := json.Marshal(undoPayload{
		SimulatorID:             helperTestUDID,
		PreparedCheckpointToken: prepared.CheckpointToken,
		CheckpointToken:         targetCheckpoint,
		Confirmation:            "UNDO_EXPERIMENTAL_MUTATION",
		Acknowledgement:         "EXPERIMENTAL",
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func request(operation protocol.Operation, payload string) protocol.Request {
	return protocol.Request{
		ProtocolVersion: protocol.Version,
		RequestID:       "test-request",
		Operation:       operation,
		Payload:         json.RawMessage(payload),
	}
}
