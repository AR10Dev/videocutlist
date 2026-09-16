package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"time"

	store "videocutlist/internal/db"
)

var (
	ErrInvalidSettings            = errors.New("invalid runtime settings")
	ErrDeploymentSettingsReadOnly = errors.New("deployment settings are read-only")
)

// DeploymentDocument tracks omitted versus explicitly supplied deployment fields.
// Clients may echo redacted metadata but cannot replace server-owned paths.
type DeploymentDocument struct {
	MediaRoots   json.RawMessage `json:"mediaRoots"`
	Destinations json.RawMessage `json:"destinations"`
}

type RuntimeService struct {
	store *store.RuntimeSettingsStore
	state *store.RuntimeSettingsState
	apply func(context.Context, store.RuntimeSettings) error
	mu    sync.Mutex
}

func NewRuntimeService(repository *store.RuntimeSettingsStore, state *store.RuntimeSettingsState, apply func(context.Context, store.RuntimeSettings) error) *RuntimeService {
	return &RuntimeService{store: repository, state: state, apply: apply}
}

func (s *RuntimeService) Get(ctx context.Context) (store.RuntimeSettingsRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Get(ctx)
}

func (s *RuntimeService) Update(ctx context.Context, revision int64, settings store.RuntimeSettings, deployment DeploymentDocument) (store.RuntimeSettingsRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.store.Get(ctx)
	if err != nil {
		return store.RuntimeSettingsRecord{}, err
	}
	if previous.Revision != revision {
		return store.RuntimeSettingsRecord{}, store.ErrRuntimeSettingsRevisionConflict
	}
	if len(deployment.MediaRoots) > 0 && !jsonEqual(deployment.MediaRoots, previous.Settings.MediaRoots) || len(deployment.Destinations) > 0 && !destinationsMatch(deployment.Destinations, previous.Settings.Destinations) {
		return store.RuntimeSettingsRecord{}, ErrDeploymentSettingsReadOnly
	}
	settings.MediaRoots, settings.Destinations = previous.Settings.MediaRoots, previous.Settings.Destinations
	if err := store.ValidateRuntimeSettings(settings); err != nil {
		return store.RuntimeSettingsRecord{}, fmt.Errorf("%w: %w", ErrInvalidSettings, err)
	}
	if s.apply != nil {
		if err := s.apply(ctx, settings); err != nil {
			return store.RuntimeSettingsRecord{}, fmt.Errorf("apply runtime settings: %w", err)
		}
	}
	record, err := s.store.Update(ctx, revision, settings)
	if err != nil {
		if s.apply != nil {
			// A cancelled request must not prevent restoration of the live state.
			rollback, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if rollbackErr := s.apply(rollback, previous.Settings); rollbackErr != nil {
				return store.RuntimeSettingsRecord{}, fmt.Errorf("restore runtime settings: %w", errors.Join(err, rollbackErr))
			}
		}
		return store.RuntimeSettingsRecord{}, err
	}
	if s.state != nil {
		s.state.Replace(record.Settings)
	}
	return record, nil
}

func jsonEqual(raw json.RawMessage, value any) bool {
	var got, want any
	encoded, err := json.Marshal(value)
	if err != nil || json.Unmarshal(raw, &got) != nil || json.Unmarshal(encoded, &want) != nil {
		return false
	}
	return reflect.DeepEqual(got, want)
}

func destinationsMatch(raw json.RawMessage, previous []store.RuntimeDestination) bool {
	var got []map[string]json.RawMessage
	if json.Unmarshal(raw, &got) != nil || len(got) != len(previous) {
		return false
	}
	for i, destination := range previous {
		encoded, err := json.Marshal(got[i])
		var supplied store.RuntimeDestination
		if err != nil || json.Unmarshal(encoded, &supplied) != nil {
			return false
		}
		for name, value := range map[string]string{"root": destination.Root, "mediaRoot": destination.MediaRoot} {
			if field, ok := got[i][name]; ok && !jsonEqual(field, value) {
				return false
			}
		}
		supplied.Root, supplied.MediaRoot = destination.Root, destination.MediaRoot
		if supplied != destination {
			return false
		}
	}
	return true
}
