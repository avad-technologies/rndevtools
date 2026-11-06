package simslim

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
)

// SaveServices records an `enable` or `disable` in a profile file, the one
// place that describes a slim simulator, so `on`, `watch`, and `verify` with
// that profile agree with it. Enabling adds each category to "except" and each
// daemon to "keep"; disabling removes them. Entries keep their order, new ones
// go at the end, and nothing is listed twice: a daemon an excepted category
// already keeps is not added to "keep". A missing file starts from the default
// profile, the one `on` applies without --profile. An unchanged profile is not
// rewritten; a changed one is replaced atomically.
func SaveServices(path string, categories, labels []string, enable bool) error {
	data, changed, err := updatedProfile(path, categories, labels, enable)
	if err != nil || !changed {
		return err
	}
	return writeFileAtomic(path, data)
}

// updatedProfile reads the profile at path and returns it with the change
// applied, and whether that changed anything. It writes nothing.
func updatedProfile(path string, categories, labels []string, enable bool) (data []byte, changed bool, err error) {
	sp, exists, err := readSlimProfile(path)
	if err != nil {
		return nil, false, err
	}
	before := slices.Clone(sp.Except)
	beforeKeep := slices.Clone(sp.Keep)
	if enable {
		for _, id := range categories {
			if !slices.Contains(sp.Except, id) {
				sp.Except = append(sp.Except, id)
			}
		}
		excepted := coveredLabels(sp.Except, nil)
		for _, l := range labels {
			if !excepted[l] && !slices.Contains(sp.Keep, l) {
				sp.Keep = append(sp.Keep, l)
			}
		}
	} else {
		sp.Except = slices.DeleteFunc(sp.Except, func(id string) bool { return slices.Contains(categories, id) })
		sp.Keep = slices.DeleteFunc(sp.Keep, func(l string) bool { return slices.Contains(labels, l) })
		// Removing a daemon from "keep" is not enough while a category the
		// profile still excepts lists it.
		for _, l := range labels {
			for _, id := range sp.Except {
				if coveredLabels([]string{id}, nil)[l] {
					return nil, false, fmt.Errorf("profile %s keeps %s enabled through category %q; disable that category instead, or edit the file", path, l, id)
				}
			}
		}
	}
	if exists && slices.Equal(before, sp.Except) && slices.Equal(beforeKeep, sp.Keep) {
		return nil, false, nil
	}
	data, err = MarshalProfile(sp)
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// readSlimProfile reads and validates a profile file, keeping its entries as
// written. A missing file is the default profile.
func readSlimProfile(path string) (sp SlimProfile, exists bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return SlimProfile{}, false, nil
	}
	if err != nil {
		return SlimProfile{}, false, fmt.Errorf("read profile %s: %w", path, err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&sp); err != nil {
		return SlimProfile{}, false, parseProfileError(path, err)
	}
	if _, err := sp.resolve(path); err != nil {
		return SlimProfile{}, false, err
	}
	return sp, true, nil
}

// writeFileAtomic replaces path with data through a temporary file in the same
// directory, so a concurrent reader sees the old file or the new one, never
// half of it. A symlink is followed, and an existing file keeps its mode.
func writeFileAtomic(path string, data []byte) error {
	mode := fs.FileMode(0o644)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
		if info, err := os.Stat(path); err == nil {
			mode = info.Mode().Perm()
		}
	}
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	if err := os.Chmod(temp.Name(), mode); err != nil {
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return fmt.Errorf("write profile %s: %w", path, err)
	}
	return nil
}
