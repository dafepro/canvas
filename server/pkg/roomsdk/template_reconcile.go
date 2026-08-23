package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
)

var (
	ErrRoomAwake             = errors.New("roomsdk: room must be asleep for template reconciliation")
	ErrCanvasVersionConflict = errors.New("roomsdk: canvas version conflict")
	ErrSystemItemConflict    = errors.New("roomsdk: desired system item conflicts with participant item")
)

// TemplateReconcileOptions makes every destructive system-item policy explicit.
type TemplateReconcileOptions struct {
	ExpectedCanvasVersion    uint32
	AddMissingSystemItems    bool
	ReplaceSystemItems       bool
	RetireMissingSystemItems bool
}

type TemplateReconcileResult struct {
	Changed       bool
	CanvasVersion uint32
	SceneRevision uint64
	Added         []string
	Replaced      []string
	Retired       []string
}

// ReconcileRoomTemplate applies the currently registered canvas definition to
// one persisted, sleeping room. Room wake never calls this method implicitly.
func (s *Server) ReconcileRoomTemplate(
	ctx context.Context,
	canvasID string,
	options TemplateReconcileOptions,
) (TemplateReconcileResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, awake := s.rooms[canvasID]; awake {
		return TemplateReconcileResult{}, ErrRoomAwake
	}
	record, err := s.cfg.Store.LoadCanvas(ctx, canvasID)
	if err != nil {
		return TemplateReconcileResult{}, err
	}
	snapshotRecord, err := s.cfg.Store.LoadSnapshot(ctx, canvasID)
	if err != nil {
		return TemplateReconcileResult{}, err
	}
	room, err := newRoom(s, canvasID, record, snapshotRecord)
	if err != nil {
		return TemplateReconcileResult{}, err
	}
	result, err := room.reconcileTemplate(record.Version, options)
	if err != nil || !result.Changed {
		return result, err
	}
	raw, err := json.Marshal(room.snapshot)
	if err != nil {
		return TemplateReconcileResult{}, err
	}
	if err := s.cfg.Store.SaveSnapshot(ctx, SnapshotRecord{
		CanvasID:           canvasID,
		SceneRevision:      room.snapshot.SceneRevision,
		CheckpointRevision: room.snapshot.CheckpointRevision,
		HostEpoch:          room.snapshot.HostEpoch,
		Tick:               room.snapshot.Tick,
		Normalized:         room.snapshot.Normalized,
		CapturedAt:         s.cfg.Now().UTC(),
		SnapshotRaw:        raw,
	}); err != nil {
		return TemplateReconcileResult{}, err
	}
	return result, nil
}

func (r *Room) reconcileTemplate(
	targetVersion uint32,
	options TemplateReconcileOptions,
) (TemplateReconcileResult, error) {
	result := TemplateReconcileResult{
		CanvasVersion: r.snapshot.CanvasVersion,
		SceneRevision: r.snapshot.SceneRevision,
		Added:         []string{},
		Replaced:      []string{},
		Retired:       []string{},
	}
	if r.snapshot.CanvasVersion != options.ExpectedCanvasVersion || targetVersion < r.snapshot.CanvasVersion {
		return result, fmt.Errorf("%w: persisted=%d expected=%d target=%d",
			ErrCanvasVersionConflict, r.snapshot.CanvasVersion, options.ExpectedCanvasVersion, targetVersion)
	}
	if targetVersion == r.snapshot.CanvasVersion {
		return result, nil
	}

	desired := make(map[string]SnapshotItem, len(r.canvasShape.SystemItems))
	for _, template := range r.canvasShape.SystemItems {
		if _, duplicate := desired[template.EntityID]; duplicate {
			return result, fmt.Errorf("duplicate system item entity id %q", template.EntityID)
		}
		item, err := r.materializeSystemItem(template)
		if err != nil {
			return result, err
		}
		desired[item.EntityID] = item
	}

	items := make([]SnapshotItem, 0, len(r.snapshot.Items)+len(desired))
	for _, existing := range r.snapshot.Items {
		template, wanted := desired[existing.EntityID]
		if existing.OwnerUserID != "" {
			if wanted {
				return result, fmt.Errorf("%w: %s", ErrSystemItemConflict, existing.EntityID)
			}
			items = append(items, existing)
			continue
		}
		if !wanted {
			if options.RetireMissingSystemItems {
				result.Retired = append(result.Retired, existing.EntityID)
			} else {
				items = append(items, existing)
			}
			continue
		}
		delete(desired, existing.EntityID)
		if options.ReplaceSystemItems && !reflect.DeepEqual(existing, template) {
			items = append(items, template)
			result.Replaced = append(result.Replaced, existing.EntityID)
		} else {
			items = append(items, existing)
		}
	}
	if options.AddMissingSystemItems {
		for id, item := range desired {
			items = append(items, item)
			result.Added = append(result.Added, id)
		}
	}
	if len(items) > r.canvasShape.Limits.MaxItems {
		return result, fmt.Errorf("reconciled item count exceeds canvas limit")
	}
	complexItems := 0
	for _, item := range items {
		definition, err := r.itemDefinition(item.DefinitionID)
		if err != nil {
			return result, err
		}
		if definition.Complexity == ItemComplexityComplex {
			complexItems++
		}
	}
	if r.canvasShape.Limits.MaxComplexPhysicsItems > 0 &&
		complexItems > r.canvasShape.Limits.MaxComplexPhysicsItems {
		return result, fmt.Errorf("reconciled complex item count exceeds canvas limit")
	}

	sort.Slice(items, func(i, j int) bool { return items[i].EntityID < items[j].EntityID })
	sort.Strings(result.Added)
	sort.Strings(result.Replaced)
	sort.Strings(result.Retired)
	r.snapshot.Items = items
	r.snapshot.CanvasVersion = targetVersion
	r.snapshot.SceneRevision++
	r.snapshot.CheckpointRevision++
	r.snapshot.CapturedAt = r.cfg.Now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	r.snapshot.Normalized = true
	r.sceneRevision = r.snapshot.SceneRevision
	r.checkpointNo = r.snapshot.CheckpointRevision
	r.indexItems()
	result.Changed = true
	result.CanvasVersion = targetVersion
	result.SceneRevision = r.snapshot.SceneRevision
	return result, nil
}

func (r *Room) materializeSystemItem(template SystemItemTemplate) (SnapshotItem, error) {
	if template.EntityID == "" {
		return SnapshotItem{}, errors.New("system item entity id is required")
	}
	definition, err := r.itemDefinition(template.DefinitionID)
	if err != nil {
		return SnapshotItem{}, fmt.Errorf("load system item %q definition: %w", template.EntityID, err)
	}
	if definition.Version != template.DefinitionVersion {
		return SnapshotItem{}, fmt.Errorf("system item %q definition version mismatch", template.EntityID)
	}
	if err := validateConfigJSON(definition.ConfigSchema, template.ResolvedConfig); err != nil {
		return SnapshotItem{}, fmt.Errorf("system item %q config: %w", template.EntityID, err)
	}
	if !template.Transform.finite() || !r.insideCanvas(template.Transform) {
		return SnapshotItem{}, fmt.Errorf("system item %q transform is invalid", template.EntityID)
	}
	return SnapshotItem{
		EntityID:          template.EntityID,
		DefinitionID:      template.DefinitionID,
		DefinitionVersion: template.DefinitionVersion,
		Transform:         template.Transform,
		ResolvedConfig:    append(json.RawMessage(nil), template.ResolvedConfig...),
	}, nil
}
