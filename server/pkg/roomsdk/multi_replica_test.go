package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestTwoServersFenceOwnershipAndContinueFromCanonicalSnapshot(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := NewMemoryStore()
	store.PutCanvas(CanvasRecord{CanvasID: "test-canvas", Version: 1, DefinitionRaw: json.RawMessage(canvasJSON)})
	coordinator := NewMemoryRoomCoordinatorWithClock(func() time.Time { return now })
	newReplica := func(id string) *Server {
		server, err := New(Config{
			Store: store, Auth: DevAuthenticator(),
			RoomTemplates:   StaticRoomTemplates{"room": {CanvasID: "test-canvas", CanvasVersion: 1}},
			RoomCoordinator: coordinator, ReplicaID: id,
			RoomOwnershipTTL: time.Second, RoomOwnershipRenewInterval: 500 * time.Millisecond,
			HeartbeatInterval: time.Hour, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return server
	}
	first := newReplica("replica-a")
	second := newReplica("replica-b")
	firstRoom, err := first.roomFor(t.Context(), "room")
	if err != nil {
		t.Fatal(err)
	}
	firstRoom.sceneRevision = 7
	firstRoom.snapshot.SceneRevision = 7
	firstRoom.snapshotRaw, _ = json.Marshal(firstRoom.snapshot)
	if err := store.SaveSnapshot(t.Context(), firstRoom.snapshotRecord()); err != nil {
		t.Fatal(err)
	}
	if _, err := second.roomFor(t.Context(), "room"); !errors.Is(err, ErrRoomOwnershipHeld) {
		t.Fatalf("second owner before expiry = %v", err)
	}

	now = now.Add(2 * time.Second)
	secondRoom, err := second.roomFor(t.Context(), "room")
	if err != nil {
		t.Fatal(err)
	}
	if secondRoom.sceneRevision != 7 {
		t.Fatalf("failover scene revision = %d, want 7", secondRoom.sceneRevision)
	}
	if secondRoom.ownership.Generation <= firstRoom.ownership.Generation {
		t.Fatalf("failover generation = %d, want > %d",
			secondRoom.ownership.Generation, firstRoom.ownership.Generation)
	}
	stale := firstRoom.snapshotRecord()
	stale.CheckpointRevision = 999
	if err := store.SaveSnapshot(context.Background(), stale); !errors.Is(err, ErrRoomOwnershipFenced) {
		t.Fatalf("stale owner snapshot = %v, want ErrRoomOwnershipFenced", err)
	}

	drainCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := second.Drain(drainCtx); err != nil {
		t.Fatal(err)
	}
	if _, err := second.roomFor(t.Context(), "room"); !errors.Is(err, ErrServerDraining) {
		t.Fatalf("roomFor after drain = %v, want ErrServerDraining", err)
	}
}
