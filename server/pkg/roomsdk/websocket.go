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
	joinTimeout     = 5 * time.Second
)

func (s *Server) handleRealtime(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("id")

	identity, err := s.cfg.Auth.Authenticate(r.Context(), r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: s.cfg.AllowedOrigins,
		Subprotocols:   []string{"canvas-realtime"},
		// Realtime packets are small and already compact, so compression only
		// adds CPU cost (spec 19.3).
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		s.cfg.Logger.Warn("websocket upgrade failed", "room", roomID, "error", err)
		return
	}
	conn.SetReadLimit(maxMessageBytes)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer func() { _ = conn.CloseNow() }()

	join, ok := s.readJoin(ctx, conn, roomID)
	if !ok {
		return
	}
	if join.ProtocolVersion != s.cfg.ProtocolVersion {
		s.cfg.Metrics.ProtocolMismatch(roomID)
		s.writeNow(ctx, conn, &pb.RoomEnvelope{
			RoomId: roomID,
			Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
				Code:                  "protocol_mismatch",
				Message:               "the client protocol version is not supported",
				ServerProtocolVersion: s.cfg.ProtocolVersion,
			}},
		})
		return
	}

	room, err := s.roomFor(ctx, roomID)
	if err != nil {
		code := "room_unavailable"
		message := "the room is unavailable"
		if errors.Is(err, ErrNotFound) {
			code = "room_not_found"
			message = "the room was not found"
		} else if errors.Is(err, ErrRoomTemplateConflict) {
			code = "room_template_conflict"
			message = "the room template binding conflicts with persisted state"
		} else {
			s.cfg.Logger.Error("open room failed", "room", roomID, "error", err)
		}
		s.writeNow(ctx, conn, &pb.RoomEnvelope{
			RoomId: roomID,
			Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
				Code: code, Message: message,
			}},
		})
		return
	}

	client := newClient(newClientID(), identity, sendQueueDepth)
	client.definitions = make(map[string]uint32, len(join.Definitions))
	for _, definition := range join.Definitions {
		client.definitions[definition.DefinitionId] = definition.Version
	}

	room.joins <- client
	reason := "closed"
	defer func() {
		room.departures <- departure{client: client, reason: reason}
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
				"room", roomID, "client", client.ID)
			continue
		}
		if envelope.GetJoin() != nil {
			s.writeNow(ctx, conn, &pb.RoomEnvelope{
				RoomId: roomID,
				Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
					Code:    "already_joined",
					Message: "the connection already joined the room",
				}},
			})
			continue
		}
		envelope.SenderClientId = client.ID

		select {
		case room.messages <- inbound{client: client, envelope: envelope, size: len(data)}:
		case <-ctx.Done():
			return
		default:
			// The room loop is behind. Dropping a realtime packet is correct;
			// the next keyframe repairs the client.
			s.cfg.Logger.Warn("room inbox full, dropped envelope", "room", roomID)
		}
	}
}

func (s *Server) readJoin(
	ctx context.Context,
	conn *websocket.Conn,
	roomID string,
) (*pb.Join, bool) {
	joinCtx, cancel := context.WithTimeout(ctx, joinTimeout)
	defer cancel()
	messageType, data, err := conn.Read(joinCtx)
	if err != nil {
		return nil, false
	}
	if messageType != websocket.MessageBinary {
		s.writeJoinError(ctx, conn, roomID, "join_required", "the first message must be JOIN")
		return nil, false
	}
	envelope := &pb.RoomEnvelope{}
	if err := proto.Unmarshal(data, envelope); err != nil {
		s.writeJoinError(ctx, conn, roomID, "malformed_join", "the JOIN envelope is malformed")
		return nil, false
	}
	join := envelope.GetJoin()
	if join == nil {
		s.writeJoinError(ctx, conn, roomID, "join_required", "the first message must be JOIN")
		return nil, false
	}
	if join.RoomId != roomID || (envelope.RoomId != "" && envelope.RoomId != roomID) {
		s.writeJoinError(ctx, conn, roomID, "room_mismatch", "JOIN names a different room")
		return nil, false
	}
	return join, true
}

func (s *Server) writeJoinError(
	ctx context.Context,
	conn *websocket.Conn,
	roomID string,
	code string,
	message string,
) {
	s.writeNow(ctx, conn, &pb.RoomEnvelope{
		RoomId: roomID,
		Payload: &pb.RoomEnvelope_Error{Error: &pb.ProtocolError{
			Code: code, Message: message,
		}},
	})
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
