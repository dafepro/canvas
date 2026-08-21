package roomsdk

import "log/slog"

// LogMetrics writes every counter to a logger. Replace it with a Prometheus or
// OpenTelemetry implementation in production.
type LogMetrics struct{ log *slog.Logger }

func NewLogMetrics(logger *slog.Logger) *LogMetrics {
	return &LogMetrics{log: logger}
}

func (m *LogMetrics) RoomOpened(canvasID string) {
	m.log.Debug("metric room_opened", "canvas", canvasID)
}
func (m *LogMetrics) RoomSlept(canvasID string) {
	m.log.Debug("metric room_slept", "canvas", canvasID)
}
func (m *LogMetrics) ClientJoined(canvasID string) {
	m.log.Debug("metric client_joined", "canvas", canvasID)
}
func (m *LogMetrics) ClientLeft(canvasID, reason string) {
	m.log.Debug("metric client_left", "canvas", canvasID, "reason", reason)
}
func (m *LogMetrics) RelayBytes(canvasID string, bytes int) {}
func (m *LogMetrics) HostLeaseChanged(canvasID string, epoch uint64, reason string) {
	m.log.Info("metric host_lease_changed", "canvas", canvasID, "epoch", epoch, "reason", reason)
}
func (m *LogMetrics) CheckpointStored(canvasID string, bytes int) {
	m.log.Debug("metric checkpoint_stored", "canvas", canvasID, "bytes", bytes)
}
func (m *LogMetrics) DurableRejected(canvasID, reason string) {
	m.log.Warn("metric durable_rejected", "canvas", canvasID, "reason", reason)
}
func (m *LogMetrics) ProtocolMismatch(canvasID string) {
	m.log.Warn("metric protocol_mismatch", "canvas", canvasID)
}
