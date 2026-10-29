// Package export owns batch archive preparation and publication.
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
	"strings"
	"time"

	"videocutlist/internal/contextio"
	jobs "videocutlist/internal/jobs"
	jobqueue "videocutlist/internal/jobs/model"
)

type BatchArchiveService struct {
	Jobs      *jobs.JobsStore
	Service   Service
	Downloads ExportDownloadService
}

const (
	maxBatchArchiveOutputs = MaxExportOutputs
	maxBatchArchiveBytes   = int64(4 << 30)
)

type batchArchiveOutput struct {
	jobID    string
	name     string
	position int
}

// DownloadBatch prepares a verified ZIP from completed browser-download outputs.
// A shared filesystem lock serializes archive publication across processes while
// cancellation removes unpublished temporary files.
func (e BatchArchiveService) DownloadBatch(ctx context.Context, batchID string) (io.ReadCloser, string, error) {
	if e.Service.Artifacts == nil || e.Jobs == nil || e.Downloads == nil {
		return nil, "", jobqueue.ErrJobNotFound
	}
	if file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC()); err == nil {
		return file, artifact.Name, nil
	}
	jobs, err := e.Jobs.ListByBatch(ctx, batchID)
	if err != nil {
		return nil, "", err
	}
	outputs := make([]batchArchiveOutput, 0)
	var expires time.Time
	archiveRoot := ""
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		if job.Kind != jobqueue.JobExport || job.State != jobqueue.JobSucceeded || !job.ResultJSON.Valid {
			return nil, "", jobqueue.ErrJobNotFound
		}
		var result Result
		if json.Unmarshal([]byte(job.ResultJSON.String), &result) != nil || result.DestinationKind != KindDownload || result.RetainUntil.IsZero() {
			return nil, "", jobqueue.ErrJobNotFound
		}
		destination, ok := e.Service.destinationForResult(result)
		if !ok {
			return nil, "", jobqueue.ErrJobNotFound
		}
		if archiveRoot == "" {
			archiveRoot = destination.Root
		}
		names, ok := resultOutputNames(result)
		if !ok || len(names) == 0 || len(outputs)+len(names) > maxBatchArchiveOutputs {
			return nil, "", ErrOutputUnavailable
		}
		if expires.IsZero() || result.RetainUntil.Before(expires) {
			expires = result.RetainUntil
		}
		for position, name := range names {
			outputs = append(outputs, batchArchiveOutput{jobID: job.ID, name: name, position: position})
		}
	}
	if len(outputs) == 0 || archiveRoot == "" || !expires.After(time.Now().UTC()) {
		return nil, "", ErrOutputUnavailable
	}
	return e.downloadBatchWithLock(ctx, batchID, archiveRoot, outputs, expires)
}

func (e BatchArchiveService) downloadBatchWithLock(ctx context.Context, batchID, archiveRoot string, outputs []batchArchiveOutput, expires time.Time) (io.ReadCloser, string, error) {
	// One lock inode per output directory avoids leaving a lock file for every
	// batch. It must remain in place so waiting processes lock the same inode.
	unlock, err := acquireBatchArchiveLock(ctx, filepath.Join(archiveRoot, ".videocutlist-batches.lock"))
	if err != nil {
		return nil, "", err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	if file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC()); err == nil {
		return file, artifact.Name, nil
	}
	if file, name, found, err := e.openPublishedBatchArchive(ctx, batchID, archiveRoot, len(outputs)); found || err != nil {
		return file, name, err
	}
	return e.prepareBatchArchive(ctx, batchID, archiveRoot, outputs, expires)
}

// A second process has its own in-memory artifact store. Reuse the durable,
// owner-verified manifest instead of publishing a second archive for that batch.
func (e BatchArchiveService) openPublishedBatchArchive(ctx context.Context, batchID, archiveRoot string, count int) (io.ReadCloser, string, bool, error) {
	manifestPath := filepath.Join(archiveRoot, ".videocutlist-export-"+batchID+".json")
	data, err := os.ReadFile(manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", false, nil
	}
	if err != nil {
		return nil, "", true, ErrOutputUnavailable
	}
	var manifest struct {
		JobID        string   `json:"jobId"`
		Kind         string   `json:"kind"`
		Container    string   `json:"container"`
		Expires      string   `json:"expires"`
		OutputNames  []string `json:"outputNames"`
		OutputOwners []struct {
			Name   string `json:"name"`
			Device uint64 `json:"device"`
			Inode  uint64 `json:"inode"`
		} `json:"outputOwners"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.JobID != batchID || manifest.Kind != KindDownload ||
		manifest.Container != "zip" || len(manifest.OutputNames) != 1 || len(manifest.OutputOwners) != 1 {
		return nil, "", true, ErrOutputUnavailable
	}
	name, owner := manifest.OutputNames[0], manifest.OutputOwners[0]
	expiry, err := time.Parse(time.RFC3339Nano, manifest.Expires)
	if err != nil || !expiry.After(time.Now().UTC()) || owner.Name != name || owner.Device == 0 || owner.Inode == 0 ||
		!safeArtifactName(name) || !strings.HasPrefix(name, "videocutlist-clips-"+batchID) || filepath.Ext(name) != ".zip" {
		return nil, "", true, ErrOutputUnavailable
	}
	path := filepath.Join(archiveRoot, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, "", true, ErrOutputUnavailable
	}
	device, inode, ok := batchArchiveFileIdentity(info)
	if !ok || device != owner.Device || inode != owner.Inode {
		return nil, "", true, ErrOutputUnavailable
	}
	if err := validateBatchArchive(ctx, path, count, -1); err != nil {
		return nil, "", true, err
	}
	e.Service.Artifacts.Put(batchID, []Artifact{{Path: path, Name: name, Kind: KindDownload, Expires: expiry}})
	file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC())
	if err != nil {
		return nil, "", true, err
	}
	stat, err := file.(interface{ Stat() (os.FileInfo, error) }).Stat()
	if err != nil {
		_ = file.Close()
		return nil, "", true, ErrOutputUnavailable
	}
	device, inode, ok = batchArchiveFileIdentity(stat)
	if !ok || device != owner.Device || inode != owner.Inode {
		_ = file.Close()
		return nil, "", true, ErrOutputUnavailable
	}
	e.Service.Artifacts.RegisterManifest(batchID, manifestPath)
	return file, artifact.Name, true, nil
}

func (e BatchArchiveService) prepareBatchArchive(ctx context.Context, batchID, archiveRoot string, outputs []batchArchiveOutput, expires time.Time) (reader io.ReadCloser, name string, err error) {
	temporary, err := os.CreateTemp(archiveRoot, ".videocutlist-batch-*.zip")
	if err != nil {
		return nil, "", ErrOutputUnavailable
	}
	temporaryPath := temporary.Name()
	published := false
	defer func() {
		// Atomic rename removes the temporary name after publication.
		if published {
			return
		}
		if removeErr := os.Remove(temporaryPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, fmt.Errorf("remove temporary batch archive: %w", removeErr))
		}
	}()
	archiveWriter := zip.NewWriter(temporary)
	cleanup := func(primary error) error {
		if closeErr := archiveWriter.Close(); closeErr != nil {
			primary = errors.Join(primary, fmt.Errorf("close batch archive: %w", closeErr))
		}
		if closeErr := temporary.Close(); closeErr != nil {
			primary = errors.Join(primary, fmt.Errorf("close temporary batch archive: %w", closeErr))
		}
		return primary
	}
	usedNames := make(map[string]int, len(outputs))
	var total int64
	for _, output := range outputs {
		if err := ctx.Err(); err != nil {
			return nil, "", cleanup(err)
		}
		file, name, err := e.Downloads.Download(ctx, output.jobID, output.position)
		if err != nil {
			return nil, "", cleanup(ErrOutputUnavailable)
		}
		info, statOK := file.(interface{ Stat() (os.FileInfo, error) })
		closeOutput := func(primary error) error {
			if closeErr := file.Close(); closeErr != nil {
				return errors.Join(primary, closeErr)
			}
			return primary
		}
		if !statOK {
			return nil, "", cleanup(closeOutput(ErrOutputUnavailable))
		}
		fileInfo, statErr := info.Stat()
		if statErr != nil || fileInfo.Size() < 0 || fileInfo.Size() > maxBatchArchiveBytes-total {
			return nil, "", cleanup(closeOutput(ErrOutputUnavailable))
		}
		entryName := uniqueBatchArchiveName(name, usedNames)
		header := &zip.FileHeader{Name: entryName, Method: zip.Store, UncompressedSize64: uint64(fileInfo.Size())}
		entry, err := archiveWriter.CreateHeader(header)
		if err == nil {
			var copied int64
			copied, err = io.Copy(entry, contextio.NewReader(ctx, file))
			if err == nil && copied != fileInfo.Size() {
				err = ErrOutputUnavailable
			}
			total += copied
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		} else if closeErr != nil {
			err = errors.Join(err, closeErr)
		}
		if err != nil {
			return nil, "", cleanup(err)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, "", cleanup(err)
	}
	if closeErr := archiveWriter.Close(); closeErr != nil {
		closeErr = errors.Join(closeErr, temporary.Close())
		return nil, "", errors.Join(ErrOutputUnavailable, closeErr)
	}
	if syncErr := temporary.Sync(); syncErr != nil {
		return nil, "", errors.Join(ErrOutputUnavailable, syncErr, temporary.Close())
	}
	if closeErr := temporary.Close(); closeErr != nil {
		return nil, "", errors.Join(ErrOutputUnavailable, closeErr)
	}
	if err := validateBatchArchive(ctx, temporaryPath, len(outputs), total); err != nil {
		return nil, "", err
	}
	name, path, err := publishBatchArchiveWithManifest(temporaryPath, archiveRoot, batchID, func(candidate, _ string) (func(), error) {
		manifest, err := WriteManifestWithOwners(archiveRoot, batchID, KindDownload, []string{candidate}, []string{temporaryPath}, expires, "zip")
		if err != nil {
			return nil, ErrOutputUnavailable
		}
		e.Service.Artifacts.RegisterManifest(batchID, manifest)
		return func() { e.Service.Artifacts.ClearManifest(batchID) }, nil
	})
	if err != nil {
		return nil, "", err
	}
	published = true
	e.Service.Artifacts.Put(batchID, []Artifact{{Path: path, Name: name, Kind: KindDownload, Expires: expires}})
	file, artifact, err := e.Service.Artifacts.Open(batchID, 0, time.Now().UTC())
	if err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, fmt.Errorf("remove unpublished batch archive: %w", removeErr))
		} else {
			e.Service.Artifacts.ClearManifest(batchID)
		}
		return nil, "", err
	}
	return file, artifact.Name, nil
}

func validateBatchArchive(ctx context.Context, path string, count int, expectedBytes int64) (err error) {
	file, err := os.Open(path)
	if err != nil {
		return ErrOutputUnavailable
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close batch archive: %w", closeErr))
		}
	}()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxBatchArchiveBytes {
		return ErrOutputUnavailable
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil || len(archive.File) != count {
		return ErrOutputUnavailable
	}
	var total int64
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !safeArtifactName(entry.Name) || entry.FileInfo().IsDir() || entry.FileInfo().Mode()&os.ModeSymlink != 0 || entry.UncompressedSize64 > uint64(maxBatchArchiveBytes-total) {
			return ErrOutputUnavailable
		}
		reader, err := entry.Open()
		if err != nil {
			return ErrOutputUnavailable
		}
		limit := int64(entry.UncompressedSize64) + 1
		copied, copyErr := io.Copy(io.Discard, io.LimitReader(contextio.NewReader(ctx, reader), limit))
		closeErr := reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil || copied != int64(entry.UncompressedSize64) {
			return ErrOutputUnavailable
		}
		total += copied
	}
	if expectedBytes >= 0 && total != expectedBytes {
		return ErrOutputUnavailable
	}
	return nil
}

func publishBatchArchiveWithManifest(temporaryPath, archiveRoot, batchID string, beforePublish func(name, path string) (func(), error)) (string, string, error) {
	root, err := os.OpenRoot(archiveRoot)
	if err != nil {
		return "", "", ErrOutputUnavailable
	}
	defer func() { _ = root.Close() }()
	directory, err := root.Open(".")
	if err != nil {
		return "", "", ErrOutputUnavailable
	}
	defer func() { _ = directory.Close() }()
	token := "batch"
	if validBatchArchiveToken(batchID) {
		token = batchID
	}
	for attempt := range 100 {
		name := "videocutlist-clips-" + token + ".zip"
		if attempt > 0 {
			name = fmt.Sprintf("videocutlist-clips-%s-%d.zip", token, attempt)
		}
		path := filepath.Join(archiveRoot, name)
		if _, err := root.Lstat(name); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", ErrOutputUnavailable
		}
		var cleanup func()
		if beforePublish != nil {
			var err error
			cleanup, err = beforePublish(name, path)
			if err != nil {
				return "", "", err
			}
		}
		if err := PublishOpenedNoReplace(directory, directory, filepath.Base(temporaryPath), name); err == nil {
			return name, path, nil
		} else if !errors.Is(err, os.ErrExist) {
			if cleanup != nil {
				cleanup()
			}
			return "", "", ErrOutputUnavailable
		}
		if cleanup != nil {
			cleanup()
		}
	}
	return "", "", ErrOutputUnavailable
}

func uniqueBatchArchiveName(name string, used map[string]int) string {
	count := used[name]
	used[name] = count + 1
	if count == 0 {
		return name
	}
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	for suffix := count + 1; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d%s", stem, suffix, extension)
		if used[candidate] == 0 {
			used[candidate] = 1
			return candidate
		}
	}
}

func validBatchArchiveToken(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}
