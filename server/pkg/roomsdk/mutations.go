package roomsdk

import (
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
	errNormalizationFlag  = errors.New("checkpoint final flag does not match snapshot normalization")
	errInvalidTimer       = errors.New("checkpoint contains invalid behavior timer state")
)

const (
	minItemScale = 0.25
	maxItemScale = 4.0
)

// handleDurableCommand enforces ownership before the command reaches the
// simulation host (spec 14.1). Client-host physics does not grant edit rights.
func (r *Room) handleDurableCommand(client *Client, command *pb.DurableCommand) {
	accepted, item, reason := r.validateDurable(client, command)
	if !accepted {
		r.cfg.Metrics.DurableRejected(r.roomID, reason)
		r.sendTo(client, &pb.RoomEnvelope{
			RoomId:    r.roomID,
			HostEpoch: r.hostEpoch,
			Payload: &pb.RoomEnvelope_DurableResult{DurableResult: &pb.DurableCommandResult{
				CommandId:     command.CommandId,
				Accepted:      false,
				RejectReason:  reason,
				SceneRevision: r.sceneRevision,
				Command:       command,
			}},
		})
		return
	}

	// A preview move is not durable. Relay it so the host can show the drag,
	// but do not move the scene revision or persist it.
	if command.Preview {
		r.previews[command.EntityId] = client.ID
		r.relayToHost(client, &pb.RoomEnvelope{
			RoomId:         r.roomID,
			HostEpoch:      r.hostEpoch,
			SenderClientId: client.ID,
			Payload:        &pb.RoomEnvelope_DurableCommand{DurableCommand: command},
		})
		return
	}
	if command.Kind == pb.DurableCommandKind_DURABLE_MOVE_ITEM ||
		command.Kind == pb.DurableCommandKind_DURABLE_DELETE_ITEM ||
		command.Kind == pb.DurableCommandKind_DURABLE_SCALE_ITEM {
		delete(r.previews, command.EntityId)
	}

	r.applyDurable(command, item, client)
	// Spec 20. A new item can use a definition a client does not hold.
	r.checkAllDefinitions()
	r.sceneRevision++
	r.snapshot.SceneRevision = r.sceneRevision
	// Only the simulation host can normalize behavior state. Any accepted edit
	// makes a previously sleeping snapshot active again until a host sends a
	// normalized final checkpoint.
	r.snapshot.Normalized = false
	if raw, err := json.Marshal(r.snapshot); err == nil {
		r.snapshotRaw = raw
	}

	// After a spawn the created item is the one the server just indexed.
	if item == nil {
		item = r.items[command.EntityId]
	}
	var itemJSON []byte
	if item != nil {
		itemJSON, _ = json.Marshal(item)
	}

	// Every client learns the accepted mutation, including the host, which
	// applies it to the canonical world.
	r.broadcast(&pb.RoomEnvelope{
		RoomId:         r.roomID,
		HostEpoch:      r.hostEpoch,
		SenderClientId: client.ID,
		Payload: &pb.RoomEnvelope_DurableResult{DurableResult: &pb.DurableCommandResult{
			CommandId:        command.CommandId,
			Accepted:         true,
			SceneRevision:    r.sceneRevision,
			ItemInstanceJson: itemJSON,
			Command:          command,
		}},
	})
	r.persist()
}

// Revert transient placements when their editing client leaves without a
// release commit. A replacement host rebuilds from the committed snapshot; an
// existing host receives the same committed transform as one last preview.
func (r *Room) cancelPreviews(client *Client) {
	for entityID, clientID := range r.previews {
		if clientID != client.ID {
			continue
		}
		delete(r.previews, entityID)
		item := r.items[entityID]
		host := r.clients[r.hostClientID]
		if item == nil || host == nil {
			continue
		}
		command := &pb.DurableCommand{
			CommandId: fmt.Sprintf("preview-revert-%s", entityID),
			Kind:      pb.DurableCommandKind_DURABLE_MOVE_ITEM,
			EntityId:  entityID,
			Position: &pb.Vec2{
				X: float32(item.Transform.X),
				Y: float32(item.Transform.Y),
			},
			Rotation: float32(item.Transform.Rotation),
			Scale:    float32(item.Transform.Scale),
			Preview:  true,
		}
		if item.Transform.Z != nil {
			command.Z = float32(*item.Transform.Z)
		}
		r.sendTo(host, &pb.RoomEnvelope{
			RoomId:         r.roomID,
			HostEpoch:      r.hostEpoch,
			SenderClientId: client.ID,
			Payload:        &pb.RoomEnvelope_DurableCommand{DurableCommand: command},
		})
	}
}

// validateDurable returns the item the command targets, or nil for a spawn.
func (r *Room) validateDurable(
	client *Client,
	command *pb.DurableCommand,
) (bool, *SnapshotItem, string) {
	if command.Preview && command.Kind != pb.DurableCommandKind_DURABLE_MOVE_ITEM {
		return false, nil, "invalid_preview_kind"
	}
	switch command.Kind {
	case pb.DurableCommandKind_DURABLE_SPAWN_ITEM:
		if len(r.snapshot.Items) >= r.canvasShape.Limits.MaxItems {
			return false, nil, "item_limit_reached"
		}
		if command.DefinitionId == "" {
			return false, nil, "missing_definition_id"
		}
		definition, err := r.itemDefinition(command.DefinitionId)
		if err != nil {
			return false, nil, "unknown_definition"
		}
		if command.DefinitionVersion != definition.Version {
			return false, nil, "definition_version_mismatch"
		}
		if err := validateConfigJSON(definition.ConfigSchema, command.ConfigJson); err != nil {
			return false, nil, "config_schema_mismatch"
		}
		if definition.Complexity == ItemComplexityComplex &&
			r.canvasShape.Limits.MaxComplexPhysicsItems > 0 &&
			r.complexItemCount() >= r.canvasShape.Limits.MaxComplexPhysicsItems {
			return false, nil, "complex_item_limit_reached"
		}
		transform := transformOf(command)
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

	case pb.DurableCommandKind_DURABLE_DELETE_ITEM,
		pb.DurableCommandKind_DURABLE_MOVE_ITEM,
		pb.DurableCommandKind_DURABLE_ROTATE_ITEM,
		pb.DurableCommandKind_DURABLE_SCALE_ITEM,
		pb.DurableCommandKind_DURABLE_SET_ITEM_ISOLATION,
		pb.DurableCommandKind_DURABLE_SET_CONFIG:

		item, ok := r.items[command.EntityId]
		if !ok {
			return false, nil, "unknown_entity"
		}
		if item.OwnerUserID == "" {
			return false, nil, "system_owned"
		}
		if item.OwnerUserID != client.UserID {
			return false, nil, "not_owner"
		}
		if command.Kind == pb.DurableCommandKind_DURABLE_MOVE_ITEM ||
			command.Kind == pb.DurableCommandKind_DURABLE_ROTATE_ITEM {
			transform := transformOf(command)
			if !transform.finite() {
				return false, nil, "non_finite_transform"
			}
			if !r.insideCanvas(transform) {
				return false, nil, "outside_canvas"
			}
		}
		if command.Kind == pb.DurableCommandKind_DURABLE_SCALE_ITEM &&
			(float64(command.Scale) < minItemScale || float64(command.Scale) > maxItemScale) {
			return false, nil, "scale_out_of_range"
		}
		if command.Kind == pb.DurableCommandKind_DURABLE_SET_CONFIG &&
			len(command.ConfigJson) > 0 &&
			!json.Valid(command.ConfigJson) {
			return false, nil, "invalid_config_json"
		}
		if command.Kind == pb.DurableCommandKind_DURABLE_SET_CONFIG && len(command.ConfigJson) > 0 {
			definition, err := r.itemDefinition(item.DefinitionID)
			if err != nil {
				return false, nil, "unknown_definition"
			}
			if err := validateConfigJSON(definition.ConfigSchema, command.ConfigJson); err != nil {
				return false, nil, "config_schema_mismatch"
			}
		}
		return true, item, ""

	default:
		return false, nil, "unknown_command_kind"
	}
}

func (r *Room) applyDurable(command *pb.DurableCommand, item *SnapshotItem, client *Client) {
	switch command.Kind {
	case pb.DurableCommandKind_DURABLE_SPAWN_ITEM:
		r.nextEntityNo++
		entityID := command.EntityId
		if entityID == "" || r.items[entityID] != nil {
			// Spec 19.3. The id repeats in every delta for every entity, so it
			// stays short. The room already scopes it, so the canvas id would
			// only repeat bytes on the wire.
			entityID = fmt.Sprintf("i%d", r.nextEntityNo)
		}
		created := SnapshotItem{
			EntityID:          entityID,
			DefinitionID:      command.DefinitionId,
			DefinitionVersion: command.DefinitionVersion,
			// The server sets the owner from the authenticated session.
			OwnerUserID:    client.UserID,
			Transform:      transformOf(command),
			ResolvedConfig: json.RawMessage(command.ConfigJson),
		}
		r.snapshot.Items = append(r.snapshot.Items, created)
		r.indexItems()
		command.EntityId = entityID

	case pb.DurableCommandKind_DURABLE_DELETE_ITEM:
		kept := make([]SnapshotItem, 0, len(r.snapshot.Items))
		for _, existing := range r.snapshot.Items {
			if existing.EntityID != command.EntityId {
				kept = append(kept, existing)
			}
		}
		r.snapshot.Items = kept
		r.indexItems()

	case pb.DurableCommandKind_DURABLE_MOVE_ITEM:
		item.Transform = transformOf(command)

	case pb.DurableCommandKind_DURABLE_ROTATE_ITEM:
		item.Transform.Rotation = float64(command.Rotation)

	case pb.DurableCommandKind_DURABLE_SCALE_ITEM:
		item.Transform.Scale = float64(command.Scale)

	case pb.DurableCommandKind_DURABLE_SET_ITEM_ISOLATION:
		item.Isolated = command.Isolated

	case pb.DurableCommandKind_DURABLE_SET_CONFIG:
		if len(command.ConfigJson) > 0 {
			item.ResolvedConfig = json.RawMessage(command.ConfigJson)
		}
	}
}

func transformOf(command *pb.DurableCommand) Transform {
	scale := float64(command.Scale)
	if scale == 0 && command.Kind != pb.DurableCommandKind_DURABLE_SCALE_ITEM {
		scale = 1
	}
	transform := Transform{
		Rotation: float64(command.Rotation),
		Scale:    scale,
	}
	if command.Position != nil {
		transform.X = float64(command.Position.X)
		transform.Y = float64(command.Position.Y)
	}
	if command.Z != 0 {
		z := float64(command.Z)
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
