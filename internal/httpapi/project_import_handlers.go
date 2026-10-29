package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"videocutlist/internal/httpapi/transport"
	"videocutlist/internal/projects"
)

const maxProjectImportEnvelopeBytes = 6*MaxJSONBody + 256

var errProjectImportEnvelopeTooLarge = errors.New("project import envelope exceeds limit")

func (s *Server) importProjectFile(writer http.ResponseWriter, request *http.Request, id string) {
	if s.config.ProjectImports == nil {
		internalError(writer, id, nil)
		return
	}
	content, err := readProjectImportContent(request)
	if errors.Is(err, errProjectImportEnvelopeTooLarge) {
		httpx.Error(writer, http.StatusRequestEntityTooLarge, "project_import_too_large", "Project file is too large.", id)
		return
	}
	if err != nil {
		httpx.Error(writer, http.StatusBadRequest, "invalid_project_import", "Project file is invalid.", id)
		return
	}
	result, err := s.config.ProjectImports.Import(request.Context(), content)
	if request.Context().Err() != nil {
		return
	}
	if errors.Is(err, projects.ErrProjectImportTooLarge) {
		httpx.Error(writer, http.StatusRequestEntityTooLarge, "project_import_too_large", "Project file is too large.", id)
		return
	}
	if errors.Is(err, projects.ErrInvalidProjectImport) || errors.Is(err, projects.ErrInvalidProject) {
		code, message := "invalid_project_import", "Project file is invalid."
		if itemErr, ok := errors.AsType[*projects.ProjectItemError](err); ok && itemErr.Code == "media_unavailable" {
			code, message = "media_unavailable", "A referenced media item is unavailable; no project was imported."
		}
		httpx.Error(writer, http.StatusBadRequest, code, message, id)
		return
	}
	if err != nil {
		internalError(writer, id, err)
		return
	}
	response, ok := projectImportToTransport(result)
	if !ok {
		internalError(writer, id, errors.New("project import value exceeds transport integer range"))
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, response)
}

func readProjectImportContent(request *http.Request) (_ []byte, err error) {
	defer func() {
		if closeErr := request.Body.Close(); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	if request.ContentLength > maxProjectImportEnvelopeBytes {
		return nil, errProjectImportEnvelopeTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, maxProjectImportEnvelopeBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxProjectImportEnvelopeBytes {
		return nil, errProjectImportEnvelopeTooLarge
	}
	if !utf8.Valid(data) {
		return nil, errors.New("request is not valid UTF-8")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil || len(fields) != 1 {
		return nil, errors.New("invalid project import envelope")
	}
	rawContent, ok := fields["content"]
	if !ok || strings.TrimSpace(string(rawContent)) == "null" {
		return nil, errors.New("project import content is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input transport.ProjectImportInput
	if err := decoder.Decode(&input); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("request body must contain one JSON value")
	}
	return []byte(input.Content), nil
}

func projectImportToTransport(result projects.ProjectImportResult) (transport.ProjectImportResult, bool) {
	var sourceFormat transport.ProjectImportResultSourceFormat
	switch result.SourceFormat {
	case "legacy":
		sourceFormat = transport.Legacy
	case "v2":
		sourceFormat = transport.V2
	default:
		return transport.ProjectImportResult{}, false
	}
	items := make([]transport.ProjectItem, len(result.Document.Items))
	for i, domainItem := range result.Document.Items {
		mapped, ok := projectItemToTransport(domainItem)
		if !ok {
			return transport.ProjectImportResult{}, false
		}
		items[i] = mapped.ProjectItem
		if mapped.ExportOptions != nil {
			items[i].ExportOptions = *mapped.ExportOptions
		}
	}
	document := transport.ProjectInput{
		Revision:      0,
		SchemaVersion: transport.ProjectInputSchemaVersion(result.Document.SchemaVersion),
		Name:          result.Document.Name,
		Items:         items,
	}
	response := transport.ProjectImportResult{SourceFormat: sourceFormat, Document: document}
	if result.MediaID != "" {
		response.MediaId = new(result.MediaID)
	}
	return response, true
}
