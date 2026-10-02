package httpapi

import (
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
	if err := stream.setDeadline(); err != nil {
		return nil, err
	}
	if err := stream.controller.SetWriteDeadline(time.Time{}); err != nil {
		return nil, err
	}
	return stream, nil
}

func (w *sseWriter) setDeadline() error {
	return w.controller.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
}

func (w *sseWriter) Write(data []byte) (int, error) {
	if err := w.setDeadline(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(data)
}

func (w *sseWriter) flush() error {
	if err := w.setDeadline(); err != nil {
		return err
	}
	return w.controller.Flush()
}
