package authorization

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	expectedBrokerName       = "rndevtools-native-host"
	expectedBrokerIdentifier = "rndevtools-native-host"
	expectedHelperIdentifier = "rndevtools-sim-helper"
)

// expectedTeamIdentifier is the Apple Developer Team ID that must have signed
// the desktop app and its helpers. It is injected at link time so a fork can
// ship under its own signing identity:
//
//	go build -ldflags "-X <module>/internal/authorization.expectedTeamIdentifier=ABCDE12345"
//
// It is deliberately empty by default: an unsigned local build must fail closed
// rather than attest against an unknown signer.
var expectedTeamIdentifier = ""

// CompiledTeamIdentifier reports the linked parent-attestation pin for release
// verification. Reading it never authorizes a mutation or changes the pin.
func CompiledTeamIdentifier() string {
	return expectedTeamIdentifier
}

// CS_* status flags from <sys/codesign.h>, as reported by csops(CS_OPS_STATUS).
const (
	csValid uint32 = 0x00000001
	csAdhoc uint32 = 0x00000002
)

// LiveCodeIdentity is the kernel's own view of a running process: the
// CodeDirectory hash attached at exec time and the current code-signing status
// flags. Nothing that happens to the executable on disk after launch changes it.
type LiveCodeIdentity struct {
	CodeDirectoryHash [20]byte
	Flags             uint32
}

type liveCodeIdentityReader func(pid int) (LiveCodeIdentity, error)

type SystemParentAttestor struct{}

func (SystemParentAttestor) Attest(ctx context.Context, parentPID int) error {
	if runtime.GOOS != "darwin" {
		return errors.New("mutation broker attestation is supported only on macOS")
	}
	if parentPID <= 1 || os.Getppid() != parentPID {
		return errors.New("parent identity changed before attestation")
	}

	helperPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve helper executable: %w", err)
	}
	helperPath, err = filepath.EvalSymlinks(helperPath)
	if err != nil {
		return fmt.Errorf("canonicalize helper executable: %w", err)
	}

	attestationContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	parentPath, err := processPath(attestationContext, parentPID)
	if err != nil {
		return err
	}
	parentPath, err = filepath.EvalSymlinks(parentPath)
	if err != nil {
		return fmt.Errorf("canonicalize broker executable: %w", err)
	}
	if filepath.Base(parentPath) != expectedBrokerName || filepath.Dir(parentPath) != filepath.Dir(helperPath) {
		return errors.New("parent is not the packaged sibling mutation broker")
	}
	parentBefore, err := os.Stat(parentPath)
	if err != nil || !parentBefore.Mode().IsRegular() {
		return errors.New("broker executable is not a regular file")
	}

	if err := verifyLiveCode(
		attestationContext,
		parentPID,
		parentPath,
		expectedBrokerIdentifier,
		kernelLiveCodeIdentity,
		execCombinedOutput,
	); err != nil {
		return fmt.Errorf("verify live broker signature: %w", err)
	}
	if err := verifyLiveCode(
		attestationContext,
		os.Getpid(),
		helperPath,
		expectedHelperIdentifier,
		kernelLiveCodeIdentity,
		execCombinedOutput,
	); err != nil {
		return fmt.Errorf("verify live helper signature: %w", err)
	}
	if os.Getppid() != parentPID {
		return errors.New("parent identity changed during attestation")
	}
	confirmedPath, err := processPath(attestationContext, parentPID)
	if err != nil {
		return err
	}
	confirmedPath, err = filepath.EvalSymlinks(confirmedPath)
	if err != nil || confirmedPath != parentPath {
		return errors.New("parent executable changed during attestation")
	}
	parentAfter, err := os.Stat(parentPath)
	if err != nil || !os.SameFile(parentBefore, parentAfter) {
		return errors.New("broker executable identity changed during attestation")
	}
	return nil
}

func processPath(ctx context.Context, pid int) (string, error) {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-ww", "-p", fmt.Sprint(pid), "-o", "comm=").Output()
	if err != nil {
		return "", fmt.Errorf("read parent executable: %w", err)
	}
	path := strings.TrimSpace(string(output))
	if !filepath.IsAbs(path) || strings.ContainsRune(path, '\n') {
		return "", errors.New("parent executable path is invalid")
	}
	return path, nil
}

type combinedOutputRunner func(context.Context, string, ...string) ([]byte, error)

func execCombinedOutput(ctx context.Context, executable string, arguments ...string) ([]byte, error) {
	return exec.CommandContext(ctx, executable, arguments...).CombinedOutput()
}

// verifyLiveCode proves that the code running as pid satisfies the pinned
// designated requirement.
//
// codesign's "+pid" verification form is deliberately not used. On current
// macOS it cannot evaluate an explicit requirement against a process (exit 3
// even for a satisfied requirement, exit 1 as soon as --verbose is added), so
// an attestor built on it can never succeed. Instead the kernel reports the
// process's own CodeDirectory hash through csops(2), and that exact hash is
// bound into a static requirement evaluated against the executable. A file
// swapped after exec cannot carry the running image's hash, so the static
// check still speaks for the live code, exactly as the Swift host binds
// cdhash into its own requirements.
func verifyLiveCode(
	ctx context.Context,
	pid int,
	executablePath string,
	identifier string,
	readIdentity liveCodeIdentityReader,
	run combinedOutputRunner,
) error {
	if pid <= 1 || (identifier != expectedBrokerIdentifier && identifier != expectedHelperIdentifier) {
		return errors.New("live code identity is invalid")
	}
	if !filepath.IsAbs(executablePath) {
		return errors.New("live code executable path must be absolute")
	}
	identity, err := readIdentity(pid)
	if err != nil {
		return fmt.Errorf("read live code identity: %w", err)
	}
	if identity.Flags&csValid == 0 {
		return errors.New("the kernel does not consider the live code signature valid")
	}
	if identity.Flags&csAdhoc != 0 {
		return errors.New("the live code is ad-hoc signed rather than production-signed")
	}
	if expectedTeamIdentifier == "" {
		return errors.New("no signing team identifier was compiled into this helper")
	}
	codeDirectoryHash := hex.EncodeToString(identity.CodeDirectoryHash[:])
	requirement := fmt.Sprintf(
		`anchor apple generic and identifier %q and certificate leaf[subject.OU] = %q and cdhash H"%s"`,
		identifier,
		expectedTeamIdentifier,
		codeDirectoryHash,
	)
	output, err := run(
		ctx,
		"/usr/bin/codesign",
		"--verify",
		"--strict",
		"--verbose=2",
		"-R="+requirement,
		executablePath,
	)
	if err != nil {
		return fmt.Errorf(
			"static codesign requirement bound to live cdhash %s failed for %s: %s",
			codeDirectoryHash,
			executablePath,
			strings.TrimSpace(string(output)),
		)
	}
	return nil
}
