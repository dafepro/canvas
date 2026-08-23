// Package roomsdk coordinates realtime canvas rooms. It grants a single
// simulation host lease, relays realtime packets, enforces item ownership, and
// stores canonical checkpoints. It never steps physics (spec 16.1).
package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/google/uuid"
)

// Server holds every live room. Sleeping canvases live only in the Store.
type Server struct {
	cfg Config

	mu    sync.Mutex
	rooms map[string]*Room
}

// New builds a Server. It refuses a Config without storage or authentication.
func New(cfg Config) (*Server, error) {
	if cfg.Store == nil {
		return nil, errors.New("roomsdk: Config.Store is required")
	}
	if cfg.Auth == nil {
		return nil, errors.New("roomsdk: Config.Auth is required")
	}
	cfg.applyDefaults()
	return &Server{cfg: cfg, rooms: make(map[string]*Room)}, nil
}

// Handler returns the HTTP routes from spec 16.4. Mount it under any prefix.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/canvases/{id}", s.handleGetCanvas)
	mux.HandleFunc("GET /v1/realtime/canvases/{id}", s.handleRealtime)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// Spec 22.2. The endpoint appears only when the configured Metrics can
	// write an exposition, so a deployment with another backend keeps its own.
	if exporter, ok := s.cfg.Metrics.(interface {
		WriteTo(io.Writer) (int64, error)
	}); ok {
		mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			_, _ = exporter.WriteTo(w)
		})
	}
	return mux
}

// Rooms reports the canvas ids that are awake.
func (s *Server) Rooms() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.rooms))
	for id := range s.rooms {
		ids = append(ids, id)
	}
	return ids
}

type canvasResponse struct {
	CanvasID      string          `json:"canvasId"`
	SceneRevision uint64          `json:"sceneRevision"`
	HostEpoch     uint64          `json:"hostEpoch"`
	HostClientID  string          `json:"hostClientId"`
	Definition    json.RawMessage `json:"definition"`
	Snapshot      json.RawMessage `json:"snapshot"`
	Awake         bool            `json:"awake"`
	TickRate      uint32          `json:"tickRate"`
}

func (s *Server) handleGetCanvas(w http.ResponseWriter, r *http.Request) {
	canvasID := r.PathValue("id")
	record, err := s.cfg.Store.LoadCanvas(r.Context(), canvasID)
	if err != nil {
		http.Error(w, "canvas not found", http.StatusNotFound)
		return
	}
	response := canvasResponse{
		CanvasID:   canvasID,
		Definition: record.DefinitionRaw,
		TickRate:   s.cfg.TickRate,
	}

	s.mu.Lock()
	room, awake := s.rooms[canvasID]
	s.mu.Unlock()
	if awake {
		// Reading live room fields from another goroutine would race, so the
		// awake answer only reports that a room exists.
		response.Awake = true
		_ = room
	}
	if snapshot, err := s.cfg.Store.LoadSnapshot(r.Context(), canvasID); err == nil {
		response.Snapshot = snapshot.SnapshotRaw
		response.SceneRevision = snapshot.SceneRevision
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		s.cfg.Logger.Error("encode canvas response failed", "error", err)
	}
}

// roomFor returns the awake room for a canvas, waking it from the Store when it
// is the first join (spec 13.4).
func (s *Server) roomFor(ctx context.Context, canvasID string) (*Room, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room, ok := s.rooms[canvasID]; ok {
		return room, nil
	}

	record, err := s.cfg.Store.LoadCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	snapshot, err := s.cfg.Store.LoadSnapshot(ctx, canvasID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	room, err := newRoom(s, canvasID, record, snapshot)
	if err != nil {
		return nil, fmt.Errorf("roomsdk: build room %s: %w", canvasID, err)
	}
	s.rooms[canvasID] = room
	s.cfg.Metrics.RoomOpened(canvasID)
	s.cfg.Logger.Info("room opened", "canvas", canvasID,
		"sceneRevision", room.sceneRevision, "items", len(room.snapshot.Items))
	go room.run()
	return room, nil
}

func (s *Server) removeRoom(canvasID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rooms, canvasID)
}

func newClientID() string {
	return "c-" + uuid.NewString()[:8]
}
