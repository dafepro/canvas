package roomsdk

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func mutationEnvelope(mutation *pb.ItemMutation) *pb.RoomEnvelope {
	return &pb.RoomEnvelope{
		RoomId:  "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: mutation},
	}
}

func spawnMutation(clientSessionID string, mutationID uint64, x, y float32) *pb.RoomEnvelope {
	return mutationEnvelope(&pb.ItemMutation{
		ClientSessionId:   clientSessionID,
		MutationId:        mutationID,
		Kind:              pb.ItemMutationKind_ITEM_MUTATION_SPAWN,
		DefinitionId:      "rocket",
		DefinitionVersion: 1,
		Position:          &pb.Vec2{X: x, Y: y},
		Scale:             1,
		ConfigJson:        []byte(`{"thrust":24}`),
	})
}

func awaitMutationResult(client *testClient, mutationID uint64) *pb.ItemMutationResult {
	client.t.Helper()
	return client.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemMutationResult()
		return result != nil && result.MutationId == mutationID
	}).GetItemMutationResult()
}

func TestItemMutationIsAcknowledgedAndIdempotent(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })

	owner.send(spawnMutation("browser-a", 1, 20, 30))
	first := awaitMutationResult(owner, 1)
	if !first.Accepted {
		t.Fatalf("spawn rejected: code=%v message=%q", first.RejectCode, first.Message)
	}
	if first.ItemRevision != 1 || first.SceneRevision == 0 || first.EntityId == "" {
		t.Fatalf("spawn result = %#v", first)
	}
	var spawned SnapshotItem
	if err := json.Unmarshal(first.ItemInstanceJson, &spawned); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if spawned.ItemRevision != 1 || spawned.EntityID != first.EntityId {
		t.Fatalf("spawned item = %#v", spawned)
	}

	// A reconnect retry gets the exact authoritative receipt and cannot spawn a
	// second item or increment the room revision.
	owner.send(spawnMutation("browser-a", 1, 20, 30))
	duplicate := awaitMutationResult(owner, 1)
	if duplicate.EntityId != first.EntityId || duplicate.SceneRevision != first.SceneRevision {
		t.Fatalf("duplicate = %#v, first = %#v", duplicate, first)
	}

	room := h.server.rooms["test-canvas"]
	if room == nil || len(room.snapshot.Items) != 1 {
		t.Fatalf("room items = %d, want 1", len(room.snapshot.Items))
	}
}

func TestItemMutationReceiptSurvivesRoomSleep(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(spawnMutation("browser-a", 1, 20, 30))
	first := awaitMutationResult(owner, 1)
	if !first.Accepted {
		t.Fatalf("spawn rejected: %#v", first)
	}
	if err := owner.conn.Close(websocket.StatusNormalClosure, "sleep"); err != nil {
		t.Fatalf("close owner: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.server.mu.Lock()
		_, awake := h.server.rooms["test-canvas"]
		h.server.mu.Unlock()
		if !awake {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.server.mu.Lock()
	_, stillAwake := h.server.rooms["test-canvas"]
	h.server.mu.Unlock()
	if stillAwake {
		t.Fatal("room did not sleep")
	}

	reconnected := h.dial("alice")
	reconnected.join()
	reconnected.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	reconnected.send(spawnMutation("browser-a", 1, 20, 30))
	duplicate := awaitMutationResult(reconnected, 1)
	if duplicate.EntityId != first.EntityId || duplicate.SceneRevision != first.SceneRevision {
		t.Fatalf("reloaded duplicate = %#v, first = %#v", duplicate, first)
	}
}

func TestItemMutationRejectsStaleSameItemRevision(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })

	owner.send(spawnMutation("browser-a", 1, 20, 30))
	spawned := awaitMutationResult(owner, 1)

	owner.send(mutationEnvelope(&pb.ItemMutation{
		ClientSessionId:      "browser-a",
		MutationId:           2,
		ExpectedItemRevision: 1,
		Kind:                 pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
		EntityId:             spawned.EntityId,
		Position:             &pb.Vec2{X: 40, Y: 45},
		Rotation:             0.5,
		Scale:                1,
	}))
	moved := awaitMutationResult(owner, 2)
	if !moved.Accepted || moved.ItemRevision != 2 {
		t.Fatalf("move result = %#v", moved)
	}

	owner.send(mutationEnvelope(&pb.ItemMutation{
		ClientSessionId:      "browser-a",
		MutationId:           3,
		ExpectedItemRevision: 1,
		Kind:                 pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
		EntityId:             spawned.EntityId,
		ConfigJson:           []byte(`{"thrust":30}`),
	}))
	stale := awaitMutationResult(owner, 3)
	if stale.Accepted ||
		stale.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_STALE_ITEM_REVISION ||
		stale.ItemRevision != 2 || len(stale.ItemInstanceJson) == 0 {
		t.Fatalf("stale result = %#v", stale)
	}
}

func TestItemEditSessionSequencesPreviewAndArbitratesOneEditor(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(spawnMutation("browser-a", 1, 20, 30))
	spawned := awaitMutationResult(owner, 1)

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
			ClientSessionId:      "browser-a",
			EditSessionId:        "edit-a",
			EntityId:             spawned.EntityId,
			ObservedItemRevision: 1,
		}},
	})
	active := owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "edit-a"
	}).GetItemEditSessionResult()
	if active.Status != pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE ||
		active.LeaseExpiresAtUnixMs == 0 {
		t.Fatalf("active edit result = %#v", active)
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
			ClientSessionId:      "browser-a",
			EditSessionId:        "edit-b",
			EntityId:             spawned.EntityId,
			ObservedItemRevision: 1,
		}},
	})
	inUse := owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "edit-b"
	}).GetItemEditSessionResult()
	if inUse.Status != pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED ||
		inUse.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_IN_USE {
		t.Fatalf("second edit result = %#v", inUse)
	}

	preview := func(sequence uint64, x float32) *pb.RoomEnvelope {
		return &pb.RoomEnvelope{
			RoomId: "test-canvas",
			Payload: &pb.RoomEnvelope_ItemEditPreview{ItemEditPreview: &pb.ItemEditPreview{
				ClientSessionId: "browser-a",
				EditSessionId:   "edit-a",
				EntityId:        spawned.EntityId,
				PreviewSequence: sequence,
				Position:        &pb.Vec2{X: x, Y: 30},
				Scale:           1,
			}},
		}
	}
	owner.send(preview(2, 35))
	relayed := owner.await(func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetItemEditPreview() != nil
	}).GetItemEditPreview()
	if relayed.PreviewSequence != 2 || relayed.Position.GetX() != 35 {
		t.Fatalf("relayed preview = %#v", relayed)
	}

	// Sequence 1 is stale. Ending the edit supplies a deterministic message
	// after it; seeing sequence 1 before that would prove it was relayed.
	owner.send(preview(1, 5))
	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_EndItemEdit{EndItemEdit: &pb.EndItemEdit{
			ClientSessionId: "browser-a",
			EditSessionId:   "edit-a",
			EntityId:        spawned.EntityId,
			Cancel:          true,
		}},
	})
	ended := owner.await(func(envelope *pb.RoomEnvelope) bool {
		if candidate := envelope.GetItemEditPreview(); candidate != nil &&
			!candidate.Revert && candidate.PreviewSequence == 1 {
			t.Fatal("relay accepted an out-of-order preview")
		}
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "edit-a" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ENDED
	}).GetItemEditSessionResult()
	if ended.ItemRevision != 1 {
		t.Fatalf("ended edit result = %#v", ended)
	}
}

func TestActiveItemPreviewReplaysAfterHostMigration(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(envelope *pb.RoomEnvelope) bool {
		control := envelope.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	})

	owner := h.dial("bob")
	owner.join()
	owner.heartbeat()
	owner.send(spawnMutation("browser-b", 1, 20, 30))
	spawned := awaitMutationResult(owner, 1)
	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
			ClientSessionId:      "browser-b",
			EditSessionId:        "edit-b",
			EntityId:             spawned.EntityId,
			ObservedItemRevision: spawned.ItemRevision,
		}},
	})
	owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "edit-b" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE
	})
	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemEditPreview{ItemEditPreview: &pb.ItemEditPreview{
			ClientSessionId: "browser-b",
			EditSessionId:   "edit-b",
			EntityId:        spawned.EntityId,
			PreviewSequence: 7,
			Position:        &pb.Vec2{X: 44, Y: 31},
			Scale:           1,
		}},
	})
	host.await(func(envelope *pb.RoomEnvelope) bool {
		preview := envelope.GetItemEditPreview()
		return preview != nil && preview.EditSessionId == "edit-b" &&
			preview.PreviewSequence == 7
	})

	_ = host.conn.CloseNow()
	owner.await(func(envelope *pb.RoomEnvelope) bool {
		control := envelope.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	})
	replayed := owner.await(func(envelope *pb.RoomEnvelope) bool {
		preview := envelope.GetItemEditPreview()
		return preview != nil && preview.EditSessionId == "edit-b"
	}).GetItemEditPreview()
	if replayed.PreviewSequence != 7 || replayed.Position.GetX() != 44 || replayed.Revert {
		t.Fatalf("replayed preview = %#v", replayed)
	}
}

func TestExpiredItemEditLeaseRevertsAndReleasesTheItem(t *testing.T) {
	var nowMillis atomic.Int64
	nowMillis.Store(time.Now().UnixMilli())
	h := newHarness(t, func(cfg *Config) {
		cfg.Now = func() time.Time { return time.UnixMilli(nowMillis.Load()) }
		cfg.ItemEditLeaseTTL = 100 * time.Millisecond
		cfg.HeartbeatInterval = 10 * time.Millisecond
		cfg.HostLeaseTTL = time.Hour
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetHostControl() != nil
	})
	owner.send(spawnMutation("expiry-browser", 1, 20, 30))
	spawned := awaitMutationResult(owner, 1)

	begin := func(editSessionID string) {
		owner.send(&pb.RoomEnvelope{
			RoomId: "test-canvas",
			Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
				ClientSessionId:      "expiry-browser",
				EditSessionId:        editSessionID,
				EntityId:             spawned.EntityId,
				ObservedItemRevision: spawned.ItemRevision,
			}},
		})
	}
	begin("expiring-edit")
	owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "expiring-edit" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE
	})

	nowMillis.Add(101)
	expired := owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "expiring-edit" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED
	}).GetItemEditSessionResult()
	if expired.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED {
		t.Fatalf("expired result = %#v", expired)
	}

	begin("replacement-edit")
	replacement := owner.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "replacement-edit"
	}).GetItemEditSessionResult()
	if replacement.Status != pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE {
		t.Fatalf("replacement edit result = %#v", replacement)
	}
}
