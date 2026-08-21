package roomsdk

import (
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
)

// grantHost gives one client the lease and increments the epoch. Spec 11.1: the
// backend is the only authority for who may publish canonical state.
func (r *Room) grantHost(clientID string, reason string) {
	client, ok := r.clients[clientID]
	if !ok {
		return
	}
	r.hostEpoch++
	r.hostClientID = clientID
	r.hostLeaseUntil = r.cfg.Now().Add(r.cfg.HostLeaseTTL)
	client.lastHeartbeat = r.cfg.Now()

	r.cfg.Metrics.HostLeaseChanged(r.canvasID, r.hostEpoch, reason)
	r.cfg.Logger.Info("host lease granted",
		"canvas", r.canvasID, "client", clientID, "epoch", r.hostEpoch, "reason", reason)

	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.canvasID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_HostControl{HostControl: &pb.HostControl{
			Kind:                 pb.HostControlKind_HOST_CONTROL_GRANTED,
			HostClientId:         clientID,
			HostEpoch:            r.hostEpoch,
			SnapshotJson:         r.snapshotRaw,
			Reason:               reason,
			LeaseExpiresAtUnixMs: uint64(r.hostLeaseUntil.UnixMilli()),
		}},
	})

	// Every other client clears its interpolation history when the epoch moves.
	r.broadcastExcept(clientID, &pb.RoomEnvelope{
		RoomId:    r.canvasID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_HostControl{HostControl: &pb.HostControl{
			Kind:         pb.HostControlKind_HOST_CONTROL_REVOKED,
			HostClientId: clientID,
			HostEpoch:    r.hostEpoch,
			Reason:       reason,
		}},
	})
}

// electHost picks the healthiest eligible client (spec 11.2).
func (r *Room) electHost(reason string) {
	candidate := r.bestCandidate()
	if candidate == "" {
		r.hostClientID = ""
		return
	}
	r.grantHost(candidate, reason)
	r.broadcastPresence()
}

// bestCandidate prefers a visible client with a healthy simulation loop, then
// the earliest joiner, so the choice is deterministic.
func (r *Room) bestCandidate() string {
	best := ""
	bestScore := -1.0
	for _, id := range r.joinOrder {
		client, ok := r.clients[id]
		if !ok || !client.hostEligible {
			continue
		}
		score := 0.0
		if client.pageVisible {
			score += 100
		}
		if client.simulationHz > 0 {
			score += float64(client.simulationHz)
		}
		if client.workerDrift > 0 {
			score -= float64(client.workerDrift)
		}
		if score > bestScore {
			bestScore = score
			best = id
		}
	}
	return best
}

// checkHostLease revokes the lease when heartbeats stop. Visibility events are
// not guaranteed during a crash, so the heartbeat is the real signal (spec 11.4).
func (r *Room) checkHostLease() {
	if r.hostClientID == "" {
		if len(r.clients) > 0 {
			r.electHost("no_host")
		}
		return
	}
	host, ok := r.clients[r.hostClientID]
	if !ok {
		r.hostClientID = ""
		r.electHost("host_gone")
		return
	}
	if r.cfg.Now().Sub(host.lastHeartbeat) <= r.cfg.HostLeaseTTL {
		return
	}
	r.cfg.Logger.Warn("host lease expired",
		"canvas", r.canvasID, "client", r.hostClientID, "epoch", r.hostEpoch)
	host.hostEligible = false
	previous := r.hostClientID
	r.hostClientID = ""
	if r.bestCandidate() == "" {
		// No other candidate, so give the current host another chance.
		host.hostEligible = true
		host.lastHeartbeat = r.cfg.Now()
		r.hostClientID = previous
		return
	}
	r.electHost("heartbeat_timeout")
}

func (r *Room) handleHostControl(client *Client, control *pb.HostControl) {
	switch control.Kind {
	case pb.HostControlKind_HOST_CONTROL_YIELD:
		if client.ID != r.hostClientID {
			return
		}
		client.hostEligible = false
		r.hostClientID = ""
		if r.bestCandidate() == "" {
			// Nobody else can host, so the yielding client keeps the lease.
			client.hostEligible = true
			r.hostClientID = client.ID
			r.hostLeaseUntil = r.cfg.Now().Add(r.cfg.HostLeaseTTL)
			return
		}
		r.electHost("host_yield")

	case pb.HostControlKind_HOST_CONTROL_ELIGIBILITY:
		client.hostEligible = control.Eligible
		if !control.Eligible && client.ID == r.hostClientID && r.bestCandidate() != "" {
			r.hostClientID = ""
			r.electHost("host_ineligible")
		}
	}
}
