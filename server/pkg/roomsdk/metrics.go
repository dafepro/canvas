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

func (m *LogMetrics) RoomOwnershipAcquired(roomID string, generation uint64) {
	m.log.Info("metric room_ownership_acquired", "room", roomID, "generation", generation)
}
func (m *LogMetrics) RoomOwnershipRenewed(roomID string, generation uint64) {
	m.log.Debug("metric room_ownership_renewed", "room", roomID, "generation", generation)
}
func (m *LogMetrics) RoomOwnershipLost(roomID, reason string) {
	m.log.Warn("metric room_ownership_lost", "room", roomID, "reason", reason)
}
func (m *LogMetrics) RoomOwnershipFenced(roomID, operation string) {
	m.log.Warn("metric room_ownership_fenced", "room", roomID, "operation", operation)
}
func (m *LogMetrics) RoomDrainFinished(roomID, result string) {
	m.log.Info("metric room_drain_finished", "room", roomID, "result", result)
}
