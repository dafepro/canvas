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
	// SleepGrace is how long a room stays in memory after the last client left.
	SleepGrace time.Duration
	// MaxClientsPerRoom refuses a join above the limit. 0 means use the canvas
	// limit from the definition, falling back to 20.
	MaxClientsPerRoom int
	// ParticipantSignals enables a bounded, non-durable consumer signal channel.
	// An empty allowlist keeps the channel disabled.
	ParticipantSignals ParticipantSignalPolicy
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
}

type ParticipantSignalPolicy struct {
	AllowedKinds    map[string]struct{}
	MaxPayloadBytes int
	MinInterval     time.Duration
}

const (
	defaultTickRate          = 60
	defaultHostLeaseTTL      = 2500 * time.Millisecond
	defaultHeartbeatInterval = 500 * time.Millisecond
	defaultSleepGrace        = 2 * time.Second
	defaultMaxClients        = 20
	defaultProtocolVersion   = 8
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
	if len(c.ParticipantSignals.AllowedKinds) > 0 {
		allowed := make(map[string]struct{}, len(c.ParticipantSignals.AllowedKinds))
		for kind := range c.ParticipantSignals.AllowedKinds {
			allowed[kind] = struct{}{}
		}
		c.ParticipantSignals.AllowedKinds = allowed
		if c.ParticipantSignals.MinInterval <= 0 {
			c.ParticipantSignals.MinInterval = time.Second
		}
	}
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
	ParticipantSignal(canvasID string, result string)
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
func (NopMetrics) ParticipantSignal(string, string)        {}
