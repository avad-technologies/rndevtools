//go:build darwin

package authorization

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// csops(2) operations from <sys/codesign.h>.
const (
	csOpsStatus uintptr = 0
	csOpsCDHash uintptr = 5
)

// kernelLiveCodeIdentity asks the kernel, not the filesystem or the codesign
// tool, what code is running as pid. csops(2) is the same interface codesign
// itself uses for "+pid" targets, without the CLI's requirement-evaluation
// path that no longer works for processes.
func kernelLiveCodeIdentity(pid int) (LiveCodeIdentity, error) {
	var identity LiveCodeIdentity
	if pid <= 0 {
		return identity, errors.New("live code identity requires a real process")
	}
	var flags uint32
	if err := csops(pid, csOpsStatus, unsafe.Pointer(&flags), unsafe.Sizeof(flags)); err != nil {
		return identity, fmt.Errorf("read code-signing status for pid %d: %w", pid, err)
	}
	if err := csops(
		pid,
		csOpsCDHash,
		unsafe.Pointer(&identity.CodeDirectoryHash[0]),
		uintptr(len(identity.CodeDirectoryHash)),
	); err != nil {
		return identity, fmt.Errorf("read CodeDirectory hash for pid %d: %w", pid, err)
	}
	identity.Flags = flags
	return identity, nil
}

func csops(pid int, operation uintptr, buffer unsafe.Pointer, size uintptr) error {
	_, _, errno := syscall.Syscall6(syscall.SYS_CSOPS, uintptr(pid), operation, uintptr(buffer), size, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
