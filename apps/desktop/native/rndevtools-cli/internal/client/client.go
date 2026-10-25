package client

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const (
	DefaultTimeout = 75 * time.Second
	MaximumTimeout = 11 * time.Minute
)

type ErrorKind string

const (
	ErrorUnavailable ErrorKind = "unavailable"
	ErrorTimeout     ErrorKind = "timeout"
	ErrorTransport   ErrorKind = "transport"
	ErrorProtocol    ErrorKind = "protocol"
)

type ClientError struct {
	Kind  ErrorKind
	Op    string
	Cause error
}

func (e *ClientError) Error() string {
	return fmt.Sprintf("%s: %v", e.Op, e.Cause)
}

func (e *ClientError) Unwrap() error {
	return e.Cause
}

type Client struct {
	socketPath string
	timeout    time.Duration
}

func New(socketPath string, timeout time.Duration) (*Client, error) {
	if !filepath.IsAbs(socketPath) {
		return nil, errors.New("socket path must be absolute")
	}
	if timeout <= 0 || timeout > MaximumTimeout {
		return nil, fmt.Errorf("timeout must be between 1ms and %s", MaximumTimeout)
	}
	return &Client{socketPath: filepath.Clean(socketPath), timeout: timeout}, nil
}

func DefaultSocketPath() (string, error) {
	currentUser, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("resolve current user's home directory: %w", err)
	}
	homeDirectory := currentUser.HomeDir
	if !filepath.IsAbs(homeDirectory) {
		return "", errors.New("current user's home directory is not absolute")
	}
	return filepath.Join(
		homeDirectory,
		"Library",
		"Application Support",
		"RN Devtools",
		"agent",
		"rndevtools.sock",
	), nil
}

func (c *Client) Do(ctx context.Context, request protocol.Request) (protocol.Response, error) {
	encoded, err := protocol.EncodeRequest(request)
	if err != nil {
		return protocol.Response{}, &ClientError{Kind: ErrorProtocol, Op: "encode request", Cause: err}
	}
	if err := c.validateSocket(); err != nil {
		return protocol.Response{}, err
	}

	requestContext, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(requestContext, "unix", c.socketPath)
	if err != nil {
		return protocol.Response{}, classifyNetworkError("connect to desktop app", err)
	}
	defer connection.Close()
	// A caller that gives up (an MCP client cancelling a tool call) closes
	// the connection, which ends the read at once. The desktop, which has
	// already read this side's EOF, sees the close at its next liveness
	// probe (a space it writes about once a second ahead of a slow answer)
	// and aborts the handler; a desktop job the handler started keeps
	// running. The deadline below still bounds everything else.
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	failed := func(operation string, err error) error {
		if cause := ctx.Err(); cause != nil {
			// The closed connection is only the symptom; report why.
			return classifyNetworkError(operation, cause)
		}
		return classifyNetworkError(operation, err)
	}
	if err := connection.SetDeadline(time.Now().Add(c.timeout)); err != nil {
		return protocol.Response{}, &ClientError{Kind: ErrorTransport, Op: "set socket deadline", Cause: err}
	}
	if _, err := connection.Write(append(encoded, '\n')); err != nil {
		return protocol.Response{}, failed("write request", err)
	}
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return protocol.Response{}, &ClientError{
			Kind:  ErrorTransport,
			Op:    "finish request",
			Cause: errors.New("connection is not a Unix-domain socket"),
		}
	}
	if err := unixConnection.CloseWrite(); err != nil {
		return protocol.Response{}, failed("finish request", err)
	}

	limited := &io.LimitedReader{R: connection, N: protocol.MaxResponseBytes + 1}
	reader := bufio.NewReaderSize(limited, 64*1024)
	line, err := reader.ReadBytes('\n')
	if len(line) > protocol.MaxResponseBytes {
		return protocol.Response{}, &ClientError{
			Kind:  ErrorProtocol,
			Op:    "read response",
			Cause: fmt.Errorf("response exceeds %d bytes", protocol.MaxResponseBytes),
		}
	}
	if err != nil {
		return protocol.Response{}, failed("read response", err)
	}
	line = line[:len(line)-1]
	if len(line) > 0 && line[len(line)-1] == '\r' {
		return protocol.Response{}, &ClientError{
			Kind:  ErrorProtocol,
			Op:    "read response",
			Cause: errors.New("response must use a single LF delimiter"),
		}
	}
	response, err := protocol.DecodeResponse(line, request.ID)
	if err != nil {
		return protocol.Response{}, &ClientError{Kind: ErrorProtocol, Op: "validate response", Cause: err}
	}
	return response, nil
}

// Reachable reports whether the desktop answers on socketPath within timeout:
// the socket passes the same ownership and permission checks a request
// needs, and a connection opens. Nothing is sent, and the desktop drops the
// empty connection. The steering hook uses it to tell a running desktop from
// the files a crashed one left behind.
func Reachable(socketPath string, timeout time.Duration) bool {
	localClient, err := New(socketPath, timeout)
	if err != nil || localClient.validateSocket() != nil {
		return false
	}
	connection, err := net.DialTimeout("unix", localClient.socketPath, timeout)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

func (c *Client) validateSocket() error {
	directoryMetadata, err := os.Lstat(filepath.Dir(c.socketPath))
	if err != nil {
		return &ClientError{Kind: ErrorUnavailable, Op: "inspect desktop socket directory", Cause: err}
	}
	if !directoryMetadata.IsDir() || directoryMetadata.Mode()&os.ModeSymlink != 0 {
		return &ClientError{
			Kind:  ErrorUnavailable,
			Op:    "inspect desktop socket directory",
			Cause: errors.New("path is not a real directory"),
		}
	}
	if err := validateOwnershipAndMode(directoryMetadata, 0o077, "socket directory"); err != nil {
		return &ClientError{Kind: ErrorUnavailable, Op: "inspect desktop socket directory", Cause: err}
	}
	metadata, err := os.Lstat(c.socketPath)
	if err != nil {
		return &ClientError{Kind: ErrorUnavailable, Op: "inspect desktop socket", Cause: err}
	}
	if metadata.Mode()&os.ModeSymlink != 0 || metadata.Mode()&os.ModeSocket == 0 {
		return &ClientError{
			Kind:  ErrorUnavailable,
			Op:    "inspect desktop socket",
			Cause: errors.New("path is not a real Unix socket"),
		}
	}
	if err := validateOwnershipAndMode(metadata, 0o077, "socket"); err != nil {
		return &ClientError{
			Kind:  ErrorUnavailable,
			Op:    "inspect desktop socket",
			Cause: err,
		}
	}
	return nil
}

func validateOwnershipAndMode(metadata os.FileInfo, forbiddenMode os.FileMode, label string) error {
	if metadata.Mode().Perm()&forbiddenMode != 0 {
		return fmt.Errorf("%s must not grant group or other permissions", label)
	}
	stat, ok := metadata.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("%s is not owned by the current user", label)
	}
	return nil
}

func classifyNetworkError(operation string, err error) error {
	kind := ErrorTransport
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		kind = ErrorTimeout
	} else if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, os.ErrNotExist) {
		kind = ErrorUnavailable
	} else if networkError, ok := err.(net.Error); ok && networkError.Timeout() {
		kind = ErrorTimeout
	}
	return &ClientError{Kind: kind, Op: operation, Cause: err}
}
