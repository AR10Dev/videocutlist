// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"

	"videocutlist/internal/projects"
	"videocutlist/internal/projects/interchange"
	"videocutlist/internal/projects/model"
)

type automationCommand struct {
	Action        string `json:"action"`
	ProjectID     string `json:"projectId,omitempty"`
	ProjectItemID string `json:"projectItemId,omitempty"`
	JobID         string `json:"jobId,omitempty"`
	Format        string `json:"format,omitempty"`
	Input         string `json:"input,omitempty"`
}

func (s *Server) automation(w http.ResponseWriter, r *http.Request, id string) {
	if r.Header.Get("Origin") != "" || !listenerLoopback(s.config.ListenerAddress) || !s.config.RequireAutomationAuth {
		httpx.Error(w, http.StatusForbidden, "automation_forbidden", "Automation is unavailable.", id)
		return
	}
	if r.ContentLength > maxAutomationBodyBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.", id)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAutomationBodyBytes+1))
	if err != nil || len(body) > maxAutomationBodyBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "Request body is too large.", id)
		return
	}
	var command automationCommand
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil || command.Action == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
		return
	}
	switch command.Action {
	case "project.import":
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") || command.Input == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
			return
		}
		// Reuse the canonical HTTP interchange path and return only its opaque project ID.
		project, err := s.config.Projects.Get(r.Context(), command.ProjectID)
		if err != nil {
			notFound(w, id)
			return
		}
		item, ok := projectItem(project, command.ProjectItemID)
		if !ok {
			httpx.Error(w, http.StatusConflict, "project_item_required", "Select one project item.", id)
			return
		}
		media, err := s.config.Media.Get(r.Context(), item.MediaID)
		if err != nil {
			notFound(w, id)
			return
		}
		var segments []model.Segment
		if command.Format == "csv" {
			segments, err = interchange.ParseCSV([]byte(command.Input), media.DurationMS)
		} else {
			segments, err = interchange.ParseChapters([]byte(command.Input), media.DurationMS)
		}
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_interchange", "Interchange input is invalid.", id)
			return
		}
		item.Segments = append([]model.Segment(nil), segments...)
		saved, err := s.config.Projects.Save(r.Context(), command.ProjectID, projects.ProjectInput{Revision: project.Revision, Document: project.Document})
		if err != nil {
			httpx.Error(w, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"projectId": saved.ID})
	case "project.export":
		if !validProjectID(command.ProjectID) || (command.Format != "csv" && command.Format != "chapters") {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
			return
		}
		project, err := s.config.Projects.Get(r.Context(), command.ProjectID)
		if err != nil {
			notFound(w, id)
			return
		}
		item, ok := projectItem(project, command.ProjectItemID)
		if !ok {
			httpx.Error(w, http.StatusConflict, "project_item_required", "Select one project item.", id)
			return
		}
		var data []byte
		if command.Format == "csv" {
			data, err = interchange.ExportCSV(item.Segments)
		} else {
			data, err = interchange.ExportChapters(item.Segments)
		}
		if err != nil {
			internalError(w, id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"filename": "cutlist." + command.Format, "content": string(data)})
	case "job.status":
		if !validJobID(command.JobID) {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid_command", "Command is invalid.", id)
			return
		}
		job, err := s.config.Jobs.Get(r.Context(), command.JobID)
		if err != nil {
			notFound(w, id)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, job)
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "unsupported_command", "Command is not supported.", id)
	}
}

func projectItem(project projects.Project, itemID string) (*model.ProjectItem, bool) {
	if itemID == "" && len(project.Items) == 1 {
		return &project.Items[0], true
	}
	for i := range project.Items {
		if project.Items[i].ID == itemID {
			return &project.Items[i], true
		}
	}
	return nil, false
}

func listenerLoopback(address string) bool {
	ip := net.ParseIP(address)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) importInterchange(w http.ResponseWriter, r *http.Request, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), parts[0])
	if err != nil {
		notFound(w, id)
		return
	}
	item, ok := projectItem(project, r.URL.Query().Get("itemId"))
	if !ok {
		httpx.Error(w, http.StatusConflict, "project_item_required", "Select one project item.", id)
		return
	}
	media, err := s.config.Media.Get(r.Context(), item.MediaID)
	if err != nil {
		notFound(w, id)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, interchange.MaxInputBytes+1))
	if err != nil || len(body) > interchange.MaxInputBytes {
		httpx.Error(w, 422, "invalid_interchange", "Interchange input is invalid.", id)
		return
	}
	var segments []model.Segment
	if parts[1] == "csv" {
		segments, err = interchange.ParseCSV(body, media.DurationMS)
	} else {
		segments, err = interchange.ParseChapters(body, media.DurationMS)
	}
	if err != nil {
		httpx.Error(w, 422, "invalid_interchange", "Interchange input is invalid.", id)
		return
	}
	item.Segments = append([]model.Segment(nil), segments...)
	saved, err := s.config.Projects.Save(r.Context(), parts[0], projects.ProjectInput{Revision: project.Revision, Document: project.Document})
	if err != nil {
		httpx.Error(w, 409, "revision_conflict", "Project revision conflicts.", id)
		return
	}
	httpx.WriteJSON(w, 200, saved)
}
func (s *Server) exportInterchange(w http.ResponseWriter, r *http.Request, routeID, id string) {
	parts := strings.SplitN(routeID, ":", 2)
	if len(parts) != 2 {
		return
	}
	project, err := s.config.Projects.Get(r.Context(), parts[0])
	if err != nil {
		notFound(w, id)
		return
	}
	item, ok := projectItem(project, r.URL.Query().Get("itemId"))
	if !ok {
		httpx.Error(w, http.StatusConflict, "project_item_required", "Select one project item.", id)
		return
	}
	var data []byte
	if parts[1] == "csv" {
		data, err = interchange.ExportCSV(item.Segments)
	} else {
		data, err = interchange.ExportChapters(item.Segments)
	}
	if err != nil {
		internalError(w, id)
		return
	}
	if parts[1] == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.Header().Set("Content-Disposition", `attachment; filename="cutlist.`+parts[1]+`"`)
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
