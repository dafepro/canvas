package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

var (
	ErrTransientActionUnknown      = errors.New("roomsdk: transient action is not registered")
	ErrTransientActionPayload      = errors.New("roomsdk: transient action payload is invalid")
	ErrTransientActionUnauthorized = errors.New("roomsdk: transient action is unauthorized")
)

// TransientActionContext is trusted input to the application registry. The
// participant identity is derived from Authenticator, never from the envelope.
type TransientActionContext struct {
	RoomID        string
	ParticipantID string
	Action        string
	Target        TransientActionTarget
	EntityID      string
	Payload       json.RawMessage
}

type TransientActionTarget string

const (
	TransientActionTargetRoom TransientActionTarget = "room"
	TransientActionTargetItem TransientActionTarget = "item"
)

// TransientActionRoute identifies the behavior entity that receives an
// accepted action. Item actions must route to their target item. A room action
// can route to an application-selected system behavior item.
type TransientActionRoute struct {
	DispatchEntityID string
}

// TransientActionRegistry validates product action names, payload schemas, and
// any application-specific permission before behavior dispatch.
type TransientActionRegistry interface {
	ResolveTransientAction(context.Context, TransientActionContext) (TransientActionRoute, error)
}

type storedTransientActionResult struct {
	key    string
	result *pb.TransientActionResult
}

type transientActionRate struct {
	windowUnixSecond int64
	count            int
}

func (r *Room) handleTransientAction(client *Client, action *pb.TransientAction) {
	result := &pb.TransientActionResult{}
	if action != nil {
		result.ClientSessionId = action.ClientSessionId
		result.RequestId = action.RequestId
		result.Action = action.Action
		result.TargetKind = action.TargetKind
		result.EntityId = action.EntityId
	}
	key := r.transientActionKey(client, action)
	if stored := r.transientActionResults[key]; stored != nil {
		r.sendTransientActionResult(client, proto.Clone(stored).(*pb.TransientActionResult))
		return
	}

	reject := func(code pb.TransientActionRejectCode, message string) {
		result.RejectCode = code
		result.Message = message
		r.rememberTransientAction(client, action, key, result)
		r.sendTransientActionResult(client, result)
		metricTransientAction(r.cfg.Metrics, r.roomID, "rejected", code.String())
	}
	if action == nil || action.ClientSessionId == "" || len(action.ClientSessionId) > 128 ||
		action.RequestId == 0 || len(action.Action) == 0 || len(action.Action) > 128 ||
		!validTransientActionName(action.Action) {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_MALFORMED,
			"the transient action identity or name is malformed")
		return
	}
	highWaterKey := client.UserID + "\x00" + action.ClientSessionId
	if action.RequestId <= r.transientActionHighWater[highWaterKey] {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_STALE,
			"the transient action request is outside the active-room deduplication window")
		return
	}
	if len(action.PayloadJson) > r.cfg.MaxTransientActionPayloadBytes {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_PAYLOAD,
			"the transient action payload exceeds the configured limit")
		return
	}
	if len(action.PayloadJson) > 0 && !json.Valid(action.PayloadJson) {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_PAYLOAD,
			"the transient action payload is not valid JSON")
		return
	}

	target := TransientActionTargetRoom
	switch action.TargetKind {
	case pb.TransientActionTargetKind_TRANSIENT_ACTION_TARGET_ITEM:
		target = TransientActionTargetItem
		item := r.items[action.EntityId]
		if item == nil {
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_NOT_FOUND,
				"the transient action item does not exist")
			return
		}
		if item.OwnerUserID != client.UserID {
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_NOT_OWNER,
				"the authenticated participant does not own the transient action item")
			return
		}
	case pb.TransientActionTargetKind_TRANSIENT_ACTION_TARGET_ROOM:
		if action.EntityId != "" {
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_MALFORMED,
				"a room-targeted transient action cannot name an item")
			return
		}
	default:
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_MALFORMED,
			"the transient action target is malformed")
		return
	}
	if r.transientActionRateLimited(client.UserID) {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_RATE_LIMITED,
			"the transient action rate limit was exceeded")
		return
	}
	if r.cfg.TransientActions == nil {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNKNOWN_ACTION,
			"the transient action is not registered")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.TransientActionTimeout)
	route, err := r.cfg.TransientActions.ResolveTransientAction(ctx, TransientActionContext{
		RoomID: r.roomID, ParticipantID: client.UserID, Action: action.Action,
		Target: target, EntityID: action.EntityId, Payload: append(json.RawMessage(nil), action.PayloadJson...),
	})
	cancel()
	if err != nil {
		switch {
		case errors.Is(err, ErrTransientActionUnknown):
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNKNOWN_ACTION, err.Error())
		case errors.Is(err, ErrTransientActionPayload):
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_PAYLOAD, err.Error())
		case errors.Is(err, ErrTransientActionUnauthorized):
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNAUTHORIZED, err.Error())
		default:
			reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_INTERNAL,
				"the transient action registry is unavailable")
		}
		return
	}
	if target == TransientActionTargetItem && route.DispatchEntityID != "" &&
		route.DispatchEntityID != action.EntityId {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNAUTHORIZED,
			"an item action cannot be routed to another item")
		return
	}
	dispatchEntityID := action.EntityId
	if target == TransientActionTargetRoom {
		dispatchEntityID = route.DispatchEntityID
	}
	if dispatchEntityID == "" || r.items[dispatchEntityID] == nil {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_NOT_FOUND,
			"the transient action behavior target does not exist")
		return
	}
	host := r.clients[r.hostClientID]
	if host == nil {
		reject(pb.TransientActionRejectCode_TRANSIENT_ACTION_REJECT_UNAVAILABLE,
			"the room has no active simulation host")
		return
	}

	result.Accepted = true
	r.rememberTransientAction(client, action, key, result)
	r.sendTransientActionResult(client, result)
	r.sendTo(host, &pb.RoomEnvelope{
		RoomId: r.roomID, HostEpoch: r.hostEpoch, SenderClientId: client.ID,
		Payload: &pb.RoomEnvelope_TransientAction{TransientAction: &pb.TransientAction{
			ClientSessionId: action.ClientSessionId, RequestId: action.RequestId,
			Action: action.Action, TargetKind: action.TargetKind, EntityId: action.EntityId,
			PayloadJson: append([]byte(nil), action.PayloadJson...), ParticipantId: client.UserID,
			DispatchEntityId: dispatchEntityID,
		}},
	})
	metricTransientAction(r.cfg.Metrics, r.roomID, "accepted", "")
}

func validTransientActionName(value string) bool {
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '.' || character == '_' ||
			character == ':' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func (r *Room) transientActionKey(client *Client, action *pb.TransientAction) string {
	if action == nil {
		return client.UserID + "\x00connection:" + client.ID + "\x000"
	}
	session := action.ClientSessionId
	if session == "" {
		session = "connection:" + client.ID
	}
	return client.UserID + "\x00" + session + "\x00" + strconv.FormatUint(action.RequestId, 10)
}

func (r *Room) rememberTransientAction(
	client *Client,
	action *pb.TransientAction,
	key string,
	result *pb.TransientActionResult,
) {
	if _, exists := r.transientActionResults[key]; exists {
		return
	}
	r.transientActionResults[key] = proto.Clone(result).(*pb.TransientActionResult)
	r.transientActionOrder = append(r.transientActionOrder, key)
	if action != nil && action.ClientSessionId != "" && action.RequestId > 0 {
		highWaterKey := client.UserID + "\x00" + action.ClientSessionId
		if action.RequestId > r.transientActionHighWater[highWaterKey] {
			r.transientActionHighWater[highWaterKey] = action.RequestId
		}
	}
	for len(r.transientActionOrder) > r.cfg.MaxTransientActionResultsPerRoom {
		oldest := r.transientActionOrder[0]
		r.transientActionOrder = r.transientActionOrder[1:]
		delete(r.transientActionResults, oldest)
	}
}

func (r *Room) sendTransientActionResult(client *Client, result *pb.TransientActionResult) {
	r.sendTo(client, &pb.RoomEnvelope{Payload: &pb.RoomEnvelope_TransientActionResult{
		TransientActionResult: result,
	}})
}

func (r *Room) transientActionRateLimited(userID string) bool {
	second := r.cfg.Now().Unix()
	rate := r.transientActionRates[userID]
	if rate.windowUnixSecond != second {
		rate = transientActionRate{windowUnixSecond: second}
	}
	if rate.count >= r.cfg.MaxTransientActionsPerSecond {
		return true
	}
	rate.count++
	r.transientActionRates[userID] = rate
	return false
}

type transientActionMetrics interface {
	TransientAction(roomID, status, reason string)
}

func metricTransientAction(metrics Metrics, roomID, status, reason string) {
	if value, ok := metrics.(transientActionMetrics); ok {
		value.TransientAction(roomID, status, reason)
	}
}
