package httpapi

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSSEWriterArmsAndClearsDeadlineForEachOperation(t *testing.T) {
	writer := newDeadlineRecordingWriter()
	stream, err := newSSEWriter(writer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write([]byte("data: snapshot\n\n")); err != nil {
		t.Fatal(err)
	}
	if err := stream.flush(); err != nil {
		t.Fatal(err)
	}
	if got, want := len(writer.deadlines), 6; got != want {
		t.Fatalf("deadline calls = %d, want %d: %v", got, want, writer.deadlines)
	}
	for i := 0; i < len(writer.deadlines); i += 2 {
		if writer.deadlines[i].IsZero() || !writer.deadlines[i+1].IsZero() {
			t.Fatalf("deadline pair %d = (%v, %v), want future then clear", i/2, writer.deadlines[i], writer.deadlines[i+1])
		}
	}
}

func TestSSEWriterPreservesOperationAndDeadlineClearErrors(t *testing.T) {
	writeErr := errors.New("write failed")
	clearErr := errors.New("deadline clear failed")
	writer := newDeadlineRecordingWriter()
	writer.writeErr = writeErr
	writer.deadlineErrors = map[int]error{4: clearErr}
	stream, err := newSSEWriter(writer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write([]byte("data: snapshot\n\n")); !errors.Is(err, writeErr) || !errors.Is(err, clearErr) {
		t.Fatalf("write error = %v, want operation and clear errors", err)
	}
	if got := writer.deadlines[len(writer.deadlines)-1]; !got.IsZero() {
		t.Fatalf("write cleanup deadline = %v, want zero", got)
	}

	flushErr := errors.New("flush failed")
	writer = newDeadlineRecordingWriter()
	writer.flushErr = flushErr
	writer.deadlineErrors = map[int]error{4: clearErr}
	stream, err = newSSEWriter(writer)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.flush(); !errors.Is(err, flushErr) || !errors.Is(err, clearErr) {
		t.Fatalf("flush error = %v, want operation and clear errors", err)
	}
	if got := writer.deadlines[len(writer.deadlines)-1]; !got.IsZero() {
		t.Fatalf("flush cleanup deadline = %v, want zero", got)
	}
}

func TestSSEWriterReturnsDeadlineClearFailure(t *testing.T) {
	clearErr := errors.New("deadline clear failed")
	writer := newDeadlineRecordingWriter()
	writer.deadlineErrors = map[int]error{4: clearErr}
	stream, err := newSSEWriter(writer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Write([]byte("data: snapshot\n\n")); err != clearErr {
		t.Fatalf("write error = %v, want clear failure %v", err, clearErr)
	}
}

func TestSSEWriterPreservesOperationErrorWhenDeadlineClears(t *testing.T) {
	writeErr := errors.New("write failed")
	writer := newDeadlineRecordingWriter()
	writer.writeErr = writeErr
	stream, err := newSSEWriter(writer)
	if err != nil {
		t.Fatal(err)
	}
	_, err = stream.Write([]byte("data: snapshot\n\n"))
	if err != writeErr {
		t.Fatalf("write error = %v, want original error %v", err, writeErr)
	}
}

type deadlineRecordingWriter struct {
	*httptest.ResponseRecorder
	deadlines      []time.Time
	deadlineErrors map[int]error
	writeErr       error
	flushErr       error
}

func newDeadlineRecordingWriter() *deadlineRecordingWriter {
	return &deadlineRecordingWriter{ResponseRecorder: httptest.NewRecorder()}
}

func (w *deadlineRecordingWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return w.deadlineErrors[len(w.deadlines)]
}

func (w *deadlineRecordingWriter) Write(data []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return w.ResponseRecorder.Write(data)
}

func (w *deadlineRecordingWriter) FlushError() error {
	if w.flushErr != nil {
		return w.flushErr
	}
	w.Flush()
	return nil
}
