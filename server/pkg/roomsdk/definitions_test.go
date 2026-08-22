package roomsdk

import (
	"testing"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// joinWith sends a Join that declares the item definitions the client holds.
func joinWith(c *testClient, definitions ...*pb.DefinitionVersion) {
	c.send(&pb.RoomEnvelope{
		RoomId: "test-canvas",
		Payload: &pb.RoomEnvelope_Join{Join: &pb.Join{
			CanvasId:        "test-canvas",
			ProtocolVersion: 1,
			Definitions:     definitions,
		}},
	})
}

// Spec 20. A client that lacks an item definition the scene uses must not hold
// the simulation lease.
func TestClientWithoutADefinitionLosesTheHostLease(t *testing.T) {
	h := newHarness(t, nil)

	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	joinWith(host, &pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})

	// The peer holds an older version of the definition the scene will use.
	peer := h.dial("bob")
	peer.join()
	joinWith(peer, &pb.DefinitionVersion{DefinitionId: "rocket", Version: 0})

	host.send(spawnCommand("cmd-spawn", 20, 30))
	result := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetDurableResult() != nil
	}).GetDurableResult()
	if !result.Accepted {
		t.Fatalf("spawn rejected: %s", result.RejectReason)
	}

	failure := peer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetError() != nil
	}).GetError()
	if failure.Code != "definition_mismatch" {
		t.Fatalf("error code = %q, want definition_mismatch", failure.Code)
	}

	// The peer is now blocked from the lease, and presence says so.
	presence := peer.await(func(e *pb.RoomEnvelope) bool {
		presence := e.GetPresence()
		if presence == nil {
			return false
		}
		for _, entry := range presence.Peers {
			if entry.ClientId == peer.clientID && !entry.HostEligible {
				return true
			}
		}
		return false
	})
	if presence == nil {
		t.Fatal("presence never reported the peer as blocked")
	}
}

// A client that holds every definition the scene uses stays eligible.
func TestClientWithEveryDefinitionStaysEligible(t *testing.T) {
	h := newHarness(t, nil)

	host := h.dial("alice")
	host.join()
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	joinWith(host, &pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})

	host.send(spawnCommand("cmd-spawn", 20, 30))
	// Read until the result of the spawn. No refusal may appear on the way,
	// because the host holds the definition the new item uses.
	for {
		envelope := host.read()
		if failure := envelope.GetError(); failure != nil {
			t.Fatalf("unexpected refusal: %s %s", failure.Code, failure.Message)
		}
		if control := envelope.GetHostControl(); control != nil &&
			control.Kind == pb.HostControlKind_HOST_CONTROL_REVOKED {
			t.Fatal("the host lost its lease although it holds every definition")
		}
		if result := envelope.GetDurableResult(); result != nil {
			if !result.Accepted {
				t.Fatalf("spawn rejected: %s", result.RejectReason)
			}
			return
		}
	}
}
