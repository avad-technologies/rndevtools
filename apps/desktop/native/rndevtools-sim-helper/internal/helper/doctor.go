package helper

import (
	"context"
	"errors"
	"sort"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/mobai-app/simslim"
)

const maxDoctorCapabilities = 20

type DoctorCapabilityInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type DoctorCapabilityResult struct {
	ID                  string   `json:"id"`
	Available           bool     `json:"available"`
	BlockedByServiceIDs []string `json:"blockedByServiceIds"`
}

type DoctorResult struct {
	SimulatorID               string                   `json:"simulatorId"`
	Healthy                   bool                     `json:"healthy"`
	ManagedDisabledServiceIDs []string                 `json:"managedDisabledServiceIds"`
	Capabilities              []DoctorCapabilityResult `json:"capabilities"`
}

// The renderer shipped these stable IDs before SimSlim exposed its library.
// Keep that wire contract while resolving every feature and label through the
// pinned upstream library.
var doctorFeatureIDs = map[string]string{
	"push-notifications": "push",
	"storekit":           "storekit",
	"universal-links":    "universal-links",
	"icloud-sync":        "icloud",
	"healthkit":          "health",
	"homekit":            "homekit",
	"photo-library":      "photos",
	"contacts":           "contacts",
	"calendar":           "calendar",
	"siri":               "siri",
	"spotlight":          "spotlight",
	"app-store":          "app-store",
}

func doctorCapabilityInfos() []DoctorCapabilityInfo {
	ids := make([]string, 0, len(doctorFeatureIDs))
	for id := range doctorFeatureIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	result := make([]DoctorCapabilityInfo, 0, len(ids))
	for _, id := range ids {
		feature, err := resolveDoctorFeature(id)
		if err == nil {
			result = append(result, DoctorCapabilityInfo{ID: id, DisplayName: feature.Name})
		}
	}
	return result
}

func (service *Service) doctor(ctx context.Context, payload doctorPayload) (DoctorResult, *protocol.APIError) {
	if len(payload.RequiredCapabilities) == 0 || len(payload.RequiredCapabilities) > maxDoctorCapabilities {
		return DoctorResult{}, protocol.NewError(
			"invalid_capabilities",
			"requiredCapabilities must contain between 1 and 20 unique known capability IDs.",
			false,
		)
	}
	seen := make(map[string]struct{}, len(payload.RequiredCapabilities))
	features := make([]simslim.Feature, 0, len(payload.RequiredCapabilities))
	for _, id := range payload.RequiredCapabilities {
		if _, duplicate := seen[id]; duplicate {
			return DoctorResult{}, protocol.NewError("invalid_capabilities", "requiredCapabilities contains a duplicate capability ID.", false)
		}
		feature, err := resolveDoctorFeature(id)
		if err != nil {
			return DoctorResult{}, protocol.NewError("invalid_capabilities", "requiredCapabilities contains an unknown capability ID.", false)
		}
		seen[id] = struct{}{}
		features = append(features, feature)
	}
	status, err := service.backend.Status(ctx, payload.SimulatorID)
	if err != nil {
		return DoctorResult{}, backendError(err)
	}
	disabled := make(map[string]bool, len(status.ManagedDisabledServiceIDs))
	for _, label := range status.ManagedDisabledServiceIDs {
		disabled[label] = true
	}
	diagnosis := simslim.DiagnoseFeatures(features, disabled)
	capabilities := make([]DoctorCapabilityResult, 0, len(diagnosis.Features))
	for index, feature := range diagnosis.Features {
		// Keep the helper's strict JSON contract stable: a capability with no
		// blockers must encode as [] rather than null.
		blocked := append([]string{}, feature.Disabled...)
		sort.Strings(blocked)
		capabilities = append(capabilities, DoctorCapabilityResult{
			ID:                  payload.RequiredCapabilities[index],
			Available:           feature.OK,
			BlockedByServiceIDs: blocked,
		})
	}
	return DoctorResult{
		SimulatorID:               payload.SimulatorID,
		Healthy:                   diagnosis.OK,
		ManagedDisabledServiceIDs: canonicalManagedIDs(status.ManagedDisabledServiceIDs),
		Capabilities:              capabilities,
	}, nil
}

func resolveDoctorFeature(id string) (simslim.Feature, error) {
	upstreamID, known := doctorFeatureIDs[id]
	if !known {
		return simslim.Feature{}, errors.New("unknown doctor capability")
	}
	features, err := simslim.ResolveFeatures([]string{upstreamID})
	if err != nil || len(features) != 1 {
		if err != nil {
			return simslim.Feature{}, err
		}
		return simslim.Feature{}, errors.New("pinned SimSlim feature catalog is inconsistent")
	}
	return features[0], nil
}
