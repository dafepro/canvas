package roomsdk

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"time"
)

// CountingMetrics keeps the counters of spec 22.2 in memory and writes them in
// the Prometheus text format. It is the default for canvasd, so an operator can
// read the numbers without a metrics backend.
//
// Every counter carries the canvas id as a label. A room that never opens adds
// no series, so the output stays small.
type CountingMetrics struct {
	mu sync.Mutex
	// counters holds one value for each metric name and label set.
	counters map[counterKey]float64
	// checkpointAt records when each canvas last stored a checkpoint.
	checkpointAt map[string]time.Time
	now          func() time.Time
}

type counterKey struct {
	name   string
	canvas string
	reason string
}

func NewCountingMetrics() *CountingMetrics {
	return &CountingMetrics{
		counters:     make(map[counterKey]float64),
		checkpointAt: make(map[string]time.Time),
		now:          time.Now,
	}
}

func (m *CountingMetrics) add(name, canvas, reason string, delta float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters[counterKey{name: name, canvas: canvas, reason: reason}] += delta
}

func (m *CountingMetrics) RoomOpened(canvasID string) {
	m.add("canvas_rooms_opened_total", canvasID, "", 1)
	m.add("canvas_rooms_awake", canvasID, "", 1)
}

func (m *CountingMetrics) RoomSlept(canvasID string) {
	m.add("canvas_rooms_slept_total", canvasID, "", 1)
	m.add("canvas_rooms_awake", canvasID, "", -1)
}

func (m *CountingMetrics) ClientJoined(canvasID string) {
	m.add("canvas_clients_joined_total", canvasID, "", 1)
	m.add("canvas_clients_connected", canvasID, "", 1)
}

func (m *CountingMetrics) ClientLeft(canvasID, reason string) {
	m.add("canvas_clients_left_total", canvasID, reason, 1)
	m.add("canvas_clients_connected", canvasID, "", -1)
}

func (m *CountingMetrics) RelayBytes(canvasID string, bytes int) {
	m.add("canvas_relay_bytes_total", canvasID, "", float64(bytes))
}

func (m *CountingMetrics) HostLeaseChanged(canvasID string, _ uint64, reason string) {
	m.add("canvas_host_lease_changes_total", canvasID, reason, 1)
}

func (m *CountingMetrics) CheckpointStored(canvasID string, bytes int) {
	m.add("canvas_checkpoint_bytes_total", canvasID, "", float64(bytes))
	m.add("canvas_checkpoints_total", canvasID, "", 1)
	m.mu.Lock()
	m.checkpointAt[canvasID] = m.now()
	m.mu.Unlock()
}

func (m *CountingMetrics) DurableRejected(canvasID, reason string) {
	m.add("canvas_durable_rejects_total", canvasID, reason, 1)
}

func (m *CountingMetrics) ProtocolMismatch(canvasID string) {
	m.add("canvas_protocol_mismatch_total", canvasID, "", 1)
}

// Value reads one counter. A test uses it; the endpoint below uses WriteTo.
func (m *CountingMetrics) Value(name, canvas, reason string) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.counters[counterKey{name: name, canvas: canvas, reason: reason}]
}

// WriteTo writes the Prometheus text format. Series are sorted, so the output
// of two calls with the same state is identical.
func (m *CountingMetrics) WriteTo(w io.Writer) (int64, error) {
	m.mu.Lock()
	lines := make([]string, 0, len(m.counters)+len(m.checkpointAt))
	for key, value := range m.counters {
		lines = append(lines, formatSeries(key, value))
	}
	now := m.now()
	for canvas, at := range m.checkpointAt {
		lines = append(lines, formatSeries(
			counterKey{name: "canvas_checkpoint_age_seconds", canvas: canvas},
			now.Sub(at).Seconds(),
		))
	}
	m.mu.Unlock()

	sort.Strings(lines)
	written := int64(0)
	for _, line := range lines {
		n, err := fmt.Fprintln(w, line)
		written += int64(n)
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

func formatSeries(key counterKey, value float64) string {
	if key.reason == "" {
		return fmt.Sprintf("%s{canvas=%q} %g", key.name, key.canvas, value)
	}
	return fmt.Sprintf("%s{canvas=%q,reason=%q} %g", key.name, key.canvas, key.reason, value)
}

// TeeMetrics sends every counter to each member. canvasd uses it to keep the
// operator log and the exposition endpoint at the same time.
type TeeMetrics []Metrics

func (t TeeMetrics) RoomOpened(canvasID string) {
	for _, m := range t {
		m.RoomOpened(canvasID)
	}
}

func (t TeeMetrics) RoomSlept(canvasID string) {
	for _, m := range t {
		m.RoomSlept(canvasID)
	}
}

func (t TeeMetrics) ClientJoined(canvasID string) {
	for _, m := range t {
		m.ClientJoined(canvasID)
	}
}

func (t TeeMetrics) ClientLeft(canvasID, reason string) {
	for _, m := range t {
		m.ClientLeft(canvasID, reason)
	}
}

func (t TeeMetrics) RelayBytes(canvasID string, bytes int) {
	for _, m := range t {
		m.RelayBytes(canvasID, bytes)
	}
}

func (t TeeMetrics) HostLeaseChanged(canvasID string, epoch uint64, reason string) {
	for _, m := range t {
		m.HostLeaseChanged(canvasID, epoch, reason)
	}
}

func (t TeeMetrics) CheckpointStored(canvasID string, bytes int) {
	for _, m := range t {
		m.CheckpointStored(canvasID, bytes)
	}
}

func (t TeeMetrics) DurableRejected(canvasID, reason string) {
	for _, m := range t {
		m.DurableRejected(canvasID, reason)
	}
}

func (t TeeMetrics) ProtocolMismatch(canvasID string) {
	for _, m := range t {
		m.ProtocolMismatch(canvasID)
	}
}

// WriteTo delegates to the first member that can write an exposition.
func (t TeeMetrics) WriteTo(w io.Writer) (int64, error) {
	for _, m := range t {
		if exporter, ok := m.(interface {
			WriteTo(io.Writer) (int64, error)
		}); ok {
			return exporter.WriteTo(w)
		}
	}
	return 0, nil
}
