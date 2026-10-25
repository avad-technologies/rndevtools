//go:build !race

package setup

// raceDetector says that the tests run under the race detector, which makes
// the code under test several times slower.
const raceDetector = false
