package roomsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

type blockingSnapshotStore struct {
	Store
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *blockingSnapshotStore) SaveSnapshot(
	ctx context.Context,
	snapshot SnapshotRecord,
) error {
	s.once.Do(func() {
		close(s.started)
		select {
		case <-s.release:
		case <-ctx.Done():
		}
	})
	return s.Store.SaveSnapshot(ctx, snapshot)
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
		ConfigSchema: json.RawMessage(`{
			"type":"object",
			"properties":{"thrust":{"type":"number"}},
			"required":["thrust"],
			"additionalProperties":false
		}`),
	})
	store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "complex-rocket",
		Version:      1,
		Complexity:   ItemComplexityComplex,
		ConfigSchema: json.RawMessage(`{
			"type":"object",
			"properties":{"thrust":{"type":"number"}},
			"required":["thrust"],
			"additionalProperties":false
		}`),
	})
	cfg := Config{
		Store: store,
		Auth:  DevAuthenticator(),
		RoomTemplates: StaticRoomTemplates{
			"test-canvas": {CanvasID: "test-canvas", CanvasVersion: 1},
		},
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
	t      *testing.T
	conn   *websocket.Conn
	ctx    context.Context
	roomID string
	// ClientID from JoinAccepted.
	clientID      string
	hostEpoch     uint64
	itemRevisions map[string]uint64
}

func (h *harness) dial(user string) *testClient {
	return h.dialRoom("test-canvas", user)
}

func (h *harness) dialRoom(roomID, user string) *testClient {
	h.t.Helper()
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") +
		"/v1/realtime/rooms/" + roomID
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	h.t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"X-User-Id": []string{user}},
	})
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	h.t.Cleanup(func() { _ = conn.CloseNow() })
	return &testClient{
		t: h.t, conn: conn, ctx: ctx, roomID: roomID,
		itemRevisions: make(map[string]uint64),
	}
}

func (c *testClient) send(envelope *pb.RoomEnvelope) {
	c.t.Helper()
	if mutation := envelope.GetItemMutation(); mutation != nil {
		if mutation.ClientSessionId == "" {
			mutation.ClientSessionId = fmt.Sprintf("test:%s:%d", c.clientID, mutation.MutationId)
		}
		if mutation.EntityId != "" && mutation.ExpectedItemRevision == 0 {
			mutation.ExpectedItemRevision = c.itemRevisions[mutation.EntityId]
		}
	}
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
	if result := envelope.GetItemMutationResult(); result != nil && result.EntityId != "" && result.ItemRevision > 0 {
		c.itemRevisions[result.EntityId] = result.ItemRevision
	}
	return envelope
}

func mutationID(name string) uint64 {
	// Stable FNV-1a IDs keep older descriptive test labels without weakening
	// the production protocol's monotonic numeric mutation identity.
	const offset64 = uint64(14695981039346656037)
	const prime64 = uint64(1099511628211)
	value := offset64
	for i := 0; i < len(name); i++ {
		value ^= uint64(name[i])
		value *= prime64
	}
	return value
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
		RoomId: c.roomID,
		Payload: &pb.RoomEnvelope_Join{Join: &pb.Join{
			RoomId:          c.roomID,
			ProtocolVersion: 8,
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

func TestRealtimeNumericContractsRejectNonFiniteValues(t *testing.T) {
	validInput := &pb.PlayerInput{
		Direction:      &pb.Vec2{X: 0.5, Y: -0.5},
		Intensity:      0.5,
		TargetPosition: &pb.Vec2{X: 10, Y: 20},
	}
	if !validPlayerInput(validInput) {
		t.Fatal("finite player input should be valid")
	}

	for name, input := range map[string]*pb.PlayerInput{
		"direction NaN": {
			Direction: &pb.Vec2{X: float32(math.NaN())}, Intensity: 1,
		},
		"direction infinity": {
			Direction: &pb.Vec2{Y: float32(math.Inf(1))}, Intensity: 1,
		},
		"intensity NaN": {
			Direction: &pb.Vec2{X: 1}, Intensity: float32(math.NaN()),
		},
		"intensity above one": {
			Direction: &pb.Vec2{X: 1}, Intensity: 1.01,
		},
		"direction outside unit disk": {
			Direction: &pb.Vec2{X: 1, Y: 1}, Intensity: 1,
		},
		"target infinity": {
			Direction: &pb.Vec2{X: 1}, Intensity: 1,
			TargetPosition: &pb.Vec2{X: float32(math.Inf(-1))},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if validPlayerInput(input) {
				t.Fatal("malformed player input should be rejected")
			}
		})
	}

	if !validHeartbeat(&pb.Heartbeat{SimulationHz: 60, WorkerDriftMs: 2}) {
		t.Fatal("finite heartbeat health should be valid")
	}
	for name, beat := range map[string]*pb.Heartbeat{
		"simulation NaN":         {SimulationHz: float32(math.NaN())},
		"simulation infinity":    {SimulationHz: float32(math.Inf(1))},
		"negative simulation":    {SimulationHz: -1},
		"implausible simulation": {SimulationHz: 1001},
		"drift NaN":              {WorkerDriftMs: float32(math.NaN())},
		"negative drift":         {WorkerDriftMs: -1},
		"implausible drift":      {WorkerDriftMs: 60_001},
	} {
		t.Run("heartbeat "+name, func(t *testing.T) {
			if validHeartbeat(beat) {
				t.Fatal("malformed heartbeat should be rejected")
			}
		})
	}
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

func TestReconnectSupersedesTheParticipantsOldConnection(t *testing.T) {
	h := newHarness(t, nil)
	first := h.dial("alice")
	first.join()
	first.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	observer := h.dial("bob")
	observer.join()
	observer.await(func(e *pb.RoomEnvelope) bool { return e.GetPresence() != nil })

	reconnected := h.dial("alice")
	reconnected.join()
	superseded := first.await(func(e *pb.RoomEnvelope) bool {
		return e.GetError() != nil
	}).GetError()
	if superseded.Code != "session_superseded" {
		t.Fatalf("old connection error = %q, want session_superseded", superseded.Code)
	}
	presence := observer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetPresence() != nil
	}).GetPresence()

	aliceConnections := 0
	for _, peer := range presence.Peers {
		if peer.UserId == "alice" {
			aliceConnections++
			if peer.ClientId != reconnected.clientID {
				t.Fatalf("alice connection = %q, want %q", peer.ClientId, reconnected.clientID)
			}
		}
	}
	if aliceConnections != 1 {
		t.Fatalf("presence has %d alice connections, want 1", aliceConnections)
	}
}

func TestReconnectReceivesTheLatestRelayedAvatarPosition(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	accepted := host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	peer := h.dial("bob")
	peer.join()
	host.await(func(e *pb.RoomEnvelope) bool {
		presence := e.GetPresence()
		return presence != nil && len(presence.Peers) == 2
	})

	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			SceneRevision: accepted.SceneRevision,
			Entities: []*pb.EntityState{{
				EntityId:           "avatar:bob",
				QuantizedTransform: &pb.QuantizedTransform{X: 6125, Y: 2275},
			}},
		}},
	})
	peer.await(func(e *pb.RoomEnvelope) bool { return e.GetStateDelta() != nil })

	reconnected := h.dial("bob")
	rejoin := reconnected.join()
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(rejoin.SnapshotJson, &snapshot); err != nil {
		t.Fatalf("unmarshal reconnect snapshot: %v", err)
	}
	if len(snapshot.Avatars) != 1 {
		t.Fatalf("snapshot avatars = %#v, want bob's last canonical position", snapshot.Avatars)
	}
	if got := snapshot.Avatars[0]; got.EntityID != "avatar:bob" || got.Position.X != 61.25 || got.Position.Y != 22.75 {
		t.Fatalf("reconnect avatar = %#v", got)
	}
}

func TestPersistedAvatarRemainsValidAfterRoomProcessRestart(t *testing.T) {
	h := newHarness(t, nil)
	snapshot := emptySnapshot("test-canvas", 1, time.Now())
	snapshot.CheckpointRevision = 1
	snapshot.Avatars = []SnapshotAvatar{{
		EntityID: "avatar:returning-player",
		UserID:   "returning-player",
		Position: Vec2{X: 42, Y: 21},
	}}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if err := h.store.SaveSnapshot(context.Background(), SnapshotRecord{
		RoomID:             "test-canvas",
		CanvasID:           "test-canvas",
		CanvasVersion:      1,
		CheckpointRevision: 1,
		SnapshotRaw:        raw,
	}); err != nil {
		t.Fatalf("save snapshot: %v", err)
	}

	host := h.dial("alice")
	accepted := host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	observer := h.dial("bob")
	observer.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetPresence() != nil })

	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			SceneRevision: accepted.SceneRevision,
			Entities: []*pb.EntityState{{
				EntityId:           "avatar:returning-player",
				QuantizedTransform: &pb.QuantizedTransform{X: 4200, Y: 2100},
			}},
		}},
	})
	got := observer.await(func(e *pb.RoomEnvelope) bool { return e.GetStateDelta() != nil })
	if got.GetStateDelta().Entities[0].EntityId != "avatar:returning-player" {
		t.Fatalf("relayed entity = %q", got.GetStateDelta().Entities[0].EntityId)
	}
}

func TestParticipantOverlapIsScopedToOneRoomDuringTravel(t *testing.T) {
	h := newHarness(t, func(cfg *Config) {
		cfg.RoomTemplates = StaticRoomTemplates{
			"village": {CanvasID: "test-canvas", CanvasVersion: 1},
			"cave":    {CanvasID: "test-canvas", CanvasVersion: 1},
		}
	})

	oldVillage := h.dialRoom("village", "alice")
	oldVillage.join()
	oldVillage.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	cave := h.dialRoom("cave", "alice")
	cave.join()
	cave.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	returningVillage := h.dialRoom("village", "alice")
	returningVillage.join()
	superseded := oldVillage.await(func(e *pb.RoomEnvelope) bool {
		return e.GetError() != nil
	}).GetError()
	if superseded.Code != "session_superseded" {
		t.Fatalf("old village connection error = %q, want session_superseded", superseded.Code)
	}

	observer := h.dialRoom("cave", "bob")
	observer.join()
	presence := observer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetPresence() != nil
	}).GetPresence()
	users := make(map[string]bool, len(presence.Peers))
	for _, peer := range presence.Peers {
		users[peer.UserId] = true
	}
	if !users["alice"] || !users["bob"] {
		t.Fatalf("cave presence after village takeover = %#v, want alice and bob", users)
	}
}

func TestHostMayRetainAKnownAvatarAfterDisconnect(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	accepted := host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	peer := h.dial("bob")
	peer.join()
	host.await(func(e *pb.RoomEnvelope) bool {
		presence := e.GetPresence()
		return presence != nil && len(presence.Peers) == 2
	})
	_ = peer.conn.CloseNow()
	host.await(func(e *pb.RoomEnvelope) bool {
		presence := e.GetPresence()
		return presence != nil && len(presence.Peers) == 1
	})
	host.heartbeat()

	observer := h.dial("carol")
	observer.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetPresence() != nil })
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			SceneRevision: accepted.SceneRevision,
			Entities: []*pb.EntityState{{
				EntityId:           "avatar:bob",
				QuantizedTransform: &pb.QuantizedTransform{X: 1000, Y: 1000},
				Disabled:           true,
			}},
		}},
	})

	delta := observer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetStateDelta() != nil
	}).GetStateDelta()
	if len(delta.Entities) != 1 || delta.Entities[0].EntityId != "avatar:bob" {
		t.Fatalf("relayed entities = %#v, want retained avatar:bob", delta.Entities)
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
	// A durable mutation from the same client proves the loop kept running and
	// that no state delta arrived before it.
	peer.send(spawnCommand("cmd-1", 10, 10))

	got := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetStateDelta() != nil || e.GetItemMutationResult() != nil
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
		return e.GetStateDelta() != nil || e.GetItemMutationResult() != nil
	})
	if got.GetStateDelta() != nil {
		t.Fatal("the server relayed a state delta with a stale host epoch")
	}
}

func spawnCommand(id string, x, y float32) *pb.RoomEnvelope {
	return &pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId:        mutationID(id),
			Kind:              pb.ItemMutationKind_ITEM_MUTATION_SPAWN,
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
	result := owner.await(func(e *pb.RoomEnvelope) bool { return e.GetItemMutationResult() != nil }).GetItemMutationResult()
	if !result.Accepted {
		t.Fatalf("spawn rejected: %s", result.Message)
	}
	entityID := result.EntityId
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
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-steal"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
			EntityId:   entityID,
			Position:   &pb.Vec2{X: 1, Y: 1},
		}},
	})
	reject := other.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-steal")
	}).GetItemMutationResult()
	if reject.Accepted {
		t.Fatal("a non-owner moved another user's item")
	}
	if reject.Message != "not_owner" {
		t.Errorf("reject reason = %q, want not_owner", reject.Message)
	}

	// The owner may move it.
	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-move"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
			EntityId:   entityID,
			Position:   &pb.Vec2{X: 40, Y: 50},
		}},
	})
	accepted := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-move")
	}).GetItemMutationResult()
	if !accepted.Accepted {
		t.Fatalf("owner move rejected: %s", accepted.Message)
	}
	if accepted.SceneRevision <= result.SceneRevision {
		t.Error("the scene revision did not increase")
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-scale"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_SCALE,
			EntityId:   entityID,
			Scale:      1.75,
		}},
	})
	scaled := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-scale")
	}).GetItemMutationResult()
	if !scaled.Accepted {
		t.Fatalf("owner scale rejected: %s", scaled.Message)
	}
	var scaledItem SnapshotItem
	if err := json.Unmarshal(scaled.ItemInstanceJson, &scaledItem); err != nil {
		t.Fatalf("scaled item json: %v", err)
	}
	if scaledItem.Transform.Scale != 1.75 {
		t.Errorf("scale = %v, want 1.75", scaledItem.Transform.Scale)
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-isolate"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_ISOLATION,
			EntityId:   entityID,
			Isolated:   true,
		}},
	})
	isolated := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-isolate")
	}).GetItemMutationResult()
	if !isolated.Accepted {
		t.Fatalf("owner isolation rejected: %s", isolated.Message)
	}
	var isolatedItem SnapshotItem
	if err := json.Unmarshal(isolated.ItemInstanceJson, &isolatedItem); err != nil {
		t.Fatalf("isolated item json: %v", err)
	}
	if !isolatedItem.Isolated {
		t.Error("item isolation was not persisted")
	}

	other.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-steal-isolation"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_ISOLATION,
			EntityId:   entityID,
		}},
	})
	isolationReject := other.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-steal-isolation")
	}).GetItemMutationResult()
	if isolationReject.Accepted || isolationReject.Message != "not_owner" {
		t.Errorf("non-owner isolation accepted=%v reason=%q", isolationReject.Accepted, isolationReject.Message)
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId:        mutationID("cmd-disable-collisions"),
			Kind:              pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS,
			EntityId:          entityID,
			CollisionsEnabled: false,
		}},
	})
	collisions := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-disable-collisions")
	}).GetItemMutationResult()
	if !collisions.Accepted {
		t.Fatalf("owner collision change rejected: %s", collisions.Message)
	}
	var collisionItem SnapshotItem
	if err := json.Unmarshal(collisions.ItemInstanceJson, &collisionItem); err != nil {
		t.Fatalf("collision item json: %v", err)
	}
	if !collisionItem.CollisionsDisabled {
		t.Error("disabled collisions were not persisted")
	}

	other.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId:        mutationID("cmd-steal-collisions"),
			Kind:              pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS,
			EntityId:          entityID,
			CollisionsEnabled: true,
		}},
	})
	collisionReject := other.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-steal-collisions")
	}).GetItemMutationResult()
	if collisionReject.Accepted || collisionReject.Message != "not_owner" {
		t.Errorf("non-owner collision change accepted=%v reason=%q", collisionReject.Accepted, collisionReject.Message)
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-scale-too-large"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_SCALE,
			EntityId:   entityID,
			Scale:      8,
		}},
	})
	scaleReject := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-scale-too-large")
	}).GetItemMutationResult()
	if scaleReject.Accepted || scaleReject.Message != "scale_out_of_range" {
		t.Errorf("large scale accepted=%v reason=%q", scaleReject.Accepted, scaleReject.Message)
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-far")
	}).GetItemMutationResult()
	if reject.Accepted || reject.Message != "outside_canvas" {
		t.Errorf("got accepted=%v reason=%q, want outside_canvas", reject.Accepted, reject.Message)
	}

	// The canvas limit is two items.
	for i, id := range []string{"cmd-a", "cmd-b"} {
		owner.send(spawnCommand(id, float32(10+i), 10))
		r := owner.await(func(e *pb.RoomEnvelope) bool {
			r := e.GetItemMutationResult()
			return r != nil && r.MutationId == mutationID(id)
		}).GetItemMutationResult()
		if !r.Accepted {
			t.Fatalf("spawn %s rejected: %s", id, r.Message)
		}
	}
	owner.send(spawnCommand("cmd-c", 12, 10))
	limit := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-c")
	}).GetItemMutationResult()
	if limit.Accepted || limit.Message != "item_limit_reached" {
		t.Errorf("got accepted=%v reason=%q, want item_limit_reached", limit.Accepted, limit.Message)
	}
}

func TestSpawnRequiresAKnownDefinitionVersion(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	unknown := spawnCommand("cmd-unknown", 10, 10)
	unknown.GetItemMutation().DefinitionId = "invented"
	owner.send(unknown)
	unknownResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-unknown")
	}).GetItemMutationResult()
	if unknownResult.Accepted || unknownResult.Message != "unknown_definition" {
		t.Errorf("unknown definition: accepted=%v reason=%q", unknownResult.Accepted, unknownResult.Message)
	}

	wrongVersion := spawnCommand("cmd-version", 10, 10)
	wrongVersion.GetItemMutation().DefinitionVersion = 99
	owner.send(wrongVersion)
	versionResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-version")
	}).GetItemMutationResult()
	if versionResult.Accepted || versionResult.Message != "definition_version_mismatch" {
		t.Errorf("wrong version: accepted=%v reason=%q", versionResult.Accepted, versionResult.Message)
	}
}

func TestSpawnEnforcesTheComplexItemLimit(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	first := spawnCommand("cmd-complex-1", 10, 10)
	first.GetItemMutation().DefinitionId = "complex-rocket"
	owner.send(first)
	firstResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-complex-1")
	}).GetItemMutationResult()
	if !firstResult.Accepted {
		t.Fatalf("first complex item rejected: %s", firstResult.Message)
	}

	second := spawnCommand("cmd-complex-2", 20, 20)
	second.GetItemMutation().DefinitionId = "complex-rocket"
	owner.send(second)
	secondResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-complex-2")
	}).GetItemMutationResult()
	if secondResult.Accepted || secondResult.Message != "complex_item_limit_reached" {
		t.Errorf("second complex item: accepted=%v reason=%q", secondResult.Accepted, secondResult.Message)
	}
}

func TestDurableConfigMustMatchTheDefinitionSchema(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	badSpawn := spawnCommand("cmd-bad-spawn", 10, 10)
	badSpawn.GetItemMutation().ConfigJson = []byte(`{"thrust":"fast"}`)
	owner.send(badSpawn)
	badSpawnResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-bad-spawn")
	}).GetItemMutationResult()
	if badSpawnResult.Accepted || badSpawnResult.Message != "config_schema_mismatch" {
		t.Errorf("bad spawn config: accepted=%v reason=%q", badSpawnResult.Accepted, badSpawnResult.Message)
	}

	owner.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	if !spawned.Accepted {
		t.Fatalf("valid spawn rejected: %s", spawned.Message)
	}

	owner.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-bad-config"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
			EntityId:   spawned.EntityId,
			ConfigJson: []byte(`{"thrust":30,"admin":true}`),
		}},
	})
	badConfigResult := owner.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-bad-config")
	}).GetItemMutationResult()
	if badConfigResult.Accepted || badConfigResult.Message != "config_schema_mismatch" {
		t.Errorf("bad config mutation: accepted=%v reason=%q", badConfigResult.Accepted, badConfigResult.Message)
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-after-yield")
	}).GetItemMutationResult()
	if !result.Accepted {
		t.Fatalf("command after yield rejected: %s", result.Message)
	}
	if len(h.server.Rooms()) != 1 {
		t.Error("the room should still be awake")
	}
}

func TestAbruptlyClosedRoomSleepsWithoutClaimingNormalization(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	firstGrant := owner.await(func(e *pb.RoomEnvelope) bool {
		control := e.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()
	owner.send(spawnCommand("cmd-spawn", 20, 30))
	owner.await(func(e *pb.RoomEnvelope) bool { return e.GetItemMutationResult() != nil })

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
	if stored.Normalized {
		t.Error("an abrupt disconnect must not pretend the host normalized behavior state")
	}
	var sleptSnapshot CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &sleptSnapshot); err != nil {
		t.Fatalf("unmarshal sleeping snapshot: %v", err)
	}
	if sleptSnapshot.Normalized {
		t.Error("the abrupt fallback snapshot is incorrectly marked normalized")
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
	nextGrant := next.await(func(e *pb.RoomEnvelope) bool {
		control := e.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	}).GetHostControl()
	if nextGrant.HostEpoch <= firstGrant.HostEpoch {
		t.Errorf("host epoch after wake = %d, want greater than %d", nextGrant.HostEpoch, firstGrant.HostEpoch)
	}
}

func TestRoomPreservesAHostNormalizedFinalCheckpointOnSleep(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(spawnCommand("cmd-spawn", 20, 30))
	result := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetItemMutationResult() != nil
	}).GetItemMutationResult()
	entityID := result.EntityId

	finalSnapshot := CanvasSnapshot{
		SchemaVersion:      1,
		CanvasID:           "test-canvas",
		CanvasVersion:      1,
		SceneRevision:      result.SceneRevision,
		HostEpoch:          host.hostEpoch,
		CheckpointRevision: 1,
		Tick:               120,
		CapturedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		Normalized:         true,
		Items: []SnapshotItem{{
			EntityID:      entityID,
			Transform:     Transform{X: 24, Y: 33},
			BehaviorState: json.RawMessage(`{"phase":"idle"}`),
		}},
	}
	raw, err := json.Marshal(finalSnapshot)
	if err != nil {
		t.Fatalf("marshal final snapshot: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			Tick:               120,
			SnapshotJson:       raw,
			Final:              true,
		}},
	})

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		stored, loadErr := h.store.LoadSnapshot(context.Background(), "test-canvas")
		if loadErr == nil && stored.CheckpointRevision == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = host.conn.CloseNow()

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(h.server.Rooms()) > 0 {
		time.Sleep(20 * time.Millisecond)
	}
	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if !stored.Normalized {
		t.Error("the server discarded the host's final normalization marker")
	}
	var snapshot CanvasSnapshot
	if err := json.Unmarshal(stored.SnapshotRaw, &snapshot); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if !snapshot.Normalized || snapshot.Items[0].Transform.X != 24 {
		t.Fatalf("stored final snapshot = %+v", snapshot)
	}
}

func TestPeriodicCheckpointPersistenceDoesNotBlockRealtimeRelay(t *testing.T) {
	var blocked *blockingSnapshotStore
	h := newHarness(t, func(cfg *Config) {
		blocked = &blockingSnapshotStore{
			Store:   cfg.Store,
			started: make(chan struct{}),
			release: make(chan struct{}),
		}
		cfg.Store = blocked
	})
	defer close(blocked.release)

	host := h.dial("alice")
	accepted := host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()

	raw, err := json.Marshal(CanvasSnapshot{
		SchemaVersion:      1,
		CanvasID:           "test-canvas",
		CanvasVersion:      1,
		SceneRevision:      accepted.SceneRevision,
		HostEpoch:          host.hostEpoch,
		CheckpointRevision: 1,
		Tick:               60,
		CapturedAt:         time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("marshal checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 1,
			Tick:               60,
			SnapshotJson:       raw,
		}},
	})

	select {
	case <-blocked.started:
	case <-time.After(time.Second):
		t.Fatal("checkpoint persistence did not start")
	}

	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Tick:      61,
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{
			SceneRevision: accepted.SceneRevision,
			Entities: []*pb.EntityState{{
				EntityId:           "avatar:alice",
				QuantizedTransform: &pb.QuantizedTransform{X: 1200, Y: 900},
			}},
		}},
	})
	relayed := peer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetStateDelta() != nil
	})
	if relayed.Tick != 61 {
		t.Fatalf("relayed tick = %d, want 61", relayed.Tick)
	}
}

func TestFinalCheckpointRequiresANormalizedSnapshot(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	host.send(spawnCommand("cmd-spawn", 20, 30))
	result := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetItemMutationResult() != nil
	}).GetItemMutationResult()

	bad, err := json.Marshal(CanvasSnapshot{
		SchemaVersion:      1,
		CanvasID:           "test-canvas",
		CanvasVersion:      1,
		SceneRevision:      result.SceneRevision,
		HostEpoch:          host.hostEpoch,
		CheckpointRevision: 1,
		CapturedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		Normalized:         false,
		Items: []SnapshotItem{{
			EntityID:  result.EntityId,
			Transform: Transform{X: 20, Y: 30},
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
			SnapshotJson:       bad,
			Final:              true,
		}},
	})
	badTimers, err := json.Marshal(CanvasSnapshot{
		SchemaVersion:      1,
		CanvasID:           "test-canvas",
		CanvasVersion:      1,
		SceneRevision:      result.SceneRevision,
		HostEpoch:          host.hostEpoch,
		CheckpointRevision: 2,
		CapturedAt:         time.Now().UTC().Format(time.RFC3339Nano),
		Normalized:         true,
		Items: []SnapshotItem{{
			EntityID:  result.EntityId,
			Transform: Transform{X: 20, Y: 30},
			BehaviorTimers: []BehaviorTimer{{
				Key:            "countdown",
				RemainingTicks: 10,
			}},
		}},
	})
	if err != nil {
		t.Fatalf("marshal timer checkpoint: %v", err)
	}
	host.send(&pb.RoomEnvelope{
		RoomId:    "test-canvas",
		HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_Checkpoint{Checkpoint: &pb.Checkpoint{
			CheckpointRevision: 2,
			SnapshotJson:       badTimers,
			Final:              true,
		}},
	})
	// A later mutation result proves the room processed the checkpoint first.
	host.send(spawnCommand("cmd-after-checkpoint", 40, 30))
	host.await(func(e *pb.RoomEnvelope) bool {
		result := e.GetItemMutationResult()
		return result != nil && result.MutationId == mutationID("cmd-after-checkpoint")
	})

	stored, err := h.store.LoadSnapshot(context.Background(), "test-canvas")
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if stored.CheckpointRevision != 0 {
		t.Errorf("rejected checkpoint revision was stored: %d", stored.CheckpointRevision)
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-sync")
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	entityID := spawned.EntityId

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
			BehaviorTimers: []BehaviorTimer{{
				Key:            "countdown",
				ElapsedTicks:   120,
				RemainingTicks: 60,
			}},
			VisualVariant: "flying",
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
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-move-after-checkpoint"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
			EntityId:   entityID,
			Position:   &pb.Vec2{X: 45, Y: 50},
		}},
	})
	moved := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-move-after-checkpoint")
	}).GetItemMutationResult()
	if !moved.Accepted {
		t.Fatalf("owner move rejected after checkpoint: %s", moved.Message)
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
	if len(item.BehaviorTimers) != 1 || item.BehaviorTimers[0].RemainingTicks != 60 {
		t.Errorf("behavior timers = %+v, want countdown with 60 ticks remaining", item.BehaviorTimers)
	}
}

func TestCheckpointDoesNotPersistAnUncommittedPreviewTransform(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	host.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	entityID := spawned.EntityId

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
			ClientSessionId:      "checkpoint-preview-session",
			EditSessionId:        "checkpoint-preview-edit",
			EntityId:             entityID,
			ObservedItemRevision: spawned.ItemRevision,
		}},
	})
	host.await(func(e *pb.RoomEnvelope) bool {
		result := e.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "checkpoint-preview-edit" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE
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
			Transform:         Transform{X: 40, Y: 50},
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

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-config"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
			EntityId:   entityID,
			ConfigJson: []byte(`{"thrust":30}`),
		}},
	})
	configured := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-config")
	}).GetItemMutationResult()
	var item SnapshotItem
	if err := json.Unmarshal(configured.ItemInstanceJson, &item); err != nil {
		t.Fatalf("item instance json: %v", err)
	}
	if item.Transform.X != 20 || item.Transform.Y != 30 {
		t.Errorf(
			"transform = (%v,%v), want committed value (20,30)",
			item.Transform.X,
			item.Transform.Y,
		)
	}
}

func TestPreviewRevertsWhenTheEditingPeerDisconnects(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()

	peer.send(spawnCommand("cmd-spawn", 20, 30))
	spawned := peer.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	entityID := spawned.EntityId

	peer.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_BeginItemEdit{BeginItemEdit: &pb.BeginItemEdit{
			ClientSessionId:      "disconnect-preview-session",
			EditSessionId:        "disconnect-preview-edit",
			EntityId:             entityID,
			ObservedItemRevision: spawned.ItemRevision,
		}},
	})
	peer.await(func(e *pb.RoomEnvelope) bool {
		result := e.GetItemEditSessionResult()
		return result != nil && result.EditSessionId == "disconnect-preview-edit" &&
			result.Status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE
	})
	peer.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemEditPreview{ItemEditPreview: &pb.ItemEditPreview{
			ClientSessionId: "disconnect-preview-session",
			EditSessionId:   "disconnect-preview-edit",
			EntityId:        entityID,
			PreviewSequence: 1,
			Position:        &pb.Vec2{X: 40, Y: 50},
			Scale:           1,
		}},
	})
	host.await(func(e *pb.RoomEnvelope) bool {
		preview := e.GetItemEditPreview()
		return preview != nil && preview.EditSessionId == "disconnect-preview-edit" && !preview.Revert
	})

	_ = peer.conn.CloseNow()
	revert := host.await(func(e *pb.RoomEnvelope) bool {
		preview := e.GetItemEditPreview()
		return preview != nil && preview.EditSessionId == "disconnect-preview-edit" && preview.Revert
	}).GetItemEditPreview()
	if revert.Position == nil || revert.Position.X != 20 || revert.Position.Y != 30 {
		t.Fatalf("revert position = %+v, want (20,30)", revert.Position)
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

	// A following accepted durable mutation gives the room loop an ordered
	// synchronization point and persists its current snapshot.
	host.send(spawnCommand("cmd-sync", 10, 10))
	host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-sync")
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	entityID := spawned.EntityId

	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-move"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
			EntityId:   entityID,
			Position:   &pb.Vec2{X: 40, Y: 50},
		}},
	})
	host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-move")
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
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-config"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
			EntityId:   entityID,
			ConfigJson: []byte(`{"thrust":30}`),
		}},
	})
	configured := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-config")
	}).GetItemMutationResult()
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
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-spawn")
	}).GetItemMutationResult()
	entityID := spawned.EntityId

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
		Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
			MutationId: mutationID("cmd-config"),
			Kind:       pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
			EntityId:   entityID,
			ConfigJson: []byte(`{"thrust":30}`),
		}},
	})
	configured := host.await(func(e *pb.RoomEnvelope) bool {
		r := e.GetItemMutationResult()
		return r != nil && r.MutationId == mutationID("cmd-config")
	}).GetItemMutationResult()
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
						QuantizedTransform: &pb.QuantizedTransform{
							X: 2500,
							Y: 3000,
						},
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
						EntityId:           "host-invented-item",
						QuantizedTransform: &pb.QuantizedTransform{X: 2500, Y: 3000},
					}},
				}
			},
		},
		{
			name: "out-of-bounds transform",
			state: func(entityID string, sceneRevision uint64) *pb.StateDelta {
				return &pb.StateDelta{
					SceneRevision: sceneRevision,
					Entities: []*pb.EntityState{{
						EntityId:           entityID,
						QuantizedTransform: &pb.QuantizedTransform{X: math.MaxInt32},
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
						EntityId:           entityID,
						QuantizedTransform: &pb.QuantizedTransform{X: 2500, Y: 3000},
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
				r := e.GetItemMutationResult()
				return r != nil && r.MutationId == mutationID("cmd-spawn")
			}).GetItemMutationResult()
			// Consume the accepted mutation on the peer before testing relay order.
			peer.await(func(e *pb.RoomEnvelope) bool {
				r := e.GetItemMutationResult()
				return r != nil && r.MutationId == mutationID("cmd-spawn")
			})

			host.send(&pb.RoomEnvelope{
				RoomId:    "test-canvas",
				HostEpoch: host.hostEpoch,
				Payload: &pb.RoomEnvelope_StateDelta{StateDelta: tt.state(
					spawned.EntityId,
					spawned.SceneRevision,
				)},
			})
			host.send(&pb.RoomEnvelope{
				RoomId: "test-canvas",
				Payload: &pb.RoomEnvelope_ItemMutation{ItemMutation: &pb.ItemMutation{
					MutationId: mutationID("cmd-sync"),
					Kind:       pb.ItemMutationKind_ITEM_MUTATION_CONFIG,
					EntityId:   spawned.EntityId,
					ConfigJson: []byte(`{"thrust":30}`),
				}},
			})

			got := peer.await(func(e *pb.RoomEnvelope) bool {
				return e.GetStateDelta() != nil ||
					(e.GetItemMutationResult() != nil && e.GetItemMutationResult().MutationId == mutationID("cmd-sync"))
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
			RoomId:          "test-canvas",
			ProtocolVersion: 99,
		}},
	})
	got := client.await(func(e *pb.RoomEnvelope) bool { return e.GetError() != nil }).GetError()
	if got.Code != "protocol_mismatch" {
		t.Errorf("error code = %q, want protocol_mismatch", got.Code)
	}
	if got.ServerProtocolVersion != 8 {
		t.Errorf("server protocol version = %d, want 8", got.ServerProtocolVersion)
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

func TestQueryStringIdentityIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(h.http.URL, "http") +
		"/v1/realtime/rooms/test-canvas?user=query-only-client"
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("dial with only query-string identity succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %v, want 401", resp)
	}
}

func TestGetRoomReturnsTheResolvedCanvasDefinition(t *testing.T) {
	h := newHarness(t, nil)
	resp, err := http.Get(h.http.URL + "/v1/rooms/test-canvas")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	var body roomResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.RoomID != "test-canvas" || body.CanvasID != "test-canvas" ||
		body.CanvasVersion != 1 || body.TickRate != 60 {
		t.Errorf("unexpected body: %+v", body)
	}
}

func TestRemovedCanvasInstanceRouteDoesNotExist(t *testing.T) {
	h := newHarness(t, nil)
	resp, err := http.Get(h.http.URL + "/v1/canvases/test-canvas")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("removed canvas route status = %d, want 404", resp.StatusCode)
	}
}

func TestNewRefusesAConfigWithoutAStore(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("New accepted a Config with no Store")
	}
}

func TestNewRefusesAConfigWithoutAuthentication(t *testing.T) {
	if _, err := New(Config{Store: NewMemoryStore()}); err == nil {
		t.Fatal("New accepted a Config with no Authenticator")
	}
}
