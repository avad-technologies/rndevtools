package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/adalloul0928/rndevtools-cli/internal/protocol"
)

const testID = "cli-0123456789abcdef0123456789abcdef"

func TestClientRoundTrip(t *testing.T) {
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		line, err := bufio.NewReader(connection).ReadString('\n')
		if err != nil {
			return err
		}
		var request protocol.Request
		if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &request); err != nil {
			return err
		}
		_, err = connection.Write([]byte(
			`{"protocol":"rndevtools/1","id":"` + request.ID + `","ok":true,"result":{"healthy":true}}` + "\n",
		))
		return err
	})
	localClient, err := New(socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil || !response.OK {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientHalfClosesAfterExactlyOneRequestBeforeReadingResponse(t *testing.T) {
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		if _, err := bufio.NewReader(connection).ReadString('\n'); err != nil {
			return err
		}
		// The end of the stream is the event to wait for. The deadline only
		// ends the wait for a client that never half-closes, so it is far past
		// the microseconds the half-close takes here, not a window it has to
		// fit in.
		if err := connection.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		buffer := make([]byte, 1)
		_, err := connection.Read(buffer)
		if !errors.Is(err, io.EOF) {
			return fmt.Errorf("expected the client write half to close: %w", err)
		}
		_, err = connection.Write([]byte(
			`{"protocol":"rndevtools/1","id":"` + testID + `","ok":true,"result":{}}` + "\n",
		))
		return err
	})
	localClient, err := New(socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	if err != nil || !response.OK {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsPublicOrNonSocketPaths(t *testing.T) {
	directory := t.TempDir()
	filePath := filepath.Join(directory, "not-a-socket")
	if err := os.WriteFile(filePath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	localClient, _ := New(filePath, time.Second)
	_, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ := testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	if err := os.Chmod(socketPath, 0o666); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(socketPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ = testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	symlinkPath := filepath.Join(filepath.Dir(socketPath), "linked.sock")
	if err := os.Symlink(socketPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(symlinkPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	socketPath, _ = testServer(t, func(connection net.Conn) error {
		return connection.Close()
	})
	if err := os.Chmod(filepath.Dir(socketPath), 0o755); err != nil {
		t.Fatal(err)
	}
	localClient, _ = New(socketPath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)
}

func TestClientReportsStaleSocketAndTimeout(t *testing.T) {
	directory := shortTempDir(t)
	stalePath := filepath.Join(directory, "stale.sock")
	address := &net.UnixAddr{Name: stalePath, Net: "unix"}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(stalePath, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	localClient, _ := New(stalePath, time.Second)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	assertClientError(t, err, ErrorUnavailable)

	// The desktop never answers: it holds the connection open until the client
	// has given up, however long that takes, so that only the timeout can end
	// the call. The fallback only frees the handler if the client never returns.
	givenUp := make(chan struct{})
	socketPath, _ := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		select {
		case <-givenUp:
		case <-time.After(15 * time.Second):
		}
		return nil
	})
	localClient, _ = New(socketPath, 50*time.Millisecond)
	_, err = localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	close(givenUp)
	assertClientError(t, err, ErrorTimeout)
}

func TestCancellingTheContextEndsTheReadAndClosesTheConnection(t *testing.T) {
	// The desktop is still working when the caller gives up: an MCP client
	// cancelled the tool call. The connection must close then, not at the
	// deadline, so the desktop's next liveness probe finds it closed and
	// aborts the handler (agent-cli-service.test.ts covers that side).
	reading := make(chan struct{})
	returned := make(chan struct{})
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		if _, err := bufio.NewReader(connection).ReadString('\n'); err != nil {
			return err
		}
		close(reading)
		// Answer only after the client gave up; it closed the connection by
		// then, so the answer has nowhere to go.
		select {
		case <-returned:
		case <-time.After(15 * time.Second):
			return errors.New("the client never returned")
		}
		_, err := connection.Write([]byte(`{"protocol":"rndevtools/1","id":"` + testID + `","ok":true,"result":{}}` + "\n"))
		if err == nil {
			return errors.New("the client left the connection open after it was cancelled")
		}
		return nil
	})
	localClient, err := New(socketPath, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-reading
		cancel()
	}()
	started := time.Now()
	_, err = localClient.Do(ctx, protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"doctor"}`),
	})
	close(returned)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Do() error = %v, want the cancellation", err)
	}
	// A cancel returns in under a millisecond here, and a missed one at the
	// 10 s deadline: three seconds tells them apart with a wide margin on both
	// sides.
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("Do() returned after %s, not when cancelled", elapsed)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestClientReadsAnAnswerLedByLivenessProbes(t *testing.T) {
	// While a handler runs the desktop writes a space now and then, the only
	// way it can tell that this side hung up. JSON allows the whitespace, so
	// the answer is still one line the client must accept.
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		if _, err := bufio.NewReader(connection).ReadString('\n'); err != nil {
			return err
		}
		for range 3 {
			if _, err := connection.Write([]byte(" ")); err != nil {
				return err
			}
			time.Sleep(10 * time.Millisecond)
		}
		_, err := connection.Write([]byte(
			`{"protocol":"rndevtools/1","id":"` + testID + `","ok":true,"result":{"slow":true}}` + "\n",
		))
		return err
	})
	localClient, err := New(socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := localClient.Do(context.Background(), protocol.Request{
		Protocol: protocol.Name,
		ID:       testID,
		Command:  json.RawMessage(`{"kind":"wait"}`),
	})
	if err != nil || !response.OK || string(response.Result) != `{"slow":true}` {
		t.Fatalf("Do() = %#v, %v", response, err)
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestReachableProbesWithoutSending(t *testing.T) {
	received := make(chan []byte, 1)
	socketPath, serverErrors := testServer(t, func(connection net.Conn) error {
		defer connection.Close()
		data, err := io.ReadAll(connection)
		received <- data
		return err
	})
	if !Reachable(socketPath, time.Second) {
		t.Fatal("a listening private socket must be reachable")
	}
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
	if data := <-received; len(data) != 0 {
		t.Fatalf("the probe must send nothing, sent %q", data)
	}

	// A socket file a crash left behind, a public socket, and no socket at
	// all are all unreachable.
	directory := shortTempDir(t)
	stalePath := filepath.Join(directory, "stale.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: stalePath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(stalePath, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if Reachable(stalePath, 200*time.Millisecond) {
		t.Fatal("a stale socket must not be reachable")
	}
	public, _ := testServer(t, func(connection net.Conn) error { return connection.Close() })
	if err := os.Chmod(public, 0o666); err != nil {
		t.Fatal(err)
	}
	if Reachable(public, 200*time.Millisecond) {
		t.Fatal("a socket with group or other permissions must not be probed")
	}
	if Reachable(filepath.Join(directory, "missing.sock"), 200*time.Millisecond) || Reachable("relative.sock", time.Second) {
		t.Fatal("missing or relative sockets are unreachable")
	}
}

func testServer(t *testing.T, handler func(net.Conn) error) (string, <-chan error) {
	t.Helper()
	socketPath := filepath.Join(shortTempDir(t), "rndevtools.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	errors_ := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				errors_ <- err
			}
			return
		}
		errors_ <- handler(connection)
	}()
	return socketPath, errors_
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "pd-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return directory
}

func assertClientError(t *testing.T, err error, kind ErrorKind) {
	t.Helper()
	var clientError *ClientError
	if !errors.As(err, &clientError) || clientError.Kind != kind {
		t.Fatalf("error = %v, want kind %s", err, kind)
	}
}
