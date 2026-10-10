package mcp

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
)

// serveSDK preserves numeric request IDs exactly. The pinned SDK decodes IDs
// through float64, which rounds large integers. Only the transport ID is adapted;
// the SDK still parses and handles the protocol. Remove when upstream preserves IDs.
func (t *Transport) serveSDK(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		t.handler.ServeHTTP(w, r)
		return
	}
	admission := r.Context().Value(admissionKey{}).(*sessionAdmission)
	credentialID := admission.credential.ID
	workHeld := t.acquireWork(credentialID)
	controlHeld := false
	if !workHeld {
		controlHeld = t.acquireControl(credentialID)
		if !controlHeld {
			writeBusy(w)
			return
		}
	}
	defer func() {
		if workHeld {
			t.releaseWork(credentialID)
		}
		if controlHeld {
			t.releaseControl(credentialID)
		}
	}()
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	closeErr := r.Body.Close()
	if _, oversized := errors.AsType[*http.MaxBytesError](err); oversized {
		http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil || closeErr != nil {
		http.Error(w, "Parse error", http.StatusBadRequest)
		return
	}
	fields := make(map[string]json.RawMessage)
	if json.Unmarshal(data, &fields) != nil {
		http.Error(w, "Parse error", http.StatusBadRequest)
		return
	}
	id := bytes.TrimSpace(fields["id"])
	if len(id) > 128 {
		http.Error(w, "Invalid request ID", http.StatusBadRequest)
		return
	}
	// Inspect only the method to reserve a bounded lane for SDK cancellation;
	// the SDK still validates and dispatches the JSON-RPC request.
	var method string
	_ = json.Unmarshal(fields["method"], &method)
	if method == "notifications/cancelled" {
		if workHeld {
			t.releaseWork(credentialID)
			workHeld = false
			if !t.acquireControl(credentialID) {
				writeBusy(w)
				return
			}
			controlHeld = true
		}
	} else if controlHeld {
		t.releaseControl(credentialID)
		controlHeld = false
		writeBusy(w)
		return
	}
	// Numeric cancellation references use the same transient adapter as the active
	// request, so the SDK can cancel the request it actually received.
	scope := credentialID + "\x00" + r.Header.Get("Mcp-Session-Id")
	if method == "notifications/cancelled" {
		var params map[string]json.RawMessage
		if json.Unmarshal(fields["params"], &params) == nil {
			requestID := bytes.TrimSpace(params["requestId"])
			if len(requestID) > 0 && requestID[0] != '"' {
				if key, ok := canonicalNumericID(requestID); ok {
					t.mu.Lock()
					internal := t.numericIDs[scope][key]
					t.mu.Unlock()
					if internal != "" {
						params["requestId"], _ = json.Marshal(internal)
						fields["params"], _ = json.Marshal(params)
						data, _ = json.Marshal(fields)
					}
				}
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		t.dispatchSDK(w, r, method)
		return
	}
	// String IDs and notifications can pass through unchanged.
	if len(id) == 0 || id[0] == '"' || bytes.Equal(id, []byte("null")) {
		r.Body = io.NopCloser(bytes.NewReader(data))
		t.dispatchSDK(w, r, method)
		return
	}
	key, ok := canonicalNumericID(id)
	if !ok {
		http.Error(w, "Invalid request ID", http.StatusBadRequest)
		return
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	internalString := "numeric-" + hex.EncodeToString(random[:])
	internalID, _ := json.Marshal(internalString)
	t.mu.Lock()
	if t.numericIDs[scope] == nil {
		t.numericIDs[scope] = make(map[string]string)
	}
	if _, duplicate := t.numericIDs[scope][key]; duplicate {
		t.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":`+string(id)+`,"error":{"code":-32600,"message":"Invalid Request"}}`)
		return
	}
	t.numericIDs[scope][key] = internalString
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.numericIDs[scope], key)
		if len(t.numericIDs[scope]) == 0 {
			delete(t.numericIDs, scope)
		}
		t.mu.Unlock()
	}()
	fields["id"] = internalID
	data, err = json.Marshal(fields)
	if err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(data))
	r.ContentLength = int64(len(data))
	response := &numericIDResponse{ResponseWriter: w}
	t.dispatchSDK(response, r, method)
	result := make(map[string]json.RawMessage)
	output := response.body.Bytes()
	if response.overflow {
		http.Error(w, "Response exceeded the server limit", http.StatusInternalServerError)
		return
	}
	if json.Unmarshal(output, &result) == nil && bytes.Equal(result["id"], internalID) {
		result["id"] = id
		if encoded, err := json.Marshal(result); err == nil {
			output = encoded
		}
	}
	w.Header().Del("Content-Length")
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write(output)
}

// canonicalNumericID maps JSON number spellings to one exact value key without
// converting through floating point or expanding powers of ten. The wire token
// is bounded by the MCP request-ID limit, which also bounds exponent parsing.
func canonicalNumericID(raw []byte) (string, bool) {
	if len(raw) == 0 || len(raw) > 128 {
		return "", false
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil || number == "" {
		return "", false
	}
	token := string(number)
	negative := strings.HasPrefix(token, "-")
	if negative {
		token = token[1:]
	}

	exponent := new(big.Int)
	if index := strings.IndexAny(token, "eE"); index >= 0 {
		exponentText := token[index+1:]
		if _, ok := exponent.SetString(exponentText, 10); !ok {
			return "", false
		}
		token = token[:index]
	}
	integer, fraction, _ := strings.Cut(token, ".")
	digits := strings.TrimLeft(integer+fraction, "0")
	if digits == "" {
		return "0", true
	}
	exponent.Sub(exponent, big.NewInt(int64(len(fraction))))
	trimmed := strings.TrimRight(digits, "0")
	trailingZeros := len(digits) - len(trimmed)
	if trailingZeros > 0 {
		exponent.Add(exponent, big.NewInt(int64(trailingZeros)))
		digits = trimmed
	}
	sign := ""
	if negative {
		sign = "-"
	}
	return sign + digits + "e" + exponent.String(), true
}

type numericIDResponse struct {
	http.ResponseWriter
	status   int
	overflow bool
	body     bytes.Buffer
}

func (w *numericIDResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *numericIDResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	remaining := maxResultBytes - w.body.Len()
	if len(data) > remaining {
		w.overflow = true
		if remaining > 0 {
			_, _ = w.body.Write(data[:remaining])
		}
		return len(data), nil
	}
	return w.body.Write(data)
}
