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

func TestMemoryStoreOwnsImmutableCatalogBytes(t *testing.T) {
	store := NewMemoryStore()
	canvas := CanvasRecord{
		CanvasID: "owned", Version: 1, DefinitionRaw: json.RawMessage(`{"version":1}`),
	}
	definition := ItemDefinitionRecord{
		DefinitionID: "owned-item",
		Version:      1,
		ConfigSchema: json.RawMessage(`{"type":"object"}`),
		DefinitionRaw: json.RawMessage(
			`{"definitionId":"owned-item","version":1}`,
		),
	}
	store.PutCanvas(canvas)
	store.PutItemDefinition(definition)

	canvas.DefinitionRaw[0] = '['
	definition.ConfigSchema[0] = '['
	definition.DefinitionRaw[0] = '['

	loadedCanvas, err := store.LoadCanvas(context.Background(), "owned", 1)
	if err != nil {
		t.Fatal(err)
	}
	loadedDefinition, err := store.LoadItemDefinition(context.Background(), "owned-item", 1)
	if err != nil {
		t.Fatal(err)
	}
	if string(loadedCanvas.DefinitionRaw) != `{"version":1}` ||
		string(loadedDefinition.ConfigSchema) != `{"type":"object"}` ||
		string(loadedDefinition.DefinitionRaw) != `{"definitionId":"owned-item","version":1}` {
		t.Fatalf("registration retained caller-owned bytes: %#v, %#v", loadedCanvas, loadedDefinition)
	}

	loadedCanvas.DefinitionRaw[0] = '['
	loadedDefinition.ConfigSchema[0] = '['
	loadedDefinition.DefinitionRaw[0] = '['
	reloadedCanvas, _ := store.LoadCanvas(context.Background(), "owned", 1)
	reloadedDefinition, _ := store.LoadItemDefinition(context.Background(), "owned-item", 1)
	if string(reloadedCanvas.DefinitionRaw) != `{"version":1}` ||
		string(reloadedDefinition.ConfigSchema) != `{"type":"object"}` ||
		string(reloadedDefinition.DefinitionRaw) != `{"definitionId":"owned-item","version":1}` {
		t.Fatalf("load exposed store-owned bytes: %#v, %#v", reloadedCanvas, reloadedDefinition)
	}
}
