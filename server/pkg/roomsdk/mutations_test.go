package roomsdk

import (
	"testing"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func TestSpawnAllocatesANewIDAfterPersistedShortIDs(t *testing.T) {
	existing := SnapshotItem{EntityID: "i1", OwnerUserID: "mason"}
	room := &Room{
		snapshot: CanvasSnapshot{Items: []SnapshotItem{existing}},
		items:    map[string]*SnapshotItem{},
	}
	room.indexItems()
	command := &pb.DurableCommand{
		Kind:              pb.DurableCommandKind_DURABLE_SPAWN_ITEM,
		DefinitionId:      "stamp",
		DefinitionVersion: 1,
		Position:          &pb.Vec2{X: 20, Y: 30},
		Scale:             1,
	}

	room.applyDurable(command, nil, &Client{UserID: "ava"})

	if command.EntityId == "i1" {
		t.Fatal("spawn reused Mason's persisted item id")
	}
	if len(room.snapshot.Items) != 2 || room.snapshot.Items[0].OwnerUserID != "mason" {
		t.Fatalf("items = %+v, want Mason's item plus Ava's item", room.snapshot.Items)
	}
	if len(room.items) != 2 {
		t.Fatalf("indexed item count = %d, want 2", len(room.items))
	}
}
