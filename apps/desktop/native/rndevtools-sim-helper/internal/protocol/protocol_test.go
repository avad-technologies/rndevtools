package protocol

import (
	"strings"
	"testing"
)

func TestDecodeRequestAcceptsStrictEnvelope(t *testing.T) {
	request, apiError := DecodeRequest(strings.NewReader(`{
		"protocolVersion": 2,
		"requestId": "request-1",
		"operation": "handshake",
		"payload": {}
	}`))
	if apiError != nil {
		t.Fatalf("DecodeRequest() error = %v", apiError)
	}
	if request.Operation != OperationHandshake {
		t.Fatalf("operation = %q", request.Operation)
	}
}

func TestDecodeRequestRejectsUnknownAndTrailingFields(t *testing.T) {
	for name, input := range map[string]string{
		"unknown":  `{"protocolVersion":2,"requestId":"r","operation":"handshake","payload":{},"command":"whoami"}`,
		"trailing": `{"protocolVersion":2,"requestId":"r","operation":"handshake","payload":{}} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, apiError := DecodeRequest(strings.NewReader(input)); apiError == nil || apiError.Code != "invalid_request" {
				t.Fatalf("expected invalid_request, got %#v", apiError)
			}
		})
	}
}

func TestDecodeRequestBoundsInput(t *testing.T) {
	input := strings.Repeat("x", MaxRequestSize+1)
	if _, apiError := DecodeRequest(strings.NewReader(input)); apiError == nil || apiError.Code != "request_too_large" {
		t.Fatalf("expected request_too_large, got %#v", apiError)
	}
}

func TestDecodePayloadRejectsUnknownFields(t *testing.T) {
	type payload struct {
		SimulatorID string `json:"simulatorId"`
	}
	if apiError := DecodePayload([]byte(`{"simulatorId":"id","args":["delete","all"]}`), &payload{}); apiError == nil {
		t.Fatal("unknown payload field was accepted")
	}
}
