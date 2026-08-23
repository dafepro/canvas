package roomsdk

import (
	"context"
	"encoding/json"
	"testing"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

const canvasWithSystemItemJSON = `{
  "id": "test-canvas",
  "version": 1,
  "size": { "width": 100, "height": 70 },
  "orientation": "topDown",
  "edges": { "top": "solid", "right": "solid", "bottom": "solid", "left": "solid" },
  "staticGeometry": [],
  "regions": [],
  "environment": { "base": { "gravityXY": { "x": 0, "y": 0 }, "linearDrag": 0.4 } },
  "spawnPoints": [{ "id": "centre", "position": { "x": 50, "y": 35 } }],
  "limits": { "maxAvatars": 3, "maxItems": 2, "maxComplexPhysicsItems": 1 },
  "systemItems": [{
    "entityId": "match-ball",
    "definitionId": "rocket",
    "definitionVersion": 1,
    "transform": { "x": 50, "y": 35, "rotation": 0 },
    "resolvedConfig": { "thrust": 12 }
  }]
}`

func TestRoomBootstrapsSystemOwnedItems(t *testing.T) {
	h := newHarness(t, nil)
	h.store.PutCanvas(CanvasRecord{
		CanvasID:      "test-canvas",
		Version:       1,
		DefinitionRaw: json.RawMessage(canvasWithSystemItemJSON),
	})

	room, err := h.server.roomFor(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("roomFor: %v", err)
	}
	if room.sceneRevision != 1 {
		t.Fatalf("scene revision = %d, want 1", room.sceneRevision)
	}
	if len(room.snapshot.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(room.snapshot.Items))
	}
	item := room.snapshot.Items[0]
	if item.EntityID != "match-ball" || item.OwnerUserID != "" {
		t.Fatalf("system item = %#v", item)
	}
	var config map[string]float64
	if err := json.Unmarshal(item.ResolvedConfig, &config); err != nil || config["thrust"] != 12 {
		t.Fatalf("resolved config = %s, error = %v", item.ResolvedConfig, err)
	}

	accepted, _, reason := room.validateDurable(&Client{UserID: "alice"}, &pb.DurableCommand{
		Kind:     pb.DurableCommandKind_DURABLE_MOVE_ITEM,
		EntityId: "match-ball",
		Position: &pb.Vec2{X: 40, Y: 35},
	})
	if accepted || reason != "system_owned" {
		t.Fatalf("move accepted = %v, reason = %q", accepted, reason)
	}
}

func TestRoomRejectsInvalidSystemItemConfig(t *testing.T) {
	h := newHarness(t, nil)
	var definition map[string]any
	if err := json.Unmarshal([]byte(canvasWithSystemItemJSON), &definition); err != nil {
		t.Fatal(err)
	}
	items := definition["systemItems"].([]any)
	items[0].(map[string]any)["resolvedConfig"] = map[string]any{"notThrust": true}
	raw, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	h.store.PutCanvas(CanvasRecord{
		CanvasID:      "test-canvas",
		Version:       1,
		DefinitionRaw: raw,
	})

	if _, err := h.server.roomFor(context.Background(), "test-canvas"); err == nil {
		t.Fatal("roomFor accepted an invalid system item config")
	}
}
