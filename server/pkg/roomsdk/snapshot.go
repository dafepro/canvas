package roomsdk

import (
	"encoding/json"
	"errors"
	"math"
	"time"
)

// Transform mirrors the client Transform type.
type Transform struct {
	X        float64  `json:"x"`
	Y        float64  `json:"y"`
	Rotation float64  `json:"rotation"`
	Scale    float64  `json:"scale"`
	Z        *float64 `json:"z,omitempty"`
}

// UnmarshalJSON keeps the Go representation aligned with the TypeScript
// Transform contract, where an omitted scale means 1. An explicit scale,
// including zero, still overwrites the default so validation can reject it.
func (t *Transform) UnmarshalJSON(data []byte) error {
	type transformJSON Transform
	decoded := transformJSON{Scale: 1}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*t = Transform(decoded)
	return nil
}

func (t Transform) finite() bool {
	if math.IsNaN(t.X) || math.IsInf(t.X, 0) ||
		math.IsNaN(t.Y) || math.IsInf(t.Y, 0) ||
		math.IsNaN(t.Rotation) || math.IsInf(t.Rotation, 0) ||
		math.IsNaN(t.Scale) || math.IsInf(t.Scale, 0) {
		return false
	}
	if t.Z != nil && (math.IsNaN(*t.Z) || math.IsInf(*t.Z, 0)) {
		return false
	}
	return true
}

// SnapshotItem mirrors the client SnapshotItem type (spec 13.1).
type SnapshotItem struct {
	EntityID           string          `json:"entityId"`
	DefinitionID       string          `json:"definitionId"`
	DefinitionVersion  uint32          `json:"definitionVersion"`
	OwnerUserID        string          `json:"ownerUserId"`
	ItemRevision       uint64          `json:"itemRevision"`
	Transform          Transform       `json:"transform"`
	Isolated           bool            `json:"isolated,omitempty"`
	CollisionsDisabled bool            `json:"collisionsDisabled,omitempty"`
	ResolvedConfig     json.RawMessage `json:"resolvedConfig,omitempty"`
	BehaviorState      json.RawMessage `json:"behaviorState,omitempty"`
	BehaviorStateVer   uint32          `json:"behaviorStateVersion,omitempty"`
	BehaviorTimers     []BehaviorTimer `json:"behaviorTimers,omitempty"`
	VisualVariant      string          `json:"visualVariant,omitempty"`
	VisualTint         *uint32         `json:"visualTint,omitempty"`
}

type BehaviorTimer struct {
	Key            string `json:"key"`
	ElapsedTicks   uint64 `json:"elapsedTicks"`
	RemainingTicks uint64 `json:"remainingTicks"`
}

// CanvasSnapshot mirrors the client CanvasSnapshot type.
type CanvasSnapshot struct {
	SchemaVersion      uint32           `json:"schemaVersion"`
	CanvasID           string           `json:"canvasId"`
	CanvasVersion      uint32           `json:"canvasVersion"`
	SceneRevision      uint64           `json:"sceneRevision"`
	HostEpoch          uint64           `json:"hostEpoch"`
	CheckpointRevision uint64           `json:"checkpointRevision"`
	Tick               uint64           `json:"tick"`
	CapturedAt         string           `json:"capturedAt"`
	Normalized         bool             `json:"normalized"`
	Items              []SnapshotItem   `json:"items"`
	Avatars            []SnapshotAvatar `json:"avatars"`
}

type SnapshotAvatar struct {
	EntityID string `json:"entityId"`
	UserID   string `json:"userId"`
	Position Vec2   `json:"position"`
}

type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// SystemItemTemplate is an item owned by the room rather than a participant.
// An empty OwnerUserID in the materialized snapshot makes it immutable through
// participant durable mutations.
type SystemItemTemplate struct {
	EntityID          string          `json:"entityId"`
	DefinitionID      string          `json:"definitionId"`
	DefinitionVersion uint32          `json:"definitionVersion"`
	Transform         Transform       `json:"transform"`
	ResolvedConfig    json.RawMessage `json:"resolvedConfig"`
}

func emptySnapshot(canvasID string, canvasVersion uint32, now time.Time) CanvasSnapshot {
	return CanvasSnapshot{
		SchemaVersion: 1,
		CanvasID:      canvasID,
		CanvasVersion: canvasVersion,
		Normalized:    true,
		CapturedAt:    now.UTC().Format(time.RFC3339Nano),
		Items:         []SnapshotItem{},
		Avatars:       []SnapshotAvatar{},
	}
}

// canvasShape is the part of the canvas definition the server needs. It ignores
// every field that only the client uses.
type canvasShape struct {
	ID      string `json:"id"`
	Version uint32 `json:"version"`
	Size    struct {
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"size"`
	Limits      canvasLimits         `json:"limits"`
	SystemItems []SystemItemTemplate `json:"systemItems"`
}

type canvasLimits struct {
	MaxAvatars             int `json:"maxAvatars"`
	MaxItems               int `json:"maxItems"`
	MaxComplexPhysicsItems int `json:"maxComplexPhysicsItems"`
}

func parseCanvasShape(raw json.RawMessage) (canvasShape, error) {
	shape := canvasShape{Limits: canvasLimits{
		MaxAvatars:             20,
		MaxItems:               50,
		MaxComplexPhysicsItems: 5,
	}}
	if err := json.Unmarshal(raw, &shape); err != nil {
		return canvasShape{}, err
	}
	if shape.Limits.MaxAvatars < 1 {
		return canvasShape{}, errors.New("canvas maxAvatars must be positive")
	}
	if shape.Limits.MaxItems < 0 {
		return canvasShape{}, errors.New("canvas maxItems must be non-negative")
	}
	if shape.Limits.MaxComplexPhysicsItems < 0 ||
		shape.Limits.MaxComplexPhysicsItems > shape.Limits.MaxItems {
		return canvasShape{}, errors.New(
			"canvas maxComplexPhysicsItems must be non-negative and no greater than maxItems",
		)
	}
	return shape, nil
}
