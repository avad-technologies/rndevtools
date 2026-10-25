package authorization

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

const (
	testBrokerPath         = "/Applications/RN Devtools.app/Contents/Resources/native/rndevtools-native-host"
	fakeCodeDirectoryHash  = "0102030405060708090a0b0c0d0e0f1011121314"
	fakeBrokerProcessID    = 42
	unreadableIdentityText = "no such process"
)

func fakeIdentity(flags uint32) liveCodeIdentityReader {
	return func(int) (LiveCodeIdentity, error) {
		var identity LiveCodeIdentity
		for index := range identity.CodeDirectoryHash {
			identity.CodeDirectoryHash[index] = byte(index + 1)
		}
		identity.Flags = flags
		return identity, nil
	}
}

const testTeamIdentifier = "ABCDE12345"

func TestCompiledTeamIdentifierReportsTheActualAttestationPin(t *testing.T) {
	withTeamIdentifier(t, testTeamIdentifier)
	if CompiledTeamIdentifier() != testTeamIdentifier {
		t.Fatal("linked team pin was not reported")
	}
	expectedTeamIdentifier = ""
	if CompiledTeamIdentifier() != "" {
		t.Fatal("an unconfigured pin must remain empty")
	}
}

// withTeamIdentifier compiles in a signing team for the duration of a test.
// Production builds inject this through -ldflags.
func withTeamIdentifier(t *testing.T, value string) {
	t.Helper()
	previous := expectedTeamIdentifier
	expectedTeamIdentifier = value
	t.Cleanup(func() { expectedTeamIdentifier = previous })
}

func TestLiveCodeVerificationBindsKernelCDHashIntoStaticRequirement(t *testing.T) {
	withTeamIdentifier(t, testTeamIdentifier)
	var executable string
	var arguments []string
	runner := func(_ context.Context, command string, values ...string) ([]byte, error) {
		executable = command
		arguments = append([]string(nil), values...)
		return nil, nil
	}
	if err := verifyLiveCode(
		context.Background(),
		fakeBrokerProcessID,
		testBrokerPath,
		expectedBrokerIdentifier,
		fakeIdentity(csValid),
		runner,
	); err != nil {
		t.Fatal(err)
	}
	if executable != "/usr/bin/codesign" {
		t.Fatalf("unexpected verifier executable %q", executable)
	}
	expectedPrefix := []string{"--verify", "--strict", "--verbose=2"}
	if !slices.Equal(arguments[:len(expectedPrefix)], expectedPrefix) {
		t.Fatalf("unexpected verifier arguments %#v", arguments)
	}
	requirement := arguments[3]
	for _, required := range []string{
		"-R=anchor apple generic",
		`identifier "rndevtools-native-host"`,
		`certificate leaf[subject.OU] = "` + testTeamIdentifier + `"`,
		`cdhash H"` + fakeCodeDirectoryHash + `"`,
	} {
		if !strings.Contains(requirement, required) {
			t.Fatalf("requirement %q does not pin %q", requirement, required)
		}
	}
	if arguments[4] != testBrokerPath {
		t.Fatalf("codesign did not target the static executable: %#v", arguments)
	}
	for _, argument := range arguments {
		if strings.HasPrefix(argument, "+") {
			t.Fatalf("codesign +pid verification must not be relied upon: %#v", arguments)
		}
	}
}

func TestLiveCodeVerificationFailsClosedWithoutCompiledTeamIdentifier(t *testing.T) {
	withTeamIdentifier(t, "")
	runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		t.Fatal("codesign must not run without a compiled signing team")
		return nil, nil
	}
	err := verifyLiveCode(
		context.Background(),
		fakeBrokerProcessID,
		testBrokerPath,
		expectedBrokerIdentifier,
		fakeIdentity(csValid),
		runner,
	)
	if err == nil {
		t.Fatal("expected verification to fail without a compiled signing team")
	}
	if !strings.Contains(err.Error(), "signing team identifier") {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestLiveCodeVerificationRejectsUnapprovedIdentityBeforeExecution(t *testing.T) {
	identityRead := false
	codesignCalled := false
	identity := func(int) (LiveCodeIdentity, error) {
		identityRead = true
		return LiveCodeIdentity{Flags: csValid}, nil
	}
	runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		codesignCalled = true
		return nil, nil
	}
	err := verifyLiveCode(context.Background(), fakeBrokerProcessID, testBrokerPath, "forged-host", identity, runner)
	if err == nil {
		t.Fatal("forged live-code identity unexpectedly accepted")
	}
	if identityRead || codesignCalled {
		t.Fatal("an unapproved identity reached the kernel or codesign")
	}
}

func TestLiveCodeVerificationRequiresAbsoluteExecutablePath(t *testing.T) {
	runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		t.Fatal("codesign was invoked for a relative executable path")
		return nil, nil
	}
	err := verifyLiveCode(context.Background(), fakeBrokerProcessID, "rndevtools-native-host", expectedBrokerIdentifier, fakeIdentity(csValid), runner)
	if err == nil {
		t.Fatal("relative executable path unexpectedly accepted")
	}
}

func TestLiveCodeVerificationFailsClosedOnKernelIdentity(t *testing.T) {
	tests := []struct {
		name     string
		identity liveCodeIdentityReader
		want     string
	}{
		{
			name: "unreadable",
			identity: func(int) (LiveCodeIdentity, error) {
				return LiveCodeIdentity{}, errors.New(unreadableIdentityText)
			},
			want: unreadableIdentityText,
		},
		{name: "invalid signature", identity: fakeIdentity(0), want: "does not consider"},
		{name: "ad-hoc", identity: fakeIdentity(csValid | csAdhoc), want: "ad-hoc"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			codesignCalled := false
			runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
				codesignCalled = true
				return nil, nil
			}
			err := verifyLiveCode(context.Background(), fakeBrokerProcessID, testBrokerPath, expectedBrokerIdentifier, test.identity, runner)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected failure containing %q, got %v", test.want, err)
			}
			if codesignCalled {
				t.Fatal("codesign ran although the kernel identity was already rejected")
			}
		})
	}
}

func TestLiveCodeVerificationSurfacesCodesignOutput(t *testing.T) {
	withTeamIdentifier(t, testTeamIdentifier)
	runner := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("test-requirement: code failed to satisfy specified code requirement(s)\n"), errors.New("exit status 3")
	}
	err := verifyLiveCode(context.Background(), fakeBrokerProcessID, testBrokerPath, expectedBrokerIdentifier, fakeIdentity(csValid), runner)
	if err == nil {
		t.Fatal("codesign failure unexpectedly accepted")
	}
	for _, expected := range []string{"failed to satisfy", fakeCodeDirectoryHash, testBrokerPath} {
		if !strings.Contains(err.Error(), expected) {
			t.Fatalf("error %q does not carry %q", err.Error(), expected)
		}
	}
}
