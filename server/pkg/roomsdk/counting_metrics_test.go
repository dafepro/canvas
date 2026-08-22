package roomsdk

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// Spec 22.2. The counters must report the room, the client, and the relay, and
// the endpoint must write them.
func TestCountingMetricsReportsRoomAndClientActivity(t *testing.T) {
	metrics := NewCountingMetrics()
	h := newHarness(t, func(cfg *Config) {
		cfg.Metrics = TeeMetrics{metrics}
	})

	first := h.dial("alice")
	first.join()
	// The room grants the first lease on its own tick. Reading it also drains
	// the socket, so the room loop never blocks on a full send buffer.
	first.await(func(e *pb.RoomEnvelope) bool {
		control := e.GetHostControl()
		return control != nil && control.Kind == pb.HostControlKind_HOST_CONTROL_GRANTED
	})

	second := h.dial("bob")
	second.join()

	// The relay counter only moves when a client sends something.
	first.heartbeat()
	second.heartbeat()

	deadline := time.Now().Add(2 * time.Second)
	for metrics.Value("canvas_relay_bytes_total", "test-canvas", "") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the relay byte counter stayed at zero")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if got := metrics.Value("canvas_rooms_opened_total", "test-canvas", ""); got != 1 {
		t.Fatalf("rooms opened = %v, want 1", got)
	}
	if got := metrics.Value("canvas_clients_connected", "test-canvas", ""); got != 2 {
		t.Fatalf("clients connected = %v, want 2", got)
	}
	if got := metrics.Value("canvas_host_lease_changes_total", "test-canvas", "first_join"); got < 1 {
		t.Fatalf("host lease changes = %v, want at least 1", got)
	}

	response, err := http.Get(h.http.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	text := string(body)
	for _, want := range []string{
		`canvas_clients_connected{canvas="test-canvas"} 2`,
		`canvas_rooms_awake{canvas="test-canvas"} 1`,
		"canvas_relay_bytes_total",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("/metrics missing %q in:\n%s", want, text)
		}
	}
}
