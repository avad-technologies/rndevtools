//go:build !darwin

package authorization

import "errors"

func kernelLiveCodeIdentity(int) (LiveCodeIdentity, error) {
	return LiveCodeIdentity{}, errors.New("kernel live code identity is supported only on macOS")
}
