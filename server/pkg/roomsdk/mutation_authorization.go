package roomsdk

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// MutationKind is the stable product-facing name of a durable mutation kind.
type MutationKind string

const (
	MutationKindSpawn      MutationKind = "spawn"
	MutationKindDelete     MutationKind = "delete"
	MutationKindTransform  MutationKind = "transform"
	MutationKindConfig     MutationKind = "config"
	MutationKindIsolation  MutationKind = "isolation"
	MutationKindCollisions MutationKind = "collisions"
	MutationKindRotation   MutationKind = "rotation"
	MutationKindScale      MutationKind = "scale"
)

// MutationIdempotencyIdentity is stable across reconnect resends. Key is an
// opaque SHA-256 identity suitable for a product permit-consumption ledger.
type MutationIdempotencyIdentity struct {
	ParticipantID   string
	RoomID          string
	ClientSessionID string
	MutationID      uint64
	Key             string
}

// MutationAuthorizationRequest is the immutable, normalized context supplied
// to a product authorizer after Canvas's own mutation checks have passed.
type MutationAuthorizationRequest struct {
	Participant              Identity
	RoomID                   string
	CanvasID                 string
	CanvasVersion            uint32
	Kind                     MutationKind
	EntityID                 string
	DefinitionID             string
	DefinitionVersion        uint32
	CurrentItem              *SnapshotItem
	ProposedItem             *SnapshotItem
	Idempotency              MutationIdempotencyIdentity
	AuthorizationEvidence    []byte
	ApplicationCorrelationID string
}

// MutationAuthorizationDecision authorizes one otherwise-valid durable
// mutation. The zero value denies it. Reason is diagnostic only; callers must
// branch on the stable protocol rejection code.
type MutationAuthorizationDecision struct {
	Authorized bool
	Reason     string
}

// MutationAuthorizer is implemented by trusted host application code.
type MutationAuthorizer interface {
	AuthorizeMutation(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error)
}

// MutationAuthorizerFunc adapts a function to MutationAuthorizer.
type MutationAuthorizerFunc func(context.Context, MutationAuthorizationRequest) (MutationAuthorizationDecision, error)

func (f MutationAuthorizerFunc) AuthorizeMutation(
	ctx context.Context,
	request MutationAuthorizationRequest,
) (MutationAuthorizationDecision, error) {
	return f(ctx, request)
}

func (r *Room) authorizeItemMutation(
	client *Client,
	mutation *pb.ItemMutation,
	item *SnapshotItem,
) (bool, pb.ItemMutationRejectCode, string) {
	if r.cfg.MutationAuthorizer == nil {
		return true, pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED, ""
	}
	request := r.mutationAuthorizationRequest(client, mutation, item)
	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.MutationAuthorizationTimeout)
	defer cancel()
	type authorizationResult struct {
		decision MutationAuthorizationDecision
		err      error
	}
	result := make(chan authorizationResult, 1)
	go func() {
		deferred := authorizationResult{}
		defer func() {
			if recovered := recover(); recovered != nil {
				deferred.err = fmt.Errorf("mutation authorizer panic: %v", recovered)
			}
			result <- deferred
		}()
		deferred.decision, deferred.err = r.cfg.MutationAuthorizer.AuthorizeMutation(ctx, request)
	}()

	select {
	case <-ctx.Done():
		return false, pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE,
			"application authorization unavailable"
	case resolved := <-result:
		if resolved.err != nil || ctx.Err() != nil {
			return false, pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_UNAVAILABLE,
				"application authorization unavailable"
		}
		if !resolved.decision.Authorized {
			message := resolved.decision.Reason
			if message == "" {
				message = "application policy denied the mutation"
			}
			return false, pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_POLICY, message
		}
		return true, pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED, ""
	}
}

func (r *Room) mutationAuthorizationRequest(
	client *Client,
	mutation *pb.ItemMutation,
	item *SnapshotItem,
) MutationAuthorizationRequest {
	definitionID := mutation.DefinitionId
	definitionVersion := mutation.DefinitionVersion
	if item != nil {
		definitionID = item.DefinitionID
		definitionVersion = item.DefinitionVersion
	}
	idempotency := MutationIdempotencyIdentity{
		ParticipantID:   client.UserID,
		RoomID:          r.roomID,
		ClientSessionID: mutation.ClientSessionId,
		MutationID:      mutation.MutationId,
	}
	hash := sha256.New()
	for _, value := range []string{idempotency.ParticipantID, idempotency.RoomID, idempotency.ClientSessionID, uintString(idempotency.MutationID)} {
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(value))
	}
	idempotency.Key = hex.EncodeToString(hash.Sum(nil))
	return MutationAuthorizationRequest{
		Participant:              Identity{UserID: client.UserID, DisplayName: client.DisplayName},
		RoomID:                   r.roomID,
		CanvasID:                 r.canvasID,
		CanvasVersion:            r.canvasShape.Version,
		Kind:                     mutationKindName(mutation.Kind),
		EntityID:                 mutation.EntityId,
		DefinitionID:             definitionID,
		DefinitionVersion:        definitionVersion,
		CurrentItem:              cloneSnapshotItem(item),
		ProposedItem:             proposedMutationItem(client, mutation, item),
		Idempotency:              idempotency,
		AuthorizationEvidence:    bytes.Clone(mutation.AuthorizationEvidence),
		ApplicationCorrelationID: mutation.ApplicationCorrelationId,
	}
}

func mutationKindName(kind pb.ItemMutationKind) MutationKind {
	switch kind {
	case pb.ItemMutationKind_ITEM_MUTATION_SPAWN:
		return MutationKindSpawn
	case pb.ItemMutationKind_ITEM_MUTATION_DELETE:
		return MutationKindDelete
	case pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM:
		return MutationKindTransform
	case pb.ItemMutationKind_ITEM_MUTATION_CONFIG:
		return MutationKindConfig
	case pb.ItemMutationKind_ITEM_MUTATION_ISOLATION:
		return MutationKindIsolation
	case pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS:
		return MutationKindCollisions
	case pb.ItemMutationKind_ITEM_MUTATION_ROTATION:
		return MutationKindRotation
	case pb.ItemMutationKind_ITEM_MUTATION_SCALE:
		return MutationKindScale
	default:
		return ""
	}
}

func proposedMutationItem(client *Client, mutation *pb.ItemMutation, current *SnapshotItem) *SnapshotItem {
	if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_DELETE {
		return nil
	}
	if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_SPAWN {
		return &SnapshotItem{
			EntityID:          mutation.EntityId,
			DefinitionID:      mutation.DefinitionId,
			DefinitionVersion: mutation.DefinitionVersion,
			OwnerUserID:       client.UserID,
			ItemRevision:      1,
			Transform:         transformFromMutation(mutation),
			ResolvedConfig:    bytes.Clone(mutation.ConfigJson),
		}
	}
	proposed := cloneSnapshotItem(current)
	if proposed == nil {
		return nil
	}
	switch mutation.Kind {
	case pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM:
		proposed.Transform = transformFromMutation(mutation)
	case pb.ItemMutationKind_ITEM_MUTATION_ROTATION:
		proposed.Transform.Rotation = float64(mutation.Rotation)
	case pb.ItemMutationKind_ITEM_MUTATION_SCALE:
		proposed.Transform.Scale = float64(mutation.Scale)
	case pb.ItemMutationKind_ITEM_MUTATION_CONFIG:
		if len(mutation.ConfigJson) > 0 {
			proposed.ResolvedConfig = bytes.Clone(mutation.ConfigJson)
		}
	case pb.ItemMutationKind_ITEM_MUTATION_ISOLATION:
		proposed.Isolated = mutation.Isolated
	case pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS:
		proposed.CollisionsDisabled = !mutation.CollisionsEnabled
	}
	proposed.ItemRevision++
	return proposed
}

func cloneSnapshotItem(item *SnapshotItem) *SnapshotItem {
	if item == nil {
		return nil
	}
	clone := *item
	clone.ResolvedConfig = bytes.Clone(item.ResolvedConfig)
	clone.BehaviorState = bytes.Clone(item.BehaviorState)
	clone.BehaviorTimers = append([]BehaviorTimer(nil), item.BehaviorTimers...)
	if item.Transform.Z != nil {
		z := *item.Transform.Z
		clone.Transform.Z = &z
	}
	if item.VisualTint != nil {
		tint := *item.VisualTint
		clone.VisualTint = &tint
	}
	return &clone
}

var errOversizedMutationMetadata = errors.New("application mutation metadata exceeds configured bounds")
