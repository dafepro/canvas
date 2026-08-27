package roomsdk

import (
	"testing"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// Spec 20. A client that lacks an item definition the scene uses must not hold
// the simulation lease.
func TestClientWithoutADefinitionLosesTheHostLease(t *testing.T) {
	h := newHarness(t, nil)

	host := h.dial("alice")
	host.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	// The peer holds an older version of the definition the scene will use.
	peer := h.dial("bob")
	peer.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 0})

	host.send(spawnCommand("cmd-spawn", 20, 30))
	result := host.await(func(e *pb.RoomEnvelope) bool {
		return e.GetItemMutationResult() != nil
	}).GetItemMutationResult()
	if !result.Accepted {
		t.Fatalf("spawn rejected: %s", result.Message)
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

func TestClientWithANewerDefinitionLosesTheHostLease(t *testing.T) {
	h := newHarness(t, nil)

	host := h.dial("alice")
	host.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

	newer := h.dial("bob")
	newer.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 2})

	host.send(spawnCommand("cmd-spawn", 20, 30))
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetItemMutationResult() != nil })

	failure := newer.await(func(e *pb.RoomEnvelope) bool {
		return e.GetError() != nil
	}).GetError()
	if failure.Code != "definition_mismatch" {
		t.Fatalf("error code = %q, want definition_mismatch", failure.Code)
	}
}

// A client that holds every definition the scene uses stays eligible.
func TestClientWithEveryDefinitionStaysEligible(t *testing.T) {
	h := newHarness(t, nil)

	host := h.dial("alice")
	host.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })

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
		if result := envelope.GetItemMutationResult(); result != nil {
			if !result.Accepted {
				t.Fatalf("spawn rejected: %s", result.Message)
			}
			return
		}
	}
}

func TestIncompatibleFirstClientNeverReceivesTheHostLease(t *testing.T) {
	h := newHarness(t, nil)
	host := h.dial("alice")
	host.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 1})
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetHostControl() != nil })
	host.send(spawnCommand("cmd-spawn", 20, 30))
	host.await(func(e *pb.RoomEnvelope) bool { return e.GetItemMutationResult() != nil })
	_ = host.conn.CloseNow()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(h.server.Rooms()) > 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if len(h.server.Rooms()) != 0 {
		t.Fatal("the room did not sleep")
	}

	incompatible := h.dial("bob")
	incompatible.join(&pb.DefinitionVersion{DefinitionId: "rocket", Version: 0})
	for {
		envelope := incompatible.read()
		if control := envelope.GetHostControl(); control != nil &&
			control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED {
			t.Fatal("an incompatible client briefly received the host lease")
		}
		if failure := envelope.GetError(); failure != nil {
			if failure.Code != "definition_mismatch" {
				t.Fatalf("error code = %q, want definition_mismatch", failure.Code)
			}
			return
		}
	}
}
