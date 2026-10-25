package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const (
	Version        = 2
	MaxRequestSize = 64 * 1024
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)

type Operation string

const (
	OperationHandshake       Operation = "handshake"
	OperationListSimulators  Operation = "list_simulators"
	OperationCloneSimulator  Operation = "clone_simulator"
	OperationDiskCleanupPlan Operation = "disk_cleanup_plan"
	OperationDiskCleanup     Operation = "disk_cleanup"
	OperationListProfiles    Operation = "list_profiles"
	OperationSimulatorStatus Operation = "simulator_status"
	OperationPreviewProfile  Operation = "preview_profile"
	OperationVerifyProfile   Operation = "verify_profile"
	OperationDoctor          Operation = "doctor"
	OperationPrepareMutation Operation = "prepare_mutation"
	OperationApplyProfile    Operation = "apply_profile"
	OperationRestoreManaged  Operation = "restore_managed"
	OperationUndoLast        Operation = "undo_last"
)

type Request struct {
	ProtocolVersion int             `json:"protocolVersion"`
	RequestID       string          `json:"requestId"`
	Operation       Operation       `json:"operation"`
	Payload         json.RawMessage `json:"payload"`
	// RawSHA256 binds a broker authorization to the exact request bytes delivered
	// to this process. It is populated only by DecodeRequest and is never accepted
	// from JSON.
	RawSHA256 [sha256.Size]byte `json:"-"`
}

func (operation Operation) RequiresMutationAuthorization() bool {
	switch operation {
	case OperationCloneSimulator,
		OperationDiskCleanup,
		OperationApplyProfile,
		OperationRestoreManaged,
		OperationUndoLast:
		return true
	default:
		return false
	}
}

type Response struct {
	ProtocolVersion int       `json:"protocolVersion"`
	RequestID       string    `json:"requestId"`
	OK              bool      `json:"ok"`
	Result          any       `json:"result,omitempty"`
	Error           *APIError `json:"error,omitempty"`
}

type APIError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Details   any    `json:"details,omitempty"`
}

func NewError(code, message string, retryable bool) *APIError {
	return &APIError{Code: code, Message: message, Retryable: retryable}
}

func Success(requestID string, result any) Response {
	return Response{ProtocolVersion: Version, RequestID: requestID, OK: true, Result: result}
}

func Failure(requestID string, apiError *APIError) Response {
	return Response{ProtocolVersion: Version, RequestID: requestID, OK: false, Error: apiError}
}

func DecodeRequest(reader io.Reader) (Request, *APIError) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxRequestSize+1))
	if err != nil {
		return Request{}, NewError("request_read_failed", "Could not read the helper request.", false)
	}
	if len(data) == 0 {
		return Request{}, NewError("empty_request", "The helper request is empty.", false)
	}
	if len(data) > MaxRequestSize {
		return Request{}, NewError("request_too_large", "The helper request exceeds 64 KiB.", false)
	}

	var request Request
	if err := decodeStrict(data, &request); err != nil {
		return Request{}, NewError("invalid_request", "The helper request is not valid protocol JSON.", false)
	}
	request.RawSHA256 = sha256.Sum256(data)
	if !requestIDPattern.MatchString(request.RequestID) {
		return Request{}, NewError("invalid_request_id", "requestId has an invalid format.", false)
	}
	if request.ProtocolVersion != Version {
		return request, NewError(
			"unsupported_protocol_version",
			fmt.Sprintf("Protocol version %d is not supported.", request.ProtocolVersion),
			false,
		)
	}
	if request.Operation == "" {
		return request, NewError("missing_operation", "operation is required.", false)
	}
	if len(request.Payload) == 0 || bytes.Equal(bytes.TrimSpace(request.Payload), []byte("null")) {
		return request, NewError("missing_payload", "payload must be a JSON object.", false)
	}
	return request, nil
}

func DecodePayload(raw json.RawMessage, destination any) *APIError {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return NewError("invalid_payload", "payload must be a JSON object.", false)
	}
	if err := decodeStrict(trimmed, destination); err != nil {
		return NewError("invalid_payload", "payload contains missing, invalid, or unknown fields.", false)
	}
	return nil
}

func EncodeResponse(writer io.Writer, response Response) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(response)
}

func decodeStrict(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
