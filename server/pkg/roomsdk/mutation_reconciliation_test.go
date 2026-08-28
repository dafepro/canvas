package roomsdk

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

func correlatedSpawn(session string, mutationID uint64, correlation string) *pb.RoomEnvelope {
	envelope := spawnMutation(session, mutationID, 20, 30)
	envelope.GetItemMutation().ApplicationCorrelationId = correlation
	return envelope
}

func TestTrustedMutationReconciliationSurvivesLostAcknowledgementAndRestart(t *testing.T) {
	h := newHarness(t, nil)
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })

	// Do not read the browser receipt. Trusted host reconciliation must be able
	// to close the saga even when that acknowledgement is lost.
	owner.send(correlatedSpawn("lost-ack-session", 1, "reservation-lost-ack"))
	deadline := time.Now().Add(2 * time.Second)
	var first MutationOutcome
	for time.Now().Before(deadline) {
		first, _ = h.server.ReconcileMutation(t.Context(), "test-canvas", "reservation-lost-ack")
		if first.Status == MutationOutcomeAccepted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if first.Status != MutationOutcomeAccepted || first.ParticipantID != "alice" ||
		first.Kind != MutationKindSpawn || first.EntityID == "" || first.DefinitionID != "rocket" ||
		first.DefinitionVersion != 1 || first.SceneRevision == 0 || first.ItemRevision != 1 {
		t.Fatalf("reconciled outcome = %#v", first)
	}

	// A replacement service instance over the same Store returns the exact
	// immutable terminal result without waking the room or trusting a browser.
	restarted, err := New(h.server.cfg)
	if err != nil {
		t.Fatalf("restart server: %v", err)
	}
	afterRestart, err := restarted.ReconcileMutation(t.Context(), "test-canvas", "reservation-lost-ack")
	if err != nil {
		t.Fatalf("reconcile after restart: %v", err)
	}
	if afterRestart != first {
		t.Fatalf("after restart = %#v, want %#v", afterRestart, first)
	}
}

func TestTrustedMutationReconciliationSurvivesFileStoreReopen(t *testing.T) {
	root := t.TempDir()
	seed := func(store *FileStore) {
		store.PutCanvas(CanvasRecord{
			CanvasID: "test-canvas", Version: 1, DefinitionRaw: []byte(canvasJSON),
		})
		store.PutItemDefinition(ItemDefinitionRecord{
			DefinitionID: "rocket", Version: 1, Complexity: ItemComplexitySimple,
			ConfigSchema: []byte(`{"type":"object","properties":{"thrust":{"type":"number"}},"required":["thrust"],"additionalProperties":false}`),
		})
	}
	var persistent *FileStore
	h := newHarness(t, func(cfg *Config) {
		var err error
		persistent, err = NewFileStore(root)
		if err != nil {
			t.Fatalf("NewFileStore: %v", err)
		}
		seed(persistent)
		cfg.Store = persistent
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(correlatedSpawn("file-session", 1, "file-reservation"))
	result := awaitMutationResult(owner, 1)
	if !result.Accepted {
		t.Fatalf("result = %#v", result)
	}

	reopened, err := NewFileStore(root)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	seed(reopened)
	cfg := h.server.cfg
	cfg.Store = reopened
	restarted, err := New(cfg)
	if err != nil {
		t.Fatalf("restart server: %v", err)
	}
	outcome, err := restarted.ReconcileMutation(t.Context(), "test-canvas", "file-reservation")
	if err != nil || outcome.Status != MutationOutcomeAccepted || outcome.EntityID != result.EntityId {
		t.Fatalf("file outcome = %#v error=%v", outcome, err)
	}
}

func TestMutationReconciliationReturnsStableRejectionAndUnknown(t *testing.T) {
	h := newHarness(t, func(cfg *Config) {
		cfg.MutationAuthorizer = MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
			return MutationAuthorizationDecision{Reason: "permit expired"}, nil
		})
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(correlatedSpawn("denied-session", 1, "reservation-denied"))
	receipt := awaitMutationResult(owner, 1)
	if receipt.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_POLICY {
		t.Fatalf("receipt = %#v", receipt)
	}

	denied, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "reservation-denied")
	if err != nil {
		t.Fatalf("reconcile denied: %v", err)
	}
	if denied.Status != MutationOutcomeRejected || denied.RejectCode != MutationRejectApplicationPolicy ||
		denied.SceneRevision != 0 || denied.ParticipantID != "alice" {
		t.Fatalf("denied outcome = %#v", denied)
	}
	unknown, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "never-seen")
	if err != nil || unknown.Status != MutationOutcomeUnknown {
		t.Fatalf("unknown outcome = %#v, error = %v", unknown, err)
	}
}

func TestMutationCorrelationDeduplicatesAndCannotChangeParticipant(t *testing.T) {
	var authorizations atomic.Int32
	h := newHarness(t, func(cfg *Config) {
		cfg.MutationAuthorizer = MutationAuthorizerFunc(func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error) {
			authorizations.Add(1)
			return MutationAuthorizationDecision{Authorized: true}, nil
		})
	})
	alice := h.dial("alice")
	alice.join()
	alice.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	alice.send(correlatedSpawn("correlation-session", 1, "one-use-reservation"))
	first := awaitMutationResult(alice, 1)
	if !first.Accepted {
		t.Fatalf("first = %#v", first)
	}

	// A retained correlation is an additional server idempotency identity.
	// Replaying the exact mutation returns its original result.
	alice.send(correlatedSpawn("correlation-session", 1, "one-use-reservation"))
	duplicate := awaitMutationResult(alice, 1)
	if duplicate.EntityId != first.EntityId || duplicate.SceneRevision != first.SceneRevision ||
		authorizations.Load() != 1 {
		t.Fatalf("duplicate = %#v authorizations=%d", duplicate, authorizations.Load())
	}

	bob := h.dial("bob")
	bob.join()
	bob.send(correlatedSpawn("bob-session", 1, "one-use-reservation"))
	conflict := awaitMutationResult(bob, 1)
	if conflict.Accepted || conflict.RejectCode != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_CORRELATION_CONFLICT {
		t.Fatalf("cross-participant correlation = %#v", conflict)
	}
	authoritative, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "one-use-reservation")
	if err != nil || authoritative.Status != MutationOutcomeAccepted || authoritative.ParticipantID != "alice" {
		t.Fatalf("authoritative outcome = %#v error=%v", authoritative, err)
	}
}

func TestMutationReconciliationExpiryAndSizeBounds(t *testing.T) {
	var nowMillis atomic.Int64
	nowMillis.Store(time.Now().UnixMilli())
	h := newHarness(t, func(cfg *Config) {
		cfg.Now = func() time.Time { return time.UnixMilli(nowMillis.Load()) }
		cfg.MutationOutcomeRetention = time.Minute
		cfg.MaxMutationOutcomesPerRoom = 1
	})
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(correlatedSpawn("retention-session", 1, "old-reservation"))
	if result := awaitMutationResult(owner, 1); !result.Accepted {
		t.Fatalf("old result = %#v", result)
	}
	nowMillis.Add(int64(time.Minute + time.Millisecond))
	expired, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "old-reservation")
	if err != nil || expired.Status != MutationOutcomeExpired {
		t.Fatalf("expired = %#v error=%v", expired, err)
	}

	owner.send(correlatedSpawn("retention-session", 2, "new-reservation"))
	if result := awaitMutationResult(owner, 2); !result.Accepted {
		t.Fatalf("new result = %#v", result)
	}
	evicted, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "old-reservation")
	if err != nil || evicted.Status != MutationOutcomeUnknown {
		t.Fatalf("evicted = %#v error=%v", evicted, err)
	}
	policy := h.server.MutationOutcomePolicy()
	if policy.Retention != time.Minute || policy.MaxPerRoom != 1 {
		t.Fatalf("policy = %#v", policy)
	}
}

type failingOutcomeSink struct {
	calls atomic.Int32
}

func (s *failingOutcomeSink) NotifyMutationOutcome(context.Context, MutationOutcome) error {
	s.calls.Add(1)
	return errors.New("sink is down")
}

func TestMutationOutcomeSinkFailureDoesNotRollBackAcceptance(t *testing.T) {
	sink := &failingOutcomeSink{}
	h := newHarness(t, func(cfg *Config) { cfg.MutationOutcomeSink = sink })
	owner := h.dial("alice")
	owner.join()
	owner.await(func(envelope *pb.RoomEnvelope) bool { return envelope.GetHostControl() != nil })
	owner.send(correlatedSpawn("sink-session", 1, "sink-reservation"))
	result := awaitMutationResult(owner, 1)
	if !result.Accepted {
		t.Fatalf("result = %#v", result)
	}
	deadline := time.Now().Add(time.Second)
	for sink.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sink.calls.Load() != 1 {
		t.Fatalf("sink calls = %d, want 1", sink.calls.Load())
	}
	outcome, err := h.server.ReconcileMutation(t.Context(), "test-canvas", "sink-reservation")
	if err != nil || outcome.Status != MutationOutcomeAccepted {
		t.Fatalf("query after sink failure = %#v error=%v", outcome, err)
	}
}
