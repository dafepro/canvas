// canvasd is the reference realtime coordination service. It is a thin wiring
// layer over pkg/roomsdk, so an existing Go service can copy this file.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

func main() {
	addr := flag.String("addr", envOr("CANVASD_ADDR", ":8080"), "listen address")
	canvasDir := flag.String("canvases", envOr("CANVASD_CANVAS_DIR", "./canvases"),
		"directory of canvas definition JSON files")
	definitionDir := flag.String("definitions", envOr("CANVASD_DEFINITION_DIR", "./definitions"),
		"directory of item definition JSON files")
	origins := flag.String("allowed-origins", envOr("CANVASD_ALLOWED_ORIGINS", "*"),
		"comma separated WebSocket origin patterns")
	tickRate := flag.Uint("tick-rate", 60, "simulation tick rate advertised to the host")
	logLevel := flag.String("log-level", envOr("CANVASD_LOG_LEVEL", "info"), "debug, info, warn, or error")
	flag.Parse()

	logger := newLogger(*logLevel)
	slog.SetDefault(logger)

	store := roomsdk.NewMemoryStore()
	definitionCount, err := loadItemDefinitions(store, *definitionDir)
	if err != nil {
		logger.Error("load item definitions failed", "dir", *definitionDir, "error", err)
		os.Exit(1)
	}
	logger.Info("loaded item definitions", "count", definitionCount, "dir", *definitionDir)
	loaded, err := loadCanvases(store, *canvasDir)
	if err != nil {
		logger.Error("load canvases failed", "dir", *canvasDir, "error", err)
		os.Exit(1)
	}
	logger.Info("loaded canvas definitions", "count", loaded, "dir", *canvasDir)

	server, err := roomsdk.New(roomsdk.Config{
		Store:          store,
		Auth:           roomsdk.DevAuthenticator(),
		TickRate:       uint32(*tickRate),
		Logger:         logger,
		AllowedOrigins: strings.Split(*origins, ","),
		Metrics:        roomsdk.TeeMetrics{roomsdk.NewCountingMetrics(), roomsdk.NewLogMetrics(logger)},
	})
	if err != nil {
		logger.Error("build server failed", "error", err)
		os.Exit(1)
	}

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           withCORS(server.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("canvasd listening", "addr", *addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}

func loadItemDefinitions(store *roomsdk.MemoryStore, dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return count, err
		}
		var probe struct {
			DefinitionID string                 `json:"definitionId"`
			Version      uint32                 `json:"version"`
			Complexity   roomsdk.ItemComplexity `json:"complexity"`
			ConfigSchema json.RawMessage        `json:"configSchema"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			return count, err
		}
		if probe.DefinitionID == "" {
			return count, errors.New("item definition file " + entry.Name() + " has no definitionId")
		}
		if probe.Complexity != roomsdk.ItemComplexitySimple &&
			probe.Complexity != roomsdk.ItemComplexityComplex {
			return count, errors.New("item definition file " + entry.Name() + " has invalid complexity")
		}
		store.PutItemDefinition(roomsdk.ItemDefinitionRecord{
			DefinitionID:  probe.DefinitionID,
			Version:       probe.Version,
			Complexity:    probe.Complexity,
			ConfigSchema:  probe.ConfigSchema,
			DefinitionRaw: raw,
		})
		count++
	}
	return count, nil
}

func loadCanvases(store *roomsdk.MemoryStore, dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return count, err
		}
		var probe struct {
			ID      string `json:"id"`
			Version uint32 `json:"version"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			return count, err
		}
		if probe.ID == "" {
			return count, errors.New("canvas file " + entry.Name() + " has no id")
		}
		store.PutCanvas(roomsdk.CanvasRecord{
			CanvasID:      probe.ID,
			Version:       probe.Version,
			DefinitionRaw: raw,
		})
		count++
	}
	return count, nil
}

// withCORS lets the demo page on another port reach the API.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-User-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	switch strings.ToLower(level) {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
