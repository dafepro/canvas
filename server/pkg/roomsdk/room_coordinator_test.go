package roomsdk

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestMemoryRoomCoordinatorFencesExpiredAndReleasedOwners(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	coordinator := NewMemoryRoomCoordinatorWithClock(func() time.Time { return now })
	first, err := coordinator.AcquireRoom(t.Context(), RoomOwnershipRequest{
		RoomID: "room", ReplicaID: "replica-a", OwnerID: "process-a", TTL: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.AcquireRoom(t.Context(), RoomOwnershipRequest{
		RoomID: "room", ReplicaID: "replica-b", OwnerID: "process-b", TTL: time.Second,
	}); !errors.Is(err, ErrRoomOwnershipHeld) {
		t.Fatalf("concurrent AcquireRoom error = %v, want ErrRoomOwnershipHeld", err)
	}

	now = now.Add(2 * time.Second)
	second, err := coordinator.AcquireRoom(t.Context(), RoomOwnershipRequest{
		RoomID: "room", ReplicaID: "replica-b", OwnerID: "process-b", TTL: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Generation <= first.Generation {
		t.Fatalf("generation = %d, want > %d", second.Generation, first.Generation)
	}
	if err := coordinator.ValidateRoom(t.Context(), first); !errors.Is(err, ErrRoomOwnershipFenced) {
		t.Fatalf("stale ValidateRoom error = %v, want ErrRoomOwnershipFenced", err)
	}
	if _, err := coordinator.RenewRoom(t.Context(), first, time.Second); !errors.Is(err, ErrRoomOwnershipFenced) {
		t.Fatalf("stale RenewRoom error = %v, want ErrRoomOwnershipFenced", err)
	}
	if err := coordinator.ReleaseRoom(t.Context(), first); !errors.Is(err, ErrRoomOwnershipFenced) {
		t.Fatalf("stale ReleaseRoom error = %v, want ErrRoomOwnershipFenced", err)
	}
	if err := coordinator.ReleaseRoom(t.Context(), second); err != nil {
		t.Fatal(err)
	}
	third, err := coordinator.AcquireRoom(t.Context(), RoomOwnershipRequest{
		RoomID: "room", ReplicaID: "replica-a", OwnerID: "process-c", TTL: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if third.Generation <= second.Generation {
		t.Fatalf("generation = %d, want > %d", third.Generation, second.Generation)
	}
}

func TestMemoryRoomCoordinatorConcurrentAcquireHasOneWinner(t *testing.T) {
	coordinator := NewMemoryRoomCoordinator()
	var wait sync.WaitGroup
	winners := make(chan RoomOwnership, 16)
	for index := 0; index < 16; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			lease, err := coordinator.AcquireRoom(context.Background(), RoomOwnershipRequest{
				RoomID: "room", ReplicaID: "replica", OwnerID: time.Now().String(), TTL: time.Minute,
			})
			if err == nil {
				winners <- lease
			} else if !errors.Is(err, ErrRoomOwnershipHeld) {
				t.Errorf("AcquireRoom error = %v", err)
			}
		}()
	}
	wait.Wait()
	close(winners)
	if got := len(winners); got != 1 {
		t.Fatalf("winners = %d, want 1", got)
	}
}

func TestMemoryRoomCoordinatorHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := NewMemoryRoomCoordinator().AcquireRoom(ctx, RoomOwnershipRequest{
		RoomID: "room", ReplicaID: "replica", OwnerID: "process", TTL: time.Second,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("AcquireRoom error = %v, want context.Canceled", err)
	}
}
