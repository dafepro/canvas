package roomsdk

import (
	"encoding/json"
	"strings"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

const mutationReceiptLimit = 256

type storedMutationReceipt struct {
	userID string
	result *pb.ItemMutationResult
}

type itemEditSession struct {
	clientID        string
	userID          string
	clientSessionID string
	editSessionID   string
	entityID        string
	itemRevision    uint64
	leaseUntil      time.Time
	lastPreviewSeq  uint64
	latestPreview   *pb.ItemEditPreview
}

func clientSessionKey(userID, clientSessionID string) string {
	return userID + "\x00" + clientSessionID
}

func splitClientSessionKey(key string) (string, string) {
	parts := strings.SplitN(key, "\x00", 2)
	if len(parts) != 2 {
		return key, ""
	}
	return parts[0], parts[1]
}

func mutationReceiptKey(userID, clientSessionID string, mutationID uint64) string {
	return clientSessionKey(userID, clientSessionID) + "\x00" + stringID(mutationID)
}

func editSessionKey(clientSessionID, editSessionID string) string {
	return clientSessionID + "\x00" + editSessionID
}

func stringID(value uint64) string {
	// Fixed-width decimal keeps diagnostic and persisted ordering stable.
	const digits = "00000000000000000000"
	text := uintString(value)
	return digits[:len(digits)-len(text)] + text
}

func uintString(value uint64) string {
	if value == 0 {
		return "0"
	}
	var buffer [20]byte
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[index:])
}

func (r *Room) loadMutationReceipts(record SnapshotRecord) error {
	for _, high := range record.MutationHighWater {
		if high.UserID == "" || high.ClientSessionID == "" {
			continue
		}
		r.mutationHighWater[clientSessionKey(high.UserID, high.ClientSessionID)] = high.MutationID
	}
	for _, persisted := range record.MutationReceipts {
		if persisted.UserID == "" || persisted.ClientSessionID == "" || persisted.MutationID == 0 {
			continue
		}
		result := &pb.ItemMutationResult{}
		if err := proto.Unmarshal(persisted.ResultBytes, result); err != nil {
			return err
		}
		key := mutationReceiptKey(persisted.UserID, persisted.ClientSessionID, persisted.MutationID)
		r.mutationReceipts[key] = &storedMutationReceipt{userID: persisted.UserID, result: result}
		r.mutationReceiptOrder = append(r.mutationReceiptOrder, key)
	}
	return nil
}

func (r *Room) recordMutationReceipt(userID string, result *pb.ItemMutationResult) {
	key := mutationReceiptKey(userID, result.ClientSessionId, result.MutationId)
	if _, exists := r.mutationReceipts[key]; !exists {
		r.mutationReceiptOrder = append(r.mutationReceiptOrder, key)
	}
	r.mutationReceipts[key] = &storedMutationReceipt{
		userID: userID,
		result: proto.Clone(result).(*pb.ItemMutationResult),
	}
	highKey := clientSessionKey(userID, result.ClientSessionId)
	if result.MutationId > r.mutationHighWater[highKey] {
		r.mutationHighWater[highKey] = result.MutationId
	}
	for len(r.mutationReceiptOrder) > mutationReceiptLimit {
		oldest := r.mutationReceiptOrder[0]
		r.mutationReceiptOrder = r.mutationReceiptOrder[1:]
		delete(r.mutationReceipts, oldest)
	}
}

func (r *Room) handleItemMutation(client *Client, mutation *pb.ItemMutation) {
	if mutation == nil || mutation.ClientSessionId == "" || mutation.MutationId == 0 {
		r.sendItemMutationRejection(client, mutation,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_MALFORMED,
			"client session and mutation id are required", nil)
		return
	}

	key := mutationReceiptKey(client.UserID, mutation.ClientSessionId, mutation.MutationId)
	if receipt := r.mutationReceipts[key]; receipt != nil {
		r.sendTo(client, &pb.RoomEnvelope{
			RoomId:    r.roomID,
			HostEpoch: r.hostEpoch,
			Payload: &pb.RoomEnvelope_ItemMutationResult{
				ItemMutationResult: proto.Clone(receipt.result).(*pb.ItemMutationResult),
			},
		})
		return
	}
	if len(mutation.AuthorizationEvidence) > r.cfg.MaxMutationAuthorizationBytes ||
		len(mutation.ApplicationCorrelationId) > r.cfg.MaxMutationCorrelationBytes {
		r.sendItemMutationRejection(client, mutation,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_MALFORMED,
			errOversizedMutationMetadata.Error(), nil)
		return
	}
	if outcome, exists := r.retainedMutationOutcome(mutation); exists {
		if outcome.ParticipantID == client.UserID &&
			outcome.ClientSessionID == mutation.ClientSessionId && outcome.MutationID == mutation.MutationId {
			if r.cfg.Now().Before(outcome.ExpiresAt) {
				result := &pb.ItemMutationResult{}
				if proto.Unmarshal(outcome.ResultBytes, result) == nil {
					r.sendTo(client, &pb.RoomEnvelope{RoomId: r.roomID, HostEpoch: r.hostEpoch,
						Payload: &pb.RoomEnvelope_ItemMutationResult{ItemMutationResult: result}})
					return
				}
			}
			r.sendItemMutationRejectionWithoutOutcome(client, mutation,
				pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_RECEIPT_EXPIRED,
				"the retained application correlation has expired", nil)
			return
		}
		r.sendItemMutationRejectionWithoutOutcome(client, mutation,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_APPLICATION_CORRELATION_CONFLICT,
			"application correlation is already bound to another mutation", nil)
		return
	}
	if mutation.MutationId <= r.mutationHighWater[clientSessionKey(client.UserID, mutation.ClientSessionId)] {
		r.sendItemMutationRejection(client, mutation,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_RECEIPT_EXPIRED,
			"the retained idempotency receipt has expired", nil)
		return
	}

	accepted, item, reason := r.validateItemMutation(client, mutation)
	if !accepted {
		r.sendItemMutationRejection(client, mutation, rejectCodeForReason(reason), reason, item)
		return
	}
	if item != nil && mutation.ExpectedItemRevision != item.ItemRevision {
		r.sendItemMutationRejection(client, mutation,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_STALE_ITEM_REVISION,
			"stale_item_revision", item)
		return
	}
	if mutation.EditSessionId != "" {
		session := r.editSessions[editSessionKey(mutation.ClientSessionId, mutation.EditSessionId)]
		if session == nil || session.clientID != client.ID || session.entityID != mutation.EntityId ||
			!r.cfg.Now().Before(session.leaseUntil) {
			r.sendItemMutationRejection(client, mutation,
				pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED,
				"edit_expired", item)
			return
		}
	}
	if authorized, code, message := r.authorizeItemMutation(client, mutation, item); !authorized {
		r.sendItemMutationRejection(client, mutation, code, message, item)
		return
	}

	r.applyItemMutation(mutation, item, client)
	r.checkAllDefinitions()
	r.sceneRevision++
	r.snapshot.SceneRevision = r.sceneRevision
	r.snapshot.Normalized = false
	if raw, err := json.Marshal(r.snapshot); err == nil {
		r.snapshotRaw = raw
	}

	if item == nil {
		item = r.items[mutation.EntityId]
	}
	itemRevision := uint64(0)
	var itemJSON []byte
	deletedEntityID := ""
	if mutation.Kind == pb.ItemMutationKind_ITEM_MUTATION_DELETE {
		deletedEntityID = mutation.EntityId
		// applyItemMutation increments the pointed-to tombstone before removing it.
		if item != nil {
			itemRevision = item.ItemRevision
		}
	} else if item != nil {
		itemRevision = item.ItemRevision
		itemJSON, _ = json.Marshal(item)
	}
	if session := r.editSessions[editSessionKey(mutation.ClientSessionId, mutation.EditSessionId)]; session != nil {
		session.itemRevision = itemRevision
	}

	result := &pb.ItemMutationResult{
		ClientSessionId:  mutation.ClientSessionId,
		MutationId:       mutation.MutationId,
		EditSessionId:    mutation.EditSessionId,
		Accepted:         true,
		SceneRevision:    r.sceneRevision,
		ItemRevision:     itemRevision,
		ItemInstanceJson: itemJSON,
		DeletedEntityId:  deletedEntityID,
		Kind:             mutation.Kind,
		EntityId:         mutation.EntityId,
	}
	r.recordMutationReceipt(client.UserID, result)
	r.recordMutationOutcome(client, mutation, result, item)
	r.broadcast(&pb.RoomEnvelope{
		RoomId:         r.roomID,
		HostEpoch:      r.hostEpoch,
		SenderClientId: client.ID,
		Payload: &pb.RoomEnvelope_ItemMutationResult{
			ItemMutationResult: result,
		},
	})
	r.persistAsync()
}

func (r *Room) sendItemMutationRejection(
	client *Client,
	mutation *pb.ItemMutation,
	code pb.ItemMutationRejectCode,
	message string,
	item *SnapshotItem,
) {
	r.sendItemMutationRejectionWithOutcome(client, mutation, code, message, item, true)
}

func (r *Room) sendItemMutationRejectionWithoutOutcome(
	client *Client,
	mutation *pb.ItemMutation,
	code pb.ItemMutationRejectCode,
	message string,
	item *SnapshotItem,
) {
	r.sendItemMutationRejectionWithOutcome(client, mutation, code, message, item, false)
}

func (r *Room) sendItemMutationRejectionWithOutcome(
	client *Client,
	mutation *pb.ItemMutation,
	code pb.ItemMutationRejectCode,
	message string,
	item *SnapshotItem,
	recordOutcome bool,
) {
	result := &pb.ItemMutationResult{
		Accepted:      false,
		RejectCode:    code,
		Message:       message,
		SceneRevision: r.sceneRevision,
	}
	if mutation != nil {
		result.ClientSessionId = mutation.ClientSessionId
		result.MutationId = mutation.MutationId
		result.EditSessionId = mutation.EditSessionId
		result.Kind = mutation.Kind
		result.EntityId = mutation.EntityId
	}
	if item != nil {
		result.ItemRevision = item.ItemRevision
		result.ItemInstanceJson, _ = json.Marshal(item)
	}
	if mutation != nil && mutation.ClientSessionId != "" && mutation.MutationId != 0 &&
		code != pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_RECEIPT_EXPIRED {
		r.recordMutationReceipt(client.UserID, result)
	}
	if recordOutcome {
		r.recordMutationOutcome(client, mutation, result, item)
	}
	r.cfg.Metrics.DurableRejected(r.roomID, code.String())
	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_ItemMutationResult{
			ItemMutationResult: result,
		},
	})
}

func rejectCodeForReason(reason string) pb.ItemMutationRejectCode {
	switch reason {
	case "unknown_entity":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_FOUND
	case "system_owned":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_SYSTEM_OWNED
	case "not_owner":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_OWNER
	case "outside_canvas", "non_finite_transform":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_OUTSIDE_CANVAS
	case "scale_out_of_range":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_SCALE_OUT_OF_RANGE
	case "missing_definition_id", "unknown_definition_version":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_DEFINITION
	case "invalid_config_json", "config_schema_mismatch":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_CONFIG
	case "item_limit_reached", "complex_item_limit_reached":
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_CAPACITY
	default:
		return pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_MALFORMED
	}
}

func transformFromPreview(preview *pb.ItemEditPreview) Transform {
	scale := float64(preview.Scale)
	if scale == 0 {
		scale = 1
	}
	transform := Transform{
		Rotation: float64(preview.Rotation),
		Scale:    scale,
	}
	if preview.Position != nil {
		transform.X = float64(preview.Position.X)
		transform.Y = float64(preview.Position.Y)
	}
	if preview.Z != 0 {
		z := float64(preview.Z)
		transform.Z = &z
	}
	return transform
}

func (r *Room) handleBeginItemEdit(client *Client, begin *pb.BeginItemEdit) {
	if begin == nil || begin.ClientSessionId == "" || begin.EditSessionId == "" || begin.EntityId == "" {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_MALFORMED,
			"edit session and entity are required", nil, time.Time{})
		return
	}
	item := r.items[begin.EntityId]
	if item == nil {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_FOUND,
			"unknown_entity", nil, time.Time{})
		return
	}
	if item.OwnerUserID == "" {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_SYSTEM_OWNED,
			"system_owned", item, time.Time{})
		return
	}
	if item.OwnerUserID != client.UserID {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_NOT_OWNER,
			"not_owner", item, time.Time{})
		return
	}
	if begin.ObservedItemRevision != item.ItemRevision {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_STALE_ITEM_REVISION,
			"stale_item_revision", item, time.Time{})
		return
	}

	now := r.cfg.Now()
	key := editSessionKey(begin.ClientSessionId, begin.EditSessionId)
	if existingKey := r.editByEntity[begin.EntityId]; existingKey != "" && existingKey != key {
		existing := r.editSessions[existingKey]
		if existing != nil && now.Before(existing.leaseUntil) {
			r.sendEditSessionResult(client, begin,
				pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
				pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_IN_USE,
				"item_edit_in_use", item, time.Time{})
			return
		}
		if existing != nil {
			r.finishItemEdit(existing, pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED,
				"edit lease expired", true)
		}
	}
	if existing := r.editSessions[key]; existing != nil {
		if existing.clientID != client.ID || existing.entityID != begin.EntityId {
			r.sendEditSessionResult(client, begin,
				pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_REJECTED,
				pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_IN_USE,
				"edit session id is already active", item, time.Time{})
			return
		}
		existing.leaseUntil = now.Add(r.cfg.ItemEditLeaseTTL)
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED,
			"", item, existing.leaseUntil)
		return
	}

	session := &itemEditSession{
		clientID:        client.ID,
		userID:          client.UserID,
		clientSessionID: begin.ClientSessionId,
		editSessionID:   begin.EditSessionId,
		entityID:        begin.EntityId,
		itemRevision:    item.ItemRevision,
		leaseUntil:      now.Add(r.cfg.ItemEditLeaseTTL),
	}
	r.editSessions[key] = session
	r.editByEntity[begin.EntityId] = key
	r.sendEditSessionResult(client, begin,
		pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ACTIVE,
		pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED,
		"", item, session.leaseUntil)
}

func (r *Room) handleRenewItemEdit(client *Client, renew *pb.RenewItemEdit) {
	if renew == nil {
		return
	}
	begin := &pb.BeginItemEdit{
		ClientSessionId: renew.ClientSessionId,
		EditSessionId:   renew.EditSessionId,
		EntityId:        renew.EntityId,
	}
	session := r.editSessions[editSessionKey(renew.ClientSessionId, renew.EditSessionId)]
	if session == nil || session.clientID != client.ID || session.entityID != renew.EntityId ||
		!r.cfg.Now().Before(session.leaseUntil) {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED,
			"edit_expired", r.items[renew.EntityId], time.Time{})
		return
	}
	session.leaseUntil = r.cfg.Now().Add(r.cfg.ItemEditLeaseTTL)
	r.sendEditSessionResult(client, begin,
		pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_RENEWED,
		pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED,
		"", r.items[renew.EntityId], session.leaseUntil)
}

func (r *Room) handleEndItemEdit(client *Client, end *pb.EndItemEdit) {
	if end == nil {
		return
	}
	session := r.editSessions[editSessionKey(end.ClientSessionId, end.EditSessionId)]
	begin := &pb.BeginItemEdit{
		ClientSessionId: end.ClientSessionId,
		EditSessionId:   end.EditSessionId,
		EntityId:        end.EntityId,
	}
	if session == nil || session.clientID != client.ID || session.entityID != end.EntityId {
		r.sendEditSessionResult(client, begin,
			pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED,
			pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED,
			"edit_expired", r.items[end.EntityId], time.Time{})
		return
	}
	r.finishItemEdit(session, pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_ENDED, "", true)
}

func (r *Room) handleItemEditPreview(client *Client, preview *pb.ItemEditPreview) {
	if preview == nil || preview.Revert {
		return
	}
	session := r.editSessions[editSessionKey(preview.ClientSessionId, preview.EditSessionId)]
	if session == nil || session.clientID != client.ID || session.entityID != preview.EntityId ||
		!r.cfg.Now().Before(session.leaseUntil) || preview.PreviewSequence <= session.lastPreviewSeq {
		return
	}
	transform := transformFromPreview(preview)
	if !transform.finite() || !r.insideCanvas(transform) {
		return
	}
	session.lastPreviewSeq = preview.PreviewSequence
	session.latestPreview = proto.Clone(preview).(*pb.ItemEditPreview)
	r.relayToHost(client, &pb.RoomEnvelope{
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_ItemEditPreview{
			ItemEditPreview: proto.Clone(preview).(*pb.ItemEditPreview),
		},
	})
}

func (r *Room) sendEditSessionResult(
	client *Client,
	begin *pb.BeginItemEdit,
	status pb.ItemEditSessionStatus,
	rejectCode pb.ItemMutationRejectCode,
	message string,
	item *SnapshotItem,
	leaseUntil time.Time,
) {
	result := &pb.ItemEditSessionResult{
		Status:     status,
		RejectCode: rejectCode,
		Message:    message,
	}
	if begin != nil {
		result.ClientSessionId = begin.ClientSessionId
		result.EditSessionId = begin.EditSessionId
		result.EntityId = begin.EntityId
	}
	if item != nil {
		result.ItemRevision = item.ItemRevision
		result.ItemInstanceJson, _ = json.Marshal(item)
	}
	if !leaseUntil.IsZero() {
		result.LeaseExpiresAtUnixMs = uint64(leaseUntil.UnixMilli())
	}
	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_ItemEditSessionResult{
			ItemEditSessionResult: result,
		},
	})
}

func (r *Room) finishItemEdit(
	session *itemEditSession,
	status pb.ItemEditSessionStatus,
	message string,
	notify bool,
) {
	key := editSessionKey(session.clientSessionID, session.editSessionID)
	delete(r.editSessions, key)
	if r.editByEntity[session.entityID] == key {
		delete(r.editByEntity, session.entityID)
	}
	r.sendItemEditRevert(session)
	if !notify {
		return
	}
	client := r.clients[session.clientID]
	if client == nil {
		return
	}
	code := pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_UNSPECIFIED
	if status == pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED {
		code = pb.ItemMutationRejectCode_ITEM_MUTATION_REJECT_EDIT_EXPIRED
	}
	r.sendEditSessionResult(client, &pb.BeginItemEdit{
		ClientSessionId: session.clientSessionID,
		EditSessionId:   session.editSessionID,
		EntityId:        session.entityID,
	}, status, code, message, r.items[session.entityID], time.Time{})
}

func (r *Room) sendItemEditRevert(session *itemEditSession) {
	item := r.items[session.entityID]
	host := r.clients[r.hostClientID]
	if item == nil || host == nil {
		return
	}
	preview := &pb.ItemEditPreview{
		ClientSessionId: session.clientSessionID,
		EditSessionId:   session.editSessionID,
		EntityId:        session.entityID,
		PreviewSequence: session.lastPreviewSeq + 1,
		Position: &pb.Vec2{
			X: float32(item.Transform.X),
			Y: float32(item.Transform.Y),
		},
		Rotation: float32(item.Transform.Rotation),
		Scale:    float32(item.Transform.Scale),
		Revert:   true,
	}
	if item.Transform.Z != nil {
		preview.Z = float32(*item.Transform.Z)
	}
	r.sendTo(host, &pb.RoomEnvelope{
		RoomId:         r.roomID,
		HostEpoch:      r.hostEpoch,
		SenderClientId: session.clientID,
		Payload: &pb.RoomEnvelope_ItemEditPreview{
			ItemEditPreview: preview,
		},
	})
}

func (r *Room) cancelItemEdits(client *Client) {
	for _, session := range r.editSessions {
		if session.clientID == client.ID {
			r.finishItemEdit(session, pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_SUPERSEDED,
				"connection ended", false)
		}
	}
}

func (r *Room) checkItemEditLeases() {
	now := r.cfg.Now()
	for _, session := range r.editSessions {
		if !now.Before(session.leaseUntil) {
			r.finishItemEdit(session, pb.ItemEditSessionStatus_ITEM_EDIT_SESSION_EXPIRED,
				"edit lease expired", true)
		}
	}
}

func (r *Room) replayItemEditPreviews(host *Client) {
	for _, session := range r.editSessions {
		if session.latestPreview == nil || !r.cfg.Now().Before(session.leaseUntil) {
			continue
		}
		r.sendTo(host, &pb.RoomEnvelope{
			RoomId:         r.roomID,
			HostEpoch:      r.hostEpoch,
			SenderClientId: session.clientID,
			Payload: &pb.RoomEnvelope_ItemEditPreview{
				ItemEditPreview: proto.Clone(session.latestPreview).(*pb.ItemEditPreview),
			},
		})
	}
}
