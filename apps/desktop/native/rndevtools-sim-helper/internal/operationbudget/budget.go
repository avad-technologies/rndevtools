// Package operationbudget owns the end-to-end helper deadlines and the
// independent cleanup grace each mutating operation requires.
package operationbudget

import (
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/mobai-app/simslim"
)

const (
	DefaultTimeout  = 30 * time.Second
	DiskTimeout     = 10 * time.Minute
	VerifyTimeout   = 11 * time.Minute
	MutationTimeout = 30 * time.Minute
	RollbackTimeout = 30 * time.Minute
)

func Primary(operation protocol.Operation) time.Duration {
	switch operation {
	case protocol.OperationCloneSimulator:
		return simslim.CloneOperationTimeout()
	case protocol.OperationDiskCleanupPlan, protocol.OperationDiskCleanup:
		return DiskTimeout
	case protocol.OperationSimulatorStatus,
		protocol.OperationPreviewProfile,
		protocol.OperationVerifyProfile,
		protocol.OperationDoctor:
		return VerifyTimeout
	case protocol.OperationPrepareMutation:
		return MutationTimeout
	case protocol.OperationApplyProfile,
		protocol.OperationRestoreManaged,
		protocol.OperationUndoLast:
		return MutationTimeout
	default:
		return DefaultTimeout
	}
}

// CleanupGrace is the maximum independently bounded work that can continue
// after the primary context is cancelled. Electron must wait longer than this
// before escalating a graceful SIGTERM to SIGKILL.
func CleanupGrace(operation protocol.Operation) time.Duration {
	switch operation {
	case protocol.OperationCloneSimulator:
		// Unsafe-clone deletion and source-state restoration are distinct LIFO
		// defers, each with its own BootTimeout context.
		return 2 * simslim.BootTimeout
	case protocol.OperationDiskCleanup:
		return simslim.BootTimeout
	case protocol.OperationSimulatorStatus,
		protocol.OperationPreviewProfile,
		protocol.OperationVerifyProfile,
		protocol.OperationDoctor:
		// Inspection of a Shutdown target temporarily boots it and restores the
		// original state using an independent cleanup context.
		return simslim.BootTimeout
	case protocol.OperationPrepareMutation:
		return simslim.BootTimeout
	case protocol.OperationApplyProfile,
		protocol.OperationRestoreManaged,
		protocol.OperationUndoLast:
		return RollbackTimeout
	default:
		return 0
	}
}
