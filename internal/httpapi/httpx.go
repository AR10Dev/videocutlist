// Package httpx contains bounded HTTP boundary helpers.
package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
)

const MaxJSONBody = 1 << 20

// httpx keeps the handler call sites compact while all boundary helpers remain
// in this package (there is no cross-layer helper package).
var httpx boundary

type boundary struct{}

// closeResponseBody records cleanup failures after an HTTP response has been
// committed; changing the response at that point would produce a misleading status.
func closeResponseBody(logger *log.Logger, resource string, closer io.Closer) {
	if err := closer.Close(); err != nil && logger != nil {
		logger.Printf(`{"error_category":"response_cleanup","resource":%q}`, resource)
	}
}

func (boundary) Error(w http.ResponseWriter, status int, code, message, requestID string) {
	Error(w, status, code, message, requestID)
}
func (boundary) WriteJSON(w http.ResponseWriter, status int, value any) { WriteJSON(w, status, value) }
func (boundary) ReadJSON(r *http.Request, destination any) error        { return ReadJSON(r, destination) }

type requestIDKey struct{}

// RequestIDFromContext returns the server-generated correlation ID, never a
// client-supplied identifier or credential.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func RequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "request-id-unavailable"
	}
	return hex.EncodeToString(value[:])
}

func WriteJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func Error(writer http.ResponseWriter, status int, code, message, requestID string) {
	if observed, ok := writer.(*statusWriter); ok {
		observed.errorCode = code
	}
	WriteJSON(writer, status, map[string]any{"error": map[string]string{"code": code, "message": message, "requestId": requestID}})
}

// ReadJSON rejects oversized, malformed, and trailing JSON values.
func ReadJSON(request *http.Request, destination any) (err error) {
	defer func() {
		if closeErr := request.Body.Close(); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	if request.ContentLength > MaxJSONBody {
		return errors.New("request body exceeds limit")
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, MaxJSONBody+1))
	if err != nil {
		return err
	}
	if len(data) > MaxJSONBody {
		return errors.New("request body exceeds limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}
