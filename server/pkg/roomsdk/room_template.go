package roomsdk

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrRoomTemplateResolverRequired = errors.New("roomsdk: Config.RoomTemplates is required")
	ErrRoomTemplateConflict         = errors.New("roomsdk: room template conflicts with persisted binding")
)

// RoomTemplate identifies immutable canvas definition data selected for one
// product-owned room instance.
type RoomTemplate struct {
	CanvasID      string `json:"canvasId"`
	CanvasVersion uint32 `json:"canvasVersion"`
}

// RoomTemplateResolver lets a product map its room identifiers to reusable
// canvas templates. It may read the product's own database or configuration.
type RoomTemplateResolver interface {
	ResolveRoomTemplate(ctx context.Context, roomID string) (RoomTemplate, error)
}

type RoomTemplateResolverFunc func(context.Context, string) (RoomTemplate, error)

func (f RoomTemplateResolverFunc) ResolveRoomTemplate(
	ctx context.Context,
	roomID string,
) (RoomTemplate, error) {
	return f(ctx, roomID)
}

// StaticRoomTemplates is convenient for reference services and tests. A
// production product can implement RoomTemplateResolver against its own data.
type StaticRoomTemplates map[string]RoomTemplate

func (templates StaticRoomTemplates) ResolveRoomTemplate(
	_ context.Context,
	roomID string,
) (RoomTemplate, error) {
	template, ok := templates[roomID]
	if !ok {
		return RoomTemplate{}, ErrNotFound
	}
	return template, nil
}

func (s *Server) resolveRoomTemplate(ctx context.Context, roomID string) (RoomTemplate, error) {
	if roomID == "" {
		return RoomTemplate{}, fmt.Errorf("roomsdk: room id is required")
	}
	template, err := s.cfg.RoomTemplates.ResolveRoomTemplate(ctx, roomID)
	if err != nil {
		return RoomTemplate{}, err
	}
	if template.CanvasID == "" || template.CanvasVersion == 0 {
		return RoomTemplate{}, fmt.Errorf("roomsdk: resolver returned an invalid template for room %q", roomID)
	}
	return template, nil
}
