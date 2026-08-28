package roomsdktest

import (
	"testing"
	"time"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

func TestMemoryRoomCoordinatorConforms(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	RunRoomCoordinatorConformance(t, RoomCoordinatorConformanceFixture{
		NewCoordinator: func(*testing.T) roomsdk.RoomCoordinator {
			return roomsdk.NewMemoryRoomCoordinatorWithClock(func() time.Time { return now })
		},
		ExpireLeases: func(*testing.T) { now = now.Add(2 * time.Second) },
		TTL:          time.Second,
	})
}
