package roomsdk

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

type transientActionRegistryFunc func(
	context.Context,
	TransientActionContext,
) (TransientActionRoute, error)

func (f transientActionRegistryFunc) ResolveTransientAction(
	ctx context.Context,
	request TransientActionContext,
) (TransientActionRoute, error) {
	return f(ctx, request)
}

func transientActionEnvelope(
	session string,
	requestID uint64,
	entityID string,
) *pb.RoomEnvelope {
	return &pb.RoomEnvelope{RoomId: "test-canvas", Payload: &pb.RoomEnvelope_TransientAction{
		TransientAction: &pb.TransientAction{
			ClientSessionId: session, RequestId: requestID, Action: "rocket.launch",
			TargetKind: pb.TransientActionTargetKind_TRANSIENT_ACTION_TARGET_ITEM,
			EntityId:   entityID, PayloadJson: []byte(`{"power":2}`), ParticipantId: "mallory",
		},
	}}
}

func awaitTransientActionResult(client *testClient, requestID uint64) *pb.TransientActionResult {
	client.t.Helper()
	return client.await(func(envelope *pb.RoomEnvelope) bool {
		result := envelope.GetTransientActionResult()
		return result != nil && result.RequestId == requestID
	}).GetTransientActionResult()
}

func TestTransientItemActionAuthenticatesDeduplicatesAndUsesNormalEffects(t *testing.T) {
	var registryCalls atomic.Int32
	h := newHarness(t, func(cfg *Config) {
		cfg.TransientActions = transientActionRegistryFunc(func(
			_ context.Context,
			request TransientActionContext,
		) (TransientActionRoute, error) {
			registryCalls.Add(1)
			if request.ParticipantID != "alice" || request.Action != "rocket.launch" ||
				request.Target != TransientActionTargetItem || string(request.Payload) != `{"power":2}` {
				return TransientActionRoute{}, ErrTransientActionUnauthorized
			}
			return TransientActionRoute{}, nil
		})
	})
	host := h.dial("alice")
	host.join()
	host.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	peer := h.dial("bob")
	peer.join()

	host.send(spawnMutation("spawn-session", 1, 20, 30))
	spawned := awaitMutationResult(host, 1)
	if !spawned.Accepted {
		t.Fatalf("spawn rejected: %#v", spawned)
	}
	room := h.server.rooms["test-canvas"]
	revisionBefore := room.sceneRevision
	checkpointBefore := room.checkpointNo

	host.send(transientActionEnvelope("actions", 1, spawned.EntityId))
	accepted := awaitTransientActionResult(host, 1)
	if !accepted.Accepted {
		t.Fatalf("action rejected: %#v", accepted)
	}
	dispatched := host.await(func(envelope *pb.RoomEnvelope) bool {
		action := envelope.GetTransientAction()
		return action != nil && action.RequestId == 1
	}).GetTransientAction()
	if dispatched.ParticipantId != "alice" || dispatched.DispatchEntityId != spawned.EntityId {
		t.Fatalf("server-authored dispatch = %#v", dispatched)
	}
	if room.sceneRevision != revisionBefore || room.checkpointNo != checkpointBefore {
		t.Fatal("transient action changed a durable revision")
	}

	// The active-room receipt is stable and the behavior dispatch is at most once.
	host.send(transientActionEnvelope("actions", 1, spawned.EntityId))
	duplicate := awaitTransientActionResult(host, 1)
	if !duplicate.Accepted || registryCalls.Load() != 1 {
		t.Fatalf("duplicate = %#v, registry calls = %d", duplicate, registryCalls.Load())
	}

	// A behavior response uses the ordinary host-authorized effect path.
	host.send(&pb.RoomEnvelope{
		RoomId: "test-canvas", HostEpoch: host.hostEpoch,
		Payload: &pb.RoomEnvelope_EffectEvent{EffectEvent: &pb.EffectEvent{
			EntityId: spawned.EntityId, Effect: "launch", Mode: "oneShot", ParamsJson: []byte(`{"power":2}`),
		}},
	})
	gotEffect := peer.await(func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetEffectEvent() != nil
	}).GetEffectEvent()
	if gotEffect.Effect != "launch" {
		t.Fatalf("effect = %#v", gotEffect)
	}

	peer.send(transientActionEnvelope("bob-actions", 1, spawned.EntityId))
	denied := awaitTransientActionResult(peer, 1)
	if denied.RejectCode != pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_NOT_OWNER {
		t.Fatalf("non-owner result = %#v", denied)
	}
}

func TestTransientRoomActionRequiresRegistrationAndRoutesToBehavior(t *testing.T) {
	withoutRegistry := newHarness(t, nil)
	client := withoutRegistry.dial("alice")
	client.join()
	client.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	client.send(&pb.RoomEnvelope{Payload: &pb.RoomEnvelope_TransientAction{TransientAction: &pb.TransientAction{
		ClientSessionId: "room-actions", RequestId: 1, Action: "round.restart",
		TargetKind:  pb.TransientActionTargetKind_TRANSIENT_ACTION_TARGET_ROOM,
		PayloadJson: []byte(`{}`),
	}}})
	unknown := awaitTransientActionResult(client, 1)
	if unknown.RejectCode != pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNKNOWN_ACTION {
		t.Fatalf("unregistered action = %#v", unknown)
	}

	var route atomic.Value
	withRegistry := newHarness(t, func(cfg *Config) {
		cfg.TransientActions = transientActionRegistryFunc(func(
			_ context.Context,
			request TransientActionContext,
		) (TransientActionRoute, error) {
			if request.Action != "round.restart" || request.Target != TransientActionTargetRoom {
				return TransientActionRoute{}, ErrTransientActionUnknown
			}
			dispatch, _ := route.Load().(string)
			return TransientActionRoute{DispatchEntityID: dispatch}, nil
		})
	})
	host := withRegistry.dial("alice")
	host.join()
	host.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	host.send(spawnMutation("spawn", 1, 20, 30))
	spawned := awaitMutationResult(host, 1)
	route.Store(spawned.EntityId)
	host.send(&pb.RoomEnvelope{Payload: &pb.RoomEnvelope_TransientAction{TransientAction: &pb.TransientAction{
		ClientSessionId: "room-actions", RequestId: 1, Action: "round.restart",
		TargetKind:  pb.TransientActionTargetKind_TRANSIENT_ACTION_TARGET_ROOM,
		PayloadJson: []byte(`{}`),
	}}})
	if result := awaitTransientActionResult(host, 1); !result.Accepted {
		t.Fatalf("room action rejected: %#v", result)
	}
	dispatched := host.await(func(envelope *pb.RoomEnvelope) bool {
		return envelope.GetTransientAction() != nil
	}).GetTransientAction()
	if dispatched.DispatchEntityId != spawned.EntityId || dispatched.EntityId != "" {
		t.Fatalf("room action route = %#v", dispatched)
	}
}

func TestTransientActionRejectsMalformedPayloadRateLimitAndStaleRequest(t *testing.T) {
	h := newHarness(t, func(cfg *Config) {
		cfg.MaxTransientActionsPerSecond = 1
		cfg.MaxTransientActionResultsPerRoom = 1
		cfg.TransientActions = transientActionRegistryFunc(func(
			context.Context,
			TransientActionContext,
		) (TransientActionRoute, error) {
			return TransientActionRoute{}, nil
		})
	})
	host := h.dial("alice")
	host.join()
	host.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	host.send(spawnMutation("spawn", 1, 20, 30))
	spawned := awaitMutationResult(host, 1)

	malformed := transientActionEnvelope("actions", 1, spawned.EntityId)
	malformed.GetTransientAction().PayloadJson = []byte(`{"bad"`)
	host.send(malformed)
	if result := awaitTransientActionResult(host, 1); result.RejectCode != pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_PAYLOAD {
		t.Fatalf("malformed result = %#v", result)
	}

	host.send(transientActionEnvelope("actions", 2, spawned.EntityId))
	if result := awaitTransientActionResult(host, 2); !result.Accepted {
		t.Fatalf("first rate-counted result = %#v", result)
	}
	host.send(transientActionEnvelope("actions", 3, spawned.EntityId))
	if result := awaitTransientActionResult(host, 3); result.RejectCode != pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_RATE_LIMITED {
		t.Fatalf("rate-limited result = %#v", result)
	}

	// The one-entry ledger evicted request 1, but high-water prevents replay.
	host.send(transientActionEnvelope("actions", 1, spawned.EntityId))
	if result := awaitTransientActionResult(host, 1); result.RejectCode != pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_STALE {
		t.Fatalf("stale result = %#v", result)
	}
}

func TestTransientActionIsNotPersistedOrReplayedAcrossRoomSleep(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, func(cfg *Config) {
		cfg.TransientActions = transientActionRegistryFunc(func(
			context.Context,
			TransientActionContext,
		) (TransientActionRoute, error) {
			calls.Add(1)
			return TransientActionRoute{}, nil
		})
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(spawnMutation("spawn", 1, 20, 30))
	spawned := awaitMutationResult(owner, 1)
	owner.send(transientActionEnvelope("actions", 1, spawned.EntityId))
	if result := awaitTransientActionResult(owner, 1); !result.Accepted {
		t.Fatalf("first action rejected: %#v", result)
	}
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetTransientAction() != nil })
	if err := owner.conn.Close(websocket.StatusNormalClosure, "sleep"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.server.mu.Lock()
		_, awake := h.server.rooms["test-canvas"]
		h.server.mu.Unlock()
		if !awake {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	reconnected := h.dial("alice")
	reconnected.join()
	reconnected.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	reconnected.send(transientActionEnvelope("actions", 1, spawned.EntityId))
	if result := awaitTransientActionResult(reconnected, 1); !result.Accepted {
		t.Fatalf("action after wake rejected: %#v", result)
	}
	if calls.Load() != 2 {
		t.Fatalf("registry calls = %d, want 2 independent active-room actions", calls.Load())
	}
}
