package roomsdk

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrRoomOwnershipHeld means another healthy replica currently owns a room.
	ErrRoomOwnershipHeld = errors.New("roomsdk: room ownership is held by another replica")
	// ErrRoomOwnershipFenced means a lease or snapshot belongs to an obsolete generation.
	ErrRoomOwnershipFenced = errors.New("roomsdk: room ownership generation is fenced")
	// ErrServerDraining means this server has stopped acquiring rooms.
	ErrServerDraining = errors.New("roomsdk: server is draining")
)

// RoomOwnership is an opaque, generation-fenced room lease. Adapters must
// compare every field when renewing, validating, or releasing a lease.
type RoomOwnership struct {
	RoomID         string
	ReplicaID      string
	OwnerID        string
	LeaseID        string
	Generation     uint64
	LeaseExpiresAt time.Time
}

// RoomOwnershipRequest identifies the process attempting to acquire a room.
type RoomOwnershipRequest struct {
	RoomID    string
	ReplicaID string
	OwnerID   string
	TTL       time.Duration
}

// RoomCoordinator provides exclusive, expiring ownership with monotonically
// increasing fencing generations. Implementations must make Acquire atomic.
type RoomCoordinator interface {
	AcquireRoom(context.Context, RoomOwnershipRequest) (RoomOwnership, error)
	RenewRoom(context.Context, RoomOwnership, time.Duration) (RoomOwnership, error)
	ValidateRoom(context.Context, RoomOwnership) error
	ReleaseRoom(context.Context, RoomOwnership) error
}

// MemoryRoomCoordinator is the process-local reference implementation. Share
// one instance between Server values to exercise multi-replica behavior.
type MemoryRoomCoordinator struct {
	mu          sync.Mutex
	now         func() time.Time
	active      map[string]RoomOwnership
	generations map[string]uint64
}

func NewMemoryRoomCoordinator() *MemoryRoomCoordinator {
	return NewMemoryRoomCoordinatorWithClock(time.Now)
}

// NewMemoryRoomCoordinatorWithClock supplies a deterministic clock for tests.
func NewMemoryRoomCoordinatorWithClock(now func() time.Time) *MemoryRoomCoordinator {
	if now == nil {
		now = time.Now
	}
	return &MemoryRoomCoordinator{
		now:         now,
		active:      make(map[string]RoomOwnership),
		generations: make(map[string]uint64),
	}
}

func (c *MemoryRoomCoordinator) AcquireRoom(
	ctx context.Context,
	request RoomOwnershipRequest,
) (RoomOwnership, error) {
	if err := ctx.Err(); err != nil {
		return RoomOwnership{}, err
	}
	if request.RoomID == "" || request.ReplicaID == "" || request.OwnerID == "" || request.TTL <= 0 {
		return RoomOwnership{}, errors.New("roomsdk: room ownership request is incomplete")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if current, ok := c.active[request.RoomID]; ok && now.Before(current.LeaseExpiresAt) {
		return RoomOwnership{}, fmt.Errorf("%w: owner=%s generation=%d",
			ErrRoomOwnershipHeld, current.ReplicaID, current.Generation)
	}
	generation := c.generations[request.RoomID] + 1
	c.generations[request.RoomID] = generation
	lease := RoomOwnership{
		RoomID:         request.RoomID,
		ReplicaID:      request.ReplicaID,
		OwnerID:        request.OwnerID,
		LeaseID:        uuid.NewString(),
		Generation:     generation,
		LeaseExpiresAt: now.Add(request.TTL),
	}
	c.active[request.RoomID] = lease
	return lease, nil
}

func (c *MemoryRoomCoordinator) RenewRoom(
	ctx context.Context,
	lease RoomOwnership,
	ttl time.Duration,
) (RoomOwnership, error) {
	if err := ctx.Err(); err != nil {
		return RoomOwnership{}, err
	}
	if ttl <= 0 {
		return RoomOwnership{}, errors.New("roomsdk: room ownership TTL must be positive")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.active[lease.RoomID]
	if !ok || !sameOwnership(current, lease) || !c.now().Before(current.LeaseExpiresAt) {
		return RoomOwnership{}, ErrRoomOwnershipFenced
	}
	current.LeaseExpiresAt = c.now().Add(ttl)
	c.active[lease.RoomID] = current
	return current, nil
}

func (c *MemoryRoomCoordinator) ValidateRoom(ctx context.Context, lease RoomOwnership) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.active[lease.RoomID]
	if !ok || !sameOwnership(current, lease) || !c.now().Before(current.LeaseExpiresAt) {
		return ErrRoomOwnershipFenced
	}
	return nil
}

func (c *MemoryRoomCoordinator) ReleaseRoom(ctx context.Context, lease RoomOwnership) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.active[lease.RoomID]
	if !ok || !sameOwnership(current, lease) {
		return ErrRoomOwnershipFenced
	}
	delete(c.active, lease.RoomID)
	return nil
}

func sameOwnership(left, right RoomOwnership) bool {
	return left.RoomID == right.RoomID && left.ReplicaID == right.ReplicaID &&
		left.OwnerID == right.OwnerID && left.LeaseID == right.LeaseID &&
		left.Generation == right.Generation
}
