package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

var (
	errCanvasMismatch     = errors.New("canvas id mismatch")
	errTooManyItems       = errors.New("item count above the canvas limit")
	errNonFiniteTransform = errors.New("transform is not finite")
	errOutOfBounds        = errors.New("transform is grossly out of bounds")
	errStaleCheckpoint    = errors.New("checkpoint revision is not newer than the stored one")
	errStaleScene         = errors.New("checkpoint scene revision does not match the room")
	errUnknownEntity      = errors.New("checkpoint contains an unknown entity id")
	errDuplicateEntity    = errors.New("checkpoint contains a duplicate entity id")
	errMissingStateVector = errors.New("canonical state is missing a position or velocity")
	errDefinitionMismatch = errors.New("canonical state definition does not match the durable item")
	errInvalidBehavior    = errors.New("canonical behavior state is not valid json")
	errInvalidEffect      = errors.New("canonical effect parameters are not valid json")
	errNormalizationFlag  = errors.New("checkpoint final flag does not match snapshot normalization")
	errInvalidTimer       = errors.New("checkpoint contains invalid behavior timer state")
	errSnapshotSchema     = errors.New("snapshot schema version is not supported")
)

const (
	minItemScale = 0.25
	maxItemScale = 4.0
)

// validateItemMutation returns the item the mutation targets, or nil for a spawn.
// Client-host physics never grants edit rights: ownership is enforced here.
func (r *Room) validateItemMutation(
	client *Client,
	mutation *pb.ItemMutation,
) (bool, *SnapshotItem, string) {
	switch mutation.Kind {
	case pb.ItemMutationKind_ITEM_MUTATION_SPAWN:
		if len(r.snapshot.Items) >= r.canvasShape.Limits.MaxItems {
			return false, nil, "item_limit_reached"
		}
		if mutation.DefinitionId == "" {
			return false, nil, "missing_definition_id"
		}
		definition, err := r.itemDefinition(mutation.DefinitionId, mutation.DefinitionVersion)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				if _, latestErr := r.cfg.Store.LoadItemDefinition(
					context.Background(), mutation.DefinitionId,
				); latestErr == nil {
					return false, nil, "definition_version_mismatch"
				}
			}
			return false, nil, "unknown_definition"
		}
		if mutation.DefinitionVersion != definition.Version {
			return false, nil, "definition_version_mismatch"
		}
		if err := validateConfigJSON(definition.ConfigSchema, mutation.ConfigJson); err != nil {
			return false, nil, "config_schema_mismatch"
		}
		if definition.Complexity == ItemComplexityComplex &&
			r.complexItemCount() >= r.canvasShape.Limits.MaxComplexPhysicsItems {
			return false, nil, "complex_item_limit_reached"
		}
		transform := transformFromMutation(mutation)
		if !transform.finite() {
			return false, nil, "non_finite_transform"
		}
		if transform.Scale < minItemScale || transform.Scale > maxItemScale {
			return false, nil, "scale_out_of_range"
		}
		if !r.insideCanvas(transform) {
			return false, nil, "outside_canvas"
		}
		return true, nil, ""

	case pb.ItemMutationKind_ITEM_MUTATION_DELETE,
		pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM,
		pb.ItemMutationKind_ITEM_MUTATION_ROTATION,
		pb.ItemMutationKind_ITEM_MUTATION_SCALE,
		pb.ItemMutationKind_ITEM_MUTATION_ISOLATION,
		pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS,
		pb.ItemMutationKind_ITEM_MUTATION_CONFIG:

		item, ok := r.items[mutation.EntityId]
		if !ok {
			return false, nil, "unknown_entity"
		}
		if item.OwnerUserID == "" {
			return false, item, "system_owned"
		}
		if item.OwnerUserID != client.UserID {
			return false, item, "not_owner"
		}
		if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM {
			transform := transformFromMutation(mutation)
			if !transform.finite() {
				return false, item, "non_finite_transform"
			}
			if !r.insideCanvas(transform) {
				return false, item, "outside_canvas"
			}
		}
		if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_ROTATION &&
			(math.IsNaN(float64(mutation.Rotation)) || math.IsInf(float64(mutation.Rotation), 0)) {
			return false, item, "non_finite_transform"
		}
		if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_SCALE {
			scale := float64(mutation.Scale)
			if math.IsNaN(scale) || math.IsInf(scale, 0) {
				return false, item, "non_finite_transform"
			}
			if scale < minItemScale || scale > maxItemScale {
				return false, item, "scale_out_of_range"
			}
		}
		if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_CONFIG &&
			len(mutation.ConfigJson) > 0 && !json.Valid(mutation.ConfigJson) {
			return false, item, "invalid_config_json"
		}
		if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_CONFIG && len(mutation.ConfigJson) > 0 {
			definition, err := r.itemDefinition(item.DefinitionID, item.DefinitionVersion)
			if err != nil {
				return false, item, "unknown_definition"
			}
			if err := validateConfigJSON(definition.ConfigSchema, mutation.ConfigJson); err != nil {
				return false, item, "config_schema_mismatch"
			}
		}
		return true, item, ""

	default:
		return false, nil, "unknown_mutation_kind"
	}
}

func (r *Room) applyItemMutation(mutation *pb.ItemMutation, item *SnapshotItem, client *Client) {
	if item != nil {
		item.ItemRevision++
	}
	switch mutation.Kind {
	case pb.ItemMutationKind_ITEM_MUTATION_SPAWN:
		r.nextEntityNo++
		entityID := mutation.EntityId
		if entityID == "" || r.items[entityID] != nil {
			// Spec 19.3. The id repeats in every delta for every entity, so it
			// stays short. The room already scopes it, so the canvas id would
			// only repeat bytes on the wire.
			entityID = fmt.Sprintf("i%d", r.nextEntityNo)
		}
		created := SnapshotItem{
			EntityID:          entityID,
			DefinitionID:      mutation.DefinitionId,
			DefinitionVersion: mutation.DefinitionVersion,
			// The server sets the owner from the authenticated session.
			OwnerUserID:    client.UserID,
			ItemRevision:   1,
			Transform:      transformFromMutation(mutation),
			ResolvedConfig: json.RawMessage(mutation.ConfigJson),
		}
		r.snapshot.Items = append(r.snapshot.Items, created)
		r.indexItems()
		mutation.EntityId = entityID

	case pb.ItemMutationKind_ITEM_MUTATION_DELETE:
		kept := make([]SnapshotItem, 0, len(r.snapshot.Items))
		for _, existing := range r.snapshot.Items {
			if existing.EntityID != mutation.EntityId {
				kept = append(kept, existing)
			}
		}
		r.snapshot.Items = kept
		r.indexItems()

	case pb.ItemMutationKind_ITEM_MUTATION_TRANSFORM:
		item.Transform = transformFromMutation(mutation)

	case pb.ItemMutationKind_ITEM_MUTATION_ROTATION:
		item.Transform.Rotation = float64(mutation.Rotation)

	case pb.ItemMutationKind_ITEM_MUTATION_SCALE:
		item.Transform.Scale = float64(mutation.Scale)

	case pb.ItemMutationKind_ITEM_MUTATION_ISOLATION:
		item.Isolated = mutation.Isolated

	case pb.ItemMutationKind_ITEM_MUTATION_COLLISIONS:
		item.CollisionsDisabled = !mutation.CollisionsEnabled

	case pb.ItemMutationKind_ITEM_MUTATION_CONFIG:
		if len(mutation.ConfigJson) > 0 {
			item.ResolvedConfig = json.RawMessage(mutation.ConfigJson)
		}
	}
}

func transformFromMutation(mutation *pb.ItemMutation) Transform {
	scale := float64(mutation.Scale)
	if scale == 0 {
		scale = 1
	}
	transform := Transform{
		Rotation: float64(mutation.Rotation),
		Scale:    scale,
	}
	if mutation.Position != nil {
		transform.X = float64(mutation.Position.X)
		transform.Y = float64(mutation.Position.Y)
	}
	if mutation.Z != 0 {
		z := float64(mutation.Z)
		transform.Z = &z
	}
	return transform
}

// insideCanvas refuses an authored placement outside the canvas. A physics body
// may leave the canvas, but an owner may not place one there.
func (r *Room) insideCanvas(t Transform) bool {
	width := r.canvasShape.Size.Width
	height := r.canvasShape.Size.Height
	if width == 0 || height == 0 {
		return t.finite()
	}
	return t.X >= 0 && t.X <= width && t.Y >= 0 && t.Y <= height &&
		!math.IsNaN(t.Rotation)
}

// ItemOwner reports the owner of an item, for host applications that need it.
func (r *Room) ItemOwner(entityID string) (string, bool) {
	item, ok := r.items[entityID]
	if !ok {
		return "", false
	}
	return item.OwnerUserID, true
}
