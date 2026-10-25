//go:build darwin

package authorization

import "testing"

func TestKernelLiveCodeIdentityReportsPlatformProcessAndFailsClosed(t *testing.T) {
	// launchd is platform-signed on every macOS and readable by any user, so it
	// exercises the real syscall deterministically.
	identity, err := kernelLiveCodeIdentity(1)
	if err != nil {
		t.Fatal(err)
	}
	if identity.CodeDirectoryHash == [20]byte{} {
		t.Fatal("kernel reported an empty CodeDirectory hash for launchd")
	}
	if identity.Flags&csValid == 0 {
		t.Fatalf("launchd was not reported as validly signed: flags=%#x", identity.Flags)
	}
	if identity.Flags&csAdhoc != 0 {
		t.Fatalf("launchd was reported as ad-hoc signed: flags=%#x", identity.Flags)
	}
	if _, err := kernelLiveCodeIdentity(2147483647); err == nil {
		t.Fatal("a nonexistent process unexpectedly produced a live identity")
	}
	if _, err := kernelLiveCodeIdentity(0); err == nil {
		t.Fatal("pid 0 unexpectedly produced a live identity")
	}
}
