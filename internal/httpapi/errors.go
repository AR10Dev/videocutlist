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
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_project", "Project is invalid.", id)
	default:
		resourceError(w, id, err)
	}
}
