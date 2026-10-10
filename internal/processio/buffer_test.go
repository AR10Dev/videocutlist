package processio

import (
	"errors"
	"sync"
	"testing"
)

func TestLimitedBuffer(t *testing.T) {
	overflow := errors.New("output too large")
	for _, test := range []struct {
		name     string
		limit    int
		writes   []string
		retained string
		failsAt  int
	}{
		{"exact fit", 4, []string{"", "12", "34"}, "1234", -1},
		{"crossing write", 4, []string{"12", "345", "", "3"}, "12", 1},
		{"oversized first write", 4, []string{"12345", "1"}, "", 0},
		{"zero limit", 0, []string{"", "1", ""}, "", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			buffer := NewLimitedBuffer(test.limit, overflow)
			for i, write := range test.writes {
				n, err := buffer.Write([]byte(write))
				if test.failsAt >= 0 && i >= test.failsAt {
					if n != 0 || !errors.Is(err, overflow) || buffer.Err() != overflow {
						t.Fatalf("write %d = %d, %v; stored error %v", i, n, err, buffer.Err())
					}
				} else if n != len(write) || err != nil || buffer.Err() != nil {
					t.Fatalf("write %d = %d, %v; stored error %v", i, n, err, buffer.Err())
				}
			}
			if buffer.String() != test.retained || string(buffer.Bytes()) != test.retained {
				t.Fatalf("retained %q, want %q", buffer.String(), test.retained)
			}
		})
	}
}

func TestLimitedBufferRequiresOverflowError(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for missing overflow error")
		}
	}()
	NewLimitedBuffer(4, nil)
}

func TestTruncatedBuffer(t *testing.T) {
	for _, limit := range []int{-1, 0, 4} {
		buffer := NewTruncatedBuffer(limit)
		for _, write := range []string{"", "12", "3456", "7"} {
			n, err := buffer.Write([]byte(write))
			if n != len(write) || err != nil {
				t.Fatalf("write = %d, %v", n, err)
			}
		}
		want := ""
		if limit == 4 {
			want = "1234"
		}
		if buffer.String() != want || string(buffer.Bytes()) != want {
			t.Fatalf("limit %d retained %q, want %q", limit, buffer.String(), want)
		}
		snapshot := buffer.Bytes()
		if len(snapshot) > 0 {
			snapshot[0] = 'x'
			if buffer.String() != want {
				t.Fatal("byte accessor exposed mutable storage")
			}
		}
	}
}

func TestTruncatedBufferConcurrentAccess(t *testing.T) {
	buffer := NewTruncatedBuffer(32)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			for range 100 {
				n, err := buffer.Write([]byte("1234"))
				if n != 4 || err != nil {
					t.Errorf("write = %d, %v", n, err)
				}
				if len(buffer.String()) > 32 || len(buffer.Bytes()) > 32 {
					t.Error("exceeded limit")
				}
			}
		})
	}
	workers.Wait()
	if len(buffer.String()) != 32 {
		t.Fatal("did not retain full prefix")
	}
}
