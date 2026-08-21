package roomsdk

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

type inbound struct {
	client   *Client
	envelope *pb.RoomEnvelope
	size     int
}

type departure struct {
	client *Client
	reason string
}

// Room is coordination state, not a physics world (spec 16.3). One goroutine
// owns every field, so no lock is needed inside the loop.
type Room struct {
	cfg    *Config
	server *Server

	canvasID      string
	canvasShape   canvasShape
	definitionRaw json.RawMessage

	sceneRevision  uint64
	hostEpoch      uint64
	hostClientID   string
	hostLeaseUntil time.Time
	sleeping       bool

	clients map[string]*Client
	// joinOrder keeps election deterministic.
	joinOrder []string

	snapshot     CanvasSnapshot
	snapshotRaw  json.RawMessage
	checkpointNo uint64
	items        map[string]*SnapshotItem
	nextEntityNo uint64

	joins      chan *Client
	departures chan departure
	messages   chan inbound
	done       chan struct{}
	emptyAt    time.Time
}

func newRoom(server *Server, canvasID string, record CanvasRecord, snapshot SnapshotRecord) (*Room, error) {
	shape, err := parseCanvasShape(record.DefinitionRaw)
	if err != nil {
		return nil, err
	}

	room := &Room{
		cfg:           &server.cfg,
		server:        server,
		canvasID:      canvasID,
		canvasShape:   shape,
		definitionRaw: record.DefinitionRaw,
		clients:       make(map[string]*Client),
		items:         make(map[string]*SnapshotItem),
		joins:         make(chan *Client, 8),
		departures:    make(chan departure, 8),
		messages:      make(chan inbound, 512),
		done:          make(chan struct{}),
		sleeping:      true,
	}

	if len(snapshot.SnapshotRaw) > 0 {
		if err := json.Unmarshal(snapshot.SnapshotRaw, &room.snapshot); err != nil {
			return nil, err
		}
		room.snapshotRaw = snapshot.SnapshotRaw
		room.sceneRevision = snapshot.SceneRevision
		room.checkpointNo = snapshot.CheckpointRevision
	} else {
		room.snapshot = emptySnapshot(canvasID, shape.Version, server.cfg.Now())
		raw, err := json.Marshal(room.snapshot)
		if err != nil {
			return nil, err
		}
		room.snapshotRaw = raw
	}
	room.indexItems()
	return room, nil
}

func (r *Room) indexItems() {
	r.items = make(map[string]*SnapshotItem, len(r.snapshot.Items))
	for i := range r.snapshot.Items {
		item := &r.snapshot.Items[i]
		r.items[item.EntityID] = item
	}
}

// run owns every field of the Room until the room sleeps.
func (r *Room) run() {
	defer close(r.done)
	ticker := time.NewTicker(r.cfg.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case client := <-r.joins:
			r.handleJoin(client)
		case gone := <-r.departures:
			r.handleLeave(gone)
			if len(r.clients) == 0 {
				r.emptyAt = r.cfg.Now()
			}
		case msg := <-r.messages:
			r.handleMessage(msg)
		case <-ticker.C:
			r.checkHostLease()
			if len(r.clients) == 0 && r.cfg.Now().Sub(r.emptyAt) >= r.cfg.SleepGrace {
				r.sleep()
				return
			}
		}
	}
}

// ---------- join and leave ----------

func (r *Room) handleJoin(client *Client) {
	if len(r.clients) >= r.maxClients() {
		r.sendTo(client, &pb.RoomEnvelope{
			RoomId: r.canvasID,
			Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
				Code:    "room_full",
				Message: "the canvas has reached its client limit",
			}},
		})
		client.close()
		return
	}

	wasSleeping := r.sleeping
	r.sleeping = false
	r.clients[client.ID] = client
	r.joinOrder = append(r.joinOrder, client.ID)
	client.joined = true
	r.cfg.Metrics.ClientJoined(r.canvasID)

	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.canvasID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_JoinAccepted{JoinAccepted: &pb.JoinAccepted{
			ClientId:             client.ID,
			SceneRevision:        r.sceneRevision,
			HostEpoch:            r.hostEpoch,
			HostClientId:         r.hostClientID,
			CanvasDefinitionJson: r.definitionRaw,
			SnapshotJson:         r.snapshotRaw,
			RoomWasSleeping:      wasSleeping,
			TickRate:             r.cfg.TickRate,
		}},
	})

	// Spec 13.4. The first client of a sleeping room becomes the host.
	if r.hostClientID == "" {
		r.grantHost(client.ID, "first_join")
	}
	r.broadcastPresence()
}

func (r *Room) handleLeave(gone departure) {
	client := gone.client
	if _, ok := r.clients[client.ID]; !ok {
		return
	}
	delete(r.clients, client.ID)
	for i, id := range r.joinOrder {
		if id == client.ID {
			r.joinOrder = append(r.joinOrder[:i], r.joinOrder[i+1:]...)
			break
		}
	}
	client.close()
	r.cfg.Metrics.ClientLeft(r.canvasID, gone.reason)

	if r.hostClientID == client.ID {
		r.hostClientID = ""
		r.electHost("host_disconnected")
	}
	if len(r.clients) > 0 {
		r.broadcastPresence()
	}
}

func (r *Room) maxClients() int {
	if r.canvasShape.Limits.MaxAvatars > 0 {
		return r.canvasShape.Limits.MaxAvatars
	}
	return r.cfg.MaxClientsPerRoom
}

// ---------- message handling ----------

func (r *Room) handleMessage(msg inbound) {
	envelope := msg.envelope
	client := msg.client
	r.cfg.Metrics.RelayBytes(r.canvasID, msg.size)

	switch payload := envelope.Payload.(type) {
	case *pb.RoomEnvelope_Heartbeat:
		r.handleHeartbeat(client, payload.Heartbeat)

	case *pb.RoomEnvelope_PlayerInput:
		// Input goes only to the simulation host.
		r.relayToHost(client, envelope)

	case *pb.RoomEnvelope_StateDelta, *pb.RoomEnvelope_FullState, *pb.RoomEnvelope_EffectEvent:
		r.relayFromHost(client, envelope)

	case *pb.RoomEnvelope_HostControl:
		r.handleHostControl(client, payload.HostControl)

	case *pb.RoomEnvelope_DurableCommand:
		r.handleDurableCommand(client, payload.DurableCommand)

	case *pb.RoomEnvelope_Checkpoint:
		r.handleCheckpoint(client, payload.Checkpoint)

	default:
		// Unknown payloads are ignored rather than closing the connection.
	}
}

func (r *Room) handleHeartbeat(client *Client, beat *pb.Heartbeat) {
	client.lastHeartbeat = r.cfg.Now()
	client.simulationHz = beat.SimulationHz
	client.workerDrift = beat.WorkerDriftMs
	client.pageVisible = beat.PageVisible
	if client.ID == r.hostClientID {
		r.hostLeaseUntil = r.cfg.Now().Add(r.cfg.HostLeaseTTL)
	}
}

// relayToHost forwards player input. The server never reads the physics content.
func (r *Room) relayToHost(from *Client, envelope *pb.RoomEnvelope) {
	host := r.clients[r.hostClientID]
	if host == nil {
		return
	}
	envelope.SenderClientId = from.ID
	envelope.RoomId = r.canvasID
	r.sendTo(host, envelope)
}

// relayFromHost broadcasts canonical state. It refuses a sender without the
// active lease and refuses a stale epoch (spec 11.1).
func (r *Room) relayFromHost(from *Client, envelope *pb.RoomEnvelope) {
	if from.ID != r.hostClientID {
		r.cfg.Metrics.DurableRejected(r.canvasID, "state_from_non_host")
		return
	}
	if envelope.HostEpoch != r.hostEpoch {
		r.cfg.Metrics.DurableRejected(r.canvasID, "stale_host_epoch")
		return
	}
	envelope.SenderClientId = from.ID
	envelope.RoomId = r.canvasID
	r.broadcastExcept(from.ID, envelope)
}

func (r *Room) handleCheckpoint(from *Client, checkpoint *pb.Checkpoint) {
	if from.ID != r.hostClientID {
		r.cfg.Metrics.DurableRejected(r.canvasID, "checkpoint_from_non_host")
		return
	}
	if err := r.acceptCheckpoint(checkpoint); err != nil {
		r.cfg.Logger.Warn("rejected checkpoint",
			"canvas", r.canvasID, "reason", err.Error())
		r.cfg.Metrics.DurableRejected(r.canvasID, "malformed_checkpoint")
		return
	}
	r.cfg.Metrics.CheckpointStored(r.canvasID, len(checkpoint.SnapshotJson))
	if checkpoint.Final {
		r.persist(true)
	} else {
		r.persist(false)
	}
}

func (r *Room) acceptCheckpoint(checkpoint *pb.Checkpoint) error {
	var incoming CanvasSnapshot
	if err := json.Unmarshal(checkpoint.SnapshotJson, &incoming); err != nil {
		return err
	}
	if incoming.CanvasID != r.canvasID {
		return errCanvasMismatch
	}
	if len(incoming.Items) > r.canvasShape.Limits.MaxItems {
		return errTooManyItems
	}
	for i := range incoming.Items {
		if !incoming.Items[i].Transform.finite() {
			return errNonFiniteTransform
		}
		if !r.withinBounds(incoming.Items[i].Transform) {
			return errOutOfBounds
		}
	}
	if checkpoint.CheckpointRevision < r.checkpointNo {
		return errStaleCheckpoint
	}

	// The server keeps its own scene revision, which only durable mutations move.
	incoming.SceneRevision = r.sceneRevision
	incoming.HostEpoch = r.hostEpoch
	incoming.CheckpointRevision = checkpoint.CheckpointRevision
	r.snapshot = incoming
	r.checkpointNo = checkpoint.CheckpointRevision
	r.indexItems()
	raw, err := json.Marshal(r.snapshot)
	if err != nil {
		return err
	}
	r.snapshotRaw = raw
	return nil
}

func (r *Room) withinBounds(t Transform) bool {
	const slack = 4
	maxX := r.canvasShape.Size.Width * slack
	maxY := r.canvasShape.Size.Height * slack
	if maxX == 0 || maxY == 0 {
		return true
	}
	return t.X > -maxX && t.X < maxX && t.Y > -maxY && t.Y < maxY
}

func (r *Room) persist(final bool) {
	record := SnapshotRecord{
		CanvasID:           r.canvasID,
		SceneRevision:      r.sceneRevision,
		CheckpointRevision: r.checkpointNo,
		HostEpoch:          r.hostEpoch,
		Tick:               r.snapshot.Tick,
		Normalized:         final,
		CapturedAt:         r.cfg.Now().UTC(),
		SnapshotRaw:        r.snapshotRaw,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.cfg.Store.SaveSnapshot(ctx, record); err != nil {
		r.cfg.Logger.Error("save snapshot failed", "canvas", r.canvasID, "error", err)
	}
}

// ---------- room sleep (spec 13.3) ----------

func (r *Room) sleep() {
	r.normalizeForSleep()
	r.persist(true)
	r.sleeping = true
	r.cfg.Metrics.RoomSlept(r.canvasID)
	r.cfg.Logger.Info("room sleeping", "canvas", r.canvasID,
		"sceneRevision", r.sceneRevision, "items", len(r.snapshot.Items))
	r.server.removeRoom(r.canvasID)
}

// normalizeForSleep zeroes motion. The snapshot carries no velocity, so this
// only marks the snapshot and drops transient behavior state the host left.
func (r *Room) normalizeForSleep() {
	r.snapshot.Normalized = true
	r.snapshot.HostEpoch = r.hostEpoch
	r.snapshot.SceneRevision = r.sceneRevision
	if raw, err := json.Marshal(r.snapshot); err == nil {
		r.snapshotRaw = raw
	}
}

// ---------- fan-out ----------

func (r *Room) sendTo(client *Client, envelope *pb.RoomEnvelope) {
	if envelope.RoomId == "" {
		envelope.RoomId = r.canvasID
	}
	if !client.enqueue(envelope) {
		r.cfg.Logger.Warn("dropped envelope for slow client",
			"canvas", r.canvasID, "client", client.ID)
	}
}

func (r *Room) broadcast(envelope *pb.RoomEnvelope) {
	r.broadcastExcept("", envelope)
}

func (r *Room) broadcastExcept(exceptClientID string, envelope *pb.RoomEnvelope) {
	for _, id := range r.joinOrder {
		if id == exceptClientID {
			continue
		}
		if client, ok := r.clients[id]; ok {
			// Each client gets its own copy so a transport cannot mutate a
			// shared message.
			r.sendTo(client, proto.Clone(envelope).(*pb.RoomEnvelope))
		}
	}
}

func (r *Room) broadcastPresence() {
	peers := make([]*pb.Peer, 0, len(r.clients))
	ids := append([]string(nil), r.joinOrder...)
	sort.Strings(ids)
	for _, id := range ids {
		if client, ok := r.clients[id]; ok {
			peers = append(peers, client.toPeer(r.hostClientID))
		}
	}
	r.broadcast(&pb.RoomEnvelope{
		RoomId:    r.canvasID,
		HostEpoch: r.hostEpoch,
		Payload:   &pb.RoomEnvelope_Presence{Presence: &pb.Presence{Peers: peers}},
	})
}
