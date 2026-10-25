package helper

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/catalog"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/simulator"
)

const (
	MaxCheckpointTokenBytes   = 32 * 1024
	checkpointSchemaVersion   = 4
	checkpointDigestDomain    = "rndevtools-sim-checkpoint-v4\x00"
	checkpointPurposePrepared = "prepared-mutation"
)

var checkpointPreparationIDPattern = regexp.MustCompile(`^preparation-[a-f0-9]{32}$`)
var checkpointProfileIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$`)

type checkpointPayload struct {
	SchemaVersion               int                 `json:"schemaVersion"`
	CatalogVersion              string              `json:"catalogVersion"`
	CatalogSourceCommit         string              `json:"catalogSourceCommit"`
	CatalogPatchSet             string              `json:"catalogPatchSet"`
	VendoredSourceManifestHash  string              `json:"vendoredSourceManifestHash"`
	CompatibilityMatrixVersion  string              `json:"compatibilityMatrixVersion"`
	SimulatorID                 string              `json:"simulatorId"`
	Tuple                       compatibility.Tuple `json:"tuple"`
	OriginalBootState           string              `json:"originalBootState"`
	ManagedDisabledServiceIDs   []string            `json:"managedDisabledServiceIds"`
	Purpose                     string              `json:"purpose"`
	PreparationID               string              `json:"preparationId,omitempty"`
	PreparedOperation           protocol.Operation  `json:"preparedOperation,omitempty"`
	PreparedProfileID           string              `json:"preparedProfileId,omitempty"`
	PreparedDesiredServiceIDs   []string            `json:"preparedDesiredServiceIds"`
	ObservedRunningProcessNames []string            `json:"observedRunningProcessNames"`
}

func encodePreparedCheckpoint(
	simulatorID, originalBootState string,
	tuple compatibility.Tuple,
	managedDisabledServiceIDs []string,
	operation protocol.Operation,
	profileID string,
	desiredServiceIDs []string,
	observedRunningProcessNames []string,
) (string, error) {
	preparationIDBytes := make([]byte, 16)
	if _, err := rand.Read(preparationIDBytes); err != nil {
		return "", errors.New("could not create checkpoint preparation ID")
	}
	return encodeCheckpointPayload(checkpointPayload{
		SchemaVersion:               checkpointSchemaVersion,
		CatalogVersion:              catalog.Version,
		CatalogSourceCommit:         catalog.UpstreamCommit,
		CatalogPatchSet:             catalog.PatchSet,
		VendoredSourceManifestHash:  catalog.VendoredSourceManifestSHA256,
		CompatibilityMatrixVersion:  compatibility.Version,
		SimulatorID:                 simulatorID,
		Tuple:                       tuple,
		OriginalBootState:           originalBootState,
		ManagedDisabledServiceIDs:   canonicalManagedIDs(managedDisabledServiceIDs),
		Purpose:                     checkpointPurposePrepared,
		PreparationID:               "preparation-" + hex.EncodeToString(preparationIDBytes),
		PreparedOperation:           operation,
		PreparedProfileID:           profileID,
		PreparedDesiredServiceIDs:   canonicalManagedIDs(desiredServiceIDs),
		ObservedRunningProcessNames: canonicalProcessNames(observedRunningProcessNames),
	})
}

func encodeCheckpointPayload(payload checkpointPayload) (string, error) {
	if err := validateCheckpointPayload(payload); err != nil {
		return "", err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", errors.New("could not encode checkpoint")
	}
	digest := checkpointDigest(data)
	token := base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString(digest[:])
	if len(token) > MaxCheckpointTokenBytes {
		return "", errors.New("checkpoint exceeds its safety limit")
	}
	return token, nil
}

func decodeCheckpoint(token string) (checkpointPayload, error) {
	if token == "" || len(token) > MaxCheckpointTokenBytes || strings.TrimSpace(token) != token {
		return checkpointPayload{}, errors.New("checkpoint token is invalid")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return checkpointPayload{}, errors.New("checkpoint token is invalid")
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return checkpointPayload{}, errors.New("checkpoint token is invalid")
	}
	digest, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(digest) != sha256.Size {
		return checkpointPayload{}, errors.New("checkpoint token is invalid")
	}
	expectedDigest := checkpointDigest(data)
	if subtle.ConstantTimeCompare(digest, expectedDigest[:]) != 1 {
		return checkpointPayload{}, errors.New("checkpoint integrity check failed")
	}

	var payload checkpointPayload
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return checkpointPayload{}, errors.New("checkpoint payload is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return checkpointPayload{}, errors.New("checkpoint payload is invalid")
	}
	if err := validateCheckpointPayload(payload); err != nil {
		return checkpointPayload{}, err
	}
	canonical, err := json.Marshal(payload)
	if err != nil || !bytes.Equal(canonical, data) {
		return checkpointPayload{}, errors.New("checkpoint payload is not canonical")
	}
	return payload, nil
}

func validateCheckpointPayload(payload checkpointPayload) error {
	if payload.SchemaVersion != checkpointSchemaVersion || payload.CatalogVersion != catalog.Version ||
		payload.CatalogSourceCommit != catalog.UpstreamCommit || payload.CatalogPatchSet != catalog.PatchSet ||
		payload.VendoredSourceManifestHash != catalog.VendoredSourceManifestSHA256 ||
		payload.CompatibilityMatrixVersion != compatibility.Version {
		return errors.New("checkpoint metadata is not compatible with this helper")
	}
	if !simulator.UDIDPattern.MatchString(payload.SimulatorID) {
		return errors.New("checkpoint simulator ID is invalid")
	}
	if payload.OriginalBootState != "Booted" && payload.OriginalBootState != "Shutdown" {
		return errors.New("checkpoint boot state is invalid")
	}
	if payload.Tuple.CatalogVersion != catalog.Version || payload.Tuple.RuntimeIdentifier == "" ||
		payload.Tuple.MacOSBuild == "" || payload.Tuple.XcodeBuild == "" ||
		payload.Tuple.CoreSimulatorBuild == "" || payload.Tuple.RuntimeBuild == "" ||
		payload.Tuple.HelperVersion == "" || payload.Tuple.HelperBuildCommit == "" ||
		(payload.Tuple.HostArchitecture != "arm64" && payload.Tuple.HostArchitecture != "x64") {
		return errors.New("checkpoint compatibility tuple is invalid")
	}
	if compatibility.Classify(payload.Tuple, catalog.Version).Status == "blocked" {
		return errors.New("checkpoint compatibility tuple is blocked")
	}
	if len(payload.ManagedDisabledServiceIDs) > len(catalog.ManagedServiceIDs()) {
		return errors.New("checkpoint managed service set exceeds the catalog")
	}
	allowlist := stringSet(catalog.ManagedServiceIDs())
	previous := ""
	for index, serviceID := range payload.ManagedDisabledServiceIDs {
		if _, allowed := allowlist[serviceID]; !allowed {
			return errors.New("checkpoint contains a non-catalog service")
		}
		if index > 0 && serviceID <= previous {
			return errors.New("checkpoint managed service set is not sorted and unique")
		}
		previous = serviceID
	}
	if payload.PreparedDesiredServiceIDs == nil {
		return errors.New("checkpoint prepared desired service set is missing")
	}
	if payload.ObservedRunningProcessNames == nil || len(payload.ObservedRunningProcessNames) > 256 {
		return errors.New("checkpoint observed process set is missing or too large")
	}
	previous = ""
	for index, processName := range payload.ObservedRunningProcessNames {
		if !simulator.ProcessNamePattern.MatchString(processName) {
			return errors.New("checkpoint observed process name is invalid")
		}
		if index > 0 && processName <= previous {
			return errors.New("checkpoint observed process set is not sorted and unique")
		}
		previous = processName
	}
	previous = ""
	for index, serviceID := range payload.PreparedDesiredServiceIDs {
		if _, allowed := allowlist[serviceID]; !allowed {
			return errors.New("checkpoint prepared target contains a non-catalog service")
		}
		if index > 0 && serviceID <= previous {
			return errors.New("checkpoint prepared target is not sorted and unique")
		}
		previous = serviceID
	}
	if payload.Purpose != checkpointPurposePrepared {
		return errors.New("checkpoint purpose is invalid")
	}
	if !checkpointPreparationIDPattern.MatchString(payload.PreparationID) {
		return errors.New("checkpoint preparation ID is invalid")
	}
	switch payload.PreparedOperation {
	case protocol.OperationApplyProfile:
		if !checkpointProfileIDPattern.MatchString(payload.PreparedProfileID) {
			return errors.New("checkpoint prepared profile ID is invalid")
		}
		desired, err := catalog.DesiredServiceIDs(payload.PreparedProfileID)
		if err != nil || !slices.Equal(canonicalManagedIDs(desired), payload.PreparedDesiredServiceIDs) {
			return errors.New("checkpoint prepared profile target is invalid")
		}
	case protocol.OperationRestoreManaged:
		if payload.PreparedProfileID != "" || len(payload.PreparedDesiredServiceIDs) != 0 {
			return errors.New("checkpoint prepared restore target is invalid")
		}
	case protocol.OperationUndoLast:
		if payload.PreparedProfileID != "" {
			return errors.New("checkpoint prepared undo target is invalid")
		}
	default:
		return errors.New("checkpoint prepared operation is invalid")
	}
	return nil
}

func checkpointDigest(data []byte) [sha256.Size]byte {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte(checkpointDigestDomain))
	_, _ = hasher.Write(data)
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return digest
}

func canonicalManagedIDs(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

func canonicalProcessNames(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return slices.Compact(out)
}
