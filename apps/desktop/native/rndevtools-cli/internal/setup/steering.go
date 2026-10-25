package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/adalloul0928/rndevtools-cli/internal/client"
)

// steering.json is how the desktop tells the hook about local Supabase: it
// writes the file (0600, atomically) into the agent socket's 0700 directory
// while the feature is on, refreshes it every minute and whenever its
// managed roots change, keeps it across a quit, and removes it when the user
// turns the feature off. The hook only reads it.
const (
	steeringFileName = "steering.json"
	steeringMaxBytes = 64 << 10
	// steeringFreshFor is how long a file still proves the desktop is
	// managing its roots; a crashed desktop's file goes stale after it.
	steeringFreshFor = 3 * time.Minute
	// steeringClockSkew tolerates a file written slightly in the future.
	steeringClockSkew = time.Minute
	// desktopProbeTimeout bounds the connect that proves the desktop runs.
	desktopProbeTimeout = 200 * time.Millisecond
	steeringMaxRoots    = 256
	steeringMaxRunner   = 256
	steeringMaxBranch   = 1024
)

// steeringState is a validated steering.json v1.
type steeringState struct {
	writtenAt time.Time
	// enabled is the user's local Supabase setting; no Supabase rule applies
	// while it is off.
	enabled bool
	roots   []steeringRoot
}

// steeringRoot is one worktree whose stack RN Devtools manages.
type steeringRoot struct {
	worktreeRoot string
	// projectRoot holds supabase/config.toml; it is the worktree root or a
	// directory inside it.
	projectRoot   string
	branchContext string
	// stackReady is false until the branch's stack exists and runs; until
	// then, commands that would create a stack or a shadow are blocked.
	stackReady bool
	// runner is the worktree's own CLI, for example `pnpm exec supabase`.
	runner string
}

// fresh reports whether the file was written recently enough to trust that
// the desktop still manages its roots.
func (state steeringState) fresh(now time.Time) bool {
	age := now.Sub(state.writtenAt)
	return age <= steeringFreshFor && age >= -steeringClockSkew
}

// steeringDirectory is the agent socket's directory, where steering.json
// lives, and the socket the desktop answers on.
func steeringDirectory() (directory string, socket string, err error) {
	socket, err = client.DefaultSocketPath()
	if err != nil {
		return "", "", err
	}
	return filepath.Dir(socket), socket, nil
}

// readSteering loads <directory>/steering.json, validated like the agent
// socket: a real directory and a regular file (neither a symlink), both
// owned by this user with no group or other write, at most 64 KiB, and
// strict v1 JSON. ok is false when the file is missing or fails any check;
// no Supabase rule applies then.
func readSteering(directory string) (steeringState, bool) {
	if !privateDirectory(directory) {
		return steeringState{}, false
	}
	raw, ok := readPrivateFile(filepath.Join(directory, steeringFileName), steeringMaxBytes)
	if !ok {
		return steeringState{}, false
	}
	return parseSteering(raw)
}

func privateDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && ownedAndNotShared(info)
}

// ownedAndNotShared is the socket's ownership rule: this user owns it, and
// neither group nor other may write it.
func ownedAndNotShared(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid()) && info.Mode().Perm()&0o022 == 0
}

// readPrivateFile reads a regular file this user owns and nobody else can
// write, without following a symlink or blocking on a FIFO.
func readPrivateFile(path string, limit int64) ([]byte, bool) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || !ownedAndNotShared(before) || before.Size() > limit {
		return nil, false
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || !after.Mode().IsRegular() {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, false
	}
	return raw, true
}

// parseSteering accepts exactly the v1 shape the desktop writes:
// {"version":1,"writtenAt","desktopPid","supabase":{"enabled","roots":[
// {"worktreeRoot","projectRoot","mode":"managed","branchContext",
// "stackReady","runner"}]}}, every key present and no other.
func parseSteering(raw []byte) (steeringState, bool) {
	document, ok := exactObject(raw, "version", "writtenAt", "desktopPid", "supabase")
	if !ok {
		return steeringState{}, false
	}
	var version int
	if !decodeStrict(document["version"], &version) || version != 1 {
		return steeringState{}, false
	}
	writtenAt, ok := nonNegativeInteger(document["writtenAt"])
	if !ok {
		return steeringState{}, false
	}
	// desktopPid must be a real process id for the file to be v1, though the
	// hook never uses it: a connect to the desktop's socket proves it runs.
	desktopPID, ok := nonNegativeInteger(document["desktopPid"])
	if !ok || desktopPID < 1 || desktopPID > 1<<31-1 {
		return steeringState{}, false
	}
	supabase, ok := exactObject(document["supabase"], "enabled", "roots")
	if !ok {
		return steeringState{}, false
	}
	state := steeringState{writtenAt: time.UnixMilli(writtenAt)}
	if !decodeStrict(supabase["enabled"], &state.enabled) {
		return steeringState{}, false
	}
	var roots []json.RawMessage
	if !decodeStrict(supabase["roots"], &roots) || roots == nil || len(roots) > steeringMaxRoots {
		return steeringState{}, false
	}
	for _, encoded := range roots {
		root, ok := parseSteeringRoot(encoded)
		if !ok {
			return steeringState{}, false
		}
		state.roots = append(state.roots, root)
	}
	return state, true
}

func parseSteeringRoot(raw json.RawMessage) (steeringRoot, bool) {
	fields, ok := exactObject(raw, "worktreeRoot", "projectRoot", "mode", "branchContext", "stackReady", "runner")
	if !ok {
		return steeringRoot{}, false
	}
	var root steeringRoot
	var mode string
	valid := decodeStrict(fields["worktreeRoot"], &root.worktreeRoot) &&
		decodeStrict(fields["projectRoot"], &root.projectRoot) &&
		decodeStrict(fields["mode"], &mode) &&
		decodeStrict(fields["branchContext"], &root.branchContext) &&
		decodeStrict(fields["stackReady"], &root.stackReady) &&
		decodeStrict(fields["runner"], &root.runner)
	if !valid || mode != "managed" ||
		!steeringPath(root.worktreeRoot) || !steeringPath(root.projectRoot) ||
		!steeringText(root.branchContext, steeringMaxBranch) || !steeringText(root.runner, steeringMaxRunner) {
		return steeringRoot{}, false
	}
	root.worktreeRoot = filepath.Clean(root.worktreeRoot)
	root.projectRoot = filepath.Clean(root.projectRoot)
	return root, true
}

// exactObject decodes a JSON object whose keys are exactly names, compared
// case-sensitively (encoding/json alone would match keys in any case).
func exactObject(raw json.RawMessage, names ...string) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if !decodeStrict(raw, &object) || object == nil || len(object) != len(names) {
		return nil, false
	}
	for _, name := range names {
		if _, present := object[name]; !present {
			return nil, false
		}
	}
	return object, true
}

// decodeStrict decodes exactly one JSON value into destination; null, a
// type mismatch, and trailing data all fail.
func decodeStrict(raw json.RawMessage, destination any) bool {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return false
	}
	var trailing any
	return errors.Is(decoder.Decode(&trailing), io.EOF)
}

func nonNegativeInteger(raw json.RawMessage) (int64, bool) {
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err != nil {
		return 0, false
	}
	value, err := number.Int64()
	return value, err == nil && value >= 0
}

// steeringPath is an absolute path the hook can compare against: 2..1024
// bytes, no control characters.
func steeringPath(value string) bool {
	return strings.HasPrefix(value, "/") && len(value) >= 2 && len(value) <= 1024 && steeringText(value, 1024)
}

// steeringText is non-empty, valid UTF-8 text without control characters,
// safe to echo in a hook's reason.
func steeringText(value string, limit int) bool {
	if value == "" || len(value) > limit || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character <= 0x1f || (character >= 0x7f && character <= 0x9f) {
			return false
		}
	}
	return true
}
