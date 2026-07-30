// Package httpx contains bounded HTTP boundary helpers.
package httpx

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const MaxJSONBody = 1 << 20

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
	WriteJSON(writer, status, map[string]any{"error": map[string]string{"code": code, "message": message, "requestId": requestID}})
}

// ReadJSON rejects oversized, malformed, and trailing JSON values.
func ReadJSON(request *http.Request, destination any) error {
	defer request.Body.Close()
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
