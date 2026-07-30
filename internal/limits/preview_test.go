package limits

import (
	"errors"
	"testing"
)

func TestPreviewLimits(t *testing.T) {
	p, err := NewPreview(2, 1)
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
