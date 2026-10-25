package helper

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/operationbudget"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/simulator"
)

type mutationRequest struct {
	Operation       protocol.Operation
	SimulatorID     string
	ProfileID       string
	Desired         []string
	Acknowledgement string
	PreparedToken   string
	UndoCheckpoint  *checkpointPayload
}

type MutationPreparationEvidence struct {
	Operation                   protocol.Operation     `json:"operation"`
	SimulatorID                 string                 `json:"simulatorId"`
	ProfileID                   string                 `json:"profileId,omitempty"`
	Changed                     bool                   `json:"changed"`
	CheckpointToken             string                 `json:"checkpointToken"`
	Compatibility               compatibility.Decision `json:"compatibility"`
	OriginalBootState           string                 `json:"originalBootState"`
	Before                      simulator.ManagedState `json:"before"`
	Desired                     simulator.ManagedState `json:"desired"`
	Plan                        MutationDelta          `json:"plan"`
	Verification                simulator.Verification `json:"verification"`
	ObservedRunningProcessNames []string               `json:"observedRunningProcessNames"`
}

type MutationDelta struct {
	ToDisableServiceIDs []string `json:"toDisableServiceIds"`
	ToEnableServiceIDs  []string `json:"toEnableServiceIds"`
}

type RollbackEvidence struct {
	Attempted    bool                    `json:"attempted"`
	Succeeded    bool                    `json:"succeeded"`
	Rebooted     bool                    `json:"rebooted"`
	Before       *simulator.ManagedState `json:"before,omitempty"`
	After        *simulator.ManagedState `json:"after,omitempty"`
	Verification *simulator.Verification `json:"verification,omitempty"`
	ErrorCode    string                  `json:"errorCode,omitempty"`
}

type MutationEvidence struct {
	Operation         protocol.Operation     `json:"operation"`
	ProfileID         string                 `json:"profileId,omitempty"`
	FailureCode       string                 `json:"failureCode,omitempty"`
	FailureDetail     string                 `json:"failureDetail,omitempty"`
	Changed           bool                   `json:"changed"`
	CheckpointToken   string                 `json:"checkpointToken"`
	Compatibility     compatibility.Decision `json:"compatibility"`
	OriginalBootState string                 `json:"originalBootState"`
	FinalBootState    string                 `json:"finalBootState"`
	TemporarilyBooted bool                   `json:"temporarilyBooted"`
	Rebooted          bool                   `json:"rebooted"`
	Before            simulator.ManagedState `json:"before"`
	Desired           simulator.ManagedState `json:"desired"`
	Plan              MutationDelta          `json:"plan"`
	After             simulator.ManagedState `json:"after"`
	Verification      simulator.Verification `json:"verification"`
	Rollback          RollbackEvidence       `json:"rollback"`
}

// prepareMutation performs the complete fresh preflight and returns a bounded
// checkpoint before any managed launchd transition occurs. Electron must
// durably persist this token before invoking the matching commit operation.
func (service *Service) prepareMutation(
	ctx context.Context,
	request mutationRequest,
) (result MutationPreparationEvidence, apiError *protocol.APIError) {
	preparation, err := service.backend.PrepareMutation(ctx, request.SimulatorID)
	if err != nil {
		return MutationPreparationEvidence{}, backendError(err)
	}
	defer func() {
		cleanupContext, cancel := context.WithTimeout(
			context.WithoutCancel(ctx),
			operationbudget.CleanupGrace(protocol.OperationPrepareMutation),
		)
		defer cancel()
		if _, restoreErr := service.backend.RestoreBootState(
			cleanupContext,
			preparation.Device.ID,
			preparation.OriginalBootState,
		); restoreErr != nil {
			result = MutationPreparationEvidence{}
			apiError = protocol.NewError(
				"simulator_needs_attention",
				"Preflight made no service changes, but could not restore the Simulator's original boot state.",
				false,
			)
		}
	}()

	if _, err := catalog.UpstreamProfileForDesired(preparation.State.ManagedDisabledServiceIDs); err != nil {
		return MutationPreparationEvidence{}, protocol.NewError(
			"checkpoint_not_representable",
			"The existing managed state includes an upstream restore-only service and cannot be reproduced through the pinned SimSlim API; no mutation was attempted.",
			false,
		)
	}
	if _, err := catalog.UpstreamProfileForDesired(request.Desired); err != nil {
		return MutationPreparationEvidence{}, protocol.NewError(
			"mutation_target_not_representable",
			"The requested managed state cannot be represented through the pinned SimSlim API; no mutation was attempted.",
			false,
		)
	}
	decision, err := compatibility.Evaluate(
		preparation.Tuple,
		string(request.Operation),
		// Preparation is read-only. Electron binds and durably persists the
		// exact tuple acknowledgement before the returned token can be committed.
		// The commit path below independently evaluates the caller acknowledgement
		// against the token-bound fresh tuple.
		compatibility.ExperimentalAcknowledgement,
		catalog.Version,
	)
	if err != nil {
		return MutationPreparationEvidence{}, mutationPolicyError(decision, err)
	}
	before := stateEvidence(preparation.State.ManagedDisabledServiceIDs)
	desired := stateEvidence(request.Desired)
	verification, err := service.backend.VerifyManagedState(
		ctx,
		preparation.Device.ID,
		before.ManagedDisabledServiceIDs,
		nil,
	)
	repairOperation := request.Operation == protocol.OperationRestoreManaged ||
		request.Operation == protocol.OperationUndoLast
	unsafeExistingRegistration := !verification.Verified && !repairOperation
	if err != nil || unsafeExistingRegistration {
		apiError := protocol.NewError(
			"preexisting_state_unverified",
			"The existing managed overrides or disabled-service registration state could not be verified; no mutation was attempted.",
			false,
		)
		apiError.Details = verificationEvidence(err, verification)
		return MutationPreparationEvidence{}, apiError
	}
	plan := mutationDelta(before.ManagedDisabledServiceIDs, desired.ManagedDisabledServiceIDs)
	observedProcessNames, err := service.backend.CaptureRunningServiceProcesses(
		ctx,
		preparation.Device.ID,
		plan.ToDisableServiceIDs,
	)
	if err != nil {
		return MutationPreparationEvidence{}, protocol.NewError(
			"process_mapping_inconclusive",
			"The helper could not bind running to-disable services to the exact Simulator process tree; no mutation was attempted. "+protocol.BoundedDetail(err.Error()),
			false,
		)
	}
	checkpointToken, err := encodePreparedCheckpoint(
		preparation.Device.ID,
		preparation.OriginalBootState,
		preparation.Tuple,
		before.ManagedDisabledServiceIDs,
		request.Operation,
		request.ProfileID,
		desired.ManagedDisabledServiceIDs,
		observedProcessNames,
	)
	if err != nil {
		return MutationPreparationEvidence{}, protocol.NewError(
			"checkpoint_failed",
			"The helper could not create a bounded restore checkpoint.",
			false,
		)
	}
	return MutationPreparationEvidence{
		Operation:                   request.Operation,
		SimulatorID:                 preparation.Device.ID,
		ProfileID:                   request.ProfileID,
		Changed:                     len(plan.ToDisableServiceIDs)+len(plan.ToEnableServiceIDs) > 0,
		CheckpointToken:             checkpointToken,
		Compatibility:               decision,
		OriginalBootState:           preparation.OriginalBootState,
		Before:                      before,
		Desired:                     desired,
		Plan:                        plan,
		Verification:                verification,
		ObservedRunningProcessNames: observedProcessNames,
	}, nil
}

func (service *Service) mutate(ctx context.Context, request mutationRequest) (MutationEvidence, *protocol.APIError) {
	if request.PreparedToken == "" {
		return MutationEvidence{}, protocol.NewError(
			"checkpoint_required",
			"A separately persisted pre-mutation checkpointToken is required.",
			false,
		)
	}
	preparedCheckpoint, err := decodeCheckpoint(request.PreparedToken)
	if err != nil {
		return MutationEvidence{}, protocol.NewError("invalid_checkpoint", "checkpointToken is invalid or incompatible with this helper.", false)
	}
	if !strings.EqualFold(preparedCheckpoint.SimulatorID, request.SimulatorID) {
		return MutationEvidence{}, protocol.NewError("checkpoint_simulator_mismatch", "checkpointToken belongs to a different simulator.", false)
	}
	if request.UndoCheckpoint != nil && !strings.EqualFold(request.UndoCheckpoint.SimulatorID, request.SimulatorID) {
		return MutationEvidence{}, protocol.NewError("checkpoint_simulator_mismatch", "checkpointToken belongs to a different simulator.", false)
	}
	preparation, err := service.backend.PrepareMutation(ctx, request.SimulatorID)
	if err != nil {
		return MutationEvidence{}, backendError(err)
	}
	cleanupPreflight := func(apiError *protocol.APIError) (MutationEvidence, *protocol.APIError) {
		cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), operationbudget.RollbackTimeout)
		defer cancel()
		if _, cleanupErr := service.backend.RestoreBootState(cleanupContext, preparation.Device.ID, preparation.OriginalBootState); cleanupErr != nil {
			failure := protocol.NewError("simulator_needs_attention", "The operation was blocked, but the helper could not restore the simulator's original boot state.", false)
			failure.Details = map[string]any{"causeCode": apiError.Code, "finalBootState": "Unknown"}
			return MutationEvidence{}, failure
		}
		return MutationEvidence{}, apiError
	}

	if preparedCheckpoint.Tuple != preparation.Tuple ||
		(request.UndoCheckpoint != nil && request.UndoCheckpoint.Tuple != preparation.Tuple) {
		return cleanupPreflight(protocol.NewError(
			"checkpoint_tuple_mismatch",
			"checkpointToken was created for a different macOS, Xcode, runtime, architecture, or catalog tuple.",
			false,
		))
	}
	if preparedCheckpoint.OriginalBootState != preparation.OriginalBootState ||
		!slices.Equal(
			preparedCheckpoint.ManagedDisabledServiceIDs,
			canonicalManagedIDs(preparation.State.ManagedDisabledServiceIDs),
		) {
		return cleanupPreflight(protocol.NewError(
			"checkpoint_state_mismatch",
			"The Simulator state changed after checkpoint preparation; no mutation was attempted.",
			false,
		))
	}
	if preparedCheckpoint.PreparedOperation != request.Operation ||
		preparedCheckpoint.PreparedProfileID != request.ProfileID ||
		!slices.Equal(
			preparedCheckpoint.PreparedDesiredServiceIDs,
			canonicalManagedIDs(request.Desired),
		) {
		return cleanupPreflight(protocol.NewError(
			"checkpoint_intent_mismatch",
			"checkpointToken was prepared for a different operation, profile, or managed-service target; no mutation was attempted.",
			false,
		))
	}

	// A rollback target must be expressible through SimSlim's public API before
	// any mutation begins. The managed catalog intentionally includes upstream
	// restore-only labels (currently sharingd) so they can be inspected, but
	// SimSlim will not create a profile that disables one. If such a label is
	// already disabled, attempting another mutation could leave us unable to
	// reproduce the exact checkpoint after a partial failure.
	if _, err := catalog.UpstreamProfileForDesired(preparation.State.ManagedDisabledServiceIDs); err != nil {
		apiError := protocol.NewError(
			"checkpoint_not_representable",
			"The existing managed state includes an upstream restore-only service and cannot be reproduced through the pinned SimSlim API; no mutation was attempted.",
			false,
		)
		return cleanupPreflight(apiError)
	}
	if _, err := catalog.UpstreamProfileForDesired(request.Desired); err != nil {
		apiError := protocol.NewError(
			"mutation_target_not_representable",
			"The requested managed state cannot be represented through the pinned SimSlim API; no mutation was attempted.",
			false,
		)
		return cleanupPreflight(apiError)
	}

	decision, err := compatibility.Evaluate(
		preparation.Tuple,
		string(request.Operation),
		request.Acknowledgement,
		catalog.Version,
	)
	if err != nil {
		return cleanupPreflight(mutationPolicyError(decision, err))
	}

	before := stateEvidence(preparation.State.ManagedDisabledServiceIDs)
	desired := stateEvidence(request.Desired)
	plan := mutationDelta(before.ManagedDisabledServiceIDs, desired.ManagedDisabledServiceIDs)
	checkpointToken := request.PreparedToken

	preflightVerification, err := service.backend.VerifyManagedState(ctx, preparation.Device.ID, before.ManagedDisabledServiceIDs, nil)
	// restore_managed is the repair path for an override that exists while its
	// launchd job is still registered. A conclusive present-job result may proceed
	// to an all-enabled target; ambiguous probes still fail closed.
	repairOperation := request.Operation == protocol.OperationRestoreManaged ||
		request.Operation == protocol.OperationUndoLast
	unsafeExistingRegistration := !preflightVerification.Verified && !repairOperation
	if err != nil || unsafeExistingRegistration {
		apiError := protocol.NewError(
			"preexisting_state_unverified",
			"The existing managed overrides or disabled launchd-job registration state could not be verified; no mutation was attempted.",
			false,
		)
		apiError.Details = verificationEvidence(err, preflightVerification)
		return cleanupPreflight(apiError)
	}
	// The durable preparation token records the process roots observed during
	// preview, but that snapshot is not used as commit-time efficacy evidence.
	// A shutdown target is intentionally booted again between the two helper
	// processes, and an on-demand job can legitimately change state in that
	// interval. Re-bind every currently running to-disable launchd job to the
	// exact Simulator process tree immediately before mutation, then require
	// those fresh executable roots to be absent after the transition.
	commitObservedProcessNames, err := service.backend.CaptureRunningServiceProcesses(
		ctx,
		preparation.Device.ID,
		plan.ToDisableServiceIDs,
	)
	if err != nil {
		return cleanupPreflight(protocol.NewError(
			"process_mapping_inconclusive",
			"The helper could not bind commit-time running services to the exact Simulator process tree; no mutation was attempted. "+protocol.BoundedDetail(err.Error()),
			false,
		))
	}

	evidence := MutationEvidence{
		Operation:         request.Operation,
		ProfileID:         request.ProfileID,
		Changed:           len(plan.ToDisableServiceIDs)+len(plan.ToEnableServiceIDs) > 0,
		CheckpointToken:   checkpointToken,
		Compatibility:     decision,
		OriginalBootState: preparation.OriginalBootState,
		FinalBootState:    "Unknown",
		TemporarilyBooted: preparation.TemporarilyBooted,
		Before:            before,
		Desired:           desired,
		Plan:              plan,
		After:             before,
		Verification:      emptyVerification(desired.ManagedDisabledServiceIDs),
		Rollback:          RollbackEvidence{},
	}

	if !evidence.Changed {
		evidence.Verification = preflightVerification
		evidence.After = stateEvidence(preflightVerification.CurrentManagedDisabledIDs)
		finalState, restoreErr := service.backend.RestoreBootState(ctx, preparation.Device.ID, preparation.OriginalBootState)
		if restoreErr == nil {
			evidence.FinalBootState = finalState
			return evidence, nil
		}
		return service.failAndRollback(ctx, evidence, preparation, "restore_boot_state_failed")
	}

	changed, err := service.backend.ApplyManagedState(
		ctx,
		preparation.Device.ID,
		desired.ManagedDisabledServiceIDs,
	)
	if err != nil {
		// SimSlim explains an apply failure in prose ("the disable overrides did
		// not survive the reboot (3 of 60 changes lost)"); the code alone hides
		// which layer refused and why.
		evidence.FailureDetail = protocol.BoundedDetail(err.Error())
		return service.failAndRollback(ctx, evidence, preparation, "apply_delta_failed")
	}
	evidence.Rebooted = changed
	verification, err := service.backend.VerifyManagedState(
		ctx,
		preparation.Device.ID,
		desired.ManagedDisabledServiceIDs,
		commitObservedProcessNames,
	)
	evidence.Verification = verificationEvidence(err, verification)
	evidence.After = stateEvidence(evidence.Verification.CurrentManagedDisabledIDs)
	if err != nil || !evidence.Verification.Verified {
		if err != nil {
			evidence.FailureDetail = protocol.BoundedDetail(err.Error())
		}
		return service.failAndRollback(ctx, evidence, preparation, "verification_failed")
	}
	finalState, err := service.backend.RestoreBootState(ctx, preparation.Device.ID, preparation.OriginalBootState)
	if err != nil {
		evidence.FailureDetail = protocol.BoundedDetail(err.Error())
		return service.failAndRollback(ctx, evidence, preparation, "restore_boot_state_failed")
	}
	evidence.FinalBootState = finalState
	return evidence, nil
}

func mutationPolicyError(decision compatibility.Decision, err error) *protocol.APIError {
	switch {
	case errors.Is(err, compatibility.ErrAcknowledgementRequired):
		return protocol.NewError(
			"experimental_acknowledgement_required",
			"This unknown compatibility tuple requires acknowledgement set exactly to EXPERIMENTAL.",
			false,
		)
	case errors.Is(err, compatibility.ErrOperationNotVerified):
		apiError := protocol.NewError(
			"limited_operation_blocked",
			"This operation is not verified for the limited compatibility tuple.",
			false,
		)
		apiError.Details = decision
		return apiError
	default:
		apiError := protocol.NewError(
			"mutation_policy_blocked",
			"The immutable compatibility policy blocks mutation on this tuple.",
			false,
		)
		apiError.Details = decision
		return apiError
	}
}

func (service *Service) failAndRollback(
	ctx context.Context,
	evidence MutationEvidence,
	preparation simulator.MutationPreparation,
	primaryErrorCode string,
) (MutationEvidence, *protocol.APIError) {
	evidence.FailureCode = primaryErrorCode
	evidence.Rollback.Attempted = true
	rollbackTarget := preparation.State.ManagedDisabledServiceIDs
	rollbackContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), operationbudget.RollbackTimeout)
	defer cancel()

	if _, err := service.backend.RestoreBootState(rollbackContext, preparation.Device.ID, "Booted"); err != nil {
		return rollbackFailure(evidence, primaryErrorCode, "rollback_boot_failed")
	}
	status, err := service.backend.Status(rollbackContext, preparation.Device.ID)
	if err != nil {
		return rollbackFailure(evidence, primaryErrorCode, "rollback_status_failed")
	}
	rollbackBefore := stateEvidence(status.ManagedDisabledServiceIDs)
	evidence.Rollback.Before = &rollbackBefore
	// This fresh read is the authoritative state after the primary failure and
	// immediately before rollback, including any partially applied delta.
	evidence.After = rollbackBefore
	delta := mutationDelta(rollbackBefore.ManagedDisabledServiceIDs, rollbackTarget)
	if len(delta.ToDisableServiceIDs)+len(delta.ToEnableServiceIDs) > 0 {
		changed, err := service.backend.ApplyManagedState(
			rollbackContext,
			preparation.Device.ID,
			rollbackTarget,
		)
		if err != nil {
			return rollbackFailure(evidence, primaryErrorCode, "rollback_delta_failed")
		}
		evidence.Rollback.Rebooted = changed
	}
	verification, err := service.backend.VerifyManagedState(rollbackContext, preparation.Device.ID, rollbackTarget, nil)
	evidence.Rollback.Verification = pointerVerification(verificationEvidence(err, verification))
	rollbackAfter := stateEvidence(evidence.Rollback.Verification.CurrentManagedDisabledIDs)
	evidence.Rollback.After = &rollbackAfter
	if err != nil || !evidence.Rollback.Verification.Verified {
		return rollbackFailure(evidence, primaryErrorCode, "rollback_verification_failed")
	}
	finalState, err := service.backend.RestoreBootState(rollbackContext, preparation.Device.ID, preparation.OriginalBootState)
	if err != nil {
		return rollbackFailure(evidence, primaryErrorCode, "rollback_boot_restore_failed")
	}
	evidence.FinalBootState = finalState
	evidence.Rollback.Succeeded = true
	apiError := protocol.NewError("mutation_failed_rolled_back", "The mutation failed and the helper restored the verified pre-operation state.", false)
	apiError.Details = evidence
	return MutationEvidence{}, apiError
}

func rollbackFailure(evidence MutationEvidence, primaryErrorCode, rollbackErrorCode string) (MutationEvidence, *protocol.APIError) {
	evidence.FailureCode = primaryErrorCode
	evidence.FinalBootState = "Unknown"
	evidence.Rollback.ErrorCode = rollbackErrorCode
	apiError := protocol.NewError("mutation_failed_needs_attention", "The mutation failed and the helper could not prove a complete rollback.", false)
	apiError.Details = evidence
	return MutationEvidence{}, apiError
}

func mutationDelta(current, desired []string) MutationDelta {
	currentSet := stringSet(current)
	desiredSet := stringSet(desired)
	return MutationDelta{
		ToDisableServiceIDs: difference(desiredSet, currentSet),
		ToEnableServiceIDs:  difference(currentSet, desiredSet),
	}
}

func stateEvidence(values []string) simulator.ManagedState {
	values = canonicalManagedIDs(values)
	return simulator.ManagedState{ManagedDisabledServiceIDs: values, Count: len(values)}
}

func emptyVerification(desired []string) simulator.Verification {
	return simulator.Verification{
		CurrentManagedDisabledIDs:       []string{},
		DesiredManagedDisabledIDs:       canonicalManagedIDs(desired),
		MissingDisabledServiceIDs:       []string{},
		UnexpectedDisabledServiceIDs:    []string{},
		RegisteredDisabledLaunchdJobIDs: []string{},
	}
}

func verificationEvidence(err error, verification simulator.Verification) simulator.Verification {
	var failure *simulator.VerificationError
	if errors.As(err, &failure) {
		verification = failure.Evidence
	}
	if verification.CurrentManagedDisabledIDs == nil {
		verification.CurrentManagedDisabledIDs = []string{}
	}
	if verification.DesiredManagedDisabledIDs == nil {
		verification.DesiredManagedDisabledIDs = []string{}
	}
	if verification.MissingDisabledServiceIDs == nil {
		verification.MissingDisabledServiceIDs = []string{}
	}
	if verification.UnexpectedDisabledServiceIDs == nil {
		verification.UnexpectedDisabledServiceIDs = []string{}
	}
	if verification.RegisteredDisabledLaunchdJobIDs == nil {
		verification.RegisteredDisabledLaunchdJobIDs = []string{}
	}
	return verification
}

func pointerVerification(verification simulator.Verification) *simulator.Verification {
	return &verification
}
