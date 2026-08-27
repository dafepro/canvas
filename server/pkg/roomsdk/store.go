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
	RoomID             string                    `json:"roomId"`
	CanvasID           string                    `json:"canvasId"`
	CanvasVersion      uint32                    `json:"canvasVersion"`
	SceneRevision      uint64                    `json:"sceneRevision"`
	CheckpointRevision uint64                    `json:"checkpointRevision"`
	HostEpoch          uint64                    `json:"hostEpoch"`
	Tick               uint64                    `json:"tick"`
	Normalized         bool                      `json:"normalized"`
	CapturedAt         time.Time                 `json:"capturedAt"`
	SnapshotRaw        json.RawMessage           `json:"snapshot"`
	MutationReceipts   []MutationReceiptRecord   `json:"mutationReceipts,omitempty"`
	MutationHighWater  []MutationHighWaterRecord `json:"mutationHighWater,omitempty"`
}

// MutationReceiptRecord is the bounded persisted idempotency window for one
// logical browser session. ResultBytes is a protobuf ItemMutationResult.
type MutationReceiptRecord struct {
	UserID          string `json:"userId"`
	ClientSessionID string `json:"clientSessionId"`
	MutationID      uint64 `json:"mutationId"`
	ResultBytes     []byte `json:"result"`
}

// MutationHighWaterRecord prevents an evicted duplicate from being reapplied.
type MutationHighWaterRecord struct {
	UserID          string `json:"userId"`
	ClientSessionID string `json:"clientSessionId"`
	MutationID      uint64 `json:"mutationId"`
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

// VersionedCatalogStore is an optional Store capability for hosts that retain
// more than one immutable canvas or item-definition version during a rollout.
// The SDK prefers these exact lookups when available and falls back to the
// original Store methods for existing adapters.
type VersionedCatalogStore interface {
	LoadCanvasVersion(
		ctx context.Context,
		canvasID string,
		version uint32,
	) (CanvasRecord, error)
	LoadItemDefinitionVersion(
		ctx context.Context,
		definitionID string,
		version uint32,
	) (ItemDefinitionRecord, error)
}

type catalogVersionKey struct {
	id      string
	version uint32
}

// MemoryStore keeps every canvas and snapshot in process memory. It is the
// default for local runs and tests.
type MemoryStore struct {
	mu                 sync.RWMutex
	canvases           map[string]CanvasRecord
	definitions        map[string]ItemDefinitionRecord
	canvasVersions     map[catalogVersionKey]CanvasRecord
	definitionVersions map[catalogVersionKey]ItemDefinitionRecord
	snapshots          map[string]SnapshotRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		canvases:           make(map[string]CanvasRecord),
		definitions:        make(map[string]ItemDefinitionRecord),
		canvasVersions:     make(map[catalogVersionKey]CanvasRecord),
		definitionVersions: make(map[catalogVersionKey]ItemDefinitionRecord),
		snapshots:          make(map[string]SnapshotRecord),
	}
}

// PutItemDefinition registers authoritative item metadata. Call it at start-up
// before a room accepts mutations that reference the definition.
func (s *MemoryStore) PutItemDefinition(record ItemDefinitionRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.definitions[record.DefinitionID] = record
	s.definitionVersions[catalogVersionKey{id: record.DefinitionID, version: record.Version}] = record
}

// PutCanvas registers a canvas definition. Call it at start-up.
func (s *MemoryStore) PutCanvas(record CanvasRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.canvases[record.CanvasID] = record
	s.canvasVersions[catalogVersionKey{id: record.CanvasID, version: record.Version}] = record
}

// LoadCanvasVersion loads one exact immutable catalog entry.
func (s *MemoryStore) LoadCanvasVersion(
	_ context.Context,
	canvasID string,
	version uint32,
) (CanvasRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.canvasVersions[catalogVersionKey{id: canvasID, version: version}]
	if !ok {
		return CanvasRecord{}, ErrNotFound
	}
	return record, nil
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

// LoadItemDefinitionVersion loads one exact immutable catalog entry.
func (s *MemoryStore) LoadItemDefinitionVersion(
	_ context.Context,
	definitionID string,
	version uint32,
) (ItemDefinitionRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.definitionVersions[catalogVersionKey{id: definitionID, version: version}]
	if !ok {
		return ItemDefinitionRecord{}, ErrNotFound
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

func loadCanvasCatalogVersion(
	ctx context.Context,
	store Store,
	canvasID string,
	version uint32,
) (CanvasRecord, error) {
	if versioned, ok := store.(VersionedCatalogStore); ok {
		return versioned.LoadCanvasVersion(ctx, canvasID, version)
	}
	return store.LoadCanvas(ctx, canvasID)
}

func loadItemDefinitionCatalogVersion(
	ctx context.Context,
	store Store,
	definitionID string,
	version uint32,
) (ItemDefinitionRecord, error) {
	if versioned, ok := store.(VersionedCatalogStore); ok {
		return versioned.LoadItemDefinitionVersion(ctx, definitionID, version)
	}
	return store.LoadItemDefinition(ctx, definitionID)
}
