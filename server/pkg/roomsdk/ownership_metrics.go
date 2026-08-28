package roomsdk

func metricRoomOwnershipAcquired(metrics Metrics, roomID string, generation uint64) {
	if value, ok := metrics.(roomOwnershipMetrics); ok {
		value.RoomOwnershipAcquired(roomID, generation)
	}
}

func metricRoomOwnershipRenewed(metrics Metrics, roomID string, generation uint64) {
	if value, ok := metrics.(roomOwnershipMetrics); ok {
		value.RoomOwnershipRenewed(roomID, generation)
	}
}

func metricRoomOwnershipLost(metrics Metrics, roomID, reason string) {
	if value, ok := metrics.(roomOwnershipMetrics); ok {
		value.RoomOwnershipLost(roomID, reason)
	}
}

func metricRoomOwnershipFenced(metrics Metrics, roomID, operation string) {
	if value, ok := metrics.(roomOwnershipMetrics); ok {
		value.RoomOwnershipFenced(roomID, operation)
	}
}

func metricRoomDrainFinished(metrics Metrics, roomID, result string) {
	if value, ok := metrics.(roomOwnershipMetrics); ok {
		value.RoomDrainFinished(roomID, result)
	}
}
