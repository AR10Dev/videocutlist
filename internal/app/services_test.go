package app

import (
	"context"
	"errors"
	"testing"

	"editapp/internal/api"
	"editapp/internal/auth"
)

func TestAdmissionRejectsBusyWorkBeforeDependencies(t *testing.T) {
	media := &MediaAdapter{refreshing: true}
	principal := auth.Principal{Subject: "editor"}
	if _, err := media.RefreshMedia(context.Background(), principal); !errors.Is(err, api.ErrBusy) {
		t.Fatalf("refresh error = %v", err)
	}

	exports := &ExportAdapter{slots: make(chan struct{}, 1)}
	exports.slots <- struct{}{}
	if _, err := exports.Create(context.Background(), principal, "p_project", api.Project{}, api.ExportInput{}); !errors.Is(err, api.ErrBusy) {
		t.Fatalf("export error = %v", err)
	}
}
