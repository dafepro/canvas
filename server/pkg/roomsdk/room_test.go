package roomsdk

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

const canvasJSON = `{
  "id": "test-canvas",
  "version": 1,
  "size": { "width": 100, "height": 70 },
  "orientation": "side",
  "edges": { "top": "wrap", "right": "solid", "bottom": "solid", "left": "solid" },
  "staticGeometry": [],
  "regions": [],
  "environment": { "base": { "gravityXY": { "x": 0, "y": 20 }, "linearDrag": 0.1 } },
  "spawnPoints": [{ "id": "centre", "position": { "x": 50, "y": 35 } }],
  "limits": { "maxAvatars": 3, "maxItems": 2, "maxComplexPhysicsItems": 1 }
}`

type harness struct {
	t      *testing.T
	server *Server
	store  *MemoryStore
	http   *httptest.Server
}

func newHarness(t *testing.T, mutate func(*Config)) *harness {
	t.Helper()
	store := NewMemoryStore()
	store.PutCanvas(CanvasRecord{
		CanvasID:      "test-canvas",
		Version:       1,
		DefinitionRaw: json.RawMessage(canvasJSON),
	})
	store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "rocket",
		Version:      1,
		Complexity:   ItemComplexitySimple,
	})
	store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "complex-rocket",
		Version:      1,
		Complexity:   ItemComplexityComplex,
	})
	cfg := Config{
		Store:             store,
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		AllowedOrigins:    []string{"*"},
		HostLeaseTTL:      150 * time.Millisecond,
		HeartbeatInterval: 25 * time.Millisecond,
		SleepGrace:        100 * time.Millisecond,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	server, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	return &harness{t: t, server: server, store: store, http: ts}
}

type testClient struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
	// ClientID from JoinAccepted.
	clientID  string
	hostEpoch uint64
}

func (h *harness) dial(user string) *testClient {
	h.t.Helper()
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") +
		"/v1/realtime/canvases/test-canvas?user=" + url.QueryEscape(user)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	h.t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	return &testClient{t: h.t, conn: conn, ctx: ctx}
}

func (c *testClient) send(envelope *pb.RoomEnvelope) {
	c.t.Helper()
	data, err := proto.Marshal(envelope)
	if err != nil {
		c.t.Fatalf("marshal: %v", err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageBinary, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) read() *pb.RoomEnvelope {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(c.ctx, 3*time.Second)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	envelope := &pb.RoomEnvelope{}
	if err := proto.Unmarshal(data, envelope); err != nil {
		c.t.Fatalf("unmarshal: %v", err)
	}
	return envelope
}

// await reads until a matching envelope arrives or the deadline passes.
func (c *testClient) await(match func(*pb.RoomEnvelope) bool) *pb.RoomEnvelope {
	c.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		envelope := c.read()
		if control := envelope.GetHostControl(); control != nil && control.HostEpoch > 0 {
			c.hostEpoch = control.HostEpoch
		}
		if match(envelope) {
			return envelope
		}
	}
	c.t.Fatal("timed out waiting for an envelope")
	return nil
}

func (c *testClient) sendJoin(definitions ...*pb.DefinitionVersion) {
	c.t.Helper()
	if len(definitions) == 0 {
		definitions = []*pb.DefinitionVersion{{DefinitionId: "rocket", Version: 1}}
	}
	c.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_Join{Join: &pb.Join{
			CanvasId:        "test-canvas",
			ProtocolVersion: 1,
			Definitions:     definitions,
		}},
	})
}

func (c *testClient) join(definitions ...*pb.DefinitionVersion) *pb.JoinAccepted {
	c.t.Helper()
	c.sendJoin(definitions...)
	envelope := c.await(func(e *pb.RoomEnvelope) bool { return e.GetJoinAccepted() != nil })
	accepted := envelope.GetJoinAccepted()
	c.clientID = accepted.ClientId
	c.hostEpoch = accepted.HostEpoch
	return accepted
}

func TestConnectionMustJoinBeforeRoomAdmission(t *testing.T) {
	h := newHarness(t, nil)
	client := h.dial("alice")
	client.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_Heartbeat{Heartbeat: &pb.Heartbeat{
			SentAtUnixMs: uint64(time.Now().UnixMilli()),
		}},
	})

	first := client.read()
	if first.GetError() == nil || first.GetError().Code != "join_required" {
		t.Fatalf("first response = %T, want join_required error", first.Payload)
	}
	if len(h.server.Rooms()) != 0 {
		t.Fatal("a connection entered the room before a valid JOIN")
	}
}

func (c *testClient) heartbeat() {
	c.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: c.hostEpoch,
		Payload: &pb.RoomEnvelope_Heartbeat{Heartbeat: &pb.Heartbeat{
			SentAtUnixMs: uint64(time.Now().UnixMilli()),
			SimulationHz: 60,
			PageVisible:  true,
		}},
	})
}

func TestJoinReturnsCanvasAndGrantsFirstHost(t *testing.T) {
	h := newHarness(t, nil)
	client := h.dial("alice")
	accepted := client.join()

	if accepted.TickRate != 60 {
		t.Errorf("tick rate = %d, want 60", accepted.TickRate)
	}
	if !accepted.RoomWasSleeping {
		t.Error("the first join should report a sleeping room")
	}
	if !strings.Contains(string(accepted.CanvasDefinitionJson), `"test-canvas"`) {
		t.Error("join did not carry the canvas definition")
	}

	granted := client.await(func(e *pb.RoomEnvelope) bool {
		control := e.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()
	if granted.HostClientId != client.clientID {
		t.Errorf("host = %q, want %q", granted.HostClientId, client.clientID)
	}
	if granted.HostEpoch != 1 {
		t.Errorf("first host epoch = %d, want 1", granted.HostEpoch)
	}
}

func TestOnlyOneHostAndPresenceReportsIt(t *testing.T) {
	h := newHarness(t, nil)
	first := h.dial("alice")
	first.join()
	first.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	second := h.dial("bob")
	accepted := second.join()
	if accepted.HostClientId != first.clientID {
		t.Errorf("second client sees host %q, want %q", accepted.HostClientId, first.clientID)
	}

	presence := second.await(func(e *pb.RoomEnvelope) bool { return e.GetPresence() != nil }).GetPresence()
	hosts := 0
	for _, peer := range presence.Peers {
		if peer.IsHost {
			hosts++
		}
	}
	if hosts != 1 {
		t.Errorf("presence reports %d hosts, want exactly 1", hosts)
	}
}

func TestStateFromNonHostIsNotRelayed(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	peer := h.dial("bob")
	peer.join()

	// The non-host peer publishes canonical state. The server must drop it.
	peer.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: peer.hostEpoch,
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			Entities: []*pb.EntityState{{EntityId: "fake"}},
		}},
	})
	// A durable command from the same client proves the loop kept running and
	// that no state delta arrived before it.
	peer.send(spawnCommand("cmd-1", 10, 10))

	got := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetStateDelta() != nil || e.GetDurableResult() != nil
	})
	if got.GetStateDelta() != nil {
		t.Fatal("the server relayed canonical state from a non-host client")
	}
}

func TestStaleHostEpochIsDropped(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()

	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: 0, // stale
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			Entities: []*pb.EntityState{{EntityId: "stale"}},
		}},
	})
	host.send(spawnCommand("cmd-1", 10, 10))

	got := peer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetStateDelta() != nil || e.GetDurableResult() != nil
	})
	if got.GetStateDelta() != nil {
		t.Fatal("the server relayed a state delta with a stale host epoch")
	}
}

func spawnCommand(id string, x, y float32) *pb.RoomEnvelope {
	return &pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId:         id,
			Kind:              pb.DurableCommandKind_DURABLE_SPAWN_ITEM,
			DefinitionId:      "rocket",
			DefinitionVersion: 1,
			Position:          &pb.Vec2{X: x, Y: y},
			ConfigJson:        []byte(`{"thrust":24}`),
		}},
	}
}

func TestOwnershipIsEnforced(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	other := h.dial("bob")
	other.join()

	owner.send(spawnCommand("cmd-spawn", 20, 30))
	result := owner.await(func(e *pb.RoomEnvelope) bool { return e.GetDurableResult() != nil }).GetDurableResult()
	if !result.Accepted {
		t.Fatalf("spawn rejected: %s", result.RejectReason)
	}
	entityID := result.Command.EntityId
	if entityID == "" {
		t.Fatal("the server did not assign an entity id")
	}

	var instance SnapshotItem
	if err := json.Unmarshal(result.ItemInstanceJson, &instance); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if instance.OwnerUserID != "alice" {
		t.Errorf("owner = %q, want alice", instance.OwnerUserID)
	}

	// A non-owner may not move the item.
	other.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId: "cmd-steal",
			Kind:      pb.DurableCommandKind_DURABLE_MOVE_ITEM,
			EntityId:  entityID,
			Position:  &pb.Vec2{X: 1, Y: 1},
		}},
	})
	reject := other.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-steal"
	}).GetDurableResult()
	if reject.Accepted {
		t.Fatal("a non-owner moved another user's item")
	}
	if reject.RejectReason != "not_owner" {
		t.Errorf("reject reason = %q, want not_owner", reject.RejectReason)
	}

	// The owner may move it.
	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId: "cmd-move",
			Kind:      pb.DurableCommandKind_DURABLE_MOVE_ITEM,
			EntityId:  entityID,
			Position:  &pb.Vec2{X: 40, Y: 50},
		}},
	})
	accepted := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-move"
	}).GetDurableResult()
	if !accepted.Accepted {
		t.Fatalf("owner move rejected: %s", accepted.RejectReason)
	}
	if accepted.SceneRevision <= result.SceneRevision {
		t.Error("the scene revision did not increase")
	}
}

func TestDurableLimitsAndBounds(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	// Outside the canvas.
	owner.send(spawnCommand("cmd-far", 500, 500))
	reject := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-far"
	}).GetDurableResult()
	if reject.Accepted || reject.RejectReason != "outside_canvas" {
		t.Errorf("got accepted=%v reason=%q, want outside_canvas", reject.Accepted, reject.RejectReason)
	}

	// The canvas limit is two items.
	for i, id := range []string{"cmd-a", "cmd-b"} {
		owner.send(spawnCommand(id, float32(10+i), 10))
		r := owner.await(func(e *pb.RoomEnvelope) bool {
			r := e.GetDurableResult()
			return r != nil && r.CommandId == id
		}).GetDurableResult()
		if !r.Accepted {
			t.Fatalf("spawn %s rejected: %s", id, r.RejectReason)
		}
	}
	owner.send(spawnCommand("cmd-c", 12, 10))
	limit := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-c"
	}).GetDurableResult()
	if limit.Accepted || limit.RejectReason != "item_limit_reached" {
		t.Errorf("got accepted=%v reason=%q, want item_limit_reached", limit.Accepted, limit.RejectReason)
	}
}

func TestSpawnRequiresAKnownDefinitionVersion(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	unknown := spawnCommand("cmd-unknown", 10, 10)
	unknown.GetDurableCommand().DefinitionId = "invented"
	owner.send(unknown)
	unknownResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-unknown"
	}).GetDurableResult()
	if unknownResult.Accepted || unknownResult.RejectReason != "unknown_definition" {
		t.Errorf("unknown definition: accepted=%v reason=%q", unknownResult.Accepted, unknownResult.RejectReason)
	}

	wrongVersion := spawnCommand("cmd-version", 10, 10)
	wrongVersion.GetDurableCommand().DefinitionVersion = 99
	owner.send(wrongVersion)
	versionResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-version"
	}).GetDurableResult()
	if versionResult.Accepted || versionResult.RejectReason != "definition_version_mismatch" {
		t.Errorf("wrong version: accepted=%v reason=%q", versionResult.Accepted, versionResult.RejectReason)
	}
}

func TestSpawnEnforcesTheComplexItemLimit(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	first := spawnCommand("cmd-complex-1", 10, 10)
	first.GetDurableCommand().DefinitionId = "complex-rocket"
	owner.send(first)
	firstResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-complex-1"
	}).GetDurableResult()
	if !firstResult.Accepted {
		t.Fatalf("first complex item rejected: %s", firstResult.RejectReason)
	}

	second := spawnCommand("cmd-complex-2", 20, 20)
	second.GetDurableCommand().DefinitionId = "complex-rocket"
	owner.send(second)
	secondResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-complex-2"
	}).GetDurableResult()
	if secondResult.Accepted || secondResult.RejectReason != "complex_item_limit_reached" {
		t.Errorf("second complex item: accepted=%v reason=%q", secondResult.Accepted, secondResult.RejectReason)
	}
}

func TestHostMigrationAfterHostDisconnects(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	first := host.await(func(e *pb.RoomEnvelope) bool {
		c := e.GetHostControl()
		return c != nil && c.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()

	peer := h.dial("bob")
	peer.join()
	peer.heartbeat()

	_ = host.conn.CloseNow()

	granted := peer.await(func(e *pb.RoomEnvelope) bool {
		c := e.GetHostControl()
		return c != nil && c.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()
	if granted.HostClientId != peer.clientID {
		t.Errorf("new host = %q, want %q", granted.HostClientId, peer.clientID)
	}
	if granted.HostEpoch <= first.HostEpoch {
		t.Errorf("epoch did not increase: %d then %d", first.HostEpoch, granted.HostEpoch)
	}
	if len(granted.SnapshotJson) == 0 {
		t.Error("the new host received no snapshot to rebuild from")
	}
}

func TestHostYieldMovesTheLease(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()
	peer.heartbeat()

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_HostControl{HostControl: &pb.HostControl{
			Kind:   pb.HostControlKind_HOST_CONTROL_YIELD,
			Reason: "page_hidden",
		}},
	})

	granted := peer.await(func(e *pb.RoomEnvelope) bool {
		c := e.GetHostControl()
		return c != nil && c.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()
	if granted.HostClientId != peer.clientID {
		t.Errorf("new host = %q, want %q", granted.HostClientId, peer.clientID)
	}
}

func TestSoleHostKeepsTheLeaseOnYield(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_HostControl{HostControl: &pb.HostControl{
			Kind: pb.HostControlKind_HOST_CONTROL_YIELD,
		}},
	})
	host.send(spawnCommand("cmd-after-yield", 10, 10))
	result := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-after-yield"
	}).GetDurableResult()
	if !result.Accepted {
		t.Fatalf("command after yield rejected: %s", result.RejectReason)
	}
	if len(h.server.Rooms()) != 1 {
		t.Error("the room should still be awake")
	}
}

func TestRoomSleepsAndWakesWithTheSameItems(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	owner.send(spawnCommand("cmd-spawn", 20, 30))
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetDurableResult() != nil })

	_ = owner.conn.CloseNow()

	// Wait for the sleep grace window to pass.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(h.server.Rooms()) > 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if len(h.server.Rooms()) != 0 {
		t.Fatal("the room did not sleep after the last client left")
	}

	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if !stored.Normalized {
		t.Error("the sleeping snapshot is not marked normalized")
	}

	// Wake it again and check the item survived.
	next := h.dial("bob")
	accepted := next.join()
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(accepted.SnapshotJson, &snapshot); err != nil {
		t.Fatalf("snapshot json: %v", err)
	}
	if len(snapshot.Items) != 1 {
		t.Fatalf("woken room has %d items, want 1", len(snapshot.Items))
	}
	if snapshot.Items[0].OwnerUserID != "alice" {
		t.Errorf("owner after wake = %q, want alice", snapshot.Items[0].OwnerUserID)
	}
	if snapshot.Items[0].Transform.X != 20 {
		t.Errorf("x after wake = %v, want 20", snapshot.Items[0].Transform.X)
	}
}

func TestCheckpointOnlyFromHost(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()

	badSnapshot, _ := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas",
		Items: []SnapshotItem{{
			EntityID:  "e1",
			Transform: Transform{X: 999999, Y: 0},
		}},
	})
	// A non-host checkpoint must be ignored.
	peer.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: peer.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 5,
			SnapshotJson:       badSnapshot,
		}},
	})
	// An out-of-bounds checkpoint from the host must also be refused.
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 5,
			SnapshotJson:       badSnapshot,
		}},
	})
	host.send(spawnCommand("cmd-sync", 10, 10))
	host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-sync"
	})

	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &snapshot); err != nil {
		t.Fatalf("snapshot json: %v", err)
	}
	for _, item := range snapshot.Items {
		if item.EntityID == "e1" {
			t.Fatal("the server stored a rejected checkpoint")
		}
	}
}

func TestCheckpointCannotRewriteDurableItemMetadata(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-spawn"
	}).GetDurableResult()
	entityID := spawned.Command.EntityId

	checkpointRaw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas",
		SceneRevision: spawned.SceneRevision,
		Items: []SnapshotItem{{
			EntityID:          entityID,
			DefinitionID:      "invented-definition",
			DefinitionVersion: 99,
			OwnerUserID:       "mallory",
			Transform:         Transform{X: 35, Y: 40},
			ResolvedConfig:    json.RawMessage(`{"admin":true}`),
			BehaviorState:     json.RawMessage(`{"phase":"flying"}`),
			BehaviorStateVer:  7,
			VisualVariant:     "flying",
		}},
	})
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			SnapshotJson:       checkpointRaw,
		}},
	})

	// The original authenticated owner must retain durable edit authority after
	// the host checkpoint is accepted.
	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId: "cmd-move-after-checkpoint",
			Kind:      pb.DurableCommandKind_DURABLE_MOVE_ITEM,
			EntityId:  entityID,
			Position:  &pb.Vec2{X: 45, Y: 50},
		}},
	})
	moved := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-move-after-checkpoint"
	}).GetDurableResult()
	if !moved.Accepted {
		t.Fatalf("owner move rejected after checkpoint: %s", moved.RejectReason)
	}

	var item SnapshotItem
	if err := json.Unmarshal(moved.ItemInstanceJson, &item); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if item.OwnerUserID != "alice" {
		t.Errorf("owner = %q, want alice", item.OwnerUserID)
	}
	if item.DefinitionID != "rocket" || item.DefinitionVersion != 1 {
		t.Errorf("definition = %s@%d, want rocket@1", item.DefinitionID, item.DefinitionVersion)
	}
	if string(item.ResolvedConfig) != `{"thrust":24}` {
		t.Errorf("resolved config = %s, want original config", item.ResolvedConfig)
	}
	if string(item.BehaviorState) != `{"phase":"flying"}` {
		t.Errorf("behavior state = %s, want canonical checkpoint state", item.BehaviorState)
	}
	if item.VisualVariant != "flying" {
		t.Errorf("visual variant = %q, want flying", item.VisualVariant)
	}
}

func TestCheckpointRejectsUnknownEntityIDs(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	checkpointRaw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas",
		SceneRevision: 0,
		Items: []SnapshotItem{{
			EntityID:          "host-invented-item",
			DefinitionID:      "rocket",
			DefinitionVersion: 1,
			OwnerUserID:       "alice",
			Transform:         Transform{X: 20, Y: 30},
		}},
	})
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			SnapshotJson:       checkpointRaw,
		}},
	})

	// A following accepted durable command gives the room loop an ordered
	// synchronization point and persists its current snapshot.
	host.send(spawnCommand("cmd-sync", 10, 10))
	host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-sync"
	})

	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &snapshot); err != nil {
		t.Fatalf("snapshot json: %v", err)
	}
	for _, item := range snapshot.Items {
		if item.EntityID == "host-invented-item" {
			t.Fatal("the server accepted an unknown entity from a host checkpoint")
		}
	}
}

func TestCheckpointRejectsAStaleSceneRevision(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-spawn"
	}).GetDurableResult()
	entityID := spawned.Command.EntityId

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId: "cmd-move",
			Kind:      pb.DurableCommandKind_DURABLE_MOVE_ITEM,
			EntityId:  entityID,
			Position:  &pb.Vec2{X: 40, Y: 50},
		}},
	})
	host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-move"
	})

	checkpointRaw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas",
		SceneRevision: spawned.SceneRevision,
		Items: []SnapshotItem{{
			EntityID:          entityID,
			DefinitionID:      "rocket",
			DefinitionVersion: 1,
			OwnerUserID:       "alice",
			Transform:         Transform{X: 5, Y: 6},
		}},
	})
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			SnapshotJson:       checkpointRaw,
		}},
	})

	// Synchronize and inspect the server-owned item after the stale checkpoint.
	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId:  "cmd-config",
			Kind:       pb.DurableCommandKind_DURABLE_SET_CONFIG,
			EntityId:   entityID,
			ConfigJson: []byte(`{"thrust":30}`),
		}},
	})
	configured := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-config"
	}).GetDurableResult()
	var item SnapshotItem
	if err := json.Unmarshal(configured.ItemInstanceJson, &item); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if item.Transform.X != 40 || item.Transform.Y != 50 {
		t.Errorf("transform = (%v,%v), want the newer durable move (40,50)", item.Transform.X, item.Transform.Y)
	}
}

func TestCheckpointRejectsAStaleHostEpoch(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-spawn"
	}).GetDurableResult()
	entityID := spawned.Command.EntityId

	checkpointRaw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      "test-canvas",
		SceneRevision: spawned.SceneRevision,
		Items: []SnapshotItem{{
			EntityID:          entityID,
			DefinitionID:      "rocket",
			DefinitionVersion: 1,
			OwnerUserID:       "alice",
			Transform:         Transform{X: 5, Y: 6},
		}},
	})
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: 0,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			SnapshotJson:       checkpointRaw,
		}},
	})

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
			CommandId:  "cmd-config",
			Kind:       pb.DurableCommandKind_DURABLE_SET_CONFIG,
			EntityId:   entityID,
			ConfigJson: []byte(`{"thrust":30}`),
		}},
	})
	configured := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetDurableResult()
		return r != nil && r.CommandId == "cmd-config"
	}).GetDurableResult()
	var item SnapshotItem
	if err := json.Unmarshal(configured.ItemInstanceJson, &item); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if item.Transform.X != 20 || item.Transform.Y != 30 {
		t.Errorf("transform = (%v,%v), want pre-checkpoint value (20,30)", item.Transform.X, item.Transform.Y)
	}
}

func TestCanonicalStateValidation(t *testing.T) {
	tests := []struct {
		name        string
		state       func(entityID string, sceneRevision uint64) *pb.StateDelta
		wantRelayed bool
	}{
		{
			name: "valid known item",
			state: func(entityID string, sceneRevision uint64) *pb.StateDelta {
				return &pb.StateDelta{
					SceneRevision: sceneRevision,
					Entities: []*pb.EntityState{{
						EntityId: entityID,
						Position: &pb.Vec2{X: 25, Y: 30},
						Velocity: &pb.Vec2{},
					}},
				}
			},
			wantRelayed: true,
		},
		{
			name: "unknown item",
			state: func(_ string, sceneRevision uint64) *pb.StateDelta {
				return &pb.StateDelta{
					SceneRevision: sceneRevision,
					Entities: []*pb.EntityState{{
						EntityId: "host-invented-item",
						Position: &pb.Vec2{X: 25, Y: 30},
						Velocity: &pb.Vec2{},
					}},
				}
			},
		},
		{
			name: "non-finite transform",
			state: func(entityID string, sceneRevision uint64) *pb.StateDelta {
				return &pb.StateDelta{
					SceneRevision: sceneRevision,
					Entities: []*pb.EntityState{{
						EntityId: entityID,
						Position: &pb.Vec2{X: float32(math.NaN()), Y: 30},
						Velocity: &pb.Vec2{},
					}},
				}
			},
		},
		{
			name: "stale scene revision",
			state: func(entityID string, _ uint64) *pb.StateDelta {
				return &pb.StateDelta{
					SceneRevision: 0,
					Entities: []*pb.EntityState{{
						EntityId: entityID,
						Position: &pb.Vec2{X: 25, Y: 30},
						Velocity: &pb.Vec2{},
					}},
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil)
			host := h.dial("alice")
			host.join()
			host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
			peer := h.dial("bob")
			peer.join()

			host.send(spawnCommand("cmd-spawn", 20, 30))
			spawned := host.await(func(e *pb.RoomEnvelope) bool {
				r := e.GetDurableResult()
				return r != nil && r.CommandId == "cmd-spawn"
			}).GetDurableResult()
			// Consume the accepted mutation on the peer before testing relay order.
			peer.await(func(e *pb.RoomEnvelope) bool {
				r := e.GetDurableResult()
				return r != nil && r.CommandId == "cmd-spawn"
			})

			host.send(&pb.RoomEnvelope{
				RoomId:    "test-canvas",
				HostEpoch: host.hostEpoch,
				Payload: &pb.RoomEnvelope_StateDelta{StateDelta: tt.state(
					spawned.Command.EntityId,
					spawned.SceneRevision,
				)},
			})
			host.send(&pb.RoomEnvelope{
				RoomId: "test-canvas",
				Payload: &pb.RoomEnvelope_DurableCommand{DurableCommand: &pb.DurableCommand{
					CommandId:  "cmd-sync",
					Kind:       pb.DurableCommandKind_DURABLE_SET_CONFIG,
					EntityId:   spawned.Command.EntityId,
					ConfigJson: []byte(`{"thrust":30}`),
				}},
			})

			got := peer.await(func(e *pb.RoomEnvelope) bool {
				return e.GetStateDelta() != nil ||
					(e.GetDurableResult() != nil && e.GetDurableResult().CommandId == "cmd-sync")
			})
			if tt.wantRelayed && got.GetStateDelta() == nil {
				t.Fatal("valid canonical state was not relayed")
			}
			if !tt.wantRelayed && got.GetStateDelta() != nil {
				t.Fatal("invalid canonical state was relayed")
			}
		})
	}
}

func TestProtocolMismatchIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	client := h.dial("alice")
	client.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_Join{Join: &pb.Join{
			CanvasId:        "test-canvas",
			ProtocolVersion: 99,
			UserId:          "alice",
		}},
	})
	got := client.await(func(e *pb.RoomEnvelope) bool { return e.GetError() != nil }).GetError()
	if got.Code != "protocol_mismatch" {
		t.Errorf("error code = %q, want protocol_mismatch", got.Code)
	}
	if got.ServerProtocolVersion != 1 {
		t.Errorf("server protocol version = %d, want 1", got.ServerProtocolVersion)
	}
}

func TestRoomFullIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	for _, user := range []string{"a", "b", "c"} {
		client := h.dial(user)
		client.join()
	}
	extra := h.dial("d")
	extra.sendJoin()
	got := extra.await(func(e *pb.RoomEnvelope) bool { return e.GetError() != nil }).GetError()
	if got.Code != "room_full" {
		t.Errorf("error code = %q, want room_full", got.Code)
	}
}

func TestUnauthenticatedConnectionIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") + "/v1/realtime/canvases/test-canvas"
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("dial without a user succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %v, want 401", resp)
	}
}

func TestGetCanvasReturnsTheDefinition(t *testing.T) {
	h := newHarness(t, nil)
	resp, err := http.Get(h.http.URL + "/v1/canvases/test-canvas")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	var body canvasResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.CanvasID != "test-canvas" || body.TickRate != 60 {
		t.Errorf("unexpected body: %+v", body)
	}
}

func TestNewRefusesAConfigWithoutAStore(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New accepted a Config with no Store")
	}
}
