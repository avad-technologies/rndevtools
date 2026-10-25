package main

import (
	"os"

	"github.com/adalloul0928/rndevtools-cli/internal/app"
)

var (
	version     = "dev"
	buildCommit = "unknown"
)

func main() {
	stdinMetadata, err := os.Stdin.Stat()
	stdinAvailable := err == nil && stdinMetadata.Mode()&os.ModeCharDevice == 0
	exitCode := app.Run(app.Config{
		Version:        version,
		BuildCommit:    buildCommit,
		Arguments:      os.Args[1:],
		Stdin:          os.Stdin,
		StdinAvailable: stdinAvailable,
		Stdout:         os.Stdout,
		Stderr:         os.Stderr,
	})
	os.Exit(exitCode)
}
