package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"videocutlist/internal/exportpolicy"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/probe"
)

var ErrOutputUnavailable = errors.New("export output unavailable")

type Artifact struct {
	Path, Name, Kind string
	Expires          time.Time
}
type ArtifactStore struct {
	mu        sync.Mutex
	values    map[string][]Artifact
	active    map[string]int
	manifests map[string]string
}

func NewArtifactStore() *ArtifactStore {
	return &ArtifactStore{values: map[string][]Artifact{}, active: map[string]int{}, manifests: map[string]string{}}
}

const manifestPrefix = ".videocutlist-export-"

type artifactManifest struct {
	JobID       string   `json:"jobId"`
	OutputNames []string `json:"outputNames"`
	Kind        string   `json:"kind"`
	Container   string   `json:"container,omitempty"`
	Expires     string   `json:"expires"`
}

func manifestContainer(outputNames []string, containers ...string) (string, error) {
	if len(containers) > 1 {
		return "", errors.New("multiple artifact containers")
	}
	requested := ""
	if len(containers) == 1 {
		requested = containers[0]
	}
	policy, ok := exportpolicy.For(requested)
	if requested == "" && len(outputNames) > 0 {
		if inferred, inferredOK := exportpolicy.ForFilename(outputNames[0]); inferredOK {
			policy = inferred
			ok = true
		}
	}
	if !ok {
		return "", errors.New("unsupported artifact container")
	}
	for _, name := range outputNames {
		if inferred, ok := exportpolicy.ForFilename(name); ok && inferred.Name != policy.Name {
			return "", errors.New("artifact container does not match output name")
		}
	}
	return policy.Name, nil
}

// WriteManifest records ownership before any publication. The manifest is
// published atomically and contains only opaque job metadata and basenames.
func WriteManifest(directory, jobID, kind string, outputNames []string, expires time.Time, containers ...string) (string, error) {
	container, err := manifestContainer(outputNames, containers...)
	if err != nil || jobID == "" || kind == "" || len(outputNames) == 0 {
		return "", errors.New("invalid artifact manifest")
	}
	for _, name := range outputNames {
		if name == "" || filepath.Base(name) != name || strings.Contains(name, "..") {
			return "", errors.New("invalid artifact name")
		}
	}
	manifest := artifactManifest{JobID: jobID, OutputNames: slices.Clone(outputNames), Kind: kind, Container: container, Expires: expires.UTC().Format(time.RFC3339Nano)}
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(directory, manifestPrefix+jobID+"-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	published := false
	defer func() {
		if !published {
			// Best effort: preserve the primary write or rename error when the
			// unpublished temporary manifest cannot be removed.
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	name := filepath.Join(directory, manifestPrefix+jobID+".json")
	if err := os.Rename(tmpName, name); err != nil {
		return "", err
	}
	published = true
	return name, nil
}

// writeManifestAt is the descriptor-relative variant used for an export that
// has already validated its destination root. The caller still gets the
// absolute path for artifact bookkeeping, but no write is performed through it.
func writeManifestAt(root *os.Root, directory, jobID, kind string, outputNames []string, expires time.Time, containers ...string) (string, error) {
	container, err := manifestContainer(outputNames, containers...)
	if root == nil || directory == "" || jobID == "" || kind == "" || len(outputNames) == 0 || err != nil {
		return "", errors.New("invalid artifact manifest")
	}
	for _, name := range outputNames {
		if name == "" || filepath.Base(name) != name || strings.Contains(name, "..") {
			return "", errors.New("invalid artifact name")
		}
	}
	manifest := artifactManifest{JobID: jobID, OutputNames: slices.Clone(outputNames), Kind: kind, Container: container, Expires: expires.UTC().Format(time.RFC3339Nano)}
	data, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	tmp, tmpName, err := createRootTemp(root, manifestPrefix+jobID+"-", ".tmp")
	if err != nil {
		return "", err
	}
	published := false
	defer func() {
		if !published {
			_ = root.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	name := manifestPrefix + jobID + ".json"
	if err := root.Rename(tmpName, name); err != nil {
		return "", err
	}
	published = true
	return filepath.Join(directory, name), nil
}

func removeManifest(path string) { _ = os.Remove(path) }

func removeManifestOutputs(manifestPath string, outputNames []string) (err error) {
	for _, name := range outputNames {
		if name == "" || filepath.Base(name) != name || strings.Contains(name, "..") {
			continue
		}
		path := filepath.Join(filepath.Dir(manifestPath), name)
		info, statErr := os.Lstat(path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil {
			err = errors.Join(err, fmt.Errorf("inspect cancelled artifact %q: %w", name, statErr))
			continue
		}
		if info.IsDir() {
			err = errors.Join(err, fmt.Errorf("cancelled artifact %q is a directory", name))
			continue
		}
		// Lstat plus Remove avoids following a replacement symlink and never
		// recursively removes a directory.
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, fmt.Errorf("remove cancelled artifact %q: %w", name, removeErr))
		}
	}
	return err
}

// Reconcile validates job-owned published outputs before ordinary job restart
// recovery. Unfinished manifests and their exact listed outputs are removed.
func (s *ArtifactStore) Reconcile(ctx context.Context, jobs *jobqueue.JobsStore, ffprobePath string, destinations []Destination) error {
	if jobs == nil {
		return errors.New("job store is required")
	}
	for _, directory := range manifestDirectories(destinations) {
		if _, err := os.Stat(directory); errors.Is(err, os.ErrNotExist) {
			continue
		}
		err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasPrefix(entry.Name(), manifestPrefix) || !strings.HasSuffix(entry.Name(), ".json") {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			var manifest artifactManifest
			if json.Unmarshal(data, &manifest) != nil || manifest.JobID == "" || len(manifest.OutputNames) == 0 || filepath.Base(path) != manifestPrefix+manifest.JobID+".json" {
				removeManifest(path)
				return nil
			}
			job, err := jobs.Get(ctx, manifest.JobID)
			if err != nil {
				removeManifest(path)
				return nil
			}
			if job.State == jobqueue.JobCancelled {
				if err := removeManifestOutputs(path, manifest.OutputNames); err != nil {
					return err
				}
				if err := removeArtifactPath(path); err != nil {
					return fmt.Errorf("remove cancelled artifact manifest: %w", err)
				}
				return nil
			}
			if job.State != jobqueue.JobRunning {
				return nil
			}
			valid := true
			expires, _ := time.Parse(time.RFC3339Nano, manifest.Expires)
			values := make([]Artifact, len(manifest.OutputNames))
			for i, name := range manifest.OutputNames {
				if filepath.Base(name) != name {
					valid = false
					break
				}
				output := filepath.Join(filepath.Dir(path), name)
				if err := VerifyArtifact(ctx, ffprobePath, output, manifest.Container); err != nil {
					valid = false
					break
				}
				values[i] = Artifact{Path: output, Name: name, Kind: manifest.Kind, Expires: expires}
			}
			if !valid {
				_ = removeManifestOutputs(path, manifest.OutputNames)
				removeManifest(path)
				return nil
			}
			s.Put(manifest.JobID, values)
			container := manifest.Container
			if container == "" {
				container, _ = manifestContainer(manifest.OutputNames)
			}
			result, _ := json.Marshal(Result{OutputName: manifest.OutputNames[0], OutputNames: manifest.OutputNames, Container: container, DestinationKind: manifest.Kind, Verified: true})
			if _, err := jobs.Succeed(ctx, manifest.JobID, string(result)); err == nil {
				removeManifest(path)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func manifestDirectories(destinations []Destination) []string {
	seen := map[string]bool{}
	var result []string
	for _, d := range destinations {
		root := d.Root
		if d.Kind == KindSourceAdjacent {
			root = d.MediaRoot
		}
		if root == "" {
			continue
		}
		root = filepath.Clean(root)
		if !seen[root] {
			seen[root] = true
			result = append(result, root)
		}
	}
	return result
}

// VerifyArtifact performs the minimal independent FFprobe validation available
// during restart; full source-aware validation already happened pre-publication.
func VerifyArtifact(ctx context.Context, ffprobePath, path string, containers ...string) error {
	if len(containers) > 1 {
		return ErrOutputUnavailable
	}
	policy, ok := exportpolicy.ForFilename(path)
	if len(containers) == 1 && containers[0] != "" {
		policy, ok = exportpolicy.For(containers[0])
	}
	if !ok {
		return ErrOutputUnavailable
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() || pathInfo.Size() == 0 {
		return ErrOutputUnavailable
	}
	file, err := os.Open(path)
	if err != nil {
		return ErrOutputUnavailable
	}
	defer func() {
		// Best effort: the artifact was already published, so a post-validation
		// close failure must not turn a valid artifact into a failed result.
		_ = file.Close()
	}()
	fileInfo, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, fileInfo) || !fileInfo.Mode().IsRegular() || fileInfo.Size() == 0 {
		return ErrOutputUnavailable
	}
	metadata, err := (probe.Client{Path: ffprobePath}).ProbeFile(ctx, file)
	if err != nil || metadata.DurationMS <= 0 || !policy.MatchesFormat(metadata.Container) {
		return ErrOutputUnavailable
	}
	return nil
}
func (s *ArtifactStore) RegisterManifest(job, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.manifests[job] = path
}

func (s *ArtifactStore) ClearManifest(job string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if path := s.manifests[job]; path != "" {
		_ = os.Remove(path)
	}
	delete(s.manifests, job)
}

func (s *ArtifactStore) Put(job string, values []Artifact) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[job] = slices.Clone(values)
}

// Remove rolls back published artifacts after a durable job transition fails;
// cleanup evidence remains registered when removal cannot complete.
func (s *ArtifactStore) Remove(job string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var err error
	for _, value := range s.values[job] {
		if removeErr := removeArtifactPath(value.Path); removeErr != nil {
			err = errors.Join(err, fmt.Errorf("remove artifact %q: %w", value.Name, removeErr))
		}
	}
	if err != nil {
		return err
	}
	if path := s.manifests[job]; path != "" {
		if removeErr := removeArtifactPath(path); removeErr != nil {
			return fmt.Errorf("remove artifact manifest: %w", removeErr)
		}
	}
	delete(s.values, job)
	delete(s.manifests, job)
	return nil
}

func removeArtifactPath(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("artifact path is a directory")
	}
	// Lstat plus Remove never follows a replacement symlink.
	return os.Remove(path)
}
func (s *ArtifactStore) Open(job string, position int, now time.Time) (io.ReadCloser, Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values, ok := s.values[job]
	if !ok || position < 0 || position >= len(values) {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	value := values[position]
	if value.Kind != KindDownload || !value.Expires.After(now) {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	// Open first, then compare the descriptor identity with the current path.
	// This avoids validating a pathname and reopening a potentially replaced file.
	file, err := os.Open(value.Path)
	if err != nil {
		return nil, Artifact{}, ErrOutputUnavailable
	}
	fdInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	resolved, err := filepath.EvalSymlinks(value.Path)
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	base, err := filepath.EvalSymlinks(filepath.Dir(value.Path))
	if err != nil {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	rel, relErr := filepath.Rel(base, resolved)
	pathInfo, pathErr := os.Stat(value.Path)
	if relErr != nil || pathErr != nil || !os.SameFile(fdInfo, pathInfo) || filepath.Dir(resolved) != base || rel == ".." || len(rel) >= 2 && rel[:2] == ".."+string(filepath.Separator) {
		_ = file.Close()
		return nil, Artifact{}, ErrOutputUnavailable
	}
	s.active[job]++
	return &trackedFile{File: file, done: func() { s.mu.Lock(); s.active[job]--; s.mu.Unlock() }}, value, nil
}

// Cleanup skips active streams; in-process tracking intentionally does not cover another process.
func (s *ArtifactStore) Cleanup(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for job, values := range s.values {
		if s.active[job] > 0 {
			continue
		}
		kept := values[:0]
		for _, v := range values {
			if v.Kind == KindArchive || v.Expires.After(now) {
				kept = append(kept, v)
			} else {
				_ = os.Remove(v.Path)
			}
		}
		if len(kept) == 0 {
			delete(s.values, job)
		} else {
			s.values[job] = kept
		}
	}
}

type trackedFile struct {
	*os.File
	done func()
}

func (f *trackedFile) Close() error { err := f.File.Close(); f.done(); return err }
