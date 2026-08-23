package roomsdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// FileStore keeps startup-loaded definitions in memory and persists canonical
// snapshot records as atomic, versioned JSON files. It is the reference
// service's durable Store; production integrations may replace it with a DB.
type FileStore struct {
	*MemoryStore
	root string
	mu   sync.Mutex
}

func NewFileStore(root string) (*FileStore, error) {
	if root == "" {
		return nil, errors.New("roomsdk: file store root is empty")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "snapshots"), 0o700); err != nil {
		return nil, err
	}
	return &FileStore{MemoryStore: NewMemoryStore(), root: root}, nil
}

func (s *FileStore) LoadSnapshot(ctx context.Context, canvasID string) (SnapshotRecord, error) {
	if err := ctx.Err(); err != nil {
		return SnapshotRecord{}, err
	}
	if record, err := s.MemoryStore.LoadSnapshot(ctx, canvasID); err == nil {
		return record, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if record, err := s.MemoryStore.LoadSnapshot(ctx, canvasID); err == nil {
		return record, nil
	}
	record, err := s.loadNewest(canvasID)
	if err != nil {
		return SnapshotRecord{}, err
	}
	if err := s.MemoryStore.SaveSnapshot(ctx, record); err != nil {
		return SnapshotRecord{}, err
	}
	return record, nil
}

func (s *FileStore) SaveSnapshot(ctx context.Context, snapshot SnapshotRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	current, err := s.MemoryStore.LoadSnapshot(ctx, snapshot.CanvasID)
	if err != nil {
		current, err = s.loadNewest(snapshot.CanvasID)
	}
	if err == nil && snapshotOlder(snapshot, current) {
		return nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}

	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	dir := s.snapshotDir(snapshot.CanvasID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	target := filepath.Join(dir, snapshotFilename(snapshot))
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		temporary, err := os.CreateTemp(dir, ".snapshot-*.tmp")
		if err != nil {
			return err
		}
		temporaryName := temporary.Name()
		defer os.Remove(temporaryName)
		if err := temporary.Chmod(0o600); err != nil {
			_ = temporary.Close()
			return err
		}
		if _, err := temporary.Write(raw); err != nil {
			_ = temporary.Close()
			return err
		}
		if err := temporary.Sync(); err != nil {
			_ = temporary.Close()
			return err
		}
		if err := temporary.Close(); err != nil {
			return err
		}
		if err := os.Rename(temporaryName, target); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}

	if err := s.MemoryStore.SaveSnapshot(ctx, snapshot); err != nil {
		return err
	}
	return pruneSnapshots(dir, 2)
}

func (s *FileStore) loadNewest(canvasID string) (SnapshotRecord, error) {
	entries, err := os.ReadDir(s.snapshotDir(canvasID))
	if errors.Is(err, os.ErrNotExist) {
		return SnapshotRecord{}, ErrNotFound
	}
	if err != nil {
		return SnapshotRecord{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(s.snapshotDir(canvasID), entry.Name()))
		if readErr != nil {
			continue
		}
		var record SnapshotRecord
		if json.Unmarshal(raw, &record) == nil && record.CanvasID == canvasID {
			return record, nil
		}
	}
	return SnapshotRecord{}, ErrNotFound
}

func (s *FileStore) snapshotDir(canvasID string) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(canvasID))
	return filepath.Join(s.root, "snapshots", encoded)
}

func snapshotFilename(snapshot SnapshotRecord) string {
	return fmt.Sprintf(
		"%020d-%020d-%020d.json",
		snapshot.CheckpointRevision,
		snapshot.SceneRevision,
		snapshot.HostEpoch,
	)
}

func snapshotOlder(candidate, current SnapshotRecord) bool {
	if candidate.CheckpointRevision != current.CheckpointRevision {
		return candidate.CheckpointRevision < current.CheckpointRevision
	}
	if candidate.SceneRevision != current.SceneRevision {
		return candidate.SceneRevision < current.SceneRevision
	}
	return candidate.HostEpoch < current.HostEpoch
}

func pruneSnapshots(dir string, keep int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	if len(names) <= keep {
		return nil
	}
	for _, name := range names[keep:] {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
