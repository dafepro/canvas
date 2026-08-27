package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func TestNewRequiresRoomTemplateResolver(t *testing.T) {
	_, err := New(Config{Store: NewMemoryStore(), Auth: DevAuthenticator()})
	if !errors.Is(err, ErrRoomTemplateResolverRequired) {
		t.Fatalf("New error = %v, want ErrRoomTemplateResolverRequired", err)
	}
}

func TestRoomTemplateResolverSeparatesRoomIdentityFromCanvasIdentity(t *testing.T) {
	h := newHarness(t, func(config *Config) {
		config.RoomTemplates = StaticRoomTemplates{
			"team-red":  {CanvasID: "test-canvas", CanvasVersion: 1},
			"team-blue": {CanvasID: "test-canvas", CanvasVersion: 1},
		}
	})

	red, err := h.server.roomFor(context.Background(), "team-red")
	if err != nil {
		t.Fatal(err)
	}
	blue, err := h.server.roomFor(context.Background(), "team-blue")
	if err != nil {
		t.Fatal(err)
	}
	if red == blue || red.roomID != "team-red" || blue.roomID != "team-blue" {
		t.Fatalf("rooms were not isolated: red=%p %#v blue=%p %#v", red, red, blue, blue)
	}
	if red.canvasID != "test-canvas" || blue.canvasID != "test-canvas" {
		t.Fatalf("resolved canvases = %q, %q", red.canvasID, blue.canvasID)
	}
	if red.snapshot.CanvasID != "test-canvas" || blue.snapshot.CanvasID != "test-canvas" {
		t.Fatalf("snapshot templates = %q, %q", red.snapshot.CanvasID, blue.snapshot.CanvasID)
	}
}

func TestResolvedRoomsShareTemplateDataButNotCanonicalState(t *testing.T) {
	h := newHarness(t, func(config *Config) {
		config.RoomTemplates = StaticRoomTemplates{
			"team-red":  {CanvasID: "test-canvas", CanvasVersion: 1},
			"team-blue": {CanvasID: "test-canvas", CanvasVersion: 1},
		}
	})

	red := h.dialRoom("team-red", "alice")
	redAccepted := red.join()
	if redAccepted.CanvasId != "test-canvas" {
		t.Fatalf("red canvas = %q", redAccepted.CanvasId)
	}
	red.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	red.send(spawnCommand("red-spawn", 20, 30))
	red.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetItemMutationResult()
		return result != nil && result.Accepted
	})

	blue := h.dialRoom("team-blue", "bob")
	blueAccepted := blue.join()
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(blueAccepted.SnapshotJson, &snapshot); err != nil {
		t.Fatal(err)
	}
	if blueAccepted.CanvasId != "test-canvas" || len(snapshot.Items) != 0 {
		t.Fatalf("blue joined canvas %q with items %#v", blueAccepted.CanvasId, snapshot.Items)
	}
}

func TestResolvedRoomsCanUseDifferentVersionsOfTheSameCatalogEntries(t *testing.T) {
	h := newHarness(t, func(config *Config) {
		config.RoomTemplates = StaticRoomTemplates{
			"legacy-room":  {CanvasID: "test-canvas", CanvasVersion: 1},
			"current-room": {CanvasID: "test-canvas", CanvasVersion: 2},
		}
	})

	canvasAt := func(version uint32) json.RawMessage {
		t.Helper()
		var canvas map[string]any
		if err := json.Unmarshal([]byte(canvasJSON), &canvas); err != nil {
			t.Fatal(err)
		}
		canvas["version"] = version
		canvas["systemItems"] = []any{map[string]any{
			"entityId":          "versioned-ball",
			"definitionId":      "versioned-ball",
			"definitionVersion": version,
			"transform": map[string]any{
				"x": 50, "y": 35, "rotation": 0, "scale": 1,
			},
			"resolvedConfig": map[string]any{"generation": fmt.Sprintf("v%d", version)},
		}}
		raw, err := json.Marshal(canvas)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	definitionAt := func(version uint32) ItemDefinitionRecord {
		return ItemDefinitionRecord{
			DefinitionID: "versioned-ball",
			Version:      version,
			Complexity:   ItemComplexitySimple,
			ConfigSchema: json.RawMessage(fmt.Sprintf(`{
				"type":"object",
				"properties":{"generation":{"type":"string","const":"v%d"}},
				"required":["generation"],
				"additionalProperties":false
			}`, version)),
		}
	}

	for _, version := range []uint32{1, 2} {
		h.store.PutCanvas(CanvasRecord{
			CanvasID: "test-canvas", Version: version, DefinitionRaw: canvasAt(version),
		})
		h.store.PutItemDefinition(definitionAt(version))
	}

	legacy, err := h.server.roomFor(context.Background(), "legacy-room")
	if err != nil {
		t.Fatalf("wake legacy room: %v", err)
	}
	current, err := h.server.roomFor(context.Background(), "current-room")
	if err != nil {
		t.Fatalf("wake current room: %v", err)
	}
	if legacy.canvasShape.Version != 1 || current.canvasShape.Version != 2 {
		t.Fatalf("resolved versions = %d and %d", legacy.canvasShape.Version, current.canvasShape.Version)
	}
	if legacy.snapshot.Items[0].DefinitionVersion != 1 ||
		current.snapshot.Items[0].DefinitionVersion != 2 {
		t.Fatalf("system item versions = %d and %d",
			legacy.snapshot.Items[0].DefinitionVersion,
			current.snapshot.Items[0].DefinitionVersion)
	}
}

type mismatchedCanvasVersionStore struct {
	*MemoryStore
}

func (s mismatchedCanvasVersionStore) LoadCanvasVersion(
	context.Context,
	string,
	uint32,
) (CanvasRecord, error) {
	return CanvasRecord{
		CanvasID:      "wrong-canvas",
		Version:       1,
		DefinitionRaw: []byte(strings.ReplaceAll(canvasJSON, "test-canvas", "wrong-canvas")),
	}, nil
}

func TestRoomTemplateRejectsExactLookupWithWrongCanvasID(t *testing.T) {
	server, err := New(Config{
		Store: mismatchedCanvasVersionStore{NewMemoryStore()},
		Auth:  DevAuthenticator(),
		RoomTemplates: StaticRoomTemplates{
			"team-red": {CanvasID: "test-canvas", CanvasVersion: 1},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = server.roomFor(context.Background(), "team-red")
	if !errors.Is(err, ErrRoomTemplateConflict) {
		t.Fatalf("roomFor error = %v, want ErrRoomTemplateConflict", err)
	}
}

func TestRoomWakeRejectsResolverSelectionThatConflictsWithPersistedTemplate(t *testing.T) {
	h := newHarness(t, func(config *Config) {
		config.RoomTemplates = RoomTemplateResolverFunc(func(context.Context, string) (RoomTemplate, error) {
			return RoomTemplate{CanvasID: "test-canvas", CanvasVersion: 1}, nil
		})
	})
	if err := h.store.SaveSnapshot(context.Background(), SnapshotRecord{
		RoomID:        "team-red",
		CanvasID:      "another-canvas",
		CanvasVersion: 1,
		SnapshotRaw:   []byte(`{"canvasId":"another-canvas","canvasVersion":1}`),
	}); err != nil {
		t.Fatal(err)
	}

	_, err := h.server.roomFor(context.Background(), "team-red")
	if !errors.Is(err, ErrRoomTemplateConflict) {
		t.Fatalf("roomFor error = %v, want ErrRoomTemplateConflict", err)
	}
}

func TestReconcileRoomTemplateCanAdoptADifferentCanvas(t *testing.T) {
	h := newHarness(t, nil)
	h.store.PutCanvas(CanvasRecord{
		CanvasID:      "other-canvas",
		Version:       1,
		DefinitionRaw: []byte(strings.ReplaceAll(canvasJSON, "test-canvas", "other-canvas")),
	})
	snapshot := emptySnapshot("test-canvas", 1, h.server.cfg.Now())
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveSnapshot(context.Background(), SnapshotRecord{
		RoomID: "team-red", CanvasID: "test-canvas", CanvasVersion: 1,
		SnapshotRaw: raw, Normalized: true,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := h.server.ReconcileRoomTemplate(context.Background(), "team-red",
		RoomTemplate{CanvasID: "other-canvas", CanvasVersion: 1}, TemplateReconcileOptions{
			ExpectedCanvasID: "test-canvas", ExpectedCanvasVersion: 1,
		})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.CanvasID != "other-canvas" || result.CanvasVersion != 1 {
		t.Fatalf("result = %#v", result)
	}
	stored, err := h.store.LoadSnapshot(context.Background(), "team-red")
	if err != nil {
		t.Fatal(err)
	}
	if stored.CanvasID != "other-canvas" || stored.CanvasVersion != 1 {
		t.Fatalf("stored binding = %#v", stored)
	}
	var adopted CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &adopted); err != nil {
		t.Fatal(err)
	}
	if adopted.CanvasID != "other-canvas" || adopted.CanvasVersion != 1 {
		t.Fatalf("snapshot binding = %#v", adopted)
	}
}
