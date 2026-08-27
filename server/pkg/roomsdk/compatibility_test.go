package roomsdk

import (
	"encoding/json"
	"math"
	"testing"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func TestCanvasLimitsDefaultOnlyWhenOmitted(t *testing.T) {
	omitted, err := parseCanvasShape(json.RawMessage(`{
		"id":"limits", "version":1, "size":{"width":100,"height":70}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if omitted.Limits.MaxAvatars != 20 || omitted.Limits.MaxItems != 50 ||
		omitted.Limits.MaxComplexPhysicsItems != 5 {
		t.Fatalf("omitted limits = %#v, want defaults 20/50/5", omitted.Limits)
	}

	explicit, err := parseCanvasShape(json.RawMessage(`{
		"id":"limits", "version":1, "size":{"width":100,"height":70},
		"limits":{"maxAvatars":1,"maxItems":0,"maxComplexPhysicsItems":0}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if explicit.Limits.MaxAvatars != 1 || explicit.Limits.MaxItems != 0 ||
		explicit.Limits.MaxComplexPhysicsItems != 0 {
		t.Fatalf("explicit limits = %#v, want 1/0/0", explicit.Limits)
	}
}

func TestCanvasShapeRejectsMetadataAndNumericContractViolations(t *testing.T) {
	for name, raw := range map[string]string{
		"missing id":      `{"version":1,"size":{"width":100,"height":70}}`,
		"zero version":    `{"id":"limits","version":0,"size":{"width":100,"height":70}}`,
		"zero width":      `{"id":"limits","version":1,"size":{"width":0,"height":70}}`,
		"negative height": `{"id":"limits","version":1,"size":{"width":100,"height":-1}}`,
		"unsafe max items": `{
			"id":"limits","version":1,"size":{"width":100,"height":70},
			"limits":{"maxAvatars":1,"maxItems":9007199254740992,"maxComplexPhysicsItems":0}
		}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseCanvasShape(json.RawMessage(raw)); err == nil {
				t.Fatal("accepted a canvas shape outside the shared JSON contract")
			}
		})
	}
}

func TestTransformSlackBoundaryMatchesClientValidation(t *testing.T) {
	room := &Room{}
	room.canvasShape.Size.Width = 100
	room.canvasShape.Size.Height = 70
	if !room.withinBounds(Transform{X: 400, Y: -280}) {
		t.Fatal("exact four-times slack boundary should be accepted")
	}
	if room.withinBounds(Transform{X: 400.01, Y: 0}) {
		t.Fatal("position outside four-times slack boundary should be rejected")
	}
}

func TestRoomRejectsCanvasRecordDefinitionIdentityMismatch(t *testing.T) {
	h := newHarness(t, nil)
	for name, record := range map[string]CanvasRecord{
		"id": {
			CanvasID: "record-id", Version: 1,
			DefinitionRaw: json.RawMessage(`{
				"id":"definition-id","version":1,"size":{"width":100,"height":70}
			}`),
		},
		"version": {
			CanvasID: "same-id", Version: 2,
			DefinitionRaw: json.RawMessage(`{
				"id":"same-id","version":1,"size":{"width":100,"height":70}
			}`),
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := newRoom(h.server, "room", record, SnapshotRecord{}); err == nil {
				t.Fatal("accepted canvas record metadata that disagrees with its definition")
			}
		})
	}
}

func TestZeroComplexItemLimitRejectsAComplexSpawn(t *testing.T) {
	room := &Room{
		canvasShape: canvasShape{},
		items:       make(map[string]*SnapshotItem),
		definitions: map[string]ItemDefinitionRecord{
			"complex": {
				DefinitionID: "complex",
				Version:      1,
				Complexity:   ItemComplexityComplex,
				ConfigSchema: json.RawMessage(`{"type":"object"}`),
			},
		},
	}
	room.canvasShape.Size.Width = 100
	room.canvasShape.Size.Height = 70
	room.canvasShape.Limits.MaxItems = 10
	room.canvasShape.Limits.MaxComplexPhysicsItems = 0
	accepted, _, reason := room.validateItemMutation(&Client{UserID: "alice"}, &pb.ItemMutation{
		Kind:              pb.ItemMutationKind_ITEM_MUTATION_SPAWN,
		DefinitionId:      "complex",
		DefinitionVersion: 1,
		Position:          &pb.Vec2{X: 10, Y: 10},
		Scale:             1,
		ConfigJson:        []byte(`{}`),
	})
	if accepted || reason != "complex_item_limit_reached" {
		t.Fatalf("accepted = %v, reason = %q, want complex_item_limit_reached", accepted, reason)
	}
}

func TestCheckpointRejectsUnsupportedSnapshotSchema(t *testing.T) {
	h := newHarness(t, nil)
	room, err := h.server.roomFor(t.Context(), "test-canvas")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 2,
		CanvasID:      "test-canvas",
		CanvasVersion: 1,
		SceneRevision: room.sceneRevision,
		Items:         []SnapshotItem{},
		Avatars:       []SnapshotAvatar{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := room.acceptCheckpoint(&pb.Checkpoint{
		CheckpointRevision: 1,
		SnapshotJson:       raw,
	}); err == nil {
		t.Fatal("accepted a checkpoint from unsupported snapshot schema 2")
	}
}

func TestCheckpointRejectsAnotherCanvasVersion(t *testing.T) {
	h := newHarness(t, nil)
	room, err := h.server.roomFor(t.Context(), "test-canvas")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas", CanvasVersion: 2,
		SceneRevision: room.sceneRevision,
		Items:         []SnapshotItem{}, Avatars: []SnapshotAvatar{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := room.acceptCheckpoint(&pb.Checkpoint{
		CheckpointRevision: 1,
		SnapshotJson:       raw,
	}); err == nil {
		t.Fatal("accepted a checkpoint for another canvas version")
	}
}

func TestScaleMutationRejectsANonFiniteValue(t *testing.T) {
	item := &SnapshotItem{EntityID: "item-1", OwnerUserID: "alice"}
	room := &Room{items: map[string]*SnapshotItem{"item-1": item}}
	accepted, _, reason := room.validateItemMutation(&Client{UserID: "alice"}, &pb.ItemMutation{
		Kind:     pb.ItemMutationKind_ITEM_MUTATION_SCALE,
		EntityId: "item-1",
		Scale:    float32(math.NaN()),
	})
	if accepted || reason != "non_finite_transform" {
		t.Fatalf("accepted = %v, reason = %q, want non_finite_transform", accepted, reason)
	}
}

func TestCanonicalEffectRejectsMalformedJSONParameters(t *testing.T) {
	room := &Room{}
	err := room.validateCanonicalState(&pb.RoomEnvelope{
		Payload: &pb.RoomEnvelope_EffectEvent{EffectEvent: &pb.EffectEvent{
			EntityId:   "item-1",
			Effect:     "spark",
			Mode:       "oneShot",
			ParamsJson: []byte(`{`),
		}},
	})
	if err == nil {
		t.Fatal("accepted malformed effect parameter JSON")
	}
}
