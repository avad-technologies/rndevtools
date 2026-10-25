// Package compatibility owns the exact host/runtime tuples that may perform
// simulator service mutations. Read-only operations do not depend on it.
package compatibility

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const (
	Version                     = "2026-09-03-v2"
	ExperimentalAcknowledgement = "EXPERIMENTAL"
)

var (
	ErrAcknowledgementRequired = errors.New("the exact EXPERIMENTAL acknowledgement is required for an unverified tuple")
	ErrBlocked                 = errors.New("the host/runtime tuple is blocked by the immutable mutation policy")
	ErrOperationNotVerified    = errors.New("the operation is not verified for this limited tuple")
	buildPattern               = regexp.MustCompile(`^[A-Za-z0-9.]{2,32}$`)
	helperVersionPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$`)
	SourceCommitPattern        = regexp.MustCompile(`^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$`)
	runtimePattern             = regexp.MustCompile(`^com\.apple\.CoreSimulator\.SimRuntime\.iOS-([0-9]{1,2})(?:[-.]([0-9]{1,2}))?(?:[-.]([0-9]{1,2}))?$`)
)

type Tuple struct {
	MacOSBuild         string `json:"macOSBuild"`
	XcodeBuild         string `json:"xcodeBuild"`
	CoreSimulatorBuild string `json:"coreSimulatorBuild"`
	RuntimeIdentifier  string `json:"runtimeIdentifier"`
	RuntimeBuild       string `json:"runtimeBuild"`
	HostArchitecture   string `json:"hostArchitecture"`
	HelperVersion      string `json:"helperVersion"`
	HelperBuildCommit  string `json:"helperBuildCommit"`
	CatalogVersion     string `json:"catalogVersion"`
}

type Entry struct {
	Tuple              Tuple
	Status             string
	VerifiedOperations []string
}

// matrixEntries intentionally starts empty, classifying structurally supported
// tuples as unknown. Additions require disposable real-simulator evidence;
// accepting a launchctl command is not sufficient verification. Status is one
// of verified, limited, or blocked. Unknown is the absence of an entry.
var matrixEntries = []Entry{}

// permanentlyBlockedTuples is an immutable deny hook. A tuple placed here can
// never be enabled by the experimental acknowledgement. Entries require a
// source-linked safety reason in the same review.
var permanentlyBlockedTuples = [...]Tuple{}

func VerifiedTuples() []Tuple {
	out := make([]Tuple, 0)
	for _, entry := range matrixEntries {
		if entry.Status == "verified" {
			out = append(out, entry.Tuple)
		}
	}
	return out
}

func Evaluate(candidate Tuple, operation, acknowledgement, expectedCatalogVersion string) (Decision, error) {
	decision := Classify(candidate, expectedCatalogVersion)
	switch decision.Status {
	case "verified":
		return decision, nil
	case "limited":
		for _, verifiedOperation := range decision.VerifiedOperations {
			if verifiedOperation == operation {
				return decision, nil
			}
		}
		return decision, ErrOperationNotVerified
	case "unknown":
		if acknowledgement != ExperimentalAcknowledgement {
			return decision, ErrAcknowledgementRequired
		}
		return decision, nil
	default:
		return decision, ErrBlocked
	}
}

func Classify(candidate Tuple, expectedCatalogVersion string) Decision {
	decision := Decision{
		Status:             "blocked",
		MatrixVersion:      Version,
		Tuple:              candidate,
		VerifiedOperations: []string{},
	}
	if !validTuple(candidate, expectedCatalogVersion) || isPermanentlyBlocked(candidate) {
		return decision
	}
	decision.Status = "unknown"
	// Dirty native source identities are exact and acknowledgement-bound for
	// local development, but can never match a verified release tuple.
	if strings.Contains(candidate.HelperBuildCommit, "-dirty:") {
		return decision
	}
	for _, entry := range matrixEntries {
		if entry.Tuple == candidate {
			decision.Status = entry.Status
			decision.VerifiedOperations = append([]string{}, entry.VerifiedOperations...)
			return decision
		}
	}
	return decision
}

type Decision struct {
	Status             string   `json:"status"`
	MatrixVersion      string   `json:"matrixVersion"`
	Tuple              Tuple    `json:"tuple"`
	VerifiedOperations []string `json:"verifiedOperations"`
}

func validTuple(candidate Tuple, expectedCatalogVersion string) bool {
	if !buildPattern.MatchString(candidate.MacOSBuild) ||
		!buildPattern.MatchString(candidate.XcodeBuild) ||
		!buildPattern.MatchString(candidate.CoreSimulatorBuild) ||
		!buildPattern.MatchString(candidate.RuntimeBuild) ||
		!helperVersionPattern.MatchString(candidate.HelperVersion) ||
		!SourceCommitPattern.MatchString(candidate.HelperBuildCommit) {
		return false
	}
	if candidate.HostArchitecture != "arm64" && candidate.HostArchitecture != "x64" {
		return false
	}
	if candidate.CatalogVersion != expectedCatalogVersion || candidate.CatalogVersion == "" {
		return false
	}
	match := runtimePattern.FindStringSubmatch(candidate.RuntimeIdentifier)
	if len(match) == 0 {
		return false
	}
	major, majorErr := strconv.Atoi(match[1])
	minor := 0
	var minorErr error
	if match[2] != "" {
		minor, minorErr = strconv.Atoi(match[2])
	}
	return majorErr == nil && minorErr == nil &&
		(major > 18 || (major == 18 && minor >= 5))
}

func isPermanentlyBlocked(candidate Tuple) bool {
	for _, blocked := range permanentlyBlockedTuples {
		if blocked == candidate {
			return true
		}
	}
	// Keep obviously non-production placeholders out even if they happen to
	// satisfy the structural regular expressions.
	return strings.EqualFold(candidate.MacOSBuild, "unknown") || strings.EqualFold(candidate.XcodeBuild, "unknown")
}
