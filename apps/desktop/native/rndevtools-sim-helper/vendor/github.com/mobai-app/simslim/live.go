package simslim

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
)

// EnableServices re-enables categories (IDs from `simslim profiles`) and
// individual managed daemons on a booted simulator, live, without a reboot:
// each disable override is lifted and each job loaded into the running boot
// session. It keeps no state of its own, like `on --no-reboot`: the next `on`
// or `watch` pass applies its profile again. With save, the change is also
// written to that profile file (see SaveServices), which is how it persists:
// on a booted simulator only once the live change succeeded; a simulator that
// is not booted only gets the file, and without save it is an error.
func EnableServices(ctx context.Context, udid string, ids []string, save string, report Reporter) (ServicesOutput, error) {
	categories, labels, err := resolveServiceIDs(ids)
	if err != nil {
		return ServicesOutput{}, err
	}
	if len(categories)+len(labels) == 0 {
		return ServicesOutput{}, fmt.Errorf("name at least one category ID or managed daemon to enable (see `simslim profiles`)")
	}
	if err := checkSave(save, categories, labels, true); err != nil {
		return ServicesOutput{}, err
	}
	d, err := serviceTarget(ctx, udid, save)
	if err != nil {
		return ServicesOutput{}, err
	}
	out := ServicesOutput{Action: "enable", UDID: d.UDID, Live: d.State == "Booted", Labels: []string{}}
	if out.Live {
		out.Labels = sortedKeys(coveredLabels(categories, labels))
		report.report(fmt.Sprintf("Starting %d background services without a reboot...", len(out.Labels)))
		if out.NotStarted, err = startServices(ctx, d, out.Labels, report); err != nil {
			return out, unsaved(err, save)
		}
	}
	return out, saveServices(&out, save, categories, labels, true)
}

// DisableServices is the inverse of EnableServices: it stops categories and
// daemons on a booted simulator at once, each one booted out of the running
// boot session with its disable override set, no reboot. A daemon named on its
// own is always stopped, unless the platform needs it. A daemon a named
// category covers is also kept while another category that lists it is fully
// enabled right now (iCloud and the store share the AMS daemons). Both are
// reported in StillEnabled. With save, the categories and daemons are also
// removed from that profile file, once the live change succeeded.
func DisableServices(ctx context.Context, udid string, ids []string, save string, report Reporter) (ServicesOutput, error) {
	categories, labels, err := resolveServiceIDs(ids)
	if err != nil {
		return ServicesOutput{}, err
	}
	if len(categories)+len(labels) == 0 {
		return ServicesOutput{}, fmt.Errorf("name at least one category ID or managed daemon to disable (see `simslim profiles`)")
	}
	slimmable := SlimmableSet()
	for _, l := range labels {
		if !slimmable[l] {
			return ServicesOutput{}, fmt.Errorf("%s is never disabled: simslim keeps it running for compatibility (see `simslim profiles`)", l)
		}
	}
	if err := checkSave(save, categories, labels, false); err != nil {
		return ServicesOutput{}, err
	}
	d, err := serviceTarget(ctx, udid, save)
	if err != nil {
		return ServicesOutput{}, err
	}
	out := ServicesOutput{Action: "disable", UDID: d.UDID, Live: d.State == "Booted", Labels: []string{}}
	if out.Live {
		if err := stopNamed(ctx, d, &out, categories, labels, report); err != nil {
			return out, unsaved(err, save)
		}
	}
	return out, saveServices(&out, save, categories, labels, false)
}

// stopNamed stops what DisableServices was told to on a booted simulator,
// filling out.Labels with what it stops and out.StillEnabled with what it keeps.
func stopNamed(ctx context.Context, d Device, out *ServicesOutput, categories, labels []string, report Reporter) error {
	disabled, err := readDisabled(ctx, d.Set, d.UDID)
	if err != nil {
		return err
	}
	slimmable := SlimmableSet()
	covered := coveredLabels(categories, labels)
	allowed := desiredForDevice(d, covered)
	kept := enabledNeighbours(categories, labels, disabled)
	for _, l := range sortedKeys(covered) {
		if allowed[l] && slimmable[l] && !kept[l] {
			out.Labels = append(out.Labels, l)
		} else {
			out.StillEnabled = append(out.StillEnabled, l)
		}
	}
	if len(out.Labels) == 0 {
		return nil
	}
	report.report(fmt.Sprintf("Stopping %d background services without a reboot...", len(out.Labels)))
	return stopServices(ctx, d, out.Labels, report)
}

// enabledNeighbours returns the labels the disabling categories cover that
// another category, one not being disabled and with every label enabled right
// now, also lists. Only the live state says which features are on, so that is
// what decides: stopping the store keeps the AMS daemons iCloud shares while
// iCloud is fully running. A label named on its own is never kept: naming it
// is asking for exactly that daemon to stop.
func enabledNeighbours(disabling, named []string, disabled map[string]bool) map[string]bool {
	covered := coveredLabels(disabling, nil)
	for _, l := range named {
		delete(covered, l)
	}
	kept := map[string]bool{}
	for _, c := range Categories {
		if slices.Contains(disabling, c.ID) {
			continue
		}
		enabled, shares := true, false
		for _, l := range c.Labels {
			enabled = enabled && !disabled[l]
			shares = shares || covered[l]
		}
		if !enabled || !shares {
			continue
		}
		for _, l := range c.Labels {
			if covered[l] {
				kept[l] = true
			}
		}
	}
	return kept
}

// checkSave validates the profile file --save names before anything changes,
// so a bad file fails the command up front.
func checkSave(save string, categories, labels []string, enable bool) error {
	if save == "" {
		return nil
	}
	_, _, err := updatedProfile(save, categories, labels, enable)
	return err
}

// saveServices writes the change to the profile file --save names, if any,
// once the simulator has been changed.
func saveServices(out *ServicesOutput, save string, categories, labels []string, enable bool) error {
	if save == "" {
		return nil
	}
	if err := SaveServices(save, categories, labels, enable); err != nil {
		if out.Live {
			return fmt.Errorf("the simulator was changed, but profile %s was not: %w", save, err)
		}
		return err
	}
	out.Saved = save
	return nil
}

// unsaved notes on a failed live change that --save left the profile alone.
func unsaved(err error, save string) error {
	if save == "" {
		return err
	}
	return fmt.Errorf("%w (profile %s not changed)", err, save)
}

// serviceTarget resolves the exact simulator `enable` and `disable` act on, so
// a simctl alias such as "all" can never fan out across devices. Only a booted
// simulator can change live; with a profile to save, any simulator is fine,
// since only the file changes.
func serviceTarget(ctx context.Context, udid, save string) (Device, error) {
	d, err := FindDevice(ctx, udid, "")
	if err != nil {
		return Device{}, err
	}
	if d.State != "Booted" && save == "" {
		return Device{}, fmt.Errorf("simulator %s is not booted (it is %s): enable and disable change a running simulator only; pass --save <profile.json> to record the change, then apply it with `simslim on %s --profile <profile.json>`", d.UDID, d.State, d.UDID)
	}
	return d, nil
}

// resolveServiceIDs sorts the IDs `enable` and `disable` accept into category
// IDs and individual managed labels, rejecting anything else.
func resolveServiceIDs(ids []string) (categories, labels []string, err error) {
	managed := managedSet()
	seenCategory, seenLabel := map[string]bool{}, map[string]bool{}
	for _, id := range ids {
		switch {
		case seenCategory[id] || seenLabel[id]:
		case isCategory(id):
			seenCategory[id] = true
			categories = append(categories, id)
		case managed[id]:
			seenLabel[id] = true
			labels = append(labels, id)
		default:
			return nil, nil, fmt.Errorf("unknown category or managed daemon %q (see `simslim profiles`)", id)
		}
	}
	sort.Strings(categories)
	sort.Strings(labels)
	return categories, labels, nil
}

func isCategory(id string) bool {
	_, ok := CategoryByID(id)
	return ok
}

// coveredLabels is every managed label the categories and labels name.
func coveredLabels(categories, labels []string) map[string]bool {
	covered := map[string]bool{}
	for _, id := range categories {
		if c, ok := CategoryByID(id); ok {
			for _, l := range c.Labels {
				covered[l] = true
			}
		}
	}
	managed := managedSet()
	for _, l := range labels {
		if managed[l] {
			covered[l] = true
		}
	}
	return covered
}

// startServices lifts the disable override of each label and loads its job into
// the running boot session, so the daemons are back without a reboot. One
// `launchctl load -w` per chunk handles every label whose job plist is found;
// what is still disabled afterwards gets a per-label `launchctl enable`, and
// what is still not loaded a per-label bootstrap. A label without a plist (an
// XPC service, for example) only needs its override lifted: launchd starts it
// on demand. Labels launchd re-enabled but would not load in this boot session
// are returned; they start at the next boot. A label left disabled is an error.
func startServices(ctx context.Context, d Device, labels []string, report Reporter) (notStarted []string, err error) {
	set, udid := d.Set, d.UDID
	disabled, loaded, err := serviceState(ctx, set, udid)
	if err != nil {
		return nil, err
	}
	var candidates []string
	for _, l := range labels {
		if disabled[l] || !loaded[l] {
			candidates = append(candidates, l)
		}
	}
	plists, haveRoot := map[string]string{}, false
	if d.RuntimeID != "" && len(candidates) > 0 {
		if root, err := runtimeRoot(ctx, d.RuntimeID); err == nil {
			plists, haveRoot = launchdJobPlists(ctx, root, candidates, readPlistLabel), true
		}
	}
	// Without the RuntimeRoot nothing tells a missing plist from an unknown
	// one, so every unloaded label counts as one launchd should load.
	loadable := func(l string) bool { return plists[l] != "" || !haveRoot }
	var pending []string
	for _, l := range candidates {
		if disabled[l] || loadable(l) {
			pending = append(pending, l)
		}
	}
	if len(pending) == 0 {
		report.report(fmt.Sprintf("  all %d services were already running", len(labels)))
		return nil, nil
	}
	var paths []string
	for _, l := range pending {
		if p := plists[l]; p != "" {
			paths = append(paths, p)
		}
	}
	if len(paths) > 0 {
		loadJobs(ctx, set, udid, paths)
		if disabled, loaded, err = serviceState(ctx, set, udid); err != nil {
			return nil, err
		}
		report.report(fmt.Sprintf("  %d/%d services started in one batch", len(pending)-len(stillToStart(pending, disabled, loaded, loadable)), len(pending)))
	}
	var toEnable []string
	unloaded := map[string]string{}
	for _, l := range pending {
		if disabled[l] {
			toEnable = append(toEnable, l)
		}
		if p := plists[l]; p != "" && !loaded[l] {
			unloaded[l] = p
		}
	}
	if len(toEnable) > 0 {
		if err := applyDelta(ctx, set, udid, nil, toEnable, "disable", report); err != nil {
			return nil, err
		}
	}
	if len(unloaded) > 0 {
		bootstrapJobs(ctx, set, udid, unloaded)
	}
	if len(toEnable)+len(unloaded) > 0 {
		if disabled, loaded, err = serviceState(ctx, set, udid); err != nil {
			return nil, err
		}
	}
	var still []string
	for _, l := range pending {
		switch {
		case disabled[l]:
			still = append(still, l)
		case !loaded[l] && loadable(l):
			notStarted = append(notStarted, l)
		}
	}
	if len(still) > 0 {
		return notStarted, fmt.Errorf("%d of %d services are still disabled: %s", len(still), len(pending), strings.Join(still, ", "))
	}
	return notStarted, nil
}

// stillToStart keeps the labels that are still disabled, or still not loaded
// although launchd could load them.
func stillToStart(labels []string, disabled, loaded map[string]bool, loadable func(string) bool) []string {
	var rest []string
	for _, l := range labels {
		if disabled[l] || !loaded[l] && loadable(l) {
			rest = append(rest, l)
		}
	}
	return rest
}

// serviceState reads the disable overrides and the loaded jobs together.
func serviceState(ctx context.Context, set, udid string) (disabled, loaded map[string]bool, err error) {
	if disabled, err = readDisabled(ctx, set, udid); err != nil {
		return nil, nil, err
	}
	if loaded, err = loadedLabels(ctx, set, udid); err != nil {
		return nil, nil, err
	}
	return disabled, loaded, nil
}

// stopServices disables each label and boots its job out of the running boot
// session: one `launchctl unload -w` per chunk first, then a per-label disable
// and bootout for whatever the batch missed. Every override is read back.
func stopServices(ctx context.Context, d Device, labels []string, report Reporter) error {
	remaining := unloadInBatch(ctx, d.Set, d.UDID, d.RuntimeID, labels, readPlistLabel, report)
	if err := applyDelta(ctx, d.Set, d.UDID, remaining, nil, liveDisable, report); err != nil {
		return err
	}
	after, err := readDisabled(ctx, d.Set, d.UDID)
	if err != nil {
		return err
	}
	missing := 0
	for _, l := range labels {
		if !after[l] {
			missing++
		}
	}
	if missing > 0 {
		return fmt.Errorf("%d of %d disable overrides did not take", missing, len(labels))
	}
	return nil
}
