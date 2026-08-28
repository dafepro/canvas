package roomsdk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrNotFound is returned when a requested catalog ID/version pair or room
// snapshot is absent.
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
	RoomID                  string                    `json:"roomId"`
	CanvasID                string                    `json:"canvasId"`
	CanvasVersion           uint32                    `json:"canvasVersion"`
	SceneRevision           uint64                    `json:"sceneRevision"`
	CheckpointRevision      uint64                    `json:"checkpointRevision"`
	HostEpoch               uint64                    `json:"hostEpoch"`
	Tick                    uint64                    `json:"tick"`
	Normalized              bool                      `json:"normalized"`
	CapturedAt              time.Time                 `json:"capturedAt"`
	SnapshotRaw             json.RawMessage           `json:"snapshot"`
	MutationReceipts        []MutationReceiptRecord   `json:"mutationReceipts,omitempty"`
	MutationHighWater       []MutationHighWaterRecord `json:"mutationHighWater,omitempty"`
	MutationOutcomeRevision uint64                    `json:"mutationOutcomeRevision,omitempty"`
	MutationOutcomes        []MutationOutcomeRecord   `json:"mutationOutcomes,omitempty"`
}

// MutationOutcomeRecord is private trusted reconciliation state. It is never
// included in SnapshotRaw or sent on the room protocol.
type MutationOutcomeRecord struct {
	CorrelationID     string    `json:"correlationId"`
	ParticipantID     string    `json:"participantId"`
	ClientSessionID   string    `json:"clientSessionId"`
	MutationID        uint64    `json:"mutationId"`
	Kind              string    `json:"kind"`
	EntityID          string    `json:"entityId,omitempty"`
	DefinitionID      string    `json:"definitionId,omitempty"`
	DefinitionVersion uint32    `json:"definitionVersion,omitempty"`
	Accepted          bool      `json:"accepted"`
	RejectCode        string    `json:"rejectCode,omitempty"`
	SceneRevision     uint64    `json:"sceneRevision"`
	ItemRevision      uint64    `json:"itemRevision"`
	RecordedAt        time.Time `json:"recordedAt"`
	ExpiresAt         time.Time `json:"expiresAt"`
	ResultBytes       []byte    `json:"result"`
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
	LoadCanvas(ctx context.Context, canvasID string, version uint32) (CanvasRecord, error)
	LoadItemDefinition(
		ctx context.Context,
		definitionID string,
		version uint32,
	) (ItemDefinitionRecord, error)
	LoadSnapshot(ctx context.Context, roomID string) (SnapshotRecord, error)
	SaveSnapshot(ctx context.Context, snapshot SnapshotRecord) error
}

type catalogVersionKey struct {
	id      string
	version uint32
}

// MemoryStore keeps every canvas and snapshot in process memory. It is the
// default for local runs and tests.
type MemoryStore struct {
	mu                 sync.RWMutex
	canvasVersions     map[catalogVersionKey]CanvasRecord
	definitionVersions map[catalogVersionKey]ItemDefinitionRecord
	snapshots          map[string]SnapshotRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
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
	s.definitionVersions[catalogVersionKey{id: record.DefinitionID, version: record.Version}] =
		cloneItemDefinitionRecord(record)
}

// PutCanvas registers a canvas definition. Call it at start-up.
func (s *MemoryStore) PutCanvas(record CanvasRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.canvasVersions[catalogVersionKey{id: record.CanvasID, version: record.Version}] =
		cloneCanvasRecord(record)
}

// LoadCanvas loads one exact immutable catalog entry.
func (s *MemoryStore) LoadCanvas(
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
	return cloneCanvasRecord(record), nil
}

// LoadItemDefinition loads one exact immutable catalog entry.
func (s *MemoryStore) LoadItemDefinition(
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
	return cloneItemDefinitionRecord(record), nil
}

func cloneCanvasRecord(record CanvasRecord) CanvasRecord {
	record.DefinitionRaw = bytes.Clone(record.DefinitionRaw)
	return record
}

func cloneItemDefinitionRecord(record ItemDefinitionRecord) ItemDefinitionRecord {
	record.ConfigSchema = bytes.Clone(record.ConfigSchema)
	record.DefinitionRaw = bytes.Clone(record.DefinitionRaw)
	return record
}

func (s *MemoryStore) LoadSnapshot(_ context.Context, roomID string) (SnapshotRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.snapshots[roomID]
	if !ok {
		return SnapshotRecord{}, ErrNotFound
	}
	return cloneSnapshotRecord(record), nil
}

// SaveSnapshot ignores a checkpoint older than the stored one.
func (s *MemoryStore) SaveSnapshot(_ context.Context, snapshot SnapshotRecord) error {
	if snapshot.RoomID == "" || snapshot.CanvasID == "" || snapshot.CanvasVersion == 0 {
		return errors.New("roomsdk: snapshot room and canvas binding is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.snapshots[snapshot.RoomID]
	if ok && snapshotOlder(snapshot, current) {
		return nil
	}
	s.snapshots[snapshot.RoomID] = cloneSnapshotRecord(snapshot)
	return nil
}

func cloneSnapshotRecord(record SnapshotRecord) SnapshotRecord {
	record.SnapshotRaw = bytes.Clone(record.SnapshotRaw)
	record.MutationReceipts = append([]MutationReceiptRecord(nil), record.MutationReceipts...)
	for index := range record.MutationReceipts {
		record.MutationReceipts[index].ResultBytes = bytes.Clone(record.MutationReceipts[index].ResultBytes)
	}
	record.MutationHighWater = append([]MutationHighWaterRecord(nil), record.MutationHighWater...)
	record.MutationOutcomes = append([]MutationOutcomeRecord(nil), record.MutationOutcomes...)
	for index := range record.MutationOutcomes {
		record.MutationOutcomes[index].ResultBytes = bytes.Clone(record.MutationOutcomes[index].ResultBytes)
	}
	return record
}

// CanvasIDs lists every registered canvas in no particular order.
func (s *MemoryStore) CanvasIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	unique := make(map[string]struct{}, len(s.canvasVersions))
	for key := range s.canvasVersions {
		unique[key.id] = struct{}{}
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	return ids
}
