package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
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

func TestReconcileRoomTemplateExplicitlyAddsReplacesAndRetiresSystemItems(t *testing.T) {
	h := newHarness(t, nil)
	h.store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "rocket",
		Version:      2,
		Complexity:   ItemComplexitySimple,
		ConfigSchema: json.RawMessage(`{
			"type":"object",
			"properties":{"thrust":{"type":"number"}},
			"required":["thrust"],
			"additionalProperties":false
		}`),
	})
	var definition map[string]any
	if err := json.Unmarshal([]byte(canvasWithSystemItemJSON), &definition); err != nil {
		t.Fatal(err)
	}
	definition["version"] = float64(2)
	definition["limits"].(map[string]any)["maxItems"] = float64(5)
	definition["systemItems"] = []any{
		map[string]any{
			"entityId": "match-ball", "definitionId": "rocket",
			"definitionVersion": float64(2),
			"transform":         map[string]any{"x": float64(60), "y": float64(35), "rotation": float64(0)},
			"resolvedConfig":    map[string]any{"thrust": float64(24)},
		},
		map[string]any{
			"entityId": "scoreboard", "definitionId": "rocket",
			"definitionVersion": float64(2),
			"transform":         map[string]any{"x": float64(50), "y": float64(5), "rotation": float64(0)},
			"resolvedConfig":    map[string]any{"thrust": float64(0)},
		},
	}
	definitionRaw, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	h.store.PutCanvas(CanvasRecord{
		CanvasID: "test-canvas", Version: 2, DefinitionRaw: definitionRaw,
	})

	snapshot := CanvasSnapshot{
		SchemaVersion: 1, CanvasID: "test-canvas", CanvasVersion: 1,
		SceneRevision: 7, CheckpointRevision: 11, HostEpoch: 3, Tick: 90,
		CapturedAt: "2026-01-01T00:00:00Z", Normalized: true,
		Items: []SnapshotItem{
			{
				EntityID: "match-ball", DefinitionID: "rocket", DefinitionVersion: 1,
				Transform: Transform{X: 40, Y: 35}, ResolvedConfig: json.RawMessage(`{"thrust":12}`),
				BehaviorState: json.RawMessage(`{"old":true}`),
			},
			{
				EntityID: "old-banner", DefinitionID: "rocket", DefinitionVersion: 1,
				Transform: Transform{X: 10, Y: 10}, ResolvedConfig: json.RawMessage(`{"thrust":0}`),
			},
			{
				EntityID: "alice-crate", DefinitionID: "rocket", DefinitionVersion: 1,
				OwnerUserID: "alice", Transform: Transform{X: 20, Y: 20},
				ResolvedConfig: json.RawMessage(`{"thrust":8}`),
			},
		},
	}
	snapshotRaw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveSnapshot(context.Background(), SnapshotRecord{
		RoomID: "test-canvas", CanvasID: "test-canvas", CanvasVersion: 1,
		SceneRevision: 7, CheckpointRevision: 11,
		HostEpoch: 3, Tick: 90, Normalized: true, SnapshotRaw: snapshotRaw,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := h.server.ReconcileRoomTemplate(context.Background(), "test-canvas",
		RoomTemplate{CanvasID: "test-canvas", CanvasVersion: 2}, TemplateReconcileOptions{
			ExpectedCanvasID:         "test-canvas",
			ExpectedCanvasVersion:    1,
			AddMissingSystemItems:    true,
			ReplaceSystemItems:       true,
			RetireMissingSystemItems: true,
		})
	if err != nil {
		t.Fatalf("ReconcileRoomTemplate: %v", err)
	}
	if !result.Changed || result.CanvasVersion != 2 || result.SceneRevision != 8 {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Added) != 1 || result.Added[0] != "scoreboard" ||
		len(result.Replaced) != 1 || result.Replaced[0] != "match-ball" ||
		len(result.Retired) != 1 || result.Retired[0] != "old-banner" {
		t.Fatalf("operations = %#v", result)
	}

	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatal(err)
	}
	var reconciled CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &reconciled); err != nil {
		t.Fatal(err)
	}
	if reconciled.CanvasVersion != 2 || reconciled.CheckpointRevision != 12 || len(reconciled.Items) != 3 {
		t.Fatalf("snapshot = %#v", reconciled)
	}
	items := make(map[string]SnapshotItem)
	for _, item := range reconciled.Items {
		items[item.EntityID] = item
	}
	if items["alice-crate"].OwnerUserID != "alice" {
		t.Fatal("participant-owned item changed")
	}
	if items["match-ball"].DefinitionVersion != 2 || items["match-ball"].Transform.X != 60 ||
		len(items["match-ball"].BehaviorState) != 0 {
		t.Fatalf("replacement = %#v", items["match-ball"])
	}
	if _, ok := items["old-banner"]; ok {
		t.Fatal("retired system item remains")
	}
	if _, err := h.server.ReconcileRoomTemplate(context.Background(), "test-canvas",
		RoomTemplate{CanvasID: "test-canvas", CanvasVersion: 2}, TemplateReconcileOptions{
			ExpectedCanvasID:      "test-canvas",
			ExpectedCanvasVersion: 1,
		}); !errors.Is(err, ErrCanvasVersionConflict) {
		t.Fatalf("stale version error = %v, want ErrCanvasVersionConflict", err)
	}
}

func TestReconcileRoomTemplateRejectsAwakeRooms(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.server.roomFor(context.Background(), "test-canvas"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.server.ReconcileRoomTemplate(context.Background(), "test-canvas",
		RoomTemplate{CanvasID: "test-canvas", CanvasVersion: 1}, TemplateReconcileOptions{
			ExpectedCanvasID:      "test-canvas",
			ExpectedCanvasVersion: 1,
		}); !errors.Is(err, ErrRoomAwake) {
		t.Fatalf("awake error = %v, want ErrRoomAwake", err)
	}
}
