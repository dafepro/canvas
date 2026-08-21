package roomsdk

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
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
		if match(envelope) {
			return envelope
		}
	}
	c.t.Fatal("timed out waiting for an envelope")
	return nil
}

func (c *testClient) join() *pb.JoinAccepted {
	c.t.Helper()
	envelope := c.await(func(e *pb.RoomEnvelope) bool { return e.GetJoinAccepted() != nil })
	accepted := envelope.GetJoinAccepted()
	c.clientID = accepted.ClientId
	c.hostEpoch = accepted.HostEpoch
	return accepted
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

func TestProtocolMismatchIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	client := h.dial("alice")
	client.join()
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
