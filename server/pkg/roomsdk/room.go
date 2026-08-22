package roomsdk

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"strings"
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
	definitions  map[string]ItemDefinitionRecord
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
		definitions:   make(map[string]ItemDefinitionRecord),
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
		room.hostEpoch = snapshot.HostEpoch
		if room.snapshot.HostEpoch > room.hostEpoch {
			room.hostEpoch = room.snapshot.HostEpoch
		}
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

func (r *Room) itemDefinition(definitionID string) (ItemDefinitionRecord, error) {
	if definition, ok := r.definitions[definitionID]; ok {
		return definition, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	definition, err := r.cfg.Store.LoadItemDefinition(ctx, definitionID)
	if err != nil {
		return ItemDefinitionRecord{}, err
	}
	r.definitions[definitionID] = definition
	return definition, nil
}

func (r *Room) complexItemCount() int {
	count := 0
	for _, item := range r.snapshot.Items {
		definition, err := r.itemDefinition(item.DefinitionID)
		if err == nil && definition.Complexity == ItemComplexityComplex {
			count++
		}
	}
	return count
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

	// Compatibility is known before election because JOIN was validated before
	// this client entered the room.
	r.checkDefinitions(client)

	// Spec 13.4. The first eligible client of a sleeping room becomes the host.
	if r.hostClientID == "" {
		if candidate := r.bestCandidate(); candidate != "" {
			r.grantHost(candidate, "first_join")
		}
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
		r.handleCheckpoint(client, envelope.HostEpoch, payload.Checkpoint)

	default:
		// Unknown payloads are ignored rather than closing the connection.
	}
}

// checkDefinitions blocks a client from the host lease while it lacks a
// definition the scene uses, or holds an older version of one. A client that
// declared nothing is not checked, because nothing can be compared.
func (r *Room) checkDefinitions(client *Client) {
	if client.definitions == nil {
		return
	}
	missing := make([]string, 0)
	for _, item := range r.snapshot.Items {
		version, ok := client.definitions[item.DefinitionID]
		if !ok || version < item.DefinitionVersion {
			missing = append(missing, item.DefinitionID)
		}
	}
	sort.Strings(missing)
	missing = slices.Compact(missing)

	mismatch := len(missing) > 0
	if mismatch == client.definitionMismatch {
		return
	}
	client.definitionMismatch = mismatch
	client.hostEligible = !mismatch
	if !mismatch {
		// Presence carries the flag, so every peer learns that the client is
		// eligible again.
		r.broadcastPresence()
		return
	}

	r.cfg.Metrics.ProtocolMismatch(r.canvasID)
	r.cfg.Logger.Warn("client lacks an item definition the scene uses",
		"canvas", r.canvasID, "client", client.ID, "definitions", missing)
	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.canvasID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
			Code:    "definition_mismatch",
			Message: "the client lacks these item definitions: " + strings.Join(missing, ", "),
		}},
	})
	if r.hostClientID == client.ID {
		r.hostClientID = ""
		r.electHost("host_definition_mismatch")
	}
	// The refusal is sent first, so a client reads the reason before it reads
	// the presence that carries the flag.
	r.broadcastPresence()
}

// checkAllDefinitions runs after the scene changes, so a client that lacks a
// newly spawned definition loses the lease.
func (r *Room) checkAllDefinitions() {
	for _, client := range r.clients {
		r.checkDefinitions(client)
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
	if err := r.validateCanonicalState(envelope); err != nil {
		r.cfg.Logger.Warn("rejected canonical state",
			"canvas", r.canvasID, "reason", err.Error())
		r.cfg.Metrics.DurableRejected(r.canvasID, "malformed_state")
		return
	}
	envelope.SenderClientId = from.ID
	envelope.RoomId = r.canvasID
	r.broadcastExcept(from.ID, envelope)
}

func (r *Room) validateCanonicalState(envelope *pb.RoomEnvelope) error {
	if delta := envelope.GetStateDelta(); delta != nil {
		if delta.SceneRevision != r.sceneRevision {
			return errStaleScene
		}
		return r.validateEntityStates(delta.Entities)
	}
	if full := envelope.GetFullState(); full != nil {
		if full.SceneRevision != r.sceneRevision {
			return errStaleScene
		}
		return r.validateEntityStates(full.Entities)
	}
	return nil
}

func (r *Room) validateEntityStates(states []*pb.EntityState) error {
	seen := make(map[string]struct{}, len(states))
	for _, state := range states {
		if state == nil || state.Position == nil || state.Velocity == nil {
			return errMissingStateVector
		}
		if _, duplicate := seen[state.EntityId]; duplicate {
			return errDuplicateEntity
		}
		seen[state.EntityId] = struct{}{}

		item := r.items[state.EntityId]
		if item == nil && !r.connectedAvatar(state.EntityId) {
			return errUnknownEntity
		}
		if item != nil && state.DefinitionId != "" && state.DefinitionId != item.DefinitionID {
			return errDefinitionMismatch
		}
		if len(state.BehaviorStateJson) > 0 && !json.Valid(state.BehaviorStateJson) {
			return errInvalidBehavior
		}

		values := []float64{
			float64(state.Position.X),
			float64(state.Position.Y),
			float64(state.Rotation),
			float64(state.Velocity.X),
			float64(state.Velocity.Y),
			float64(state.AngularVelocity),
			float64(state.Z),
			float64(state.Vz),
		}
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return errNonFiniteTransform
			}
		}
		if !r.withinBounds(Transform{
			X:        float64(state.Position.X),
			Y:        float64(state.Position.Y),
			Rotation: float64(state.Rotation),
		}) {
			return errOutOfBounds
		}
	}
	return nil
}

func (r *Room) connectedAvatar(entityID string) bool {
	if !strings.HasPrefix(entityID, "avatar:") {
		return false
	}
	_, ok := r.clients[strings.TrimPrefix(entityID, "avatar:")]
	return ok
}

func (r *Room) handleCheckpoint(from *Client, hostEpoch uint64, checkpoint *pb.Checkpoint) {
	if from.ID != r.hostClientID {
		r.cfg.Metrics.DurableRejected(r.canvasID, "checkpoint_from_non_host")
		return
	}
	if hostEpoch != r.hostEpoch {
		r.cfg.Metrics.DurableRejected(r.canvasID, "stale_host_epoch")
		return
	}
	if err := r.acceptCheckpoint(checkpoint); err != nil {
		r.cfg.Logger.Warn("rejected checkpoint",
			"canvas", r.canvasID, "reason", err.Error())
		r.cfg.Metrics.DurableRejected(r.canvasID, "malformed_checkpoint")
		return
	}
	r.cfg.Metrics.CheckpointStored(r.canvasID, len(checkpoint.SnapshotJson))
	r.persist()
}

func (r *Room) acceptCheckpoint(checkpoint *pb.Checkpoint) error {
	var incoming CanvasSnapshot
	if err := json.Unmarshal(checkpoint.SnapshotJson, &incoming); err != nil {
		return err
	}
	if incoming.CanvasID != r.canvasID {
		return errCanvasMismatch
	}
	if incoming.SceneRevision != r.sceneRevision {
		return errStaleScene
	}
	if len(incoming.Items) > r.canvasShape.Limits.MaxItems {
		return errTooManyItems
	}
	if checkpoint.CheckpointRevision <= r.checkpointNo {
		return errStaleCheckpoint
	}
	if checkpoint.Final != incoming.Normalized {
		return errNormalizationFlag
	}

	seen := make(map[string]struct{}, len(incoming.Items))
	for i := range incoming.Items {
		item := &incoming.Items[i]
		if _, duplicate := seen[item.EntityID]; duplicate {
			return errDuplicateEntity
		}
		seen[item.EntityID] = struct{}{}
		if r.items[item.EntityID] == nil {
			return errUnknownEntity
		}
		if !item.Transform.finite() {
			return errNonFiniteTransform
		}
		if !r.withinBounds(item.Transform) {
			return errOutOfBounds
		}
	}

	// The host owns canonical physics and behavior outcomes, but durable item
	// identity and authorship remain server-authoritative. Merge only the
	// canonical fields into records that the durable mutation path created.
	for i := range incoming.Items {
		item := &incoming.Items[i]
		stored := r.items[item.EntityID]
		stored.Transform = item.Transform
		stored.BehaviorState = item.BehaviorState
		stored.BehaviorStateVer = item.BehaviorStateVer
		stored.VisualVariant = item.VisualVariant
	}

	// The server keeps all durable snapshot metadata. Only runtime checkpoint
	// bookkeeping comes from the accepted host checkpoint.
	r.snapshot.HostEpoch = r.hostEpoch
	r.snapshot.CheckpointRevision = checkpoint.CheckpointRevision
	r.snapshot.Tick = incoming.Tick
	r.snapshot.CapturedAt = incoming.CapturedAt
	r.snapshot.Normalized = incoming.Normalized
	r.checkpointNo = checkpoint.CheckpointRevision
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

func (r *Room) persist() {
	record := SnapshotRecord{
		CanvasID:           r.canvasID,
		SceneRevision:      r.sceneRevision,
		CheckpointRevision: r.checkpointNo,
		HostEpoch:          r.hostEpoch,
		Tick:               r.snapshot.Tick,
		Normalized:         r.snapshot.Normalized,
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
	// The server cannot execute developer-authored behavior normalization. A
	// graceful host may already have supplied a normalized final checkpoint;
	// after abrupt loss the newest periodic checkpoint remains explicitly
	// unnormalized instead of making a false claim.
	r.persist()
	r.sleeping = true
	r.cfg.Metrics.RoomSlept(r.canvasID)
	r.cfg.Logger.Info("room sleeping", "canvas", r.canvasID,
		"sceneRevision", r.sceneRevision, "items", len(r.snapshot.Items))
	r.server.removeRoom(r.canvasID)
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
