package roomsdk

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestFileStoreReloadsTheNewestSnapshot(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	older := SnapshotRecord{
		RoomID:             "team/with spaces",
		CanvasID:           "canvas/with spaces",
		CanvasVersion:      1,
		SceneRevision:      3,
		CheckpointRevision: 4,
		HostEpoch:          2,
		Tick:               120,
		CapturedAt:         time.Unix(10, 0).UTC(),
		SnapshotRaw:        json.RawMessage(`{"canvasId":"canvas/with spaces","tick":120}`),
	}
	newer := older
	newer.SceneRevision = 4
	newer.CheckpointRevision = 5
	newer.Tick = 180
	newer.SnapshotRaw = json.RawMessage(`{"canvasId":"canvas/with spaces","tick":180}`)

	if err := store.SaveSnapshot(context.Background(), older); err != nil {
		t.Fatalf("save older: %v", err)
	}
	if err := store.SaveSnapshot(context.Background(), newer); err != nil {
		t.Fatalf("save newer: %v", err)
	}

	reopened, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, err := reopened.LoadSnapshot(context.Background(), older.RoomID)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.CheckpointRevision != 5 || got.SceneRevision != 4 || got.Tick != 180 {
		t.Fatalf("loaded revision = checkpoint %d scene %d tick %d", got.CheckpointRevision, got.SceneRevision, got.Tick)
	}
	if string(got.SnapshotRaw) != string(newer.SnapshotRaw) {
		t.Errorf("snapshot = %s, want %s", got.SnapshotRaw, newer.SnapshotRaw)
	}
}

func TestFileStoreIgnoresAnOlderSnapshotAfterReopen(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	newer := SnapshotRecord{
		RoomID: "team", CanvasID: "canvas", CanvasVersion: 1,
		CheckpointRevision: 9, SceneRevision: 2,
	}
	if err := store.SaveSnapshot(context.Background(), newer); err != nil {
		t.Fatalf("save newer: %v", err)
	}

	reopened, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if err := reopened.SaveSnapshot(context.Background(), SnapshotRecord{
		RoomID: "team", CanvasID: "canvas", CanvasVersion: 1,
		CheckpointRevision: 8, SceneRevision: 99,
	}); err != nil {
		t.Fatalf("save stale: %v", err)
	}
	got, err := reopened.LoadSnapshot(context.Background(), "team")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got.CheckpointRevision != 9 || got.SceneRevision != 2 {
		t.Fatalf("stale snapshot replaced newest: %+v", got)
	}
}
