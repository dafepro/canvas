package roomsdktest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

// StoreConformanceFixture creates an isolated, pre-seeded Store for each
// conformance subtest. Canvas and ItemDefinition must already be loadable.
type StoreConformanceFixture struct {
	NewStore func(t *testing.T) roomsdk.Store
	// ReopenStore is required for durable production adapters. It must return a
	// fresh adapter instance over the same backing data as the supplied store.
	ReopenStore func(t *testing.T, previous roomsdk.Store) roomsdk.Store

	Canvas         roomsdk.CanvasRecord
	ItemDefinition roomsdk.ItemDefinitionRecord

	MissingCanvasID         string
	MissingItemDefinitionID string
	MissingRoomID           string
}

// RunStoreConformance verifies the persistence and ordering guarantees the
// rooms service relies on. External hosts call it from their own Go tests.
func RunStoreConformance(t *testing.T, fixture StoreConformanceFixture) {
	t.Helper()
	validateStoreFixture(t, fixture)

	t.Run("catalog records and not-found semantics", func(t *testing.T) {
		store := fixture.NewStore(t)
		ctx := t.Context()

		canvas, err := store.LoadCanvas(ctx, fixture.Canvas.CanvasID)
		if err != nil {
			t.Fatalf("LoadCanvas returned error: %v", err)
		}
		if !equalCanvas(canvas, fixture.Canvas) {
			t.Fatalf("canvas = %#v, want %#v", canvas, fixture.Canvas)
		}

		definition, err := store.LoadItemDefinition(ctx, fixture.ItemDefinition.DefinitionID)
		if err != nil {
			t.Fatalf("LoadItemDefinition returned error: %v", err)
		}
		if !equalDefinition(definition, fixture.ItemDefinition) {
			t.Fatalf("definition = %#v, want %#v", definition, fixture.ItemDefinition)
		}

		if versioned, ok := store.(roomsdk.VersionedCatalogStore); ok {
			exactCanvas, err := versioned.LoadCanvasVersion(
				ctx,
				fixture.Canvas.CanvasID,
				fixture.Canvas.Version,
			)
			if err != nil || !equalCanvas(exactCanvas, fixture.Canvas) {
				t.Fatalf("LoadCanvasVersion returned %#v, %v", exactCanvas, err)
			}
			exactDefinition, err := versioned.LoadItemDefinitionVersion(
				ctx,
				fixture.ItemDefinition.DefinitionID,
				fixture.ItemDefinition.Version,
			)
			if err != nil || !equalDefinition(exactDefinition, fixture.ItemDefinition) {
				t.Fatalf("LoadItemDefinitionVersion returned %#v, %v", exactDefinition, err)
			}
			missingCanvas, err := versioned.LoadCanvasVersion(
				ctx,
				fixture.Canvas.CanvasID,
				fixture.Canvas.Version+1,
			)
			assertNotFound(
				t,
				"LoadCanvasVersion",
				reflect.DeepEqual(missingCanvas, roomsdk.CanvasRecord{}),
				err,
			)
			missingDefinition, err := versioned.LoadItemDefinitionVersion(
				ctx,
				fixture.ItemDefinition.DefinitionID,
				fixture.ItemDefinition.Version+1,
			)
			assertNotFound(
				t,
				"LoadItemDefinitionVersion",
				reflect.DeepEqual(missingDefinition, roomsdk.ItemDefinitionRecord{}),
				err,
			)
		}

		missingCanvas, err := store.LoadCanvas(ctx, fixture.MissingCanvasID)
		assertNotFound(t, "LoadCanvas", reflect.DeepEqual(missingCanvas, roomsdk.CanvasRecord{}), err)
		missingDefinition, err := store.LoadItemDefinition(ctx, fixture.MissingItemDefinitionID)
		assertNotFound(
			t,
			"LoadItemDefinition",
			reflect.DeepEqual(missingDefinition, roomsdk.ItemDefinitionRecord{}),
			err,
		)
		missingSnapshot, err := store.LoadSnapshot(ctx, fixture.MissingRoomID)
		assertNotFound(
			t,
			"LoadSnapshot",
			reflect.DeepEqual(missingSnapshot, roomsdk.SnapshotRecord{}),
			err,
		)
	})

	t.Run("snapshot lifecycle and room isolation", func(t *testing.T) {
		store := fixture.NewStore(t)
		ctx := t.Context()
		first := conformanceSnapshot(fixture, "room-a", 1)
		newest := conformanceSnapshot(fixture, "room-a", 3)
		stale := conformanceSnapshot(fixture, "room-a", 2)
		other := conformanceSnapshot(fixture, "room-b", 7)

		saveSnapshot(t, ctx, store, first)
		assertSnapshot(t, ctx, store, first)
		saveSnapshot(t, ctx, store, newest)
		assertSnapshot(t, ctx, store, newest)
		saveSnapshot(t, ctx, store, stale)
		assertSnapshot(t, ctx, store, newest)

		saveSnapshot(t, ctx, store, other)
		assertSnapshot(t, ctx, store, newest)
		assertSnapshot(t, ctx, store, other)
	})

	t.Run("concurrent checkpoint ordering", func(t *testing.T) {
		store := fixture.NewStore(t)
		ctx := t.Context()
		const writes = 24
		errorsByRevision := make(chan error, writes)
		var wait sync.WaitGroup
		for revision := uint64(1); revision <= writes; revision++ {
			wait.Add(1)
			go func(revision uint64) {
				defer wait.Done()
				if err := store.SaveSnapshot(
					ctx,
					conformanceSnapshot(fixture, "concurrent-room", revision),
				); err != nil {
					errorsByRevision <- fmt.Errorf("revision %d: %w", revision, err)
				}
			}(revision)
		}
		wait.Wait()
		close(errorsByRevision)
		for err := range errorsByRevision {
			t.Error(err)
		}
		assertSnapshot(
			t,
			ctx,
			store,
			conformanceSnapshot(fixture, "concurrent-room", writes),
		)
	})

	if fixture.ReopenStore != nil {
		t.Run("durable checkpoint survives adapter reopen", func(t *testing.T) {
			store := fixture.NewStore(t)
			want := conformanceSnapshot(fixture, "durable-room", 9)
			saveSnapshot(t, t.Context(), store, want)
			reopened := fixture.ReopenStore(t, store)
			if reopened == nil {
				t.Fatal("ReopenStore returned nil")
			}
			assertSnapshot(t, t.Context(), reopened, want)
		})
	}
}

func validateStoreFixture(t *testing.T, fixture StoreConformanceFixture) {
	t.Helper()
	if fixture.NewStore == nil {
		t.Fatal("roomsdktest: StoreConformanceFixture.NewStore is required")
	}
	if fixture.Canvas.CanvasID == "" || fixture.Canvas.Version == 0 {
		t.Fatal("roomsdktest: a versioned Canvas fixture is required")
	}
	if fixture.ItemDefinition.DefinitionID == "" || fixture.ItemDefinition.Version == 0 {
		t.Fatal("roomsdktest: a versioned ItemDefinition fixture is required")
	}
	if fixture.MissingCanvasID == "" || fixture.MissingItemDefinitionID == "" ||
		fixture.MissingRoomID == "" {
		t.Fatal("roomsdktest: explicit missing record IDs are required")
	}
}

func conformanceSnapshot(
	fixture StoreConformanceFixture,
	roomID string,
	revision uint64,
) roomsdk.SnapshotRecord {
	return roomsdk.SnapshotRecord{
		RoomID:             roomID,
		CanvasID:           fixture.Canvas.CanvasID,
		CanvasVersion:      fixture.Canvas.Version,
		SceneRevision:      revision + 10,
		CheckpointRevision: revision,
		HostEpoch:          4,
		Tick:               revision * 60,
		Normalized:         revision%2 == 0,
		CapturedAt:         time.Unix(int64(1_800_000_000+revision), 0).UTC(),
		SnapshotRaw:        json.RawMessage(fmt.Sprintf(`{"revision":%d}`, revision)),
		MutationReceipts: []roomsdk.MutationReceiptRecord{{
			UserID:          "owner",
			ClientSessionID: "browser-session",
			MutationID:      revision,
			ResultBytes:     []byte{byte(revision)},
		}},
		MutationHighWater: []roomsdk.MutationHighWaterRecord{{
			UserID:          "owner",
			ClientSessionID: "browser-session",
			MutationID:      revision,
		}},
	}
}

func saveSnapshot(
	t *testing.T,
	ctx context.Context,
	store roomsdk.Store,
	snapshot roomsdk.SnapshotRecord,
) {
	t.Helper()
	if err := store.SaveSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("SaveSnapshot revision %d returned error: %v", snapshot.CheckpointRevision, err)
	}
}

func assertSnapshot(
	t *testing.T,
	ctx context.Context,
	store roomsdk.Store,
	want roomsdk.SnapshotRecord,
) {
	t.Helper()
	got, err := store.LoadSnapshot(ctx, want.RoomID)
	if err != nil {
		t.Fatalf("LoadSnapshot(%q) returned error: %v", want.RoomID, err)
	}
	if !equalSnapshot(got, want) {
		t.Fatalf("snapshot = %#v, want %#v", got, want)
	}
}

func assertNotFound(t *testing.T, operation string, zero bool, err error) {
	t.Helper()
	if !errors.Is(err, roomsdk.ErrNotFound) {
		t.Fatalf("%s error = %v, want roomsdk.ErrNotFound", operation, err)
	}
	if !zero {
		t.Fatalf("%s returned a partial record with ErrNotFound", operation)
	}
}

func equalCanvas(left, right roomsdk.CanvasRecord) bool {
	return left.CanvasID == right.CanvasID && left.Version == right.Version &&
		equalJSON(left.DefinitionRaw, right.DefinitionRaw)
}

func equalDefinition(left, right roomsdk.ItemDefinitionRecord) bool {
	return left.DefinitionID == right.DefinitionID && left.Version == right.Version &&
		left.Complexity == right.Complexity &&
		equalJSON(left.ConfigSchema, right.ConfigSchema) &&
		equalJSON(left.DefinitionRaw, right.DefinitionRaw)
}

func equalSnapshot(left, right roomsdk.SnapshotRecord) bool {
	leftRaw := left.SnapshotRaw
	rightRaw := right.SnapshotRaw
	left.SnapshotRaw = nil
	right.SnapshotRaw = nil
	return reflect.DeepEqual(left, right) && equalJSON(leftRaw, rightRaw)
}

func equalJSON(left, right json.RawMessage) bool {
	var leftValue any
	var rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return reflect.DeepEqual(left, right)
	}
	return reflect.DeepEqual(leftValue, rightValue)
}
