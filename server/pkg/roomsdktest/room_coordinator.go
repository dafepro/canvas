package roomsdktest

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

// RoomCoordinatorConformanceFixture supplies an isolated coordinator and an
// expiry hook. ReopenCoordinator is required for durable shared adapters.
type RoomCoordinatorConformanceFixture struct {
	NewCoordinator    func(t *testing.T) roomsdk.RoomCoordinator
	ReopenCoordinator func(t *testing.T, previous roomsdk.RoomCoordinator) roomsdk.RoomCoordinator
	ExpireLeases      func(t *testing.T)
	TTL               time.Duration
}

// RunRoomCoordinatorConformance verifies exclusivity, renewal, release,
// expiry, fencing, cancellation, and atomic concurrent acquisition.
func RunRoomCoordinatorConformance(t *testing.T, fixture RoomCoordinatorConformanceFixture) {
	t.Helper()
	if fixture.NewCoordinator == nil || fixture.ExpireLeases == nil || fixture.TTL <= 0 {
		t.Fatal("roomsdktest: coordinator, expiry hook, and positive TTL are required")
	}
	request := func(owner string) roomsdk.RoomOwnershipRequest {
		return roomsdk.RoomOwnershipRequest{
			RoomID: "room-a", ReplicaID: "replica-" + owner, OwnerID: owner, TTL: fixture.TTL,
		}
	}

	t.Run("exclusive acquisition renewal release and fencing", func(t *testing.T) {
		coordinator := fixture.NewCoordinator(t)
		first, err := coordinator.AcquireRoom(t.Context(), request("a"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := coordinator.AcquireRoom(t.Context(), request("b")); !errors.Is(err, roomsdk.ErrRoomOwnershipHeld) {
			t.Fatalf("second acquire = %v, want ownership held", err)
		}
		renewed, err := coordinator.RenewRoom(t.Context(), first, fixture.TTL)
		if err != nil || renewed.Generation != first.Generation {
			t.Fatalf("renew = %#v, %v", renewed, err)
		}
		if err := coordinator.ValidateRoom(t.Context(), renewed); err != nil {
			t.Fatal(err)
		}
		if err := coordinator.ReleaseRoom(t.Context(), renewed); err != nil {
			t.Fatal(err)
		}
		second, err := coordinator.AcquireRoom(t.Context(), request("b"))
		if err != nil {
			t.Fatal(err)
		}
		if second.Generation <= first.Generation {
			t.Fatalf("generation = %d, want > %d", second.Generation, first.Generation)
		}
		if err := coordinator.ValidateRoom(t.Context(), first); !errors.Is(err, roomsdk.ErrRoomOwnershipFenced) {
			t.Fatalf("stale validation = %v", err)
		}
	})

	t.Run("expiry failover and adapter reopen", func(t *testing.T) {
		coordinator := fixture.NewCoordinator(t)
		first, err := coordinator.AcquireRoom(t.Context(), request("a"))
		if err != nil {
			t.Fatal(err)
		}
		fixture.ExpireLeases(t)
		if fixture.ReopenCoordinator != nil {
			coordinator = fixture.ReopenCoordinator(t, coordinator)
			if coordinator == nil {
				t.Fatal("ReopenCoordinator returned nil")
			}
		}
		second, err := coordinator.AcquireRoom(t.Context(), request("b"))
		if err != nil {
			t.Fatal(err)
		}
		if second.Generation <= first.Generation {
			t.Fatalf("generation = %d, want > %d", second.Generation, first.Generation)
		}
		if _, err := coordinator.RenewRoom(t.Context(), first, fixture.TTL); !errors.Is(err, roomsdk.ErrRoomOwnershipFenced) {
			t.Fatalf("stale renewal = %v", err)
		}
	})

	t.Run("concurrent acquisition has one winner", func(t *testing.T) {
		coordinator := fixture.NewCoordinator(t)
		var wait sync.WaitGroup
		winners := make(chan roomsdk.RoomOwnership, 16)
		errorsFound := make(chan error, 16)
		for index := 0; index < 16; index++ {
			wait.Add(1)
			go func(index int) {
				defer wait.Done()
				lease, err := coordinator.AcquireRoom(context.Background(), request(fmt.Sprintf("%d", index)))
				if err == nil {
					winners <- lease
				} else if !errors.Is(err, roomsdk.ErrRoomOwnershipHeld) {
					errorsFound <- err
				}
			}(index)
		}
		wait.Wait()
		close(winners)
		close(errorsFound)
		for err := range errorsFound {
			t.Error(err)
		}
		if len(winners) != 1 {
			t.Fatalf("winners = %d, want 1", len(winners))
		}
	})

	t.Run("cancellation", func(t *testing.T) {
		coordinator := fixture.NewCoordinator(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := coordinator.AcquireRoom(ctx, request("cancelled")); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled acquire = %v", err)
		}
	})
}
