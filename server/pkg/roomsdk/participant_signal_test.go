package roomsdk

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func TestParticipantSignalsAreAllowlistedAttributedAndRateLimited(t *testing.T) {
	now := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	h := newHarness(t, func(cfg *Config) {
		cfg.Now = func() time.Time { return now }
		cfg.ParticipantSignals = ParticipantSignalPolicy{
			AllowedKinds:    map[string]struct{}{"zoomigo.emote.wave": {}},
			MaxPayloadBytes: 0,
			MinInterval:     2 * time.Second,
		}
	})
	alice := h.dial("alice")
	alice.join()
	bob := h.dial("bob")
	bob.join()
	alice.await(func(envelope *pb.RoomEnvelope) bool {
		return len(envelope.GetPresence().GetPeers()) == 2
	})
	bob.await(func(envelope *pb.RoomEnvelope) bool {
		return len(envelope.GetPresence().GetPeers()) == 2
	})

	alice.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ParticipantSignal{ParticipantSignal: &pb.ParticipantSignal{
			Kind: "zoomigo.emote.wave",
		}},
	})
	relay := bob.await(func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetParticipantSignal() != nil
	})
	if relay.SenderClientId != alice.clientID ||
		relay.GetParticipantSignal().GetKind() != "zoomigo.emote.wave" {
		t.Fatalf("relayed signal = %#v", relay)
	}

	alice.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ParticipantSignal{ParticipantSignal: &pb.ParticipantSignal{
			Kind: "zoomigo.emote.unapproved",
		}},
	})
	alice.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_ParticipantSignal{ParticipantSignal: &pb.ParticipantSignal{
			Kind: "zoomigo.emote.wave",
		}},
	})

	readCtx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, _, err := bob.conn.Read(readCtx)
	if !errors.Is(err, context.DeadlineExceeded) && websocket.CloseStatus(err) != -1 {
		t.Fatalf("rate-limited signal read = %v, want deadline", err)
	}
}
