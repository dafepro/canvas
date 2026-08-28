package roomsdk

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func TestMutationAuthorizerReceivesValidatedContextAndDeduplicatesPermitConsumption(t *testing.T) {
	var calls atomic.Int32
	var got MutationAuthorizationRequest
	h := newHarness(t, func(cfg *Config) {
		cfg.MutationAuthorizer = MutationAuthorizerFunc(func(
			_ context.Context,
			request MutationAuthorizationRequest,
		) (MutationAuthorizationDecision, error) {
			calls.Add(1)
			got = request
			return MutationAuthorizationDecision{Authorized: true}, nil
		})
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })

	mutation := spawnMutation("permit-session", 1, 20, 30)
	mutation.GetItemMutation().AuthorizationEvidence = []byte("signed-permit")
	mutation.GetItemMutation().ApplicationCorrelationId = "reservation-123"
	owner.send(mutation)
	first := awaitMutationResult(owner, 1)
	if !first.Accepted {
		t.Fatalf("spawn rejected: %#v", first)
	}
	if calls.Load() != 1 {
		t.Fatalf("authorizer calls = %d, want 1", calls.Load())
	}
	if got.Participant.UserID != "alice" || got.RoomID != "test-canvas" ||
		got.CanvasID != "test-canvas" || got.CanvasVersion != 1 ||
		got.Kind != MutationKindSpawn || got.DefinitionID != "rocket" ||
		got.DefinitionVersion != 1 || got.Idempotency.ClientSessionID != "permit-session" ||
		got.Idempotency.MutationID != 1 || string(got.AuthorizationEvidence) != "signed-permit" ||
		got.ApplicationCorrelationID != "reservation-123" {
		t.Fatalf("authorization request = %#v", got)
	}
	if got.ProposedItem == nil || got.ProposedItem.OwnerUserID != "alice" ||
		got.ProposedItem.Transform.X != 20 || string(got.ProposedItem.ResolvedConfig) != `{"thrust":24}` {
		t.Fatalf("normalized proposed item = %#v", got.ProposedItem)
	}

	// A reconnect resend returns the retained terminal receipt without asking
	// the product to consume the one-use permit again.
	owner.send(mutation)
	duplicate := awaitMutationResult(owner, 1)
	if !duplicate.Accepted || duplicate.EntityId != first.EntityId || calls.Load() != 1 {
		t.Fatalf("duplicate = %#v, authorizer calls = %d", duplicate, calls.Load())
	}

	stored, err := h.store.LoadSnapshot(t.Context(), "test-canvas")
	if err != nil {
		t.Fatalf("LoadSnapshot: %v", err)
	}
	if string(stored.SnapshotRaw) == "" {
		t.Fatal("accepted mutation was not persisted")
	}
	if bytesContain(stored.SnapshotRaw, []byte("signed-permit")) ||
		bytesContain(stored.SnapshotRaw, []byte("reservation-123")) ||
		bytesContain(first.ItemInstanceJson, []byte("signed-permit")) {
		t.Fatal("private application metadata escaped into canonical state")
	}
}

func TestMutationAuthorizerRunsAfterCanvasValidation(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, func(cfg *Config) {
		cfg.MutationAuthorizer = MutationAuthorizerFunc(func(
			context.Context,
			MutationAuthorizationRequest,
		) (MutationAuthorizationDecision, error) {
			calls.Add(1)
			return MutationAuthorizationDecision{Authorized: true}, nil
		})
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })

	invalid := spawnMutation("validation-session", 1, 200, 300)
	invalid.GetItemMutation().AuthorizationEvidence = []byte("must-not-consume")
	owner.send(invalid)
	result := awaitMutationResult(owner, 1)
	if result.Accepted || result.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_OUTSIDE_CANVAS {
		t.Fatalf("invalid result = %#v", result)
	}
	if calls.Load() != 0 {
		t.Fatalf("authorizer consumed %d permits for an invalid mutation", calls.Load())
	}
}

func TestMutationAuthorizationFailuresFailClosedWithoutChangingTheScene(t *testing.T) {
	tests := map[string]struct {
		authorizer MutationAuthorizer
		want       pb.ItemMutationRejectCode
	}{
		"denied": {
			authorizer: MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
				return MutationAuthorizationDecision{Reason: "reservation expired"}, nil
			}),
			want: pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_POLICY,
		},
		"error": {
			authorizer: MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
				return MutationAuthorizationDecision{}, errors.New("policy service unavailable")
			}),
			want: pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE,
		},
		"panic": {
			authorizer: MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
				panic("policy client threw")
			}),
			want: pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE,
		},
		"timeout": {
			authorizer: MutationAuthorizerFunc(func(ctx context.Context, _ MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
				<-ctx.Done()
				return MutationAuthorizationDecision{}, ctx.Err()
			}),
			want: pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE,
		},
	}
	for name, testCase := range tests {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, func(cfg *Config) {
				cfg.MutationAuthorizer = testCase.authorizer
				cfg.MutationAuthorizationTimeout = 10 * time.Millisecond
			})
			owner := h.dial("alice")
			owner.join()
			owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
			owner.send(spawnMutation("failure-session", 1, 20, 30))
			result := awaitMutationResult(owner, 1)
			if result.Accepted || result.RejectCode != testCase.want {
				t.Fatalf("result = %#v, want code %v", result, testCase.want)
			}
			room := h.server.rooms["test-canvas"]
			if room.sceneRevision != 0 || len(room.snapshot.Items) != 0 {
				t.Fatalf("denial changed scene revision/items: %d/%d", room.sceneRevision, len(room.snapshot.Items))
			}
		})
	}
}

func TestMutationAuthorizationEvidenceIsBounded(t *testing.T) {
	var calls atomic.Int32
	h := newHarness(t, func(cfg *Config) {
		cfg.MaxMutationAuthorizationBytes = 4
		cfg.MutationAuthorizer = MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
			calls.Add(1)
			return MutationAuthorizationDecision{Authorized: true}, nil
		})
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	mutation := spawnMutation("bounded-session", 1, 20, 30)
	mutation.GetItemMutation().AuthorizationEvidence = []byte("12345")
	owner.send(mutation)
	result := awaitMutationResult(owner, 1)
	if result.Accepted || result.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_MALFORMED || calls.Load() != 0 {
		t.Fatalf("oversized evidence result = %#v calls=%d", result, calls.Load())
	}
}

func bytesContain(value, fragment []byte) bool {
	if len(fragment) == 0 || len(fragment) > len(value) {
		return false
	}
	for i := 0; i <= len(value)-len(fragment); i++ {
		matched := true
		for j := range fragment {
			if value[i+j] != fragment[j] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}
