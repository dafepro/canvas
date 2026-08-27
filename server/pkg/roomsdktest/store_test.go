package roomsdktest

import (
	"sync"
	"testing"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

func TestMemoryStoreConforms(t *testing.T) {
	RunStoreConformance(t, storeFixture(func(t *testing.T) roomsdk.Store {
		t.Helper()
		store := roomsdk.NewMemoryStore()
		store.PutCanvas(conformancePreviousCanvas)
		store.PutItemDefinition(conformancePreviousDefinition)
		store.PutCanvas(conformanceCanvas)
		store.PutItemDefinition(conformanceDefinition)
		return store
	}))
}

func TestFileStoreConforms(t *testing.T) {
	var roots sync.Map
	fixture := storeFixture(func(t *testing.T) roomsdk.Store {
		t.Helper()
		root := t.TempDir()
		store, err := roomsdk.NewFileStore(root)
		if err != nil {
			t.Fatal(err)
		}
		store.PutCanvas(conformancePreviousCanvas)
		store.PutItemDefinition(conformancePreviousDefinition)
		store.PutCanvas(conformanceCanvas)
		store.PutItemDefinition(conformanceDefinition)
		roots.Store(store, root)
		return store
	})
	fixture.ReopenStore = func(t *testing.T, previous roomsdk.Store) roomsdk.Store {
		t.Helper()
		root, ok := roots.Load(previous)
		if !ok {
			t.Fatal("missing file store root")
		}
		store, err := roomsdk.NewFileStore(root.(string))
		if err != nil {
			t.Fatal(err)
		}
		store.PutCanvas(conformancePreviousCanvas)
		store.PutItemDefinition(conformancePreviousDefinition)
		store.PutCanvas(conformanceCanvas)
		store.PutItemDefinition(conformanceDefinition)
		return store
	}
	RunStoreConformance(t, fixture)
}

func storeFixture(newStore func(*testing.T) roomsdk.Store) StoreConformanceFixture {
	return StoreConformanceFixture{
		NewStore:                newStore,
		Canvas:                  conformanceCanvas,
		ItemDefinition:          conformanceDefinition,
		PreviousCanvas:          conformancePreviousCanvas,
		PreviousItemDefinition:  conformancePreviousDefinition,
		MissingCanvasID:         "missing-canvas",
		MissingItemDefinitionID: "missing-definition",
		MissingRoomID:           "missing-room",
	}
}

func TestStoreConformanceRejectsANewerPreviousGeneration(t *testing.T) {
	for name, makeNewer := range map[string]func(*StoreConformanceFixture){
		"canvas": func(fixture *StoreConformanceFixture) {
			fixture.PreviousCanvas.Version = fixture.Canvas.Version + 1
		},
		"item definition": func(fixture *StoreConformanceFixture) {
			fixture.PreviousItemDefinition.Version = fixture.ItemDefinition.Version + 1
		},
	} {
		t.Run(name, func(t *testing.T) {
			fixture := storeFixture(func(t *testing.T) roomsdk.Store {
				t.Helper()
				return roomsdk.NewMemoryStore()
			})
			makeNewer(&fixture)
			if err := validateStoreFixture(fixture); err == nil {
				t.Fatal("accepted a previous generation newer than the current generation")
			}
		})
	}
}

var conformanceCanvas = roomsdk.CanvasRecord{
	CanvasID:      "conformance-canvas",
	Version:       3,
	DefinitionRaw: []byte(`{"id":"conformance-canvas","version":3}`),
}

var conformanceDefinition = roomsdk.ItemDefinitionRecord{
	DefinitionID:  "conformance-item",
	Version:       2,
	Complexity:    roomsdk.ItemComplexitySimple,
	ConfigSchema:  []byte(`{"type":"object"}`),
	DefinitionRaw: []byte(`{"definitionId":"conformance-item","version":2}`),
}

var conformancePreviousCanvas = roomsdk.CanvasRecord{
	CanvasID:      "conformance-canvas",
	Version:       2,
	DefinitionRaw: []byte(`{"id":"conformance-canvas","version":2}`),
}

var conformancePreviousDefinition = roomsdk.ItemDefinitionRecord{
	DefinitionID:  "conformance-item",
	Version:       1,
	Complexity:    roomsdk.ItemComplexitySimple,
	ConfigSchema:  []byte(`{"type":"object"}`),
	DefinitionRaw: []byte(`{"definitionId":"conformance-item","version":1}`),
}
