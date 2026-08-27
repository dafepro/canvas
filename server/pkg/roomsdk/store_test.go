package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestMemoryStoreRetainsExactCatalogVersions(t *testing.T) {
	store := NewMemoryStore()
	store.PutCanvas(CanvasRecord{
		CanvasID: "shared", Version: 1, DefinitionRaw: json.RawMessage(`{"version":1}`),
	})
	store.PutCanvas(CanvasRecord{
		CanvasID: "shared", Version: 2, DefinitionRaw: json.RawMessage(`{"version":2}`),
	})
	store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "ball", Version: 1, ConfigSchema: json.RawMessage(`{"type":"object"}`),
	})
	store.PutItemDefinition(ItemDefinitionRecord{
		DefinitionID: "ball", Version: 2, ConfigSchema: json.RawMessage(`{"type":"object","required":[]}`),
	})

	ctx := context.Background()
	for _, version := range []uint32{1, 2} {
		canvas, err := store.LoadCanvas(ctx, "shared", version)
		if err != nil || canvas.Version != version {
			t.Fatalf("LoadCanvas(shared, %d) = %#v, %v", version, canvas, err)
		}
		definition, err := store.LoadItemDefinition(ctx, "ball", version)
		if err != nil || definition.Version != version {
			t.Fatalf("LoadItemDefinition(ball, %d) = %#v, %v", version, definition, err)
		}
	}
	if _, err := store.LoadCanvas(ctx, "shared", 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing canvas version error = %v, want ErrNotFound", err)
	}
	if _, err := store.LoadItemDefinition(ctx, "ball", 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing definition version error = %v, want ErrNotFound", err)
	}
}
