package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"sync"
	"time"

	settingsmodel "videocutlist/internal/settings/model"
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

// RuntimeSettingsPersistence is the settings service's storage boundary.
type RuntimeSettingsPersistence interface {
	Seed(context.Context, settingsmodel.RuntimeSettings) (settingsmodel.RuntimeSettingsRecord, error)
	Get(context.Context) (settingsmodel.RuntimeSettingsRecord, error)
	Update(context.Context, int64, settingsmodel.RuntimeSettings) (settingsmodel.RuntimeSettingsRecord, error)
}

type RuntimeService struct {
	store RuntimeSettingsPersistence
	state *settingsmodel.RuntimeSettingsState
	apply func(context.Context, settingsmodel.RuntimeSettings) error
	mu    sync.Mutex
}

func NewRuntimeService(repository RuntimeSettingsPersistence, state *settingsmodel.RuntimeSettingsState, apply func(context.Context, settingsmodel.RuntimeSettings) error) *RuntimeService {
	return &RuntimeService{store: repository, state: state, apply: apply}
}

// BootstrapRuntimeSettings inserts defaults and refreshes deployment-owned roots
// and destinations without moving those policy decisions into storage.
func BootstrapRuntimeSettings(ctx context.Context, repository RuntimeSettingsPersistence, defaults settingsmodel.RuntimeSettings) (settingsmodel.RuntimeSettingsRecord, error) {
	record, err := repository.Seed(ctx, defaults)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	updated := record.Settings
	updated.MediaRoots = maps.Clone(defaults.MediaRoots)
	updated.Destinations = slices.Clone(defaults.Destinations)
	if maps.Equal(record.Settings.MediaRoots, updated.MediaRoots) && slices.Equal(record.Settings.Destinations, updated.Destinations) {
		return record, nil
	}
	return repository.Update(ctx, record.Revision, updated)
}

func (s *RuntimeService) Get(ctx context.Context) (settingsmodel.RuntimeSettingsRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Get(ctx)
}

func (s *RuntimeService) Update(ctx context.Context, revision int64, settings settingsmodel.RuntimeSettings, deployment DeploymentDocument) (settingsmodel.RuntimeSettingsRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := s.store.Get(ctx)
	if err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, err
	}
	if previous.Revision != revision {
		return settingsmodel.RuntimeSettingsRecord{}, settingsmodel.ErrRuntimeSettingsRevisionConflict
	}
	if len(deployment.MediaRoots) > 0 && !jsonEqual(deployment.MediaRoots, previous.Settings.MediaRoots) || len(deployment.Destinations) > 0 && !destinationsMatch(deployment.Destinations, previous.Settings.Destinations) {
		return settingsmodel.RuntimeSettingsRecord{}, ErrDeploymentSettingsReadOnly
	}
	settings.MediaRoots, settings.Destinations = previous.Settings.MediaRoots, previous.Settings.Destinations
	if err := settingsmodel.ValidateRuntimeSettings(settings); err != nil {
		return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("%w: %w", ErrInvalidSettings, err)
	}
	if s.apply != nil {
		if err := s.apply(ctx, settings); err != nil {
			return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("apply runtime settings: %w", err)
		}
	}
	record, err := s.store.Update(ctx, revision, settings)
	if err != nil {
		if s.apply != nil {
			// A cancelled request must not prevent restoration of the live state.
			rollback, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if rollbackErr := s.apply(rollback, previous.Settings); rollbackErr != nil {
				return settingsmodel.RuntimeSettingsRecord{}, fmt.Errorf("restore runtime settings: %w", errors.Join(err, rollbackErr))
			}
		}
		return settingsmodel.RuntimeSettingsRecord{}, err
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

func destinationsMatch(raw json.RawMessage, previous []settingsmodel.RuntimeDestination) bool {
	var got []map[string]json.RawMessage
	if json.Unmarshal(raw, &got) != nil || len(got) != len(previous) {
		return false
	}
	for i, destination := range previous {
		encoded, err := json.Marshal(got[i])
		var supplied settingsmodel.RuntimeDestination
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
