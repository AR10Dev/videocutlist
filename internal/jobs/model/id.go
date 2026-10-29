package model

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

// NewID generates an opaque job or batch ID with the supplied prefix.
func NewID(prefix string) (string, error) {
	var value [18]byte
	if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value[:]), nil
}
