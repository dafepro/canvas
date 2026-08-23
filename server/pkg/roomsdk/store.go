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

type ItemComplexity string

const (
	ItemComplexitySimple  ItemComplexity = "simple"
	ItemComplexityComplex ItemComplexity = "complex"
)

// ItemDefinitionRecord is the server-authoritative metadata needed to validate
// a durable item mutation. DefinitionRaw can be served or inspected by a host
// application without making the room execute behavior code.
type ItemDefinitionRecord struct {
	DefinitionID  string          `json:"definitionId"`
	Version       uint32          `json:"version"`
	Complexity    ItemComplexity  `json:"complexity"`
	ConfigSchema  json.RawMessage `json:"configSchema"`
	DefinitionRaw json.RawMessage `json:"definition,omitempty"`
}

// SnapshotRecord is one canonical checkpoint (spec 13.1).
type SnapshotRecord struct {
	RoomID             string          `json:"roomId"`
	CanvasID           string          `json:"canvasId"`
	CanvasVersion      uint32          `json:"canvasVersion"`
	SceneRevision      uint64          `json:"sceneRevision"`
	CheckpointRevision uint64          `json:"checkpointRevision"`
	HostEpoch          uint64          `json:"hostEpoch"`
	Tick               uint64          `json:"tick"`
	Normalized         bool            `json:"normalized"`
	CapturedAt         time.Time       `json:"capturedAt"`
	SnapshotRaw        json.RawMessage `json:"snapshot"`
}

// Store is the persistence port. Replace MemoryStore with a database-backed
// implementation without touching the realtime code. Missing records return
// ErrNotFound and no partial record. Snapshot saves are isolated by RoomID and
// an older CheckpointRevision must never replace a newer one.
type Store interface {
	LoadCanvas(ctx context.Context, canvasID string) (CanvasRecord, error)
	LoadItemDefinition(ctx context.Context, definitionID string) (ItemDefinitionRecord, error)
	LoadSnapshot(ctx context.Context, roomID string) (SnapshotRecord, error)
	SaveSnapshot(ctx context.Context, snapshot SnapshotRecord) error
}

// MemoryStore keeps every canvas and snapshot in process memory. It is the
// default for local runs and tests.
type MemoryStore struct {
	mu          sync.RWMutex
	canvases    map[string]CanvasRecord
	definitions map[string]ItemDefinitionRecord
	snapshots   map[string]SnapshotRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		canvases:    make(map[string]CanvasRecord),
		definitions: make(map[string]ItemDefinitionRecord),
		snapshots:   make(map[string]SnapshotRecord),
	}
}

// PutItemDefinition registers authoritative item metadata. Call it at start-up
// before a room accepts mutations that reference the definition.
func (s *MemoryStore) PutItemDefinition(record ItemDefinitionRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.definitions[record.DefinitionID] = record
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

func (s *MemoryStore) LoadItemDefinition(
	_ context.Context,
	definitionID string,
) (ItemDefinitionRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.definitions[definitionID]
	if !ok {
		return ItemDefinitionRecord{}, ErrNotFound
	}
	return record, nil
}

func (s *MemoryStore) LoadSnapshot(_ context.Context, roomID string) (SnapshotRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.snapshots[roomID]
	if !ok {
		return SnapshotRecord{}, ErrNotFound
	}
	return record, nil
}

// SaveSnapshot ignores a checkpoint older than the stored one.
func (s *MemoryStore) SaveSnapshot(_ context.Context, snapshot SnapshotRecord) error {
	if snapshot.RoomID == "" || snapshot.CanvasID == "" || snapshot.CanvasVersion == 0 {
		return errors.New("roomsdk: snapshot room and canvas binding is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.snapshots[snapshot.RoomID]
	if ok && snapshot.CheckpointRevision < current.CheckpointRevision {
		return nil
	}
	s.snapshots[snapshot.RoomID] = snapshot
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
