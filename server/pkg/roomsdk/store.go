package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrNotFound is returned by a Store when a canvas or snapshot is absent.
var ErrNotFound = errors.New("roomsdk: not found")

// CanvasRecord is the durable definition of one canvas. The definition stays
// JSON because it is editable data (spec 12.3).
type CanvasRecord struct {
	CanvasID      string          `json:"canvasId"`
	Version       uint32          `json:"version"`
	DefinitionRaw json.RawMessage `json:"definition"`
}

// SnapshotRecord is one canonical checkpoint (spec 13.1).
type SnapshotRecord struct {
	CanvasID           string          `json:"canvasId"`
	SceneRevision      uint64          `json:"sceneRevision"`
	CheckpointRevision uint64          `json:"checkpointRevision"`
	HostEpoch          uint64          `json:"hostEpoch"`
	Tick               uint64          `json:"tick"`
	Normalized         bool            `json:"normalized"`
	CapturedAt         time.Time       `json:"capturedAt"`
	SnapshotRaw        json.RawMessage `json:"snapshot"`
}

// Store is the persistence port. Replace MemoryStore with a database-backed
// implementation without touching the realtime code.
type Store interface {
	LoadCanvas(ctx context.Context, canvasID string) (CanvasRecord, error)
	LoadSnapshot(ctx context.Context, canvasID string) (SnapshotRecord, error)
	SaveSnapshot(ctx context.Context, snapshot SnapshotRecord) error
}

// MemoryStore keeps every canvas and snapshot in process memory. It is the
// default for local runs and tests.
type MemoryStore struct {
	mu        sync.RWMutex
	canvases  map[string]CanvasRecord
	snapshots map[string]SnapshotRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		canvases:  make(map[string]CanvasRecord),
		snapshots: make(map[string]SnapshotRecord),
	}
}

// PutCanvas registers a canvas definition. Call it at start-up.
func (s *MemoryStore) PutCanvas(record CanvasRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.canvases[record.CanvasID] = record
}

func (s *MemoryStore) LoadCanvas(_ context.Context, canvasID string) (CanvasRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.canvases[canvasID]
	if !ok {
		return CanvasRecord{}, ErrNotFound
	}
	return record, nil
}

func (s *MemoryStore) LoadSnapshot(_ context.Context, canvasID string) (SnapshotRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.snapshots[canvasID]
	if !ok {
		return SnapshotRecord{}, ErrNotFound
	}
	return record, nil
}

// SaveSnapshot ignores a checkpoint older than the stored one.
func (s *MemoryStore) SaveSnapshot(_ context.Context, snapshot SnapshotRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.snapshots[snapshot.CanvasID]
	if ok && snapshot.CheckpointRevision < current.CheckpointRevision {
		return nil
	}
	s.snapshots[snapshot.CanvasID] = snapshot
	return nil
}

// CanvasIDs lists every registered canvas in no particular order.
func (s *MemoryStore) CanvasIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.canvases))
	for id := range s.canvases {
		ids = append(ids, id)
	}
	return ids
}
