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
	releaseA, err := p.Acquire("a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Acquire("a"); !errors.Is(err, ErrUserLimit) {
		t.Fatalf("same user error = %v", err)
	}
	releaseB, err := p.Acquire("b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Acquire("c"); !errors.Is(err, ErrGlobalLimit) {
		t.Fatalf("global error = %v", err)
	}
	releaseA()
	releaseA()
	releaseB()
	if got := p.Active(); got != 0 {
		t.Fatalf("active = %d", got)
	}
}
