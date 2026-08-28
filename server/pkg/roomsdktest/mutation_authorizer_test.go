package roomsdktest

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

func TestMutationAuthorizerConformance(t *testing.T) {
	now := time.Now().UTC()
	type permit struct {
		participant string
		room        string
		expires     time.Time
		reservation string
		eligible    bool
	}
	permits := map[string]permit{
		"approved": {participant: "alice", room: "room-a", expires: now.Add(time.Hour), reservation: "one-use", eligible: true},
		"denied":   {participant: "alice", room: "room-a", expires: now.Add(time.Hour), reservation: "denied", eligible: false},
		"expired":  {participant: "alice", room: "room-a", expires: now.Add(-time.Second), reservation: "expired", eligible: true},
	}
	var mu sync.Mutex
	consumed := map[string]bool{}
	authorizer := roomsdk.MutationAuthorizerFunc(func(
		_ context.Context,
		request roomsdk.MutationAuthorizationRequest,
	) (roomsdk.MutationAuthorizationDecision, error) {
		token := strings.TrimPrefix(string(request.AuthorizationEvidence), "permit:")
		issued, ok := permits[token]
		if !ok || !issued.eligible || issued.participant != request.Participant.UserID ||
			issued.room != request.RoomID || !now.Before(issued.expires) {
			return roomsdk.MutationAuthorizationDecision{Reason: "permit does not apply"}, nil
		}
		mu.Lock()
		defer mu.Unlock()
		if consumed[issued.reservation] {
			return roomsdk.MutationAuthorizationDecision{Reason: "permit already consumed"}, nil
		}
		consumed[issued.reservation] = true
		return roomsdk.MutationAuthorizationDecision{Authorized: true}, nil
	})
	request := func(token, participant, room, idempotency string) roomsdk.MutationAuthorizationRequest {
		return roomsdk.MutationAuthorizationRequest{
			Participant:           roomsdk.Identity{UserID: participant, DisplayName: participant},
			RoomID:                room,
			CanvasID:              "canvas-a",
			CanvasVersion:         1,
			Kind:                  roomsdk.MutationKindSpawn,
			DefinitionID:          "item",
			DefinitionVersion:     1,
			Idempotency:           roomsdk.MutationIdempotencyIdentity{Key: idempotency},
			AuthorizationEvidence: []byte(fmt.Sprintf("permit:%s", token)),
		}
	}
	RunMutationAuthorizerConformance(t, MutationAuthorizerConformanceFixture{
		Authorizer:       authorizer,
		Approved:         request("approved", "alice", "room-a", "id-1"),
		Denied:           request("denied", "alice", "room-a", "id-2"),
		Expired:          request("expired", "alice", "room-a", "id-3"),
		WrongRoom:        request("approved", "alice", "room-b", "id-4"),
		WrongParticipant: request("approved", "bob", "room-a", "id-5"),
		Replayed:         request("approved", "alice", "room-a", "id-6"),
	})
}
