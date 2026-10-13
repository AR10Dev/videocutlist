package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"
)

type failingCloser struct{}

func (failingCloser) Close() error { return errors.New("close failed") }

func TestCloseResponseBodyLogsValidJSON(t *testing.T) {
	var logs bytes.Buffer
	resource := "quote\" control\n\x00 Unicode \u2028🙂"
	closeResponseBody(log.New(&logs, "", 0), resource, failingCloser{})
	var entry struct {
		Category string `json:"error_category"`
		Resource string `json:"resource"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("decode log: %v; record=%q", err, logs.String())
	}
	if entry.Category != "response_cleanup" || entry.Resource != resource || strings.Contains(logs.String(), "close failed") {
		t.Fatalf("unexpected cleanup log: %q (%#v)", logs.String(), entry)
	}
}
