package operationbudget

import (
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/mobai-app/simslim"
)

func TestPrimaryAndCleanupBudgetsCannotCutOffSafetyRecovery(t *testing.T) {
	if Primary(protocol.OperationCloneSimulator) != simslim.CloneOperationTimeout() {
		t.Fatal("clone primary timeout drifted from the pinned library")
	}
	if CleanupGrace(protocol.OperationCloneSimulator) < 2*simslim.BootTimeout {
		t.Fatal("clone cleanup grace cannot cover delete and source restore")
	}
	if CleanupGrace(protocol.OperationDiskCleanup) < simslim.BootTimeout {
		t.Fatal("disk cleanup grace cannot cover independent boot restoration")
	}
	if Primary(protocol.OperationApplyProfile) < RollbackTimeout ||
		CleanupGrace(protocol.OperationApplyProfile) < RollbackTimeout {
		t.Fatal("mutation budgets cannot cut off an exact rollback")
	}
	if Primary(protocol.OperationVerifyProfile) != 11*time.Minute {
		t.Fatal("profile verification lost its long-running budget")
	}
	if CleanupGrace(protocol.OperationSimulatorStatus) < simslim.BootTimeout {
		t.Fatal("shutdown-target inspection cleanup cannot be cut off")
	}
	if Primary(protocol.OperationHandshake) != DefaultTimeout || CleanupGrace(protocol.OperationHandshake) != 0 {
		t.Fatal("read-only handshake should retain the short no-cleanup budget")
	}
}
