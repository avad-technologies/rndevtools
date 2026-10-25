package authorization

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
)

const testSimulatorID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
const testBuildCommit = "0123456789abcdef0123456789abcdef01234567"

type stubAttestor struct {
	error error
	calls int
}

func (attestor *stubAttestor) Attest(_ context.Context, _ int) error {
	attestor.calls++
	return attestor.error
}

func TestDirectMutationInvocationIsDenied(t *testing.T) {
	request := mutationRequest(t, protocol.OperationCloneSimulator)
	authorizer := New(strings.NewReader(""), &stubAttestor{}, testBuildCommit)
	authorizer.parentPID = func() int { return 42 }
	if apiError := authorizer.Authorize(context.Background(), request); apiError == nil || apiError.Code != "mutation_authorization_required" {
		t.Fatalf("expected direct mutation denial, got %#v", apiError)
	}
}

func TestInheritedAuthorizationAcceptsOnlyDeadlineBoundPipes(t *testing.T) {
	regular, err := os.CreateTemp(t.TempDir(), "authorization")
	if err != nil {
		t.Fatal(err)
	}
	defer regular.Close()
	if reader := inheritedFDReader(regular, time.Now().Add(time.Second)); reader != nil {
		t.Fatal("regular file unexpectedly accepted as inherited authorization channel")
	}
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readPipe.Close()
	defer writePipe.Close()
	if reader := inheritedFDReader(readPipe, time.Now().Add(time.Second)); reader == nil {
		t.Fatal("anonymous inherited pipe unexpectedly rejected")
	}
}

func TestProductionStyleInheritedPipeRequiresNonBlockingReadDescriptor(t *testing.T) {
	var blockingDescriptors [2]int
	if err := syscall.Pipe(blockingDescriptors[:]); err != nil {
		t.Fatal(err)
	}
	blockingRead := os.NewFile(uintptr(blockingDescriptors[0]), "blocking-authorization-read")
	blockingWrite := os.NewFile(uintptr(blockingDescriptors[1]), "blocking-authorization-write")
	if reader := inheritedFDReader(blockingRead, time.Now().Add(time.Second)); reader != nil {
		t.Fatal("blocking inherited pipe unexpectedly accepted a Go deadline")
	}
	blockingRead.Close()
	blockingWrite.Close()

	var pollableDescriptors [2]int
	if err := syscall.Pipe(pollableDescriptors[:]); err != nil {
		t.Fatal(err)
	}
	if err := syscall.SetNonblock(pollableDescriptors[0], true); err != nil {
		t.Fatal(err)
	}
	pollableRead := os.NewFile(uintptr(pollableDescriptors[0]), "pollable-authorization-read")
	pollableWrite := os.NewFile(uintptr(pollableDescriptors[1]), "pollable-authorization-write")
	defer pollableRead.Close()
	defer pollableWrite.Close()
	if reader := inheritedFDReader(pollableRead, time.Now().Add(time.Second)); reader == nil {
		t.Fatal("nonblocking inherited pipe was not accepted as pollable")
	}
}

func TestReadOnlyRequestsDoNotConsumeOrRequireAuthorization(t *testing.T) {
	request := decodeRequest(t, `{"protocolVersion":2,"requestId":"read-only","operation":"simulator_status","payload":{"simulatorId":"`+testSimulatorID+`"}}`)
	authorizer := New(nil, nil, testBuildCommit)
	if apiError := authorizer.Authorize(context.Background(), request); apiError != nil {
		t.Fatalf("read-only request unexpectedly denied: %#v", apiError)
	}
	if authorizer.consumed {
		t.Fatal("read-only request consumed mutation authorization")
	}
}

func TestOperationBoundAuthorizationSucceedsOnce(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	request := mutationRequest(t, protocol.OperationApplyProfile)
	attestor := &stubAttestor{}
	authorizer := New(
		bytes.NewReader(envelopeData(t, request, now.Add(15*time.Second), 42)),
		attestor,
		testBuildCommit,
	)
	authorizer.now = func() time.Time { return now }
	authorizer.parentPID = func() int { return 42 }
	if apiError := authorizer.Authorize(context.Background(), request); apiError != nil {
		t.Fatalf("authorized request denied: %#v", apiError)
	}
	if attestor.calls != 1 {
		t.Fatalf("attestor called %d times, want 1", attestor.calls)
	}
	if apiError := authorizer.Authorize(context.Background(), request); apiError == nil {
		t.Fatal("replayed authorization unexpectedly succeeded")
	}
}

func TestBuildBoundAuthorizationRejectsOlderNativeHost(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	request := mutationRequest(t, protocol.OperationApplyProfile)
	value := validEnvelope(request, now.Add(15*time.Second), 42)
	value.BrokerBuildCommit = strings.Repeat("f", 40)
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	authorizer := New(bytes.NewReader(data), &stubAttestor{}, testBuildCommit)
	authorizer.now = func() time.Time { return now }
	authorizer.parentPID = func() int { return 42 }
	if apiError := authorizer.Authorize(context.Background(), request); apiError == nil {
		t.Fatal("authorization from an older native-host build unexpectedly succeeded")
	}
}

func TestAuthorizationRejectsMismatchesExpiryAndUntrustedParent(t *testing.T) {
	now := time.Unix(1_900_000_000, 0)
	request := mutationRequest(t, protocol.OperationRestoreManaged)
	tests := []struct {
		name        string
		mutate      func(*Envelope)
		parentPID   int
		attestError error
	}{
		{name: "request id", mutate: func(value *Envelope) { value.RequestID = "another" }, parentPID: 42},
		{name: "operation", mutate: func(value *Envelope) { value.Operation = protocol.OperationUndoLast }, parentPID: 42},
		{name: "simulator", mutate: func(value *Envelope) { value.SimulatorID = "11111111-2222-3333-4444-555555555555" }, parentPID: 42},
		{name: "request hash", mutate: func(value *Envelope) { value.RequestSHA256 = strings.Repeat("0", 64) }, parentPID: 42},
		{name: "expired", mutate: func(value *Envelope) { value.ExpiresAtUnixMS = now.Add(-time.Millisecond).UnixMilli() }, parentPID: 42},
		{name: "excessive lifetime", mutate: func(value *Envelope) { value.ExpiresAtUnixMS = now.Add(31 * time.Second).UnixMilli() }, parentPID: 42},
		{name: "parent pid", mutate: func(value *Envelope) { value.BrokerPID = 41 }, parentPID: 42},
		{name: "untrusted parent", mutate: func(_ *Envelope) {}, parentPID: 42, attestError: errors.New("unsigned")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := validEnvelope(request, now.Add(15*time.Second), 42)
			test.mutate(&value)
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			authorizer := New(bytes.NewReader(data), &stubAttestor{error: test.attestError}, testBuildCommit)
			authorizer.now = func() time.Time { return now }
			authorizer.parentPID = func() int { return test.parentPID }
			apiError := authorizer.Authorize(context.Background(), request)
			if apiError == nil {
				t.Fatal("mismatched authorization unexpectedly succeeded")
			}
			if test.attestError != nil && !strings.Contains(apiError.Message, test.attestError.Error()) {
				t.Fatalf("attestation reason was not surfaced: %q", apiError.Message)
			}
		})
	}
}

// The Swift broker binds the grant to the exact "simulatorId" key, while the
// helper decodes payloads with encoding/json, which matches keys
// case-insensitively and keeps the last match.
func TestAuthorizationBindsTheSimulatorTheHelperActsOnWhenKeysDifferOnlyByCase(t *testing.T) {
	const actedOnSimulatorID = "11111111-2222-3333-4444-555555555555"
	now := time.Unix(1_900_000_000, 0)
	for _, variant := range []string{"SIMULATORID", "simulatorID", "ſimulatorId"} {
		t.Run(variant, func(t *testing.T) {
			request := decodeRequest(t, `{"protocolVersion":2,"requestId":"mutation-1","operation":"disk_cleanup","payload":{"simulatorId":"`+testSimulatorID+`","`+variant+`":"`+actedOnSimulatorID+`","categoryIds":["caches"],"confirmation":"CLEAN_SIMULATOR_DISK"}}`)
			var payload struct {
				SimulatorID  string   `json:"simulatorId"`
				CategoryIDs  []string `json:"categoryIds"`
				Confirmation string   `json:"confirmation"`
			}
			if apiError := protocol.DecodePayload(request.Payload, &payload); apiError != nil || payload.SimulatorID != actedOnSimulatorID {
				t.Fatalf("helper payload decoding changed: %#v %#v", payload, apiError)
			}
			for _, bound := range []string{testSimulatorID, actedOnSimulatorID} {
				value := validEnvelope(request, now.Add(15*time.Second), 42)
				value.SimulatorID = bound
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				authorizer := New(bytes.NewReader(data), &stubAttestor{}, testBuildCommit)
				authorizer.now = func() time.Time { return now }
				authorizer.parentPID = func() int { return 42 }
				apiError := authorizer.Authorize(context.Background(), request)
				if allowed := bound == actedOnSimulatorID; (apiError == nil) != allowed {
					t.Fatalf("grant bound to %s: allowed=%v, want %v (%#v)", bound, apiError == nil, allowed, apiError)
				}
			}
		})
	}
}

func mutationRequest(t *testing.T, operation protocol.Operation) protocol.Request {
	t.Helper()
	return decodeRequest(t, `{"protocolVersion":2,"requestId":"mutation-1","operation":"`+string(operation)+`","payload":{"simulatorId":"`+testSimulatorID+`","checkpointToken":"bound-prepared-token","profileId":"rndevtools-development"}}`)
}

func decodeRequest(t *testing.T, value string) protocol.Request {
	t.Helper()
	request, apiError := protocol.DecodeRequest(strings.NewReader(value))
	if apiError != nil {
		t.Fatalf("decode request: %#v", apiError)
	}
	return request
}

func validEnvelope(request protocol.Request, expiry time.Time, parentPID int) Envelope {
	return Envelope{
		Version:           Version,
		RequestID:         request.RequestID,
		Operation:         request.Operation,
		SimulatorID:       testSimulatorID,
		RequestSHA256:     hex.EncodeToString(request.RawSHA256[:]),
		ExpiresAtUnixMS:   expiry.UnixMilli(),
		Nonce:             strings.Repeat("a", 64),
		BrokerPID:         parentPID,
		BrokerBuildCommit: testBuildCommit,
	}
}

func envelopeData(t *testing.T, request protocol.Request, expiry time.Time, parentPID int) []byte {
	t.Helper()
	data, err := json.Marshal(validEnvelope(request, expiry, parentPID))
	if err != nil {
		t.Fatal(err)
	}
	return data
}
