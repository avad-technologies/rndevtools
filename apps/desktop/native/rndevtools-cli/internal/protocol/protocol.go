package protocol

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
)

const (
	Name             = "rndevtools/1"
	MaxRequestBytes  = 256 * 1024
	MaxResponseBytes = 512 * 1024
)

type Command string

const (
	CommandDoctor     Command = "doctor"
	CommandSimulators Command = "simulators"
	CommandApps       Command = "apps"
	CommandScreen     Command = "screen"
	CommandElements   Command = "elements"
	CommandAct        Command = "act"
	CommandWait       Command = "wait"
	CommandCapture    Command = "capture"
	CommandRecord     Command = "record"
	CommandNetwork    Command = "network"
	CommandRecipe     Command = "recipe"
	CommandJobs       Command = "jobs"
	CommandSlimming   Command = "slimming"
	CommandLane       Command = "lane"
	CommandSupabase   Command = "supabase"
	CommandNative     Command = "native"
	CommandAgents     Command = "agents"
	CommandClaim      Command = "claim"
	CommandRelease    Command = "release"
	CommandInput      Command = "input"
)

type Request struct {
	Protocol string          `json:"protocol"`
	ID       string          `json:"id"`
	Command  json.RawMessage `json:"command"`
	// Agent is the coding-agent session the CLI runs inside, when known. The
	// desktop records a touch for every device-targeted command it carries.
	Agent map[string]any `json:"agent,omitempty"`
}

type Response struct {
	Protocol string          `json:"protocol"`
	ID       string          `json:"id"`
	OK       bool            `json:"ok"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    *RemoteError    `json:"error,omitempty"`
}

type RemoteError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Recovery  string `json:"recovery,omitempty"`
}

func Commands() []Command {
	return []Command{
		CommandDoctor,
		CommandSimulators,
		CommandApps,
		CommandScreen,
		CommandElements,
		CommandAct,
		CommandWait,
		CommandCapture,
		CommandRecord,
		CommandNetwork,
		CommandRecipe,
		CommandJobs,
		CommandSlimming,
		CommandLane,
		CommandSupabase,
		CommandNative,
		CommandAgents,
		CommandClaim,
		CommandRelease,
		CommandInput,
	}
}

func ParseCommand(value string) (Command, error) {
	command := Command(value)
	if !slices.Contains(Commands(), command) {
		return "", fmt.Errorf("unsupported command %q", value)
	}
	return command, nil
}

// NewRequestID is prefix followed by 128 random bits in hex. The prefix names
// the peer that made the request (cli-, mcp-).
func NewRequestID(prefix string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate request id: %w", err)
	}
	return prefix + hex.EncodeToString(random), nil
}

func EncodeRequest(request Request) ([]byte, error) {
	if err := validateRequest(request); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	if len(encoded)+1 > MaxRequestBytes {
		return nil, fmt.Errorf("request exceeds %d bytes", MaxRequestBytes)
	}
	return encoded, nil
}

func DecodeResponse(encoded []byte, requestID string) (Response, error) {
	if len(encoded) == 0 {
		return Response{}, errors.New("response is empty")
	}
	if len(encoded) > MaxResponseBytes {
		return Response{}, fmt.Errorf("response exceeds %d bytes", MaxResponseBytes)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return Response{}, fmt.Errorf("decode response: %w", err)
	}
	for _, required := range []string{"protocol", "id", "ok"} {
		if _, exists := fields[required]; !exists {
			return Response{}, fmt.Errorf("response is missing %s", required)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var response Response
	if err := decoder.Decode(&response); err != nil {
		return Response{}, fmt.Errorf("decode response: %w", err)
	}
	if err := requireEOF(decoder); err != nil {
		return Response{}, err
	}
	if response.Protocol != Name {
		return Response{}, fmt.Errorf("unexpected protocol %q", response.Protocol)
	}
	if response.ID != requestID && (response.OK || response.ID != "") {
		return Response{}, errors.New("response id does not match the request")
	}
	if response.OK {
		if len(response.Result) == 0 || response.Error != nil {
			return Response{}, errors.New("successful response must contain only result")
		}
	} else {
		if len(response.Result) != 0 || response.Error == nil {
			return Response{}, errors.New("failed response must contain only error")
		}
		if err := validateRemoteError(*response.Error); err != nil {
			return Response{}, err
		}
		var errorFields map[string]json.RawMessage
		if err := json.Unmarshal(fields["error"], &errorFields); err != nil {
			return Response{}, errors.New("response error is invalid")
		}
		if _, exists := errorFields["retryable"]; !exists {
			return Response{}, errors.New("response error is missing retryable")
		}
	}
	return response, nil
}

func validateRequest(request Request) error {
	if request.Protocol != Name {
		return fmt.Errorf("protocol must be %q", Name)
	}
	if !validIdentifier(request.ID) {
		return errors.New("id must be a 1..256 character ASCII identifier")
	}
	if len(request.Command) == 0 || !json.Valid(request.Command) {
		return errors.New("command must be valid JSON")
	}
	var command struct {
		Kind Command `json:"kind"`
	}
	decoder := json.NewDecoder(bytes.NewReader(request.Command))
	if err := decoder.Decode(&command); err != nil {
		return errors.New("command must be a JSON object")
	}
	if !slices.Contains(Commands(), command.Kind) {
		return fmt.Errorf("unsupported command %q", command.Kind)
	}
	return requireEOF(decoder)
}

func validIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 256 {
		return false
	}
	for index, character := range value {
		valid := (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && strings.ContainsRune("._:-", character))
		if !valid {
			return false
		}
	}
	return true
}

func validateRemoteError(remoteError RemoteError) error {
	if len(remoteError.Code) == 0 || len(remoteError.Code) > 64 {
		return errors.New("response error code is invalid")
	}
	for index, character := range remoteError.Code {
		if (character < 'a' || character > 'z') &&
			(index == 0 || ((character < '0' || character > '9') && character != '_')) {
			return errors.New("response error code is invalid")
		}
	}
	if len(remoteError.Message) > 4*1024 {
		return errors.New("response error message is invalid")
	}
	if len(remoteError.Recovery) > 4*1024 {
		return errors.New("response error recovery is invalid")
	}
	return nil
}

func requireEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains more than one value")
		}
		return fmt.Errorf("decode trailing JSON: %w", err)
	}
	return nil
}
