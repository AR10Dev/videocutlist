package export

import (
	"archive/zip"
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

const (
	manifestPrefix           = ".videocutlist-export-"
	manifestArchiveContainer = "zip"
	manifestArchiveMaxFiles  = MaxExportOutputs
	manifestArchiveMaxBytes  = int64(4 << 30)
)

type manifestOutput struct {
	Name   string `json:"name"`
	Device uint64 `json:"device,omitempty"`
	Inode  uint64 `json:"inode,omitempty"`
}

func (o manifestOutput) hasIdentity() bool {
	return o.Device != 0 && o.Inode != 0
}

type artifactManifest struct {
	JobID         string           `json:"jobId"`
	OutputNames   []string         `json:"outputNames"`
	OutputOwners  []manifestOutput `json:"outputOwners,omitempty"`
	Kind          string           `json:"kind"`
	DestinationID string           `json:"destinationId,omitempty"`
	Container     string           `json:"container,omitempty"`
	Expires       string           `json:"expires"`
}

func manifestContainer(outputNames []string, containers ...string) (string, error) {
	if len(containers) > 1 {
		return "", errors.New("multiple artifact containers")
	}
	requested := ""
	if len(containers) == 1 {
		requested = strings.ToLower(containers[0])
	}
	container := requested
	var policy exportpolicy.Policy
	var ok bool
	if container == "" && len(outputNames) > 0 {
		if inferred, inferredOK := exportpolicy.ForFilename(outputNames[0]); inferredOK {
			policy = inferred
			container = policy.Name
			ok = true
		} else if strings.EqualFold(filepath.Ext(outputNames[0]), "."+manifestArchiveContainer) {
			container = manifestArchiveContainer
			ok = true
		}
	} else if container == manifestArchiveContainer {
		ok = true
	} else {
		policy, ok = exportpolicy.For(container)
		if ok {
			container = policy.Name
		}
	}
	if !ok {
		return "", errors.New("unsupported artifact container")
	}
	for _, name := range outputNames {
		if !validManifestName(name) {
			return "", errors.New("invalid artifact name")
		}
		if container == manifestArchiveContainer {
			if !strings.EqualFold(filepath.Ext(name), ".zip") {
				return "", errors.New("artifact container does not match output name")
			}
			continue
		}
		inferred, inferredOK := exportpolicy.ForFilename(name)
		if !inferredOK || inferred.Name != container {
			return "", errors.New("artifact container does not match output name")
		}
	}
	return container, nil
}
func validManifestToken(value string) bool {
	if value == "" || filepath.Base(value) != value || strings.Contains(value, "..") {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

func validManifestOwner(value string) bool {
	return validManifestToken(value)
}

func validManifestName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 || filepath.Base(name) != name || strings.Contains(name, "..") {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validManifestArchiveName(name string) bool {
	if !validManifestName(name) {
		return false
	}
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

func isBatchManifest(manifest artifactManifest) bool {
	return manifest.Container == manifestArchiveContainer
}

func manifestEntries(manifest artifactManifest) []manifestOutput {
	if len(manifest.OutputOwners) > 0 {
		return slices.Clone(manifest.OutputOwners)
	}
	entries := make([]manifestOutput, len(manifest.OutputNames))
	for i, name := range manifest.OutputNames {
		entries[i] = manifestOutput{Name: name}
	}
	return entries
}

func manifestNames(manifest artifactManifest) []string {
	entries := manifestEntries(manifest)
	names := make([]string, len(entries))
	for i, entry := range entries {
		names[i] = entry.Name
	}
	return names
}

func validManifestEntries(manifest artifactManifest) bool {
	if len(manifest.OutputNames) == 0 {
		return false
	}
	if len(manifest.OutputOwners) == 0 {
		return true
	}
	if len(manifest.OutputOwners) != len(manifest.OutputNames) {
		return false
	}
	for i, entry := range manifest.OutputOwners {
		if entry.Name != manifest.OutputNames[i] || !entry.hasIdentity() {
			return false
		}
	}
	return true
}

func manifestOwnersForPaths(outputNames, ownerPaths []string) ([]manifestOutput, error) {
	if len(ownerPaths) == 0 {
		return nil, nil
	}
	if len(outputNames) != len(ownerPaths) {
		return nil, errors.New("manifest owner count does not match output count")
	}
	owners := make([]manifestOutput, len(outputNames))
	for i, name := range outputNames {
		info, err := os.Stat(ownerPaths[i])
		if err != nil {
			return nil, err
		}
		device, inode, ok := manifestFileIdentity(info)
		if !ok {
			return nil, nil
		}
		owners[i] = manifestOutput{Name: name, Device: device, Inode: inode}
	}
	return owners, nil
}

func newManifest(jobID, kind, destinationID string, outputNames []string, owners []manifestOutput, expires time.Time, container string) artifactManifest {
	manifest := artifactManifest{
		JobID: jobID, OutputNames: slices.Clone(outputNames), Kind: kind,
		DestinationID: destinationID, Container: container, Expires: expires.UTC().Format(time.RFC3339Nano),
	}
	if len(owners) > 0 {
		manifest.OutputOwners = slices.Clone(owners)
	}
	return manifest
}

func cleanupManifest(path string, manifest artifactManifest) error {
	if err := removeManifestOutputs(path, manifestEntries(manifest)); err != nil {
		return err
	}
	removeManifest(path)
	return nil
}

func validateManifestWrite(jobID, kind string, outputNames []string, containers ...string) (string, error) {
	container, err := manifestContainer(outputNames, containers...)
	if err != nil || !validManifestOwner(jobID) || kind == "" || len(outputNames) == 0 {
		return "", errors.New("invalid artifact manifest")
	}
	for _, name := range outputNames {
		if !validManifestName(name) {
			return "", errors.New("invalid artifact name")
		}
	}
	return container, nil
}

func writeManifestFile(directory, jobID string, manifest artifactManifest) (string, error) {
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

// WriteManifest records ownership before any publication. The manifest is
// published atomically and contains only opaque owner metadata and basenames.
func WriteManifest(directory, jobID, kind string, outputNames []string, expires time.Time, containers ...string) (string, error) {
	container, err := validateManifestWrite(jobID, kind, outputNames, containers...)
	if err != nil {
		return "", err
	}
	return writeManifestFile(directory, jobID, newManifest(jobID, kind, "", outputNames, nil, expires, container))
}

// WriteManifestWithOwners records the expected identity of each output before
// descriptor-relative publication. A restart can therefore avoid deleting an
// external file that won a concurrent name collision.
func WriteManifestWithOwners(directory, jobID, kind string, outputNames, ownerPaths []string, expires time.Time, containers ...string) (string, error) {
	container, err := validateManifestWrite(jobID, kind, outputNames, containers...)
	if err != nil {
		return "", err
	}
	owners, err := manifestOwnersForPaths(outputNames, ownerPaths)
	if err != nil {
		return "", err
	}
	return writeManifestFile(directory, jobID, newManifest(jobID, kind, "", outputNames, owners, expires, container))
}

func writeManifestAtWithOwners(root *os.Root, directory, jobID, kind, destinationID string, outputNames []string, owners []manifestOutput, expires time.Time, containers ...string) (string, error) {
	container, err := validateManifestWrite(jobID, kind, outputNames, containers...)
	if root == nil || directory == "" || err != nil || len(owners) != 0 && len(owners) != len(outputNames) {
		return "", errors.New("invalid artifact manifest")
	}
	if len(owners) > 0 {
		for i, owner := range owners {
			if owner.Name != outputNames[i] || !owner.hasIdentity() {
				return "", errors.New("invalid artifact manifest owner")
			}
		}
	}
	manifest := newManifest(jobID, kind, destinationID, outputNames, owners, expires, container)
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

func manifestOutputOwned(path string, entry manifestOutput) bool {
	if !entry.hasIdentity() {
		return true
	}
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	device, inode, ok := manifestFileIdentity(info)
	return ok && device == entry.Device && inode == entry.Inode
}

func removeManifestOutputs(manifestPath string, outputs []manifestOutput) (err error) {
	for _, output := range outputs {
		name := output.Name
		if !validManifestName(name) {
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
		if !manifestOutputOwned(path, output) {
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
			if json.Unmarshal(data, &manifest) != nil || !validManifestOwner(manifest.JobID) || !validManifestEntries(manifest) || filepath.Base(path) != manifestPrefix+manifest.JobID+".json" {
				removeManifest(path)
				return nil
			}
			names := manifestNames(manifest)
			if isBatchManifest(manifest) {
				if err := s.adoptManifestOutputs(ctx, path, manifest, ffprobePath); err != nil {
					return err
				}
				return nil
			}
			job, err := jobs.Get(ctx, manifest.JobID)
			if errors.Is(err, jobqueue.ErrJobNotFound) {
				if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
					return fmt.Errorf("remove unknown export artifacts: %w", cleanupErr)
				}
				return nil
			}
			if err != nil {
				return fmt.Errorf("load export job %q during recovery: %w", manifest.JobID, err)
			}
			if job.State == jobqueue.JobCancelled {
				if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
					return fmt.Errorf("remove cancelled export artifacts: %w", cleanupErr)
				}
				return nil
			}
			if job.State == jobqueue.JobSucceeded {
				if err := s.adoptManifestOutputs(ctx, path, manifest, ffprobePath); err != nil {
					return err
				}
				return nil
			}
			if job.State != jobqueue.JobRunning {
				return nil
			}
			expires, err := time.Parse(time.RFC3339Nano, manifest.Expires)
			if err != nil || expires.IsZero() && manifest.Kind != KindArchive {
				if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
					return fmt.Errorf("remove invalid export artifacts: %w", cleanupErr)
				}
				return nil
			}
			container, err := manifestContainer(names, manifest.Container)
			if err != nil {
				if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
					return fmt.Errorf("remove invalid export artifacts: %w", cleanupErr)
				}
				return nil
			}
			entries := manifestEntries(manifest)
			values := make([]Artifact, len(entries))
			for i, entry := range entries {
				output := filepath.Join(filepath.Dir(path), entry.Name)
				if !manifestOutputOwned(output, entry) {
					if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
						return fmt.Errorf("remove invalid export artifacts: %w", cleanupErr)
					}
					return nil
				}
				if err := validateManifestOutput(ctx, ffprobePath, output, container); err != nil {
					if cleanupErr := cleanupManifest(path, manifest); cleanupErr != nil {
						return fmt.Errorf("remove invalid export artifacts: %w", cleanupErr)
					}
					return nil
				}
				values[i] = Artifact{Path: output, Name: entry.Name, Kind: manifest.Kind, Expires: expires}
			}
			s.Put(manifest.JobID, values)
			s.RegisterManifest(manifest.JobID, path)
			result := Result{
				Container:       container,
				RetainUntil:     expires,
				DestinationID:   manifestDestinationID(path, manifest, destinations),
				DestinationKind: manifest.Kind,
				Verified:        true,
			}
			// Download classification requires exactly one of OutputName or
			// OutputNames; recovered manifests may describe either shape.
			if len(names) == 1 {
				result.OutputName = names[0]
			} else {
				result.OutputNames = names
			}
			resultJSON, err := json.Marshal(result)
			if err != nil {
				return fmt.Errorf("marshal recovered export result: %w", err)
			}
			if _, err := jobs.Succeed(ctx, manifest.JobID, string(resultJSON)); err != nil {
				return fmt.Errorf("persist recovered export result: %w", err)
			}
			// Keep the manifest as restart evidence until expiry cleanup removes
			// its owned outputs. A second restart must be able to re-adopt them.
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

func validateManifestOutput(ctx context.Context, ffprobePath, path, container string) error {
	if container == manifestArchiveContainer {
		return validateManifestArchive(ctx, path)
	}
	return VerifyArtifact(ctx, ffprobePath, path, container)
}

func validateManifestMediaShape(path string) error {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() == 0 {
		return ErrOutputUnavailable
	}
	return nil
}

func validateManifestArchive(ctx context.Context, path string) error {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > manifestArchiveMaxBytes {
		return ErrOutputUnavailable
	}
	file, err := os.Open(path)
	if err != nil {
		return ErrOutputUnavailable
	}
	defer func() { _ = file.Close() }()
	fileInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, fileInfo) {
		return ErrOutputUnavailable
	}
	archive, err := zip.NewReader(file, fileInfo.Size())
	if err != nil || len(archive.File) == 0 || len(archive.File) > manifestArchiveMaxFiles {
		return ErrOutputUnavailable
	}
	var total int64
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !validManifestArchiveName(entry.Name) || entry.FileInfo().IsDir() || entry.FileInfo().Mode()&os.ModeSymlink != 0 {
			return ErrOutputUnavailable
		}
		if entry.UncompressedSize64 > uint64(manifestArchiveMaxBytes-total) {
			return ErrOutputUnavailable
		}
		reader, err := entry.Open()
		if err != nil {
			return ErrOutputUnavailable
		}
		limit := int64(entry.UncompressedSize64) + 1
		copied, copyErr := io.Copy(io.Discard, io.LimitReader(manifestContextReader{ctx: ctx, reader: reader}, limit))
		closeErr := reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil || copied != int64(entry.UncompressedSize64) {
			return ErrOutputUnavailable
		}
		total += copied
	}
	return nil
}

type manifestContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r manifestContextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}

// adoptManifestOutputs registers valid outputs of an already-successful owner
// so expiry cleanup owns them after a restart. The manifest remains durable
// evidence until cleanup removes the owned outputs, allowing repeated restarts.
// Media output validation is intentionally non-destructive when ffprobe is
// unavailable; a successful durable publication must not be orphaned by a
// transient validator failure.
func (s *ArtifactStore) adoptManifestOutputs(ctx context.Context, path string, manifest artifactManifest, ffprobePath string) error {
	expires, err := time.Parse(time.RFC3339Nano, manifest.Expires)
	if err != nil || expires.IsZero() && manifest.Kind != KindArchive {
		return cleanupManifest(path, manifest)
	}
	if !expires.IsZero() && manifest.Kind != KindArchive && !expires.After(time.Now().UTC()) {
		return cleanupManifest(path, manifest)
	}
	names := manifestNames(manifest)
	container, err := manifestContainer(names, manifest.Container)
	if err != nil {
		return cleanupManifest(path, manifest)
	}
	entries := manifestEntries(manifest)
	values := make([]Artifact, 0, len(entries))
	for _, entry := range entries {
		output := filepath.Join(filepath.Dir(path), entry.Name)
		if !manifestOutputOwned(output, entry) {
			return cleanupManifest(path, manifest)
		}
		if container == manifestArchiveContainer {
			if err := validateManifestArchive(ctx, output); err != nil {
				return cleanupManifest(path, manifest)
			}
		} else {
			if err := validateManifestMediaShape(output); err != nil {
				return cleanupManifest(path, manifest)
			}
			if err := VerifyArtifact(ctx, ffprobePath, output, container); err != nil {
				// The output belongs to a durable successful job. Keep the
				// manifest and file when ffprobe is unavailable or transiently
				// unable to inspect it, so a later restart can retry adoption.
				return nil
			}
		}
		values = append(values, Artifact{Path: output, Name: entry.Name, Kind: manifest.Kind, Expires: expires})
	}
	s.Put(manifest.JobID, values)
	s.RegisterManifest(manifest.JobID, path)
	return nil
}

func manifestDestinationID(manifestPath string, manifest artifactManifest, destinations []Destination) string {
	if manifest.DestinationID != "" {
		return manifest.DestinationID
	}
	directory := filepath.Clean(filepath.Dir(manifestPath))
	for _, destination := range destinations {
		if destination.ID == "" || destination.Kind != manifest.Kind || destination.Root == "" {
			continue
		}
		if filepath.Clean(destination.Root) == directory {
			return destination.ID
		}
	}
	if manifest.Kind == KindDownload {
		return "download"
	}
	return ""
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
	if path := s.manifests[job]; path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read artifact manifest before cleanup: %w", err)
		}
		var manifest artifactManifest
		if err := json.Unmarshal(data, &manifest); err != nil || manifest.JobID != job || !validManifestEntries(manifest) {
			return errors.New("artifact manifest is invalid")
		}
		if err := removeManifestOutputs(path, manifestEntries(manifest)); err != nil {
			return err
		}
		if err := removeArtifactPath(path); err != nil {
			return fmt.Errorf("remove artifact manifest: %w", err)
		}
	} else {
		for _, value := range s.values[job] {
			if err := removeArtifactPath(value.Path); err != nil {
				return fmt.Errorf("remove artifact %q: %w", value.Name, err)
			}
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
				continue
			}
			if err := removeArtifactPath(v.Path); err != nil {
				kept = append(kept, v)
			}
		}
		if len(kept) == 0 {
			if path := s.manifests[job]; path != "" {
				_ = removeArtifactPath(path)
			}
			delete(s.values, job)
			delete(s.manifests, job)
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
