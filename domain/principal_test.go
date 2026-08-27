package domain

import "testing"

func TestSettingsManagementCapability(t *testing.T) {
	if !(Principal{Capabilities: []string{SettingsManageCapability}}).Allows(SettingsManageCapability, "*") {
		t.Fatal("settings management capability was not granted")
	}
	if (Principal{Capabilities: []string{"media_refresh"}}).Allows(SettingsManageCapability, "*") {
		t.Fatal("unrelated capability granted settings management")
	}
}
