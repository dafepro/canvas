package roomsdk

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

// MutationOutcomeStatus distinguishes a terminal accepted/rejected result from
// a correlation that is unavailable for reconciliation.
type MutationOutcomeStatus string

const (
	MutationOutcomeAccepted MutationOutcomeStatus = "accepted"
	MutationOutcomeRejected MutationOutcomeStatus = "rejected"
	MutationOutcomeUnknown  MutationOutcomeStatus = "unknown"
	MutationOutcomeExpired  MutationOutcomeStatus = "expired"
)

// MutationRejectCode is the stable product-facing rejection identity.
type MutationRejectCode string

const (
	MutationRejectMalformed              MutationRejectCode = "malformed"
	MutationRejectNotFound               MutationRejectCode = "not_found"
	MutationRejectSystemOwned            MutationRejectCode = "system_owned"
	MutationRejectNotOwner               MutationRejectCode = "not_owner"
	MutationRejectEditInUse              MutationRejectCode = "edit_in_use"
	MutationRejectEditExpired            MutationRejectCode = "edit_expired"
	MutationRejectStaleItemRevision      MutationRejectCode = "stale_item_revision"
	MutationRejectOutsideCanvas          MutationRejectCode = "outside_canvas"
	MutationRejectScaleOutOfRange        MutationRejectCode = "scale_out_of_range"
	MutationRejectDefinition             MutationRejectCode = "definition"
	MutationRejectConfig                 MutationRejectCode = "config"
	MutationRejectCapacity               MutationRejectCode = "capacity"
	MutationRejectReceiptExpired         MutationRejectCode = "receipt_expired"
	MutationRejectInternal               MutationRejectCode = "internal"
	MutationRejectApplicationPolicy      MutationRejectCode = "application_policy"
	MutationRejectApplicationUnavailable MutationRejectCode = "application_unavailable"
	MutationRejectCorrelationConflict    MutationRejectCode = "application_correlation_conflict"
)

// MutationOutcome is authoritative server evidence for one opaque application
// correlation. Unknown and expired are explicit non-terminal-evidence states.
type MutationOutcome struct {
	Status            MutationOutcomeStatus
	CorrelationID     string
	RoomID            string
	ParticipantID     string
	ClientSessionID   string
	MutationID        uint64
	Kind              MutationKind
	EntityID          string
	DefinitionID      string
	DefinitionVersion uint32
	RejectCode        MutationRejectCode
	SceneRevision     uint64
	ItemRevision      uint64
	RecordedAt        time.Time
	ExpiresAt         time.Time
}

// MutationOutcomePolicy is the configured reconciliation contract.
type MutationOutcomePolicy struct {
	Retention  time.Duration
	MaxPerRoom int
}

// MutationOutcomeSink receives a best-effort notification after a correlated
// terminal outcome has been placed in the durable private ledger.
type MutationOutcomeSink interface {
	NotifyMutationOutcome(context.Context, MutationOutcome) error
}

// MutationOutcomeSinkFunc adapts a function to MutationOutcomeSink.
type MutationOutcomeSinkFunc func(context.Context, MutationOutcome) error

func (f MutationOutcomeSinkFunc) NotifyMutationOutcome(ctx context.Context, outcome MutationOutcome) error {
	return f(ctx, outcome)
}

// MutationOutcomePolicy reports the retention deadline integrations should use.
func (s *Server) MutationOutcomePolicy() MutationOutcomePolicy {
	return MutationOutcomePolicy{
		Retention:  s.cfg.MutationOutcomeRetention,
		MaxPerRoom: s.cfg.MaxMutationOutcomesPerRoom,
	}
}

// ReconcileMutation is a trusted in-process seam. It is intentionally absent
// from Handler, so an untrusted room client cannot manufacture or query results.
func (s *Server) ReconcileMutation(
	ctx context.Context,
	roomID string,
	correlationID string,
) (MutationOutcome, error) {
	unknown := MutationOutcome{
		Status: MutationOutcomeUnknown, CorrelationID: correlationID, RoomID: roomID,
	}
	if roomID == "" || correlationID == "" {
		return unknown, errors.New("roomsdk: room and mutation correlation are required")
	}
	record, err := s.cfg.Store.LoadSnapshot(ctx, roomID)
	if errors.Is(err, ErrNotFound) {
		s.observeMutationReconciliation(roomID, MutationOutcomeUnknown)
		return unknown, nil
	}
	if err != nil {
		return unknown, err
	}
	retainedOutcomes := record.MutationOutcomes
	if extra := len(retainedOutcomes) - s.cfg.MaxMutationOutcomesPerRoom; extra > 0 {
		retainedOutcomes = retainedOutcomes[extra:]
	}
	for _, retained := range retainedOutcomes {
		if retained.CorrelationID != correlationID {
			continue
		}
		if !s.cfg.Now().Before(retained.ExpiresAt) {
			expired := MutationOutcome{
				Status: MutationOutcomeExpired, CorrelationID: correlationID, RoomID: roomID,
				ExpiresAt: retained.ExpiresAt,
			}
			s.observeMutationReconciliation(roomID, MutationOutcomeExpired)
			return expired, nil
		}
		outcome := mutationOutcomeFromRecord(roomID, retained)
		s.observeMutationReconciliation(roomID, outcome.Status)
		return outcome, nil
	}
	s.observeMutationReconciliation(roomID, MutationOutcomeUnknown)
	return unknown, nil
}

func (r *Room) loadMutationOutcomes(snapshot SnapshotRecord) {
	r.mutationOutcomeRevision = snapshot.MutationOutcomeRevision
	retained := append([]MutationOutcomeRecord(nil), snapshot.MutationOutcomes...)
	sort.SliceStable(retained, func(i, j int) bool {
		return retained[i].RecordedAt.Before(retained[j].RecordedAt)
	})
	if extra := len(retained) - r.cfg.MaxMutationOutcomesPerRoom; extra > 0 {
		retained = retained[extra:]
	}
	for _, outcome := range retained {
		if outcome.CorrelationID == "" || outcome.ParticipantID == "" || outcome.MutationID == 0 {
			continue
		}
		r.mutationOutcomes[outcome.CorrelationID] = cloneMutationOutcomeRecord(outcome)
		r.mutationOutcomeOrder = append(r.mutationOutcomeOrder, outcome.CorrelationID)
	}
}

func (r *Room) retainedMutationOutcome(mutation *pb.ItemMutation) (MutationOutcomeRecord, bool) {
	if mutation.ApplicationCorrelationId == "" {
		return MutationOutcomeRecord{}, false
	}
	outcome, ok := r.mutationOutcomes[mutation.ApplicationCorrelationId]
	if !ok {
		return MutationOutcomeRecord{}, false
	}
	return cloneMutationOutcomeRecord(outcome), true
}

func (r *Room) recordMutationOutcome(
	client *Client,
	mutation *pb.ItemMutation,
	result *pb.ItemMutationResult,
	item *SnapshotItem,
) {
	if mutation == nil || mutation.ApplicationCorrelationId == "" {
		return
	}
	resultBytes, err := proto.Marshal(result)
	if err != nil {
		return
	}
	definitionID := mutation.DefinitionId
	definitionVersion := mutation.DefinitionVersion
	if item != nil {
		definitionID = item.DefinitionID
		definitionVersion = item.DefinitionVersion
	}
	now := r.cfg.Now().UTC()
	record := MutationOutcomeRecord{
		CorrelationID:     mutation.ApplicationCorrelationId,
		ParticipantID:     client.UserID,
		ClientSessionID:   mutation.ClientSessionId,
		MutationID:        mutation.MutationId,
		Kind:              string(mutationKindName(mutation.Kind)),
		EntityID:          result.EntityId,
		DefinitionID:      definitionID,
		DefinitionVersion: definitionVersion,
		Accepted:          result.Accepted,
		SceneRevision:     result.SceneRevision,
		ItemRevision:      result.ItemRevision,
		RecordedAt:        now,
		ExpiresAt:         now.Add(r.cfg.MutationOutcomeRetention),
		ResultBytes:       resultBytes,
	}
	if !result.Accepted {
		record.RejectCode = string(mutationRejectCodeName(result.RejectCode))
	}
	if _, exists := r.mutationOutcomes[record.CorrelationID]; !exists {
		r.mutationOutcomeOrder = append(r.mutationOutcomeOrder, record.CorrelationID)
	}
	r.mutationOutcomes[record.CorrelationID] = record
	for len(r.mutationOutcomeOrder) > r.cfg.MaxMutationOutcomesPerRoom {
		oldest := r.mutationOutcomeOrder[0]
		r.mutationOutcomeOrder = r.mutationOutcomeOrder[1:]
		delete(r.mutationOutcomes, oldest)
	}
	r.mutationOutcomeRevision++
	if err := r.saveSnapshot(r.snapshotRecord()); err != nil {
		return
	}
	outcome := mutationOutcomeFromRecord(r.roomID, record)
	r.observeMutationOutcome(outcome)
	r.notifyMutationOutcome(outcome)
}

func (r *Room) notifyMutationOutcome(outcome MutationOutcome) {
	if r.cfg.MutationOutcomeSink == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), r.cfg.MutationOutcomeSinkTimeout)
		defer cancel()
		if err := r.cfg.MutationOutcomeSink.NotifyMutationOutcome(ctx, outcome); err != nil {
			r.cfg.Logger.Error("mutation outcome sink failed", "room", r.roomID,
				"correlation", outcome.CorrelationID, "error", err)
			r.observeMutationOutcomeSinkFailure()
		}
	}()
}

func mutationOutcomeFromRecord(roomID string, record MutationOutcomeRecord) MutationOutcome {
	status := MutationOutcomeRejected
	if record.Accepted {
		status = MutationOutcomeAccepted
	}
	return MutationOutcome{
		Status:            status,
		CorrelationID:     record.CorrelationID,
		RoomID:            roomID,
		ParticipantID:     record.ParticipantID,
		ClientSessionID:   record.ClientSessionID,
		MutationID:        record.MutationID,
		Kind:              MutationKind(record.Kind),
		EntityID:          record.EntityID,
		DefinitionID:      record.DefinitionID,
		DefinitionVersion: record.DefinitionVersion,
		RejectCode:        MutationRejectCode(record.RejectCode),
		SceneRevision:     record.SceneRevision,
		ItemRevision:      record.ItemRevision,
		RecordedAt:        record.RecordedAt,
		ExpiresAt:         record.ExpiresAt,
	}
}

func cloneMutationOutcomeRecord(record MutationOutcomeRecord) MutationOutcomeRecord {
	record.ResultBytes = bytes.Clone(record.ResultBytes)
	return record
}

func mutationRejectCodeName(code pb.ItemMutationRejectCode) MutationRejectCode {
	switch code {
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_FOUND:
		return MutationRejectNotFound
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_SYSTEM_OWNED:
		return MutationRejectSystemOwned
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_OWNER:
		return MutationRejectNotOwner
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_IN_USE:
		return MutationRejectEditInUse
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED:
		return MutationRejectEditExpired
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_STALE_ITEM_REVISION:
		return MutationRejectStaleItemRevision
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_OUTSIDE_CANVAS:
		return MutationRejectOutsideCanvas
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_SCALE_OUT_OF_RANGE:
		return MutationRejectScaleOutOfRange
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_DEFINITION:
		return MutationRejectDefinition
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_CONFIG:
		return MutationRejectConfig
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_CAPACITY:
		return MutationRejectCapacity
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_RECEIPT_EXPIRED:
		return MutationRejectReceiptExpired
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_INTERNAL:
		return MutationRejectInternal
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_POLICY:
		return MutationRejectApplicationPolicy
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE:
		return MutationRejectApplicationUnavailable
	case pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_CORRELATION_CONFLICT:
		return MutationRejectCorrelationConflict
	default:
		return MutationRejectMalformed
	}
}

type mutationOutcomeMetrics interface {
	MutationOutcomeRecorded(string, string, int)
	MutationOutcomeReconciled(string, string)
	MutationOutcomeSinkFailed(string)
}

func (r *Room) observeMutationOutcome(outcome MutationOutcome) {
	if metrics, ok := r.cfg.Metrics.(mutationOutcomeMetrics); ok {
		metrics.MutationOutcomeRecorded(r.roomID, string(outcome.Status), len(r.mutationOutcomes))
	}
}

func (r *Room) observeMutationOutcomeSinkFailure() {
	if metrics, ok := r.cfg.Metrics.(mutationOutcomeMetrics); ok {
		metrics.MutationOutcomeSinkFailed(r.roomID)
	}
}

func (s *Server) observeMutationReconciliation(roomID string, status MutationOutcomeStatus) {
	if metrics, ok := s.cfg.Metrics.(mutationOutcomeMetrics); ok {
		metrics.MutationOutcomeReconciled(roomID, string(status))
	}
}
