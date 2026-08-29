package application

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPreviewLimits(t *testing.T) {
	p, err := NewPreviewLimits(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	releaseA, err := p.AcquireUser("a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireUser("a"); !errors.Is(err, ErrUserLimit) {
		t.Fatalf("same user error = %v", err)
	}
	releaseB, err := p.AcquireUser("b")
	if err != nil {
		t.Fatal(err)
	}
	processA, err := p.AcquireProcess()
	if err != nil {
		t.Fatal(err)
	}
	processB, err := p.AcquireProcess()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireProcess(); !errors.Is(err, ErrGlobalLimit) {
		t.Fatalf("global error = %v", err)
	}
	releaseA()
	releaseA()
	releaseB()
	processA()
	processB()
	if got := p.Active(); got != 0 {
		t.Fatalf("active = %d", got)
	}
}

func TestAcquireProcessContextCancellation(t *testing.T) {
	p, err := NewPreviewLimits(1, 1)
	if err != nil {
		t.Fatal(err)
	}
	release, err := p.AcquireProcess()
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := p.AcquireProcessContext(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait error = %v", err)
	}
}
