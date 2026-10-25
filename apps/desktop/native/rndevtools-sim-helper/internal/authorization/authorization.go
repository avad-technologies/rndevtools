package authorization

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/compatibility"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
)

const (
	Version             = 1
	InheritedFD         = 3
	maxEnvelopeSize     = 4 * 1024
	maximumFutureExpiry = 30 * time.Second
)

var (
	noncePattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	simulatorIDPattern = regexp.MustCompile(`^[A-Fa-f0-9-]{8,64}$`)
)

type Envelope struct {
	Version           int                `json:"version"`
	RequestID         string             `json:"requestId"`
	Operation         protocol.Operation `json:"operation"`
	SimulatorID       string             `json:"simulatorId"`
	RequestSHA256     string             `json:"requestSha256"`
	ExpiresAtUnixMS   int64              `json:"expiresAtUnixMs"`
	Nonce             string             `json:"nonce"`
	BrokerPID         int                `json:"brokerPid"`
	BrokerBuildCommit string             `json:"brokerBuildCommit"`
}

type ParentAttestor interface {
	Attest(context.Context, int) error
}

type RequestAuthorizer interface {
	Authorize(context.Context, protocol.Request) *protocol.APIError
}

type Authorizer struct {
	reader              io.Reader
	attestor            ParentAttestor
	now                 func() time.Time
	parentPID           func() int
	mu                  sync.Mutex
	consumed            bool
	expectedBuildCommit string
}

func New(reader io.Reader, attestor ParentAttestor, expectedBuildCommit string) *Authorizer {
	return &Authorizer{
		reader:              reader,
		attestor:            attestor,
		now:                 time.Now,
		parentPID:           os.Getppid,
		expectedBuildCommit: expectedBuildCommit,
	}
}

func NewInheritedFDAuthorizer(attestor ParentAttestor, expectedBuildCommit string) *Authorizer {
	return New(
		inheritedFDReader(os.NewFile(InheritedFD, "rndevtools-mutation-authorization"), time.Now().Add(5*time.Second)),
		attestor,
		expectedBuildCommit,
	)
}

func inheritedFDReader(file *os.File, deadline time.Time) io.Reader {
	if file == nil {
		return nil
	}
	metadata, err := file.Stat()
	if err != nil || metadata.Mode()&os.ModeNamedPipe == 0 {
		return nil
	}
	if err := file.SetReadDeadline(deadline); err != nil {
		return nil
	}
	return file
}

func (authorizer *Authorizer) Authorize(ctx context.Context, request protocol.Request) *protocol.APIError {
	if !request.Operation.RequiresMutationAuthorization() {
		return nil
	}
	if authorizer == nil || authorizer.reader == nil || authorizer.attestor == nil {
		return denied("A trusted desktop broker is required for simulator mutations.")
	}

	authorizer.mu.Lock()
	defer authorizer.mu.Unlock()
	if authorizer.consumed {
		return denied("The one-shot mutation authorization has already been consumed.")
	}
	// Consume before parsing so malformed or mismatched authorizations cannot be
	// retried against the same long-lived process.
	authorizer.consumed = true

	data, err := io.ReadAll(io.LimitReader(authorizer.reader, maxEnvelopeSize+1))
	if err != nil || len(data) == 0 || len(data) > maxEnvelopeSize {
		return denied("A valid inherited mutation authorization was not provided.")
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return denied("The inherited mutation authorization is malformed.")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return denied("The inherited mutation authorization contains trailing data.")
	}

	if envelope.Version != Version || envelope.RequestID != request.RequestID || envelope.Operation != request.Operation {
		return denied("The mutation authorization does not match this request.")
	}
	if !compatibility.SourceCommitPattern.MatchString(authorizer.expectedBuildCommit) ||
		envelope.BrokerBuildCommit != authorizer.expectedBuildCommit {
		return denied("The mutation authorization was issued by a different native-helper build.")
	}
	simulatorID, err := simulatorID(request.Payload)
	if err != nil || envelope.SimulatorID != simulatorID || !simulatorIDPattern.MatchString(envelope.SimulatorID) {
		return denied("The mutation authorization does not match the target simulator.")
	}
	expectedHash := hex.EncodeToString(request.RawSHA256[:])
	providedHash, err := hex.DecodeString(envelope.RequestSHA256)
	if err != nil || len(providedHash) != sha256.Size || !bytes.Equal(providedHash, request.RawSHA256[:]) || envelope.RequestSHA256 != expectedHash {
		return denied("The mutation authorization does not match the exact request payload.")
	}
	if !noncePattern.MatchString(envelope.Nonce) {
		return denied("The mutation authorization nonce is invalid.")
	}
	now := authorizer.now()
	expiry := time.UnixMilli(envelope.ExpiresAtUnixMS)
	if !expiry.After(now) || expiry.After(now.Add(maximumFutureExpiry)) {
		return denied("The mutation authorization has expired or has an invalid lifetime.")
	}
	parentPID := authorizer.parentPID()
	if parentPID <= 1 || envelope.BrokerPID != parentPID {
		return denied("The mutation authorization was not issued by this helper's parent broker.")
	}
	if err := authorizer.attestor.Attest(ctx, parentPID); err != nil {
		return denied("The helper's parent is not an authenticated mutation broker: " + protocol.BoundedDetail(err.Error()))
	}
	return nil
}

// simulatorID reads the target with the same struct decoding the helper
// service uses to act on it, where field names match case-insensitively and
// the last match wins. An exact-key lookup would let a payload carrying both
// "simulatorId" and "SIMULATORID" authorize one Simulator while the operation
// runs against the other.
func simulatorID(payload json.RawMessage) (string, error) {
	var target struct {
		SimulatorID *string `json:"simulatorId"`
	}
	if err := json.Unmarshal(payload, &target); err != nil {
		return "", err
	}
	if target.SimulatorID == nil {
		return "", fmt.Errorf("simulatorId is missing")
	}
	if *target.SimulatorID == "" {
		return "", fmt.Errorf("simulatorId is invalid")
	}
	return *target.SimulatorID, nil
}

func denied(message string) *protocol.APIError {
	return protocol.NewError("mutation_authorization_required", message, false)
}
