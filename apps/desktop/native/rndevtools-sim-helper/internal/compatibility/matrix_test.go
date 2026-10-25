package compatibility

import (
	"errors"
	"testing"
)

func validTestTuple(runtimeIdentifier string) Tuple {
	return Tuple{
		MacOSBuild:         "25G88",
		XcodeBuild:         "17G42",
		CoreSimulatorBuild: "1051.55",
		RuntimeIdentifier:  runtimeIdentifier,
		RuntimeBuild:       "23F77",
		HostArchitecture:   "arm64",
		HelperVersion:      "0.1.0",
		HelperBuildCommit:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CatalogVersion:     "catalog-v1",
	}
}

func TestExperimentalFoundationHasNoVerifiedMutationTuples(t *testing.T) {
	if tuples := VerifiedTuples(); len(tuples) != 0 {
		t.Fatalf("mutation tuples require real-simulator evidence: %#v", tuples)
	}
}

func TestUnknownValidTupleRequiresExactExperimentalAcknowledgement(t *testing.T) {
	tuple := validTestTuple("com.apple.CoreSimulator.SimRuntime.iOS-26-5")
	if _, err := Evaluate(tuple, "apply_profile", "experimental", "catalog-v1"); !errors.Is(err, ErrAcknowledgementRequired) {
		t.Fatalf("wrong acknowledgement error: %v", err)
	}
	decision, err := Evaluate(tuple, "apply_profile", ExperimentalAcknowledgement, "catalog-v1")
	if err != nil {
		t.Fatal(err)
	}
	if decision.Status != "unknown" || decision.Tuple != tuple {
		t.Fatalf("unexpected decision: %#v", decision)
	}
}

func TestDirtySourceIdentityIsExactButCanNeverBeVerified(t *testing.T) {
	original := matrixEntries
	t.Cleanup(func() { matrixEntries = original })
	tuple := validTestTuple("com.apple.CoreSimulator.SimRuntime.iOS-26-5")
	tuple.HelperBuildCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dirty:" +
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	matrixEntries = []Entry{{Tuple: tuple, Status: "verified"}}
	decision, err := Evaluate(
		tuple,
		"apply_profile",
		ExperimentalAcknowledgement,
		"catalog-v1",
	)
	if err != nil || decision.Status != "unknown" {
		t.Fatalf("dirty source identity was not kept experimental: %#v, %v", decision, err)
	}
}

func TestHardPolicyCannotBeAcknowledged(t *testing.T) {
	for _, runtimeIdentifier := range []string{
		"com.apple.CoreSimulator.SimRuntime.iOS-17-5",
		"com.apple.CoreSimulator.SimRuntime.iOS-18-0",
		"com.apple.CoreSimulator.SimRuntime.iOS-18-4",
	} {
		tuple := validTestTuple(runtimeIdentifier)
		if _, err := Evaluate(tuple, "apply_profile", ExperimentalAcknowledgement, "catalog-v1"); !errors.Is(err, ErrBlocked) {
			t.Fatalf("unsupported runtime %s escaped hard policy: %v", runtimeIdentifier, err)
		}
	}
}

func TestLimitedTupleAllowsOnlyExplicitlyVerifiedOperations(t *testing.T) {
	original := matrixEntries
	t.Cleanup(func() { matrixEntries = original })
	tuple := validTestTuple("com.apple.CoreSimulator.SimRuntime.iOS-26-5")
	matrixEntries = []Entry{{Tuple: tuple, Status: "limited", VerifiedOperations: []string{"restore_managed"}}}
	decision, err := Evaluate(tuple, "restore_managed", "", "catalog-v1")
	if err != nil || decision.Status != "limited" {
		t.Fatalf("verified limited operation was blocked: %#v, %v", decision, err)
	}
	decision, err = Evaluate(tuple, "apply_profile", ExperimentalAcknowledgement, "catalog-v1")
	if !errors.Is(err, ErrOperationNotVerified) || decision.Status != "limited" {
		t.Fatalf("unverified limited operation escaped policy: %#v, %v", decision, err)
	}
}
