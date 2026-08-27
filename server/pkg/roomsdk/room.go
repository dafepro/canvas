package roomsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	roomID        string
	canvasID      string
	canvasShape   canvasShape
	definitionRaw json.RawMessage

	sceneRevision  uint64
	hostEpoch      uint64
	hostClientID   string
	hostLeaseUntil time.Time
	sleeping       bool

	clients map[string]*Client
	// participants records authenticated identities seen during this active room
	// lifetime. Their avatar IDs remain valid after a socket disconnects.
	participants map[string]struct{}
	// joinOrder keeps election deterministic.
	joinOrder []string

	snapshot             CanvasSnapshot
	snapshotRaw          json.RawMessage
	checkpointNo         uint64
	items                map[string]*SnapshotItem
	avatarPositions      map[string]SnapshotAvatar
	editSessions         map[string]*itemEditSession
	editByEntity         map[string]string
	mutationReceipts     map[string]*storedMutationReceipt
	mutationReceiptOrder []string
	mutationHighWater    map[string]uint64
	definitions          map[catalogVersionKey]ItemDefinitionRecord
	nextEntityNo         uint64

	joins      chan *Client
	departures chan departure
	messages   chan inbound
	done       chan struct{}
	emptyAt    time.Time

	// Persistence is intentionally outside the room loop. Disk flushes must not
	// delay realtime relay; a one-slot queue coalesces superseded checkpoints.
	persistQueue chan SnapshotRecord
	persistStop  chan struct{}
	persistDone  chan struct{}
}

func newRoom(server *Server, roomID string, record CanvasRecord, snapshot SnapshotRecord) (*Room, error) {
	return newRoomWithMode(server, roomID, record, snapshot, false)
}

func newRoomForReconciliation(
	server *Server,
	roomID string,
	record CanvasRecord,
	snapshot SnapshotRecord,
) (*Room, error) {
	return newRoomWithMode(server, roomID, record, snapshot, true)
}

func newRoomWithMode(
	server *Server,
	roomID string,
	record CanvasRecord,
	snapshot SnapshotRecord,
	allowTemplateMigration bool,
) (*Room, error) {
	shape, err := parseCanvasShape(record.DefinitionRaw)
	if err != nil {
		return nil, err
	}
	if shape.ID != record.CanvasID || shape.Version != record.Version {
		return nil, fmt.Errorf("%w: record=%s@%d definition=%s@%d",
			ErrRoomTemplateConflict, record.CanvasID, record.Version, shape.ID, shape.Version)
	}

	room := &Room{
		cfg:               &server.cfg,
		server:            server,
		roomID:            roomID,
		canvasID:          record.CanvasID,
		canvasShape:       shape,
		definitionRaw:     record.DefinitionRaw,
		clients:           make(map[string]*Client),
		participants:      make(map[string]struct{}),
		items:             make(map[string]*SnapshotItem),
		avatarPositions:   make(map[string]SnapshotAvatar),
		editSessions:      make(map[string]*itemEditSession),
		editByEntity:      make(map[string]string),
		mutationReceipts:  make(map[string]*storedMutationReceipt),
		mutationHighWater: make(map[string]uint64),
		definitions:       make(map[catalogVersionKey]ItemDefinitionRecord),
		joins:             make(chan *Client, 8),
		departures:        make(chan departure, 8),
		messages:          make(chan inbound, 512),
		done:              make(chan struct{}),
		persistQueue:      make(chan SnapshotRecord, 1),
		persistStop:       make(chan struct{}),
		persistDone:       make(chan struct{}),
		sleeping:          true,
	}

	if len(snapshot.SnapshotRaw) > 0 {
		if err := json.Unmarshal(snapshot.SnapshotRaw, &room.snapshot); err != nil {
			return nil, err
		}
		if snapshot.RoomID != roomID || snapshot.CanvasID != room.snapshot.CanvasID ||
			snapshot.CanvasVersion != room.snapshot.CanvasVersion {
			return nil, ErrRoomTemplateConflict
		}
		if room.snapshot.SchemaVersion != 1 {
			return nil, errSnapshotSchema
		}
		if err := room.validateLoadedSnapshot(snapshot, allowTemplateMigration); err != nil {
			return nil, err
		}
		room.snapshotRaw = snapshot.SnapshotRaw
		room.sceneRevision = snapshot.SceneRevision
		room.checkpointNo = snapshot.CheckpointRevision
		room.hostEpoch = snapshot.HostEpoch
		if room.snapshot.HostEpoch > room.hostEpoch {
			room.hostEpoch = room.snapshot.HostEpoch
		}
		if err := room.loadMutationReceipts(snapshot); err != nil {
			return nil, err
		}
	} else {
		room.snapshot = emptySnapshot(record.CanvasID, shape.Version, server.cfg.Now())
		if err := room.bootstrapSystemItems(); err != nil {
			return nil, err
		}
		raw, err := json.Marshal(room.snapshot)
		if err != nil {
			return nil, err
		}
		room.snapshotRaw = raw
	}
	room.indexItems()
	for _, avatar := range room.snapshot.Avatars {
		room.avatarPositions[avatar.EntityID] = avatar
		if avatar.EntityID == "avatar:"+avatar.UserID && avatar.UserID != "" {
			// A replacement process must recognize an avatar that the previous
			// host retained as disconnected. Otherwise its first canonical frame
			// is rejected before that participant has rejoined this process.
			room.participants[avatar.UserID] = struct{}{}
		}
	}
	return room, nil
}

func (r *Room) bootstrapSystemItems() error {
	if len(r.canvasShape.SystemItems) > r.canvasShape.Limits.MaxItems {
		return fmt.Errorf("system item count exceeds canvas limit")
	}
	seen := make(map[string]struct{}, len(r.canvasShape.SystemItems))
	complexItems := 0
	for _, template := range r.canvasShape.SystemItems {
		if template.EntityID == "" {
			return fmt.Errorf("system item entity id is required")
		}
		if _, duplicate := seen[template.EntityID]; duplicate {
			return fmt.Errorf("duplicate system item entity id %q", template.EntityID)
		}
		seen[template.EntityID] = struct{}{}
		definition, err := r.itemDefinition(template.DefinitionID, template.DefinitionVersion)
		if err != nil {
			return fmt.Errorf("load system item %q definition: %w", template.EntityID, err)
		}
		if definition.Version != template.DefinitionVersion {
			return fmt.Errorf("system item %q definition version mismatch", template.EntityID)
		}
		if err := validateConfigJSON(definition.ConfigSchema, template.ResolvedConfig); err != nil {
			return fmt.Errorf("system item %q config: %w", template.EntityID, err)
		}
		if !r.validSystemItemTransform(template.Transform) {
			return fmt.Errorf("system item %q transform is invalid", template.EntityID)
		}
		if definition.Complexity == ItemComplexityComplex {
			complexItems++
			if complexItems > r.canvasShape.Limits.MaxComplexPhysicsItems {
				return fmt.Errorf("system complex item count exceeds canvas limit")
			}
		}
		r.snapshot.Items = append(r.snapshot.Items, SnapshotItem{
			EntityID:          template.EntityID,
			DefinitionID:      template.DefinitionID,
			DefinitionVersion: template.DefinitionVersion,
			OwnerUserID:       "",
			ItemRevision:      1,
			Transform:         template.Transform,
			ResolvedConfig:    append(json.RawMessage(nil), template.ResolvedConfig...),
		})
	}
	if len(r.snapshot.Items) > 0 {
		r.sceneRevision = 1
		r.snapshot.SceneRevision = 1
	}
	return nil
}

func (r *Room) validSystemItemTransform(transform Transform) bool {
	return transform.finite() && transform.Scale > 0 && r.insideCanvas(transform)
}

func (r *Room) itemDefinition(
	definitionID string,
	version uint32,
) (ItemDefinitionRecord, error) {
	key := catalogVersionKey{id: definitionID, version: version}
	if definition, ok := r.definitions[key]; ok {
		return definition, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	definition, err := r.cfg.Store.LoadItemDefinition(ctx, definitionID, version)
	if err != nil {
		return ItemDefinitionRecord{}, err
	}
	if definition.DefinitionID != definitionID || definition.Version != version {
		return ItemDefinitionRecord{}, fmt.Errorf(
			"definition catalog returned %s@%d for requested %s@%d",
			definition.DefinitionID, definition.Version, definitionID, version,
		)
	}
	r.definitions[key] = definition
	return definition, nil
}

func (r *Room) complexItemCount() int {
	count := 0
	for _, item := range r.snapshot.Items {
		definition, err := r.itemDefinition(item.DefinitionID, item.DefinitionVersion)
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
	go r.persistenceLoop()
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
			r.checkItemEditLeases()
			if len(r.clients) == 0 && r.cfg.Now().Sub(r.emptyAt) >= r.cfg.SleepGrace {
				r.sleep()
				return
			}
		}
	}
}

// ---------- join and leave ----------

func (r *Room) handleJoin(client *Client) {
	// One authenticated participant owns at most one live room connection. A
	// reconnect supersedes its stale socket before capacity is evaluated.
	for _, existing := range r.clients {
		if existing.UserID == client.UserID {
			r.sendTo(existing, &pb.RoomEnvelope{
				RoomId:    r.roomID,
				HostEpoch: r.hostEpoch,
				Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
					Code:    "session_superseded",
					Message: "another connection for this participant joined the room",
				}},
			})
			r.removeClient(existing, "superseded")
		}
	}
	if len(r.clients) >= r.maxClients() {
		r.sendTo(client, &pb.RoomEnvelope{
			RoomId: r.roomID,
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
	r.participants[client.UserID] = struct{}{}
	r.joinOrder = append(r.joinOrder, client.ID)
	client.joined = true
	r.cfg.Metrics.ClientJoined(r.roomID)

	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_JoinAccepted{JoinAccepted: &pb.JoinAccepted{
			ClientId:             client.ID,
			SceneRevision:        r.sceneRevision,
			HostEpoch:            r.hostEpoch,
			HostClientId:         r.hostClientID,
			CanvasDefinitionJson: r.definitionRaw,
			SnapshotJson:         r.snapshotForClient(),
			RoomWasSleeping:      wasSleeping,
			TickRate:             r.cfg.TickRate,
			UserId:               client.UserID,
			DisplayName:          client.DisplayName,
			CanvasId:             r.canvasID,
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
	wasHost := client.ID == r.hostClientID
	if !r.removeClient(client, gone.reason) {
		return
	}
	if wasHost {
		r.electHost("host_disconnected")
	}
	if len(r.clients) > 0 {
		r.broadcastPresence()
	}
}

// removeClient updates connection state without broadcasting or electing. A
// reconnect uses it to replace a stale socket atomically from presence's view.
func (r *Room) removeClient(client *Client, reason string) bool {
	if _, ok := r.clients[client.ID]; !ok {
		return false
	}
	delete(r.clients, client.ID)
	for i, id := range r.joinOrder {
		if id == client.ID {
			r.joinOrder = append(r.joinOrder[:i], r.joinOrder[i+1:]...)
			break
		}
	}
	client.close()
	r.cfg.Metrics.ClientLeft(r.roomID, reason)
	r.cancelItemEdits(client)

	if r.hostClientID == client.ID {
		r.hostClientID = ""
	}
	return true
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
	r.cfg.Metrics.RelayBytes(r.roomID, msg.size)

	switch payload := envelope.Payload.(type) {
	case *pb.RoomEnvelope_Heartbeat:
		r.handleHeartbeat(client, payload.Heartbeat)

	case *pb.RoomEnvelope_PlayerInput:
		// Input goes only to the simulation host.
		if validPlayerInput(payload.PlayerInput) {
			r.relayToHost(client, envelope)
		}

	case *pb.RoomEnvelope_StateDelta, *pb.RoomEnvelope_FullState, *pb.RoomEnvelope_EffectEvent:
		r.relayFromHost(client, envelope)

	case *pb.RoomEnvelope_HostControl:
		r.handleHostControl(client, payload.HostControl)

	case *pb.RoomEnvelope_ItemMutation:
		r.handleItemMutation(client, payload.ItemMutation)

	case *pb.RoomEnvelope_BeginItemEdit:
		r.handleBeginItemEdit(client, payload.BeginItemEdit)

	case *pb.RoomEnvelope_RenewItemEdit:
		r.handleRenewItemEdit(client, payload.RenewItemEdit)

	case *pb.RoomEnvelope_EndItemEdit:
		r.handleEndItemEdit(client, payload.EndItemEdit)

	case *pb.RoomEnvelope_ItemEditPreview:
		r.handleItemEditPreview(client, payload.ItemEditPreview)

	case *pb.RoomEnvelope_Checkpoint:
		r.handleCheckpoint(client, envelope.HostEpoch, payload.Checkpoint)

	default:
		// Unknown payloads are ignored rather than closing the connection.
	}
}

// checkDefinitions blocks a client from the host lease while it lacks the
// exact version of any definition the scene uses. A different version can
// change physics or behavior and is not a compatible substitute.
func (r *Room) checkDefinitions(client *Client) {
	missing := make([]string, 0)
	for _, item := range r.snapshot.Items {
		version, ok := client.definitions[item.DefinitionID]
		if !ok || version != item.DefinitionVersion {
			missing = append(missing, fmt.Sprintf("%s@%d", item.DefinitionID, item.DefinitionVersion))
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

	r.cfg.Metrics.ProtocolMismatch(r.roomID)
	r.cfg.Logger.Warn("client lacks an exact item definition the scene uses",
		"canvas", r.roomID, "client", client.ID, "definitions", missing)
	r.sendTo(client, &pb.RoomEnvelope{
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
			Code:    "definition_mismatch",
			Message: "the client lacks these exact item definitions: " + strings.Join(missing, ", "),
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
	if !validHeartbeat(beat) {
		return
	}
	client.lastHeartbeat = r.cfg.Now()
	client.simulationHz = beat.SimulationHz
	client.workerDrift = beat.WorkerDriftMs
	client.pageVisible = beat.PageVisible
	if client.ID == r.hostClientID {
		r.hostLeaseUntil = r.cfg.Now().Add(r.cfg.HostLeaseTTL)
	}
}

const (
	maxReportedSimulationHz  = 1000
	maxReportedWorkerDriftMs = 60_000
)

func finiteFloat32(value float32) bool {
	converted := float64(value)
	return !math.IsNaN(converted) && !math.IsInf(converted, 0)
}

func validVec2(value *pb.Vec2) bool {
	return value == nil || finiteFloat32(value.X) && finiteFloat32(value.Y)
}

func validPlayerInput(input *pb.PlayerInput) bool {
	if input == nil || !validVec2(input.Direction) || !validVec2(input.TargetPosition) ||
		!finiteFloat32(input.Intensity) || input.Intensity < 0 || input.Intensity > 1 {
		return false
	}
	if input.Direction == nil {
		return true
	}
	// Direction is a normalized intent vector. Enforcing the unit disk prevents
	// custom clients from multiplying the authored maximum avatar speed.
	return math.Hypot(float64(input.Direction.X), float64(input.Direction.Y)) <= 1.000001
}

func validHeartbeat(beat *pb.Heartbeat) bool {
	return beat != nil && finiteFloat32(beat.SimulationHz) &&
		beat.SimulationHz >= 0 && beat.SimulationHz <= maxReportedSimulationHz &&
		finiteFloat32(beat.WorkerDriftMs) && beat.WorkerDriftMs >= 0 &&
		beat.WorkerDriftMs <= maxReportedWorkerDriftMs
}

// relayToHost forwards player input. The server never reads the physics content.
func (r *Room) relayToHost(from *Client, envelope *pb.RoomEnvelope) {
	host := r.clients[r.hostClientID]
	if host == nil {
		return
	}
	envelope.SenderClientId = from.ID
	envelope.RoomId = r.roomID
	r.sendTo(host, envelope)
}

// relayFromHost broadcasts canonical state. It refuses a sender without the
// active lease and refuses a stale epoch (spec 11.1).
func (r *Room) relayFromHost(from *Client, envelope *pb.RoomEnvelope) {
	if from.ID != r.hostClientID {
		r.cfg.Metrics.DurableRejected(r.roomID, "state_from_non_host")
		return
	}
	if envelope.HostEpoch != r.hostEpoch {
		r.cfg.Metrics.DurableRejected(r.roomID, "stale_host_epoch")
		return
	}
	if err := r.validateCanonicalState(envelope); err != nil {
		r.cfg.Logger.Warn("rejected canonical state",
			"canvas", r.roomID, "reason", err.Error())
		r.cfg.Metrics.DurableRejected(r.roomID, "malformed_state")
		return
	}
	r.captureAvatarPositions(envelope)
	envelope.SenderClientId = from.ID
	envelope.RoomId = r.roomID
	r.broadcastExcept(from.ID, envelope)
}

func (r *Room) validateCanonicalState(envelope *pb.RoomEnvelope) error {
	if effect := envelope.GetEffectEvent(); effect != nil {
		if len(effect.ParamsJson) > 0 && !json.Valid(effect.ParamsJson) {
			return errInvalidEffect
		}
		return nil
	}
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
		if state == nil || state.QuantizedTransform == nil {
			return errMissingStateVector
		}
		if _, duplicate := seen[state.EntityId]; duplicate {
			return errDuplicateEntity
		}
		seen[state.EntityId] = struct{}{}

		item := r.items[state.EntityId]
		if item == nil && !r.knownParticipantAvatar(state.EntityId) {
			return fmt.Errorf("%w %q", errUnknownEntity, state.EntityId)
		}
		if item != nil && state.DefinitionId != "" && state.DefinitionId != item.DefinitionID {
			return errDefinitionMismatch
		}
		if len(state.BehaviorStateJson) > 0 && !json.Valid(state.BehaviorStateJson) {
			return errInvalidBehavior
		}

		quantized := state.QuantizedTransform
		transform := Transform{
			X:        float64(quantized.X) / 100,
			Y:        float64(quantized.Y) / 100,
			Rotation: float64(quantized.Rotation) / 1000,
		}
		if !r.withinBounds(transform) {
			return errOutOfBounds
		}
	}
	return nil
}

func (r *Room) knownParticipantAvatar(entityID string) bool {
	if !strings.HasPrefix(entityID, "avatar:") {
		return false
	}
	_, ok := r.participants[strings.TrimPrefix(entityID, "avatar:")]
	return ok
}

func (r *Room) captureAvatarPositions(envelope *pb.RoomEnvelope) {
	var states []*pb.EntityState
	if delta := envelope.GetStateDelta(); delta != nil {
		states = delta.Entities
	} else if full := envelope.GetFullState(); full != nil {
		states = full.Entities
	}
	for _, state := range states {
		if state == nil || state.QuantizedTransform == nil || !r.knownParticipantAvatar(state.EntityId) {
			continue
		}
		userID := strings.TrimPrefix(state.EntityId, "avatar:")
		r.avatarPositions[state.EntityId] = SnapshotAvatar{
			EntityID: state.EntityId,
			UserID:   userID,
			Position: Vec2{
				X: float64(state.QuantizedTransform.X) / 100,
				Y: float64(state.QuantizedTransform.Y) / 100,
			},
		}
	}
}

func (r *Room) snapshotForClient() json.RawMessage {
	snapshot := r.snapshot
	snapshot.Avatars = make([]SnapshotAvatar, 0, len(r.avatarPositions))
	for _, avatar := range r.avatarPositions {
		snapshot.Avatars = append(snapshot.Avatars, avatar)
	}
	sort.Slice(snapshot.Avatars, func(i, j int) bool {
		return snapshot.Avatars[i].EntityID < snapshot.Avatars[j].EntityID
	})
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return r.snapshotRaw
	}
	return raw
}

func (r *Room) handleCheckpoint(from *Client, hostEpoch uint64, checkpoint *pb.Checkpoint) {
	if from.ID != r.hostClientID {
		r.cfg.Metrics.DurableRejected(r.roomID, "checkpoint_from_non_host")
		return
	}
	if hostEpoch != r.hostEpoch {
		r.cfg.Metrics.DurableRejected(r.roomID, "stale_host_epoch")
		return
	}
	if err := r.acceptCheckpoint(checkpoint); err != nil {
		r.cfg.Logger.Warn("rejected checkpoint",
			"canvas", r.roomID, "reason", err.Error())
		r.cfg.Metrics.DurableRejected(r.roomID, "malformed_checkpoint")
		return
	}
	r.cfg.Metrics.CheckpointStored(r.roomID, len(checkpoint.SnapshotJson))
	r.persistAsync()
}

func (r *Room) acceptCheckpoint(checkpoint *pb.Checkpoint) error {
	var incoming CanvasSnapshot
	if err := json.Unmarshal(checkpoint.SnapshotJson, &incoming); err != nil {
		return err
	}
	if incoming.SchemaVersion != 1 {
		return errSnapshotSchema
	}
	if incoming.CanvasID != r.canvasID {
		return errCanvasMismatch
	}
	if incoming.CanvasVersion != r.canvasShape.Version {
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
			return fmt.Errorf("%w %q", errUnknownEntity, item.EntityID)
		}
		if !item.Transform.finite() {
			return errNonFiniteTransform
		}
		if !r.withinBounds(item.Transform) {
			return errOutOfBounds
		}
		if incoming.Normalized && len(item.BehaviorTimers) > 0 {
			return errInvalidTimer
		}
		if len(item.BehaviorTimers) > 64 {
			return errInvalidTimer
		}
		for _, timer := range item.BehaviorTimers {
			if timer.Key == "" || len(timer.Key) > 128 || timer.RemainingTicks == 0 ||
				timer.ElapsedTicks > maxJSONSafeInteger ||
				timer.RemainingTicks > maxJSONSafeInteger {
				return errInvalidTimer
			}
		}
	}
	seenAvatars := make(map[string]struct{}, len(incoming.Avatars))
	for _, avatar := range incoming.Avatars {
		if _, duplicate := seenAvatars[avatar.EntityID]; duplicate {
			return errDuplicateEntity
		}
		seenAvatars[avatar.EntityID] = struct{}{}
		if avatar.EntityID != "avatar:"+avatar.UserID || !r.knownParticipantAvatar(avatar.EntityID) {
			return fmt.Errorf("%w %q", errUnknownEntity, avatar.EntityID)
		}
		transform := Transform{X: avatar.Position.X, Y: avatar.Position.Y, Scale: 1}
		if !transform.finite() {
			return errNonFiniteTransform
		}
		if !r.withinBounds(transform) {
			return errOutOfBounds
		}
	}

	// The host owns canonical physics and behavior outcomes, but durable item
	// identity and authorship remain server-authoritative. Merge only the
	// canonical fields into records that the durable mutation path created.
	for i := range incoming.Items {
		item := &incoming.Items[i]
		stored := r.items[item.EntityID]
		if _, previewing := r.editByEntity[item.EntityID]; !previewing {
			stored.Transform = item.Transform
		}
		stored.BehaviorState = item.BehaviorState
		stored.BehaviorStateVer = item.BehaviorStateVer
		stored.BehaviorTimers = item.BehaviorTimers
		stored.VisualVariant = item.VisualVariant
		stored.VisualTint = item.VisualTint
	}
	for _, avatar := range incoming.Avatars {
		r.avatarPositions[avatar.EntityID] = avatar
	}
	r.snapshot.Avatars = make([]SnapshotAvatar, 0, len(r.avatarPositions))
	for _, avatar := range r.avatarPositions {
		r.snapshot.Avatars = append(r.snapshot.Avatars, avatar)
	}
	sort.Slice(r.snapshot.Avatars, func(i, j int) bool {
		return r.snapshot.Avatars[i].EntityID < r.snapshot.Avatars[j].EntityID
	})

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

func (r *Room) validateLoadedSnapshot(
	record SnapshotRecord,
	allowTemplateMigration bool,
) error {
	snapshot := &r.snapshot
	if !allowTemplateMigration &&
		(snapshot.CanvasID != r.canvasID || snapshot.CanvasVersion != r.canvasShape.Version) {
		return errCanvasMismatch
	}
	if record.SceneRevision != snapshot.SceneRevision ||
		record.CheckpointRevision != snapshot.CheckpointRevision ||
		record.HostEpoch < snapshot.HostEpoch || record.Tick != snapshot.Tick ||
		record.Normalized != snapshot.Normalized {
		return errors.New("persisted snapshot metadata disagrees with its record")
	}
	if snapshot.SceneRevision > maxJSONSafeInteger ||
		snapshot.CheckpointRevision > maxJSONSafeInteger ||
		snapshot.HostEpoch > maxJSONSafeInteger || snapshot.Tick > maxJSONSafeInteger {
		return errors.New("persisted snapshot counter exceeds the JSON safe integer range")
	}
	if len(snapshot.Items) > r.canvasShape.Limits.MaxItems {
		return errTooManyItems
	}
	seen := make(map[string]struct{}, len(snapshot.Items)+len(snapshot.Avatars))
	complexItems := 0
	for i := range snapshot.Items {
		item := &snapshot.Items[i]
		if item.EntityID == "" || item.DefinitionID == "" || item.DefinitionVersion == 0 {
			return errors.New("persisted item identity is incomplete")
		}
		if _, duplicate := seen[item.EntityID]; duplicate {
			return errDuplicateEntity
		}
		seen[item.EntityID] = struct{}{}
		if item.ItemRevision == 0 || item.ItemRevision > maxJSONSafeInteger {
			return errors.New("persisted item revision is outside the JSON contract")
		}
		if !item.Transform.finite() || item.Transform.Scale <= 0 {
			return errNonFiniteTransform
		}
		if !r.withinBounds(item.Transform) {
			return errOutOfBounds
		}
		definition, err := r.itemDefinition(item.DefinitionID, item.DefinitionVersion)
		if err != nil {
			return fmt.Errorf("persisted item %q definition: %w", item.EntityID, err)
		}
		if !allowTemplateMigration && definition.Version != item.DefinitionVersion {
			return errDefinitionMismatch
		}
		if err := validateConfigJSON(definition.ConfigSchema, item.ResolvedConfig); err != nil {
			return fmt.Errorf("persisted item %q config: %w", item.EntityID, err)
		}
		if definition.Complexity == ItemComplexityComplex {
			complexItems++
		}
		if snapshot.Normalized && len(item.BehaviorTimers) > 0 {
			return errInvalidTimer
		}
		if len(item.BehaviorTimers) > 64 {
			return errInvalidTimer
		}
		for _, timer := range item.BehaviorTimers {
			if timer.Key == "" || len(timer.Key) > 128 || timer.RemainingTicks == 0 ||
				timer.ElapsedTicks > maxJSONSafeInteger ||
				timer.RemainingTicks > maxJSONSafeInteger {
				return errInvalidTimer
			}
		}
	}
	if complexItems > r.canvasShape.Limits.MaxComplexPhysicsItems {
		return errors.New("persisted snapshot exceeds the complex item limit")
	}
	for _, avatar := range snapshot.Avatars {
		if avatar.EntityID == "" || avatar.UserID == "" ||
			avatar.EntityID != "avatar:"+avatar.UserID {
			return fmt.Errorf("%w %q", errUnknownEntity, avatar.EntityID)
		}
		if _, duplicate := seen[avatar.EntityID]; duplicate {
			return errDuplicateEntity
		}
		seen[avatar.EntityID] = struct{}{}
		transform := Transform{X: avatar.Position.X, Y: avatar.Position.Y, Scale: 1}
		if !transform.finite() {
			return errNonFiniteTransform
		}
		if !r.withinBounds(transform) {
			return errOutOfBounds
		}
	}
	return nil
}

func (r *Room) withinBounds(t Transform) bool {
	const slack = 4
	maxX := r.canvasShape.Size.Width * slack
	maxY := r.canvasShape.Size.Height * slack
	if maxX == 0 || maxY == 0 {
		return true
	}
	return t.X >= -maxX && t.X <= maxX && t.Y >= -maxY && t.Y <= maxY
}

func (r *Room) snapshotRecord() SnapshotRecord {
	record := SnapshotRecord{
		RoomID:             r.roomID,
		CanvasID:           r.canvasID,
		CanvasVersion:      r.snapshot.CanvasVersion,
		SceneRevision:      r.sceneRevision,
		CheckpointRevision: r.checkpointNo,
		HostEpoch:          r.hostEpoch,
		Tick:               r.snapshot.Tick,
		Normalized:         r.snapshot.Normalized,
		CapturedAt:         r.cfg.Now().UTC(),
		SnapshotRaw:        append(json.RawMessage(nil), r.snapshotRaw...),
	}
	for _, key := range r.mutationReceiptOrder {
		receipt := r.mutationReceipts[key]
		if receipt == nil {
			continue
		}
		resultBytes, err := proto.Marshal(receipt.result)
		if err != nil {
			continue
		}
		record.MutationReceipts = append(record.MutationReceipts, MutationReceiptRecord{
			UserID:          receipt.userID,
			ClientSessionID: receipt.result.ClientSessionId,
			MutationID:      receipt.result.MutationId,
			ResultBytes:     resultBytes,
		})
	}
	for key, mutationID := range r.mutationHighWater {
		userID, clientSessionID := splitClientSessionKey(key)
		record.MutationHighWater = append(record.MutationHighWater, MutationHighWaterRecord{
			UserID:          userID,
			ClientSessionID: clientSessionID,
			MutationID:      mutationID,
		})
	}
	sort.Slice(record.MutationHighWater, func(i, j int) bool {
		left := record.MutationHighWater[i]
		right := record.MutationHighWater[j]
		if left.UserID != right.UserID {
			return left.UserID < right.UserID
		}
		return left.ClientSessionID < right.ClientSessionID
	})
	return record
}

func (r *Room) persistAsync() {
	record := r.snapshotRecord()
	select {
	case r.persistQueue <- record:
		return
	default:
	}
	// Only the room goroutine produces records. Replace a queued older record
	// rather than building a disk-I/O backlog when storage is temporarily slow.
	select {
	case <-r.persistQueue:
	default:
	}
	select {
	case r.persistQueue <- record:
	default:
	}
}

func (r *Room) persistenceLoop() {
	defer close(r.persistDone)
	for {
		select {
		case record := <-r.persistQueue:
			r.saveSnapshot(record)
		case <-r.persistStop:
			return
		}
	}
}

func (r *Room) saveSnapshot(record SnapshotRecord) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.cfg.Store.SaveSnapshot(ctx, record); err != nil {
		r.cfg.Logger.Error("save snapshot failed", "canvas", r.roomID, "error", err)
	}
}

// ---------- room sleep (spec 13.3) ----------

func (r *Room) sleep() {
	// The server cannot execute developer-authored behavior normalization. A
	// graceful host may already have supplied a normalized final checkpoint;
	// after abrupt loss the newest periodic checkpoint remains explicitly
	// unnormalized instead of making a false claim.
	close(r.persistStop)
	<-r.persistDone
	r.saveSnapshot(r.snapshotRecord())
	r.sleeping = true
	r.cfg.Metrics.RoomSlept(r.roomID)
	r.cfg.Logger.Info("room sleeping", "canvas", r.roomID,
		"sceneRevision", r.sceneRevision, "items", len(r.snapshot.Items))
	r.server.removeRoom(r.roomID)
}

// ---------- fan-out ----------

func (r *Room) sendTo(client *Client, envelope *pb.RoomEnvelope) {
	if envelope.RoomId == "" {
		envelope.RoomId = r.roomID
	}
	if !client.enqueue(envelope) {
		if isRealtimeEnvelope(envelope) {
			r.cfg.Logger.Warn("dropped realtime envelope for slow client",
				"canvas", r.roomID, "client", client.ID)
			return
		}
		r.cfg.Logger.Warn("closing client whose reliable queue is saturated",
			"canvas", r.roomID, "client", client.ID)
		client.close()
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
		RoomId:    r.roomID,
		HostEpoch: r.hostEpoch,
		Payload:   &pb.RoomEnvelope_Presence{Presence: &pb.Presence{Peers: peers}},
	})
}
