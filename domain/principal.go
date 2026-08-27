// Package domain contains provider-neutral business values and rules.
package domain

import (
	"errors"
)

var ErrUnauthenticated = errors.New("unauthenticated")

// SettingsManageCapability authorizes reading and changing server runtime settings.
// Settings handlers must check it before parsing a request or loading settings.
const SettingsManageCapability = "settings:manage"

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
