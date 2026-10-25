package catalog

import (
	"regexp"
	"slices"
	"testing"

	"github.com/mobai-app/simslim"
)

func TestCatalogInvariants(t *testing.T) {
	servicePattern := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	categoryIDs := make(map[string]struct{})
	allCategories := Categories()
	if len(allCategories) != 15 {
		t.Fatalf("category count = %d, want 15", len(allCategories))
	}
	for _, category := range allCategories {
		if _, duplicate := categoryIDs[category.ID]; duplicate {
			t.Fatalf("duplicate category ID %q", category.ID)
		}
		categoryIDs[category.ID] = struct{}{}
		seen := make(map[string]struct{})
		for _, serviceID := range category.ServiceIDs {
			if !servicePattern.MatchString(serviceID) {
				t.Errorf("invalid service ID %q", serviceID)
			}
			if _, duplicate := seen[serviceID]; duplicate {
				t.Errorf("category %q repeats service %q", category.ID, serviceID)
			}
			seen[serviceID] = struct{}{}
		}
	}

	// SimSlim v0.12.2 moved assistantd and gamed from slimmable labels to
	// restore-only AlwaysEnabled services (alongside sharingd). The slimmable
	// universe is therefore 168 and the managed universe 168 + 3.
	if len(ManagedServiceIDs()) != 171 {
		t.Fatalf("managed allowlist count = %d, want 171", len(ManagedServiceIDs()))
	}
	maximum, err := DesiredServiceIDs("maximum-density")
	if err != nil {
		t.Fatal(err)
	}
	if len(maximum) != 168 {
		t.Fatalf("maximum profile count = %d, want 168 plus three restore-only labels", len(maximum))
	}
}

func TestUpstreamRestoreOnlyServicesAreNeverSlimTargetsButRemainRestorable(t *testing.T) {
	restoreOnly := []string{
		"com.apple.sharingd",   // system share sheets
		"com.apple.assistantd", // dictation host; Spotlight leaks memory without it
		"com.apple.gamed",      // XCUITest launch latency (DTServiceHub / GameKit)
	}
	for _, label := range restoreOnly {
		if simslim.SlimmableSet()[label] {
			t.Fatalf("test assumption drifted: %s is slimmable upstream again", label)
		}
		if !slices.Contains(ManagedServiceIDs(), label) {
			t.Errorf("legacy override for %s can no longer be restored", label)
		}
		for _, profile := range Profiles() {
			desired, err := DesiredServiceIDs(profile.ID)
			if err != nil {
				t.Fatal(err)
			}
			if slices.Contains(desired, label) {
				t.Errorf("profile %q disables restore-only service %s", profile.ID, label)
			}
		}
	}
}

func TestProjectionMatchesPinnedUpstreamDesiredSets(t *testing.T) {
	for _, profile := range Profiles() {
		desired, err := DesiredServiceIDs(profile.ID)
		if err != nil {
			t.Fatal(err)
		}
		upstreamProfile, err := UpstreamProfileForDesired(desired)
		if err != nil {
			t.Fatalf("profile %q is not representable by upstream: %v", profile.ID, err)
		}
		if upstreamDesired := sortedKeys(upstreamProfile.Desired()); !slices.Equal(desired, upstreamDesired) {
			t.Fatalf("profile %q drifted from upstream: got %#v want %#v", profile.ID, upstreamDesired, desired)
		}
	}

	if _, err := UpstreamProfileForDesired([]string{"com.apple.sharingd"}); err == nil {
		t.Fatal("upstream restore-only service unexpectedly became a representable slim target")
	}
	if simslim.SlimmableSet()["com.apple.sharingd"] {
		t.Fatal("test assumption drifted: sharingd is no longer restore-only upstream")
	}
}

func TestPUMDPresetsPreserveDeclaredDevelopmentCapabilities(t *testing.T) {
	criticalServices := []string{
		"com.apple.apsd",          // push notifications
		"com.apple.swcd",          // universal links
		"com.apple.akd",           // account/keychain authentication
		"com.apple.appleaccountd", // Apple Account
		"com.apple.storekitd",     // StoreKit
		"com.apple.appstored",     // App Store installs
		"com.apple.passd",         // purchase credentials
		"com.apple.financed",      // purchase finance state
	}
	for _, profileID := range []string{"rndevtools-development", "rndevtools-ui-automation"} {
		desired, err := DesiredServiceIDs(profileID)
		if err != nil {
			t.Fatal(err)
		}
		for _, serviceID := range criticalServices {
			if slices.Contains(desired, serviceID) {
				t.Errorf("profile %q disables preserved capability service %q", profileID, serviceID)
			}
		}
	}
}

func TestBuiltInProfilesAreTheThreeApprovedImmutablePresets(t *testing.T) {
	profiles := Profiles()
	got := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		got = append(got, profile.ID)
	}
	want := []string{"rndevtools-development", "rndevtools-ui-automation", "maximum-density"}
	if !slices.Equal(got, want) {
		t.Fatalf("profile IDs = %#v, want %#v", got, want)
	}
	legacy, ok := ProfileByID("ui-automation")
	if !ok || legacy.ID != "rndevtools-ui-automation" {
		t.Fatalf("legacy profile alias did not resolve: %#v", legacy)
	}
}

func TestPUMDPresetsKeepPersistentLaunchdJobsEnabledAndRestorable(t *testing.T) {
	kept := []string{
		"com.apple.MapKit.SnapshotService",
		"com.apple.siri.acousticsignature",
		"com.apple.siri.context.service",
	}
	for _, profileID := range []string{"rndevtools-development", "rndevtools-ui-automation"} {
		desired, err := DesiredServiceIDs(profileID)
		if err != nil {
			t.Fatal(err)
		}
		profile, _ := ProfileByID(profileID)
		for _, label := range kept {
			if slices.Contains(desired, label) {
				t.Errorf("%s still disables persistent launchd job %s", profileID, label)
			}
			if !slices.Contains(ManagedServiceIDs(), label) {
				t.Errorf("legacy override for %s can no longer be restored", label)
			}
			if !slices.Contains(profile.PreservedServiceIDs, label) {
				t.Errorf("%s does not disclose preserved service %s", profileID, label)
			}
		}
	}
}

func TestSharedServiceStaysEnabledWhenAnyOwningCategoryIsKept(t *testing.T) {
	desired, err := desiredForCategories([]string{"store"})
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(desired, "com.apple.amsaccountsd") {
		t.Fatal("shared iCloud/Store service must stay enabled when iCloud is kept")
	}
	if !slices.Contains(desired, "com.apple.storekitd") {
		t.Fatal("Store-only service should be disabled by a Store profile")
	}
}

func TestProfilesOnlyReferenceKnownCategories(t *testing.T) {
	known := make(map[string]struct{})
	for _, category := range Categories() {
		known[category.ID] = struct{}{}
	}
	for _, profile := range Profiles() {
		for _, id := range profile.CategoryIDs {
			if _, ok := known[id]; !ok {
				t.Errorf("profile %q references unknown category %q", profile.ID, id)
			}
		}
		if _, err := DesiredServiceIDs(profile.ID); err != nil {
			t.Errorf("profile %q does not resolve: %v", profile.ID, err)
		}
	}
}
