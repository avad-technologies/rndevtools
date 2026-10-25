package helper

import (
	"context"
	"errors"
	"runtime"
	"sort"
	"strings"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/authorization"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/simulator"
)

const mutationSafetySummary = "Mutations require a signed desktop broker authorization plus exact catalog labels, strict compatibility policy, launchd and observed-process verification, and automatic rollback. Unknown tuples also require EXPERIMENTAL acknowledgement."

type Service struct {
	backend       simulator.Backend
	helperVersion string
	buildCommit   string
}

type emptyPayload struct{}

type simulatorPayload struct {
	SimulatorID string `json:"simulatorId"`
}

type clonePayload struct {
	SimulatorID string `json:"simulatorId"`
	Name        string `json:"name"`
}

type diskCleanupPayload struct {
	SimulatorID  string   `json:"simulatorId"`
	CategoryIDs  []string `json:"categoryIds"`
	Confirmation string   `json:"confirmation"`
}

type CloneResult struct {
	SourceSimulatorID string `json:"sourceSimulatorId"`
	SimulatorID       string `json:"simulatorId"`
	Name              string `json:"name"`
}

type DiskCleanupPlanResult struct {
	SimulatorID    string                                     `json:"simulatorId"`
	TotalBytes     int64                                      `json:"totalBytes"`
	CleanableBytes int64                                      `json:"cleanableBytes"`
	Categories     []simulator.DiskCleanupCategoryMeasurement `json:"categories"`
	Storage        []simulator.DiskStorageMeasurement         `json:"storage"`
}

type DiskCleanupResult struct {
	SimulatorID       string   `json:"simulatorId"`
	CategoryIDs       []string `json:"categoryIds"`
	BeforeBytes       int64    `json:"beforeBytes"`
	AfterBytes        int64    `json:"afterBytes"`
	ReclaimedBytes    int64    `json:"reclaimedBytes"`
	WasBooted         bool     `json:"wasBooted"`
	BootStateRestored bool     `json:"bootStateRestored"`
}

type profilePayload struct {
	SimulatorID string `json:"simulatorId"`
	ProfileID   string `json:"profileId"`
}

type applyProfilePayload struct {
	SimulatorID     string `json:"simulatorId"`
	ProfileID       string `json:"profileId"`
	CheckpointToken string `json:"checkpointToken"`
	Confirmation    string `json:"confirmation"`
	Acknowledgement string `json:"acknowledgement"`
}

type restorePayload struct {
	SimulatorID     string `json:"simulatorId"`
	CheckpointToken string `json:"checkpointToken"`
	Confirmation    string `json:"confirmation"`
	Acknowledgement string `json:"acknowledgement"`
}

type prepareMutationPayload struct {
	SimulatorID     string             `json:"simulatorId"`
	Operation       protocol.Operation `json:"operation"`
	ProfileID       string             `json:"profileId"`
	CheckpointToken string             `json:"checkpointToken"`
}

type undoPayload struct {
	SimulatorID             string `json:"simulatorId"`
	PreparedCheckpointToken string `json:"preparedCheckpointToken"`
	CheckpointToken         string `json:"checkpointToken"`
	Confirmation            string `json:"confirmation"`
	Acknowledgement         string `json:"acknowledgement"`
}

type doctorPayload struct {
	SimulatorID          string   `json:"simulatorId"`
	RequiredCapabilities []string `json:"requiredCapabilities"`
}

type HandshakeResult struct {
	SigningTeamIdentifier string        `json:"signingTeamIdentifier"`
	HelperVersion         string        `json:"helperVersion"`
	BuildCommit           string        `json:"buildCommit"`
	ProtocolVersion       int           `json:"protocolVersion"`
	Platform              string        `json:"platform"`
	Architecture          string        `json:"architecture"`
	CatalogVersion        string        `json:"catalogVersion"`
	CatalogSource         CatalogSource `json:"catalogSource"`
	Capabilities          Capabilities  `json:"capabilities"`
}

type CatalogSource struct {
	Repository                   string `json:"repository"`
	Commit                       string `json:"commit"`
	ProfilesSHA256               string `json:"profilesSha256"`
	PatchSet                     string `json:"patchSet"`
	UpstreamSourceManifestSHA256 string `json:"upstreamSourceManifestSha256"`
	PatchSHA256                  string `json:"patchSha256"`
	VendoredSourceManifestSHA256 string `json:"vendoredSourceManifestSha256"`
}

type Capabilities struct {
	Operations                 []protocol.Operation `json:"operations"`
	ReadOnlyAvailable          bool                 `json:"readOnlyAvailable"`
	MutationMode               string               `json:"mutationMode"`
	MutationSafety             string               `json:"mutationSafety"`
	CompatibilityMatrixVersion string               `json:"compatibilityMatrixVersion"`
	CompatibilityStates        []string             `json:"compatibilityStates"`
	VerifiedMutationTuples     int                  `json:"verifiedMutationTuples"`
	CheckpointTokenMaxBytes    int                  `json:"checkpointTokenMaxBytes"`
	RuntimeDownloads           bool                 `json:"runtimeDownloads"`
}

type ProfilesResult struct {
	CatalogVersion     string                 `json:"catalogVersion"`
	Categories         []catalog.Category     `json:"categories"`
	Profiles           []catalog.Profile      `json:"profiles"`
	DoctorCapabilities []DoctorCapabilityInfo `json:"doctorCapabilities"`
}

type Plan struct {
	SimulatorID        string                 `json:"simulatorId"`
	ProfileID          string                 `json:"profileId,omitempty"`
	CurrentDisabled    []string               `json:"currentDisabledServiceIds"`
	DesiredDisabled    []string               `json:"desiredDisabledServiceIds"`
	ToDisable          []string               `json:"toDisableServiceIds"`
	ToEnable           []string               `json:"toEnableServiceIds"`
	RequiresCheckpoint bool                   `json:"requiresCheckpoint"`
	RequiresReboot     bool                   `json:"requiresReboot"`
	Executable         bool                   `json:"executable"`
	BlockedReason      string                 `json:"blockedReason,omitempty"`
	Compatibility      compatibility.Decision `json:"compatibility"`
}

type VerifyProfileResult struct {
	SimulatorID string `json:"simulatorId"`
	ProfileID   string `json:"profileId"`
	simulator.Verification
}

func NewService(backend simulator.Backend, helperVersion, buildCommit string) *Service {
	return &Service{backend: backend, helperVersion: helperVersion, buildCommit: buildCommit}
}

func (service *Service) Handle(ctx context.Context, request protocol.Request) (any, *protocol.APIError) {
	switch request.Operation {
	case protocol.OperationHandshake:
		if apiError := protocol.DecodePayload(request.Payload, &emptyPayload{}); apiError != nil {
			return nil, apiError
		}
		return service.handshake(), nil
	case protocol.OperationListSimulators:
		if apiError := protocol.DecodePayload(request.Payload, &emptyPayload{}); apiError != nil {
			return nil, apiError
		}
		devices, err := service.backend.List(ctx)
		if err != nil {
			return nil, backendError(err)
		}
		return struct {
			Simulators []simulator.Device `json:"simulators"`
		}{Simulators: devices}, nil
	case protocol.OperationCloneSimulator:
		var payload clonePayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		cloneID, normalizedName, err := service.backend.Clone(ctx, payload.SimulatorID, payload.Name)
		if err != nil {
			return nil, protocol.NewError(
				"clone_failed",
				"Pinned SimSlim could not safely prepare the exact simulator clone.",
				false,
			)
		}
		return CloneResult{
			SourceSimulatorID: payload.SimulatorID,
			SimulatorID:       cloneID,
			Name:              normalizedName,
		}, nil
	case protocol.OperationDiskCleanupPlan:
		var payload simulatorPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		plan, err := service.backend.PlanDiskCleanup(ctx, payload.SimulatorID)
		if err != nil {
			return nil, protocol.NewError(
				"disk_plan_failed",
				"Pinned SimSlim could not inspect the exact simulator disk.",
				false,
			)
		}
		return DiskCleanupPlanResult{
			SimulatorID:    payload.SimulatorID,
			TotalBytes:     plan.TotalBytes,
			CleanableBytes: plan.CleanableBytes,
			Categories:     plan.Categories,
			Storage:        plan.Storage,
		}, nil
	case protocol.OperationDiskCleanup:
		var payload diskCleanupPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		if payload.Confirmation != "CLEAN_SIMULATOR_DISK" {
			return nil, protocol.NewError(
				"confirmation_required",
				"The exact disk cleanup confirmation token is required.",
				false,
			)
		}
		if len(payload.CategoryIDs) == 0 || len(payload.CategoryIDs) > 4 {
			return nil, protocol.NewError(
				"invalid_disk_cleanup_selection",
				"Select between one and four allowlisted disk cleanup categories.",
				false,
			)
		}
		seenCategories := make(map[string]bool, len(payload.CategoryIDs))
		for _, categoryID := range payload.CategoryIDs {
			if seenCategories[categoryID] {
				return nil, protocol.NewError(
					"invalid_disk_cleanup_selection",
					"Disk cleanup categories must be unique.",
					false,
				)
			}
			seenCategories[categoryID] = true
		}
		result, err := service.backend.CleanDisk(ctx, payload.SimulatorID, payload.CategoryIDs)
		if err != nil {
			return nil, protocol.NewError(
				"disk_cleanup_failed",
				"Pinned SimSlim could not safely clean the exact simulator disk.",
				false,
			)
		}
		return DiskCleanupResult{
			SimulatorID:       payload.SimulatorID,
			CategoryIDs:       result.CategoryIDs,
			BeforeBytes:       result.BeforeBytes,
			AfterBytes:        result.AfterBytes,
			ReclaimedBytes:    result.ReclaimedBytes,
			WasBooted:         result.WasBooted,
			BootStateRestored: result.BootStateRestored,
		}, nil
	case protocol.OperationListProfiles:
		if apiError := protocol.DecodePayload(request.Payload, &emptyPayload{}); apiError != nil {
			return nil, apiError
		}
		return ProfilesResult{
			CatalogVersion:     catalog.Version,
			Categories:         catalog.Categories(),
			Profiles:           catalog.Profiles(),
			DoctorCapabilities: doctorCapabilityInfos(),
		}, nil
	case protocol.OperationSimulatorStatus:
		var payload simulatorPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		status, err := service.backend.Status(ctx, payload.SimulatorID)
		if err != nil {
			return nil, backendError(err)
		}
		return status, nil
	case protocol.OperationPreviewProfile:
		var payload profilePayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		return service.profilePlan(ctx, payload.SimulatorID, payload.ProfileID)
	case protocol.OperationVerifyProfile:
		var payload profilePayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		return service.verifyProfile(ctx, payload)
	case protocol.OperationDoctor:
		var payload doctorPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		return service.doctor(ctx, payload)
	case protocol.OperationPrepareMutation:
		var payload prepareMutationPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		var desired []string
		switch payload.Operation {
		case protocol.OperationApplyProfile:
			if payload.CheckpointToken != "" {
				return nil, protocol.NewError("invalid_payload", "checkpointToken must be empty when preparing apply_profile.", false)
			}
			profile, ok := catalog.ProfileByID(payload.ProfileID)
			if !ok {
				return nil, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
			}
			var err error
			desired, err = catalog.DesiredServiceIDs(profile.ID)
			if err != nil {
				return nil, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
			}
			payload.ProfileID = profile.ID
		case protocol.OperationRestoreManaged:
			if payload.ProfileID != "" || payload.CheckpointToken != "" {
				return nil, protocol.NewError("invalid_payload", "profileId and checkpointToken must be empty when preparing restore_managed.", false)
			}
			desired = []string{}
		case protocol.OperationUndoLast:
			if payload.ProfileID != "" || payload.CheckpointToken == "" {
				return nil, protocol.NewError("invalid_payload", "undo_last preparation requires checkpointToken and an empty profileId.", false)
			}
			checkpoint, err := decodeCheckpoint(payload.CheckpointToken)
			if err != nil {
				return nil, protocol.NewError("invalid_checkpoint", "checkpointToken is invalid or incompatible with this helper.", false)
			}
			if !strings.EqualFold(checkpoint.SimulatorID, payload.SimulatorID) {
				return nil, protocol.NewError("checkpoint_simulator_mismatch", "checkpointToken belongs to a different simulator.", false)
			}
			desired = checkpoint.ManagedDisabledServiceIDs
		default:
			return nil, protocol.NewError("invalid_payload", "operation must be apply_profile, restore_managed, or undo_last.", false)
		}
		return service.prepareMutation(ctx, mutationRequest{
			Operation:   payload.Operation,
			SimulatorID: payload.SimulatorID,
			ProfileID:   payload.ProfileID,
			Desired:     desired,
		})
	case protocol.OperationApplyProfile:
		var payload applyProfilePayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		if payload.Confirmation != "APPLY_EXPERIMENTAL_PROFILE" {
			return nil, protocol.NewError("confirmation_required", "The exact apply confirmation token is required.", false)
		}
		profile, ok := catalog.ProfileByID(payload.ProfileID)
		if !ok {
			return nil, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
		}
		desired, err := catalog.DesiredServiceIDs(profile.ID)
		if err != nil {
			return nil, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
		}
		result, apiError := service.mutate(ctx, mutationRequest{
			Operation:       protocol.OperationApplyProfile,
			SimulatorID:     payload.SimulatorID,
			ProfileID:       profile.ID,
			Desired:         desired,
			Acknowledgement: payload.Acknowledgement,
			PreparedToken:   payload.CheckpointToken,
		})
		if apiError != nil {
			return nil, apiError
		}
		return result, nil
	case protocol.OperationRestoreManaged:
		var payload restorePayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		if payload.Confirmation != "RESTORE_ALL_MANAGED_SERVICES" {
			return nil, protocol.NewError("confirmation_required", "The exact restore confirmation token is required.", false)
		}
		result, apiError := service.mutate(ctx, mutationRequest{
			Operation:       protocol.OperationRestoreManaged,
			SimulatorID:     payload.SimulatorID,
			Desired:         []string{},
			Acknowledgement: payload.Acknowledgement,
			PreparedToken:   payload.CheckpointToken,
		})
		if apiError != nil {
			return nil, apiError
		}
		return result, nil
	case protocol.OperationUndoLast:
		var payload undoPayload
		if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil {
			return nil, apiError
		}
		if payload.Confirmation != "UNDO_EXPERIMENTAL_MUTATION" {
			return nil, protocol.NewError("confirmation_required", "The exact undo confirmation token is required.", false)
		}
		checkpoint, err := decodeCheckpoint(payload.CheckpointToken)
		if err != nil {
			return nil, protocol.NewError("invalid_checkpoint", "checkpointToken is invalid or incompatible with this helper.", false)
		}
		// Undo restores the checkpoint's managed services, not the boot state
		// recorded with it: like apply and restore, it ends in the boot state
		// the Simulator had when the undo started, so it never shuts down a
		// device that was booted for use after the original change.
		result, apiError := service.mutate(ctx, mutationRequest{
			Operation:       protocol.OperationUndoLast,
			SimulatorID:     payload.SimulatorID,
			Desired:         checkpoint.ManagedDisabledServiceIDs,
			Acknowledgement: payload.Acknowledgement,
			PreparedToken:   payload.PreparedCheckpointToken,
			UndoCheckpoint:  &checkpoint,
		})
		if apiError != nil {
			return nil, apiError
		}
		return result, nil
	default:
		return nil, protocol.NewError("unsupported_operation", "The requested helper operation is not supported.", false)
	}
}

func (service *Service) handshake() HandshakeResult {
	operations := []protocol.Operation{
		protocol.OperationHandshake,
		protocol.OperationListSimulators,
		protocol.OperationCloneSimulator,
		protocol.OperationDiskCleanupPlan,
		protocol.OperationDiskCleanup,
		protocol.OperationListProfiles,
		protocol.OperationSimulatorStatus,
		protocol.OperationPreviewProfile,
		protocol.OperationVerifyProfile,
		protocol.OperationDoctor,
		protocol.OperationPrepareMutation,
		protocol.OperationApplyProfile,
		protocol.OperationRestoreManaged,
		protocol.OperationUndoLast,
	}
	architecture := runtime.GOARCH
	if architecture == "amd64" {
		architecture = "x64"
	}
	return HandshakeResult{
		SigningTeamIdentifier: authorization.CompiledTeamIdentifier(),
		HelperVersion:         service.helperVersion,
		BuildCommit:           service.buildCommit,
		ProtocolVersion:       protocol.Version,
		Platform:              runtime.GOOS,
		Architecture:          architecture,
		CatalogVersion:        catalog.Version,
		CatalogSource: CatalogSource{
			Repository:                   "https://github.com/MobAI-App/simslim",
			Commit:                       catalog.UpstreamCommit,
			ProfilesSHA256:               catalog.UpstreamProfilesHash,
			PatchSet:                     catalog.PatchSet,
			UpstreamSourceManifestSHA256: catalog.UpstreamSourceManifestSHA256,
			PatchSHA256:                  catalog.PatchSHA256,
			VendoredSourceManifestSHA256: catalog.VendoredSourceManifestSHA256,
		},
		Capabilities: Capabilities{
			Operations:                 operations,
			ReadOnlyAvailable:          runtime.GOOS == "darwin",
			MutationMode:               "signed_broker_compatibility_gated_experimental",
			MutationSafety:             mutationSafetySummary,
			CompatibilityMatrixVersion: compatibility.Version,
			CompatibilityStates:        []string{"verified", "limited", "unknown", "blocked"},
			VerifiedMutationTuples:     len(compatibility.VerifiedTuples()),
			CheckpointTokenMaxBytes:    MaxCheckpointTokenBytes,
			RuntimeDownloads:           false,
		},
	}
}

func (service *Service) profilePlan(ctx context.Context, simulatorID, profileID string) (Plan, *protocol.APIError) {
	profile, ok := catalog.ProfileByID(profileID)
	if !ok {
		return Plan{}, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
	}
	desired, err := catalog.DesiredServiceIDs(profile.ID)
	if err != nil {
		return Plan{}, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
	}
	status, err := service.backend.Status(ctx, simulatorID)
	if err != nil {
		return Plan{}, backendError(err)
	}
	tuple, err := service.backend.Compatibility(ctx, simulatorID)
	if err != nil {
		return Plan{}, backendError(err)
	}
	decision := compatibility.Classify(tuple, catalog.Version)
	_, policyErr := compatibility.Evaluate(
		tuple,
		string(protocol.OperationApplyProfile),
		compatibility.ExperimentalAcknowledgement,
		catalog.Version,
	)
	plan := buildPlan(simulatorID, profile.ID, status.ManagedDisabledServiceIDs, desired)
	plan.Compatibility = decision
	if _, representabilityErr := catalog.UpstreamProfileForDesired(status.ManagedDisabledServiceIDs); representabilityErr != nil {
		plan.Executable = false
		plan.BlockedReason = "The existing managed state contains an upstream restore-only service, so exact rollback is unavailable."
	} else if policyErr != nil {
		plan.Executable = false
		plan.BlockedReason = policyErr.Error()
	}
	return plan, nil
}

func (service *Service) verifyProfile(ctx context.Context, payload profilePayload) (VerifyProfileResult, *protocol.APIError) {
	profile, ok := catalog.ProfileByID(payload.ProfileID)
	if !ok {
		return VerifyProfileResult{}, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
	}
	desired, err := catalog.DesiredServiceIDs(profile.ID)
	if err != nil {
		return VerifyProfileResult{}, protocol.NewError("unknown_profile", "profileId is not in the pinned catalog.", false)
	}
	verification, err := service.backend.VerifyManagedState(ctx, payload.SimulatorID, desired, nil)
	if err != nil {
		apiError := protocol.NewError("verification_inconclusive", "The helper could not prove the requested simulator service state.", true)
		var failure *simulator.VerificationError
		if errors.As(err, &failure) {
			apiError.Details = failure.Evidence
		}
		return VerifyProfileResult{}, apiError
	}
	return VerifyProfileResult{SimulatorID: payload.SimulatorID, ProfileID: profile.ID, Verification: verification}, nil
}

func buildPlan(simulatorID, profileID string, current, desired []string) Plan {
	currentSet := stringSet(current)
	desiredSet := stringSet(desired)
	toDisable := difference(desiredSet, currentSet)
	toEnable := difference(currentSet, desiredSet)
	changes := len(toDisable)+len(toEnable) > 0
	return Plan{
		SimulatorID:        simulatorID,
		ProfileID:          profileID,
		CurrentDisabled:    canonicalManagedIDs(current),
		DesiredDisabled:    canonicalManagedIDs(desired),
		ToDisable:          toDisable,
		ToEnable:           toEnable,
		RequiresCheckpoint: changes,
		RequiresReboot:     changes,
		Executable:         true,
	}
}

func backendError(err error) *protocol.APIError {
	return protocol.NewError("simulator_unavailable", err.Error(), true)
}

func stringSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set
}

func difference(left, right map[string]struct{}) []string {
	out := make([]string, 0)
	for value := range left {
		if _, exists := right[value]; !exists {
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}
