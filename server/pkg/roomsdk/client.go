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

// enqueue drops the envelope when the client queue is full. Realtime state is
// newest-matters-most, so a dropped packet is repaired by the next keyframe.
func (c *Client) enqueue(envelope *pb.RoomEnvelope) bool {
	if c.closed.Load() {
		return false
	}
	select {
	case c.send <- envelope:
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
