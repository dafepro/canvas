package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

func TestTwoServersFenceOwnershipAndContinueFromCanonicalSnapshot(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	store := NewMemoryStore()
	store.PutCanvas(CanvasRecord{CanvasID: "test-canvas", Version: 1, DefinitionRaw: json.RawMessage(canvasJSON)})
	coordinator := NewMemoryRoomCoordinatorWithClock(func() time.Time { return now })
	newReplica := func(id string) *Server {
		server, err := New(Config{
			Store: store, Auth: DevAuthenticator(),
			RoomTemplates:   StaticRoomTemplates{"room": {CanvasID: "test-canvas", CanvasVersion: 1}},
			RoomCoordinator: coordinator, ReplicaID: id,
			RoomOwnershipTTL: time.Second, RoomOwnershipRenewInterval: 500 * time.Millisecond,
			HeartbeatInterval: time.Hour, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return server
	}
	first := newReplica("replica-a")
	second := newReplica("replica-b")
	firstRoom, err := first.roomFor(t.Context(), "room")
	if err != nil {
		t.Fatal(err)
	}
	firstRoom.sceneRevision = 7
	firstRoom.snapshot.SceneRevision = 7
	firstRoom.snapshotRaw, _ = json.Marshal(firstRoom.snapshot)
	if err := store.SaveSnapshot(t.Context(), firstRoom.snapshotRecord()); err != nil {
		t.Fatal(err)
	}
	if _, err := second.roomFor(t.Context(), "room"); !errors.Is(err, ErrRoomOwnershipHeld) {
		t.Fatalf("second owner before expiry = %v", err)
	}

	now = now.Add(2 * time.Second)
	secondRoom, err := second.roomFor(t.Context(), "room")
	if err != nil {
		t.Fatal(err)
	}
	if secondRoom.sceneRevision != 7 {
		t.Fatalf("failover scene revision = %d, want 7", secondRoom.sceneRevision)
	}
	if secondRoom.ownership.Generation <= firstRoom.ownership.Generation {
		t.Fatalf("failover generation = %d, want > %d",
			secondRoom.ownership.Generation, firstRoom.ownership.Generation)
	}
	stale := firstRoom.snapshotRecord()
	stale.CheckpointRevision = 999
	if err := store.SaveSnapshot(context.Background(), stale); !errors.Is(err, ErrRoomOwnershipFenced) {
		t.Fatalf("stale owner snapshot = %v, want ErrRoomOwnershipFenced", err)
	}

	drainCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := second.Drain(drainCtx); err != nil {
		t.Fatal(err)
	}
	if _, err := second.roomFor(t.Context(), "room"); !errors.Is(err, ErrServerDraining) {
		t.Fatalf("roomFor after drain = %v, want ErrServerDraining", err)
	}
}

func TestTwoRealtimeServicesRouteOnlyToTheCurrentRoomOwner(t *testing.T) {
	store := NewMemoryStore()
	store.PutCanvas(CanvasRecord{CanvasID: "test-canvas", Version: 1, DefinitionRaw: json.RawMessage(canvasJSON)})
	coordinator := NewMemoryRoomCoordinator()
	newReplica := func(id string) *Server {
		server, err := New(Config{
			Store: store, Auth: DevAuthenticator(),
			RoomTemplates:   StaticRoomTemplates{"room": {CanvasID: "test-canvas", CanvasVersion: 1}},
			RoomCoordinator: coordinator, ReplicaID: id,
			RoomOwnershipTTL: time.Second, RoomOwnershipRenewInterval: 250 * time.Millisecond,
			HeartbeatInterval: 25 * time.Millisecond, SleepGrace: time.Second,
			AllowedOrigins: []string{"*"}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return server
	}
	first := newReplica("replica-a")
	second := newReplica("replica-b")
	firstHTTP := httptest.NewServer(first.Handler())
	secondHTTP := httptest.NewServer(second.Handler())
	t.Cleanup(firstHTTP.Close)
	t.Cleanup(secondHTTP.Close)

	dial := func(base, user string) (*websocket.Conn, context.Context) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		t.Cleanup(cancel)
		conn, _, err := websocket.Dial(ctx,
			"ws"+strings.TrimPrefix(base, "http")+"/v1/realtime/rooms/room",
			&websocket.DialOptions{HTTPHeader: http.Header{"X-User-Id": []string{user}}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.CloseNow() })
		join, _ := proto.Marshal(&pb.RoomEnvelope{RoomId: "room", Payload: &pb.RoomEnvelope_Join{
			Join: &pb.Join{RoomId: "room", ProtocolVersion: 8},
		}})
		if err := conn.Write(ctx, websocket.MessageBinary, join); err != nil {
			t.Fatal(err)
		}
		return conn, ctx
	}
	readUntil := func(conn *websocket.Conn, ctx context.Context, match func(*pb.RoomEnvelope) bool) *pb.RoomEnvelope {
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			envelope := &pb.RoomEnvelope{}
			if err := proto.Unmarshal(raw, envelope); err != nil {
				t.Fatal(err)
			}
			if match(envelope) {
				return envelope
			}
		}
	}

	owned, ownedCtx := dial(firstHTTP.URL, "alice")
	readUntil(owned, ownedCtx, func(envelope *pb.RoomEnvelope) bool { return envelope.GetJoinAccepted() != nil })
	routed, routedCtx := dial(secondHTTP.URL, "bob")
	refusal := readUntil(routed, routedCtx, func(envelope *pb.RoomEnvelope) bool { return envelope.GetError() != nil }).GetError()
	if refusal.Code != "room_owned_elsewhere" {
		t.Fatalf("non-owner routing error = %#v", refusal)
	}

	drainCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := first.Drain(drainCtx); err != nil {
		t.Fatal(err)
	}
	failover, failoverCtx := dial(secondHTTP.URL, "bob")
	accepted := readUntil(failover, failoverCtx, func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetJoinAccepted() != nil
	}).GetJoinAccepted()
	if accepted.ClientId == "" {
		t.Fatal("failover service did not accept the room")
	}
}
