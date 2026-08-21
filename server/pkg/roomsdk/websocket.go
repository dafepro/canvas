package roomsdk

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
	pb "github.com/dafepro/canvas/server/gen/canvasphysicsv1"
	"google.golang.org/protobuf/proto"
)

const (
	sendQueueDepth = 256
	// A room envelope stays far below this. The limit stops a hostile client
	// from allocating without bound.
	maxMessageBytes = 1 << 20
	writeTimeout    = 5 * time.Second
)

func (s *Server) handleRealtime(w http.ResponseWriter, r *http.Request) {
	canvasID := r.PathValue("id")

	identity, err := s.cfg.Auth.Authenticate(r.Context(), r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	room, err := s.roomFor(r.Context(), canvasID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "canvas not found", http.StatusNotFound)
			return
		}
		s.cfg.Logger.Error("open room failed", "canvas", canvasID, "error", err)
		http.Error(w, "room unavailable", http.StatusInternalServerError)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.cfg.AllowedOrigins,
		// Realtime packets are small and already compact, so compression only
		// adds CPU cost (spec 19.3).
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		s.cfg.Logger.Warn("websocket upgrade failed", "canvas", canvasID, "error", err)
		return
	}
	conn.SetReadLimit(maxMessageBytes)

	client := newClient(newClientID(), identity, sendQueueDepth)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	room.joins <- client
	reason := "closed"
	defer func() {
		room.departures <- departure{client: client, reason: reason}
		_ = conn.CloseNow()
	}()

	go s.writePump(ctx, conn, client)

	for {
		messageType, data, err := conn.Read(ctx)
		if err != nil {
			reason = "read_error"
			return
		}
		if messageType != websocket.MessageBinary {
			continue
		}
		envelope := &pb.RoomEnvelope{}
		if err := proto.Unmarshal(data, envelope); err != nil {
			s.cfg.Logger.Warn("dropped malformed envelope",
				"canvas", canvasID, "client", client.ID)
			continue
		}
		if join := envelope.GetJoin(); join != nil && join.ProtocolVersion != s.cfg.ProtocolVersion {
			s.cfg.Metrics.ProtocolMismatch(canvasID)
			// Write the refusal on this goroutine so the client receives it
			// before the deferred close runs.
			s.writeNow(ctx, conn, &pb.RoomEnvelope{
				RoomId: canvasID,
				Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
					Code:                  "protocol_mismatch",
					Message:               "the client protocol version is not supported",
					ServerProtocolVersion: s.cfg.ProtocolVersion,
				}},
			})
			reason = "protocol_mismatch"
			return
		}
		envelope.SenderClientId = client.ID

		select {
		case room.messages <- inbound{client: client, envelope: envelope, size: len(data)}:
		case <-ctx.Done():
			return
		default:
			// The room loop is behind. Dropping a realtime packet is correct;
			// the next keyframe repairs the client.
			s.cfg.Logger.Warn("room inbox full, dropped envelope", "canvas", canvasID)
		}
	}
}

// writeNow sends one envelope immediately, bypassing the client queue.
func (s *Server) writeNow(ctx context.Context, conn *websocket.Conn, envelope *pb.RoomEnvelope) {
	data, err := proto.Marshal(envelope)
	if err != nil {
		s.cfg.Logger.Error("marshal envelope failed", "error", err)
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageBinary, data); err != nil {
		s.cfg.Logger.Warn("direct write failed", "error", err)
	}
}

func (s *Server) writePump(ctx context.Context, conn *websocket.Conn, client *Client) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-client.closeOnce:
			// Flush what the room already queued, such as a refusal, so the
			// client learns why the connection ended.
			for {
				select {
				case envelope := <-client.send:
					s.writeNow(ctx, conn, envelope)
					continue
				default:
				}
				break
			}
			_ = conn.Close(websocket.StatusNormalClosure, "server closed the room connection")
			return
		case envelope := <-client.send:
			data, err := proto.Marshal(envelope)
			if err != nil {
				s.cfg.Logger.Error("marshal envelope failed", "error", err)
				continue
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err = conn.Write(writeCtx, websocket.MessageBinary, data)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
