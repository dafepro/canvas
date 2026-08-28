package roomsdk

import (
	"log/slog"
	"time"
)

// Config wires the SDK into a host application. Store and Auth are required.
type Config struct {
	// Store holds canvas definitions and canonical checkpoints.
	Store Store
	// RoomTemplates maps product-owned room ids to reusable canvas templates.
	RoomTemplates RoomTemplateResolver
	// Auth turns an HTTP request into an Identity.
	Auth Authenticator
	// TickRate the host should simulate at, sent in JoinAccepted (spec 10.3).
	TickRate uint32
	// HostLeaseTTL is the missed-heartbeat window before the lease is revoked.
	HostLeaseTTL time.Duration
	// HeartbeatInterval is the rate the SDK expects host heartbeats at.
	HeartbeatInterval time.Duration
	// ItemEditLeaseTTL bounds an abandoned live-preview session. The client
	// renews the lease while item controls remain open.
	ItemEditLeaseTTL time.Duration
	// SleepGrace is how long a room stays in memory after the last client left.
	SleepGrace time.Duration
	// MaxClientsPerRoom refuses a join above the limit. 0 means use the canvas
	// limit from the definition, falling back to 20.
	MaxClientsPerRoom int
	// ProtocolVersion refuses a client that does not match.
	ProtocolVersion uint32
	// Logger receives coordination events. Defaults to slog.Default().
	Logger *slog.Logger
	// Now is injectable for tests.
	Now func() time.Time
	// AllowedOrigins for the WebSocket upgrade. Empty means same origin only.
	// Use []string{"*"} for local runs.
	AllowedOrigins []string
	// Metrics receives counters listed in spec 22.2. Optional.
	Metrics Metrics
	// MutationAuthorizer lets the host application consume product-owned
	// authorization evidence at the durable mutation boundary. Optional.
	MutationAuthorizer MutationAuthorizer
	// MutationAuthorizationTimeout bounds a product authorization decision.
	MutationAuthorizationTimeout time.Duration
	// MaxMutationAuthorizationBytes bounds opaque evidence sent by a client.
	MaxMutationAuthorizationBytes int
	// MaxMutationCorrelationBytes bounds an opaque reconciliation identity.
	MaxMutationCorrelationBytes int
	// MutationOutcomeRetention is the trusted reconciliation window.
	MutationOutcomeRetention time.Duration
	// MaxMutationOutcomesPerRoom bounds the private per-room outcome ledger.
	MaxMutationOutcomesPerRoom int
	// MutationOutcomeSink receives best-effort terminal notifications after the
	// authoritative outcome has been added to durable storage. Optional.
	MutationOutcomeSink MutationOutcomeSink
	// MutationOutcomeSinkTimeout bounds one best-effort sink delivery.
	MutationOutcomeSinkTimeout time.Duration
	// RoomCoordinator provides cross-process room ownership and fencing. Nil
	// keeps the existing process-local ownership behavior.
	RoomCoordinator RoomCoordinator
	// ReplicaID is the stable deployment replica label exposed to coordination
	// diagnostics. A generated process-local label is used when empty.
	ReplicaID string
	// RoomOwnershipTTL is the lease duration in a shared coordinator.
	RoomOwnershipTTL time.Duration
	// RoomOwnershipRenewInterval controls proactive lease renewal.
	RoomOwnershipRenewInterval time.Duration
}

const (
	defaultTickRate                      = 60
	defaultHostLeaseTTL                  = 2500 * time.Millisecond
	defaultHeartbeatInterval             = 500 * time.Millisecond
	defaultItemEditLeaseTTL              = 5 * time.Second
	defaultSleepGrace                    = 2 * time.Second
	defaultMaxClients                    = 20
	defaultProtocolVersion               = 8
	defaultMutationAuthorizationTimeout  = 2 * time.Second
	defaultMaxMutationAuthorizationBytes = 4096
	defaultMaxMutationCorrelationBytes   = 256
	defaultMutationOutcomeRetention      = 24 * time.Hour
	defaultMaxMutationOutcomesPerRoom    = 1024
	defaultMutationOutcomeSinkTimeout    = 5 * time.Second
	defaultRoomOwnershipTTL              = 10 * time.Second
)

func (c *Config) applyDefaults() {
	if c.TickRate == 0 {
		c.TickRate = defaultTickRate
	}
	if c.HostLeaseTTL <= 0 {
		c.HostLeaseTTL = defaultHostLeaseTTL
	}
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = defaultHeartbeatInterval
	}
	if c.ItemEditLeaseTTL <= 0 {
		c.ItemEditLeaseTTL = defaultItemEditLeaseTTL
	}
	if c.SleepGrace <= 0 {
		c.SleepGrace = defaultSleepGrace
	}
	if c.MaxClientsPerRoom <= 0 {
		c.MaxClientsPerRoom = defaultMaxClients
	}
	if c.ProtocolVersion == 0 {
		c.ProtocolVersion = defaultProtocolVersion
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Metrics == nil {
		c.Metrics = NopMetrics{}
	}
	if c.MutationAuthorizationTimeout <= 0 {
		c.MutationAuthorizationTimeout = defaultMutationAuthorizationTimeout
	}
	if c.MaxMutationAuthorizationBytes <= 0 {
		c.MaxMutationAuthorizationBytes = defaultMaxMutationAuthorizationBytes
	}
	if c.MaxMutationCorrelationBytes <= 0 {
		c.MaxMutationCorrelationBytes = defaultMaxMutationCorrelationBytes
	}
	if c.MutationOutcomeRetention <= 0 {
		c.MutationOutcomeRetention = defaultMutationOutcomeRetention
	}
	if c.MaxMutationOutcomesPerRoom <= 0 {
		c.MaxMutationOutcomesPerRoom = defaultMaxMutationOutcomesPerRoom
	}
	if c.MutationOutcomeSinkTimeout <= 0 {
		c.MutationOutcomeSinkTimeout = defaultMutationOutcomeSinkTimeout
	}
	if c.RoomOwnershipTTL <= 0 {
		c.RoomOwnershipTTL = defaultRoomOwnershipTTL
	}
	if c.RoomOwnershipRenewInterval <= 0 || c.RoomOwnershipRenewInterval >= c.RoomOwnershipTTL {
		c.RoomOwnershipRenewInterval = c.RoomOwnershipTTL / 3
	}
}

type roomOwnershipMetrics interface {
	RoomOwnershipAcquired(roomID string, generation uint64)
	RoomOwnershipRenewed(roomID string, generation uint64)
	RoomOwnershipLost(roomID, reason string)
	RoomOwnershipFenced(roomID, operation string)
	RoomDrainFinished(roomID, result string)
}

// Metrics reports the backend counters from spec 22.2.
type Metrics interface {
	RoomOpened(canvasID string)
	RoomSlept(canvasID string)
	ClientJoined(canvasID string)
	ClientLeft(canvasID string, reason string)
	RelayBytes(canvasID string, bytes int)
	HostLeaseChanged(canvasID string, epoch uint64, reason string)
	CheckpointStored(canvasID string, bytes int)
	DurableRejected(canvasID string, reason string)
	ProtocolMismatch(canvasID string)
}

// NopMetrics discards every counter.
type NopMetrics struct{}

func (NopMetrics) RoomOpened(string)                       {}
func (NopMetrics) RoomSlept(string)                        {}
func (NopMetrics) ClientJoined(string)                     {}
func (NopMetrics) ClientLeft(string, string)               {}
func (NopMetrics) RelayBytes(string, int)                  {}
func (NopMetrics) HostLeaseChanged(string, uint64, string) {}
func (NopMetrics) CheckpointStored(string, int)            {}
func (NopMetrics) DurableRejected(string, string)          {}
func (NopMetrics) ProtocolMismatch(string)                 {}
