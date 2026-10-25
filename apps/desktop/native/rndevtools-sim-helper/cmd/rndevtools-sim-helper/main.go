package main

import (
	"context"
	"io"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/adalloul0928/rndevtools-sim-helper/internal/authorization"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/helper"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/operationbudget"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/protocol"
	"github.com/adalloul0928/rndevtools-sim-helper/internal/simulator"
)

var (
	version     = "dev"
	buildCommit = "unknown"
)

const controlFD = 4
const controlFDEnvironment = "RNDEVTOOLS_HELPER_CONTROL_FD"

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stopControl := contextWithInheritedControl(context.Background(), controlFD)
	defer stopControl()
	return runWithContext(
		ctx,
		os.Args,
		os.Stdin,
		os.Stdout,
		authorization.NewInheritedFDAuthorizer(authorization.SystemParentAttestor{}, buildCommit),
	)
}

func runWithContext(
	parent context.Context,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
	authorizer authorization.RequestAuthorizer,
) int {
	if len(args) != 1 {
		_ = protocol.EncodeResponse(stdout, protocol.Failure("", protocol.NewError(
			"unexpected_arguments",
			"rndevtools-sim-helper accepts one versioned JSON request on stdin and no command-line arguments.",
			false,
		)))
		return 2
	}

	request, apiError := protocol.DecodeRequest(stdin)
	if apiError != nil {
		_ = protocol.EncodeResponse(stdout, protocol.Failure(request.RequestID, apiError))
		return 2
	}

	timeout := operationbudget.Primary(request.Operation)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if request.Operation.RequiresMutationAuthorization() {
		parentPID := os.Getppid()
		if apiError := authorizer.Authorize(ctx, request); apiError != nil {
			_ = protocol.EncodeResponse(stdout, protocol.Failure(request.RequestID, apiError))
			return 1
		}
		var stopParentWatch context.CancelFunc
		ctx, stopParentWatch = contextWithParentWatch(ctx, parentPID, os.Getppid, 20*time.Millisecond)
		defer stopParentWatch()
	}
	service := helper.NewService(simulator.NewClient(version, buildCommit), version, buildCommit)
	result, apiError := service.Handle(ctx, request)
	if apiError != nil {
		_ = protocol.EncodeResponse(stdout, protocol.Failure(request.RequestID, apiError))
		return 1
	}
	if err := protocol.EncodeResponse(stdout, protocol.Success(request.RequestID, result)); err != nil {
		return 1
	}
	return 0
}

// contextWithInheritedControl replaces os/signal delivery with a private pipe
// owned by Electron or the authenticated Swift mutation broker. Closing FD 4
// requests graceful cancellation, so rollback can finish before the parent
// escalates to SIGKILL. This also avoids Darwin signal-runtime failures while
// the helper is supervising simctl child processes.
//
// The Swift broker passes a pipe(2), but Electron's 'pipe' stdio slot is a
// libuv socketpair, so both are accepted: either reads EOF once the parent
// closes or half-closes its end. Any other descriptor type, such as /dev/null,
// would read EOF at once and cancel every run, so it is refused.
func contextWithInheritedControl(parent context.Context, descriptor int) (context.Context, context.CancelFunc) {
	if descriptor < 3 || os.Getenv(controlFDEnvironment) != strconv.Itoa(descriptor) {
		return parent, func() {}
	}
	file := os.NewFile(uintptr(descriptor), "rndevtools-helper-control")
	if file == nil {
		return parent, func() {}
	}
	metadata, err := file.Stat()
	if err != nil || metadata.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		_ = file.Close()
		return parent, func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = file.Close()
			cancel()
		})
	}
	go func() {
		var controlByte [1]byte
		_, _ = file.Read(controlByte[:])
		stop()
	}()
	return ctx, stop
}

func contextWithParentWatch(
	parent context.Context,
	expectedParentPID int,
	currentParentPID func() int,
	interval time.Duration,
) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	if expectedParentPID <= 1 || currentParentPID == nil || currentParentPID() != expectedParentPID {
		cancel()
		return ctx, cancel
	}
	if interval <= 0 {
		interval = 20 * time.Millisecond
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if currentParentPID() != expectedParentPID {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}
