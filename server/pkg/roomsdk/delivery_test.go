package roomsdk

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func realtimeEnvelope() *pb.RoomEnvelope {
	return &pb.RoomEnvelope{
		Payload: &pb.RoomEnvelope_StateDelta{StateDelta: &pb.StateDelta{}},
	}
}

func reliableEnvelope(code string) *pb.RoomEnvelope {
	return &pb.RoomEnvelope{
		Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{Code: code}},
	}
}

func TestReliableEnvelopeDisplacesQueuedRealtimeState(t *testing.T) {
	client := newClient("slow-client", Identity{UserID: "alice"}, 1)
	if !client.enqueue(realtimeEnvelope()) {
		t.Fatal("initial realtime envelope was not queued")
	}
	if !client.enqueue(reliableEnvelope("important")) {
		t.Fatal("reliable envelope was dropped behind repairable realtime state")
	}

	got := <-client.send
	if got.GetError().GetCode() != "important" {
		t.Fatalf("queued payload = %T, want the reliable protocol error", got.Payload)
	}
}

func TestReliableQueueSaturationClosesTheSlowClient(t *testing.T) {
	client := newClient("slow-client", Identity{UserID: "alice"}, 1)
	if !client.enqueue(reliableEnvelope("first")) {
		t.Fatal("initial reliable envelope was not queued")
	}
	room := &Room{
		roomID: "delivery-room",
		cfg:    &Config{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
	}

	room.sendTo(client, reliableEnvelope("second"))
	select {
	case <-client.closeOnce:
	case <-time.After(time.Second):
		t.Fatal("slow client remained connected after reliable queue saturation")
	}
}

func TestReliableInboundWaitsForRoomCapacity(t *testing.T) {
	inbox := make(chan inbound, 1)
	inbox <- inbound{envelope: realtimeEnvelope()}
	delivered := make(chan bool, 1)
	go func() {
		delivered <- enqueueInbound(context.Background(), inbox, inbound{
			envelope: reliableEnvelope("mutation-result"),
		})
	}()

	select {
	case <-delivered:
		t.Fatal("reliable inbound returned while the room inbox was full")
	case <-time.After(20 * time.Millisecond):
	}
	<-inbox
	if !<-delivered {
		t.Fatal("reliable inbound was not delivered after room capacity returned")
	}
	if got := <-inbox; got.envelope.GetError().GetCode() != "mutation-result" {
		t.Fatalf("delivered payload = %T, want reliable protocol error", got.envelope.Payload)
	}
}

func TestRealtimeInboundDropsWhenRoomInboxIsFull(t *testing.T) {
	inbox := make(chan inbound, 1)
	inbox <- inbound{envelope: reliableEnvelope("occupied")}
	if enqueueInbound(context.Background(), inbox, inbound{envelope: realtimeEnvelope()}) {
		t.Fatal("repairable realtime input blocked or displaced reliable room work")
	}
}
