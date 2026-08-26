package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
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
