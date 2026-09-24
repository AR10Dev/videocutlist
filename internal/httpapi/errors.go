package httpapi

import (
	"errors"
	"net/http"

	store "videocutlist/internal/db"
	"videocutlist/internal/jobs"
	"videocutlist/internal/projects"
)

func resourceError(w http.ResponseWriter, id string, err error) {
	switch {
	case errors.Is(err, store.ErrProjectNotFound), errors.Is(err, store.ErrMediaNotFound), errors.Is(err, jobs.ErrJobNotFound):
		notFound(w, id)
	default:
		internalError(w, id)
	}
}

func projectError(w http.ResponseWriter, id string, err error) {
	switch {
	case errors.Is(err, store.ErrRevisionConflict):
		httpx.Error(w, http.StatusConflict, "revision_conflict", "Project revision conflicts.", id)
	case errors.Is(err, projects.ErrInvalidProject):
		message := "Project name, clips, or export settings are invalid."
		if itemErr, ok := errors.AsType[*projects.ProjectItemError](err); ok {
			switch itemErr.Code {
			case "media_unavailable":
				message = "A project video is no longer available. Refresh the media library and try again."
			case "invalid":
				message = "A project item has invalid editor or export settings. Reload the project and try again."
			}
		}
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_project", message, id)
	default:
		resourceError(w, id, err)
	}
}
