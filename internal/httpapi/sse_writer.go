package httpapi

import (
	"errors"
	"net/http"
	"time"
)

const sseWriteTimeout = 5 * time.Second

type sseWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
}

func newSSEWriter(writer http.ResponseWriter) (*sseWriter, error) {
	stream := &sseWriter{ResponseWriter: writer, controller: http.NewResponseController(writer)}
	if err := stream.withDeadline(func() error { return nil }); err != nil {
		return nil, err
	}
	return stream, nil
}

func (w *sseWriter) setDeadline() error {
	return w.controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
}

func (w *sseWriter) withDeadline(operation func() error) error {
	if err := w.setDeadline(); err != nil {
		if clearErr := w.controller.SetWriteDeadline(time.Time{}); clearErr != nil {
			return errors.Join(err, clearErr)
		}
		return err
	}
	operationErr := operation()
	clearErr := w.controller.SetWriteDeadline(time.Time{})
	if operationErr != nil && clearErr != nil {
		return errors.Join(operationErr, clearErr)
	}
	if operationErr != nil {
		return operationErr
	}
	return clearErr
}

func (w *sseWriter) Write(data []byte) (int, error) {
	var written int
	err := w.withDeadline(func() error {
		var err error
		written, err = w.ResponseWriter.Write(data)
		return err
	})
	return written, err
}

func (w *sseWriter) flush() error {
	return w.withDeadline(w.controller.Flush)
}
