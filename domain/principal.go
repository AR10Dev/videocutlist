// Package domain contains provider-neutral business values and rules.
package domain

import (
	"errors"
)

var ErrUnauthenticated = errors.New("unauthenticated")

// Principal is the authenticated subject propagated through application code.
type Principal struct {
	Subject      string
	DisplayName  string
	Roles        []string
	Capabilities []string
}

// Allows reports whether a principal has a matching generic capability.
func (principal Principal) Allows(action, resource string) bool {
	for _, capability := range principal.Capabilities {
		if capability == "*" || capability == action || capability == action+":"+resource {
			return true
		}
	}
	return false
}
