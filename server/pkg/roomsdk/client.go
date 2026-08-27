package roomsdk

import (
	"sync/atomic"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// Client is one connected browser.
type Client struct {
	ID          string
	UserID      string
	DisplayName string

	// send carries outbound envelopes. A slow client is disconnected rather
	// than allowed to block the room loop.
	send chan *pb.RoomEnvelope
	// close is closed once, when the connection must end.
	closeOnce chan struct{}
	closed    atomic.Bool

	joined bool

	// Host health from the newest heartbeat (spec 11.2).
	lastHeartbeat time.Time
	simulationHz  float32
	workerDrift   float32
	pageVisible   bool
	hostEligible  bool

	// Spec 20. Exact item definition versions the client declared on join.
	definitions map[string]uint32
	// True while the client lacks a definition the scene uses.
	definitionMismatch bool
}

func newClient(id string, identity Identity, queueDepth int) *Client {
	return &Client{
		ID:           id,
		UserID:       identity.UserID,
		DisplayName:  identity.DisplayName,
		send:         make(chan *pb.RoomEnvelope, queueDepth),
		closeOnce:    make(chan struct{}),
		pageVisible:  true,
		hostEligible: true,
	}
}

// enqueue prioritizes reliable envelopes over repairable realtime state. A
// false return for a reliable envelope means the client cannot keep up even
// after all queued realtime state has been discarded.
func (c *Client) enqueue(envelope *pb.RoomEnvelope) bool {
	if c.closed.Load() {
		return false
	}
	if cap(c.send) == 0 {
		return false
	}
	for {
		select {
		case c.send <- envelope:
			return true
		default:
		}
		if isRealtimeEnvelope(envelope) {
			return false
		}
		select {
		case queued := <-c.send:
			if isRealtimeEnvelope(queued) {
				continue
			}
			// Only the room goroutine produces outbound messages. With one
			// slot just removed, restoring an earlier reliable envelope cannot
			// block even while the writer consumes from the channel.
			c.send <- queued
			return false
		default:
			// The writer freed capacity after the first send attempt.
		}
	}
}

func isRealtimeEnvelope(envelope *pb.RoomEnvelope) bool {
	if envelope == nil {
		return false
	}
	switch envelope.Payload.(type) {
	case *pb.RoomEnvelope_PlayerInput,
		*pb.RoomEnvelope_StateDelta,
		*pb.RoomEnvelope_ItemEditPreview:
		return true
	default:
		return false
	}
}

func (c *Client) close() {
	if c.closed.CompareAndSwap(false, true) {
		close(c.closeOnce)
	}
}

func (c *Client) toPeer(hostClientID string) *pb.Peer {
	return &pb.Peer{
		ClientId:     c.ID,
		UserId:       c.UserID,
		DisplayName:  c.DisplayName,
		IsHost:       c.ID == hostClientID,
		HostEligible: c.hostEligible,
	}
}
