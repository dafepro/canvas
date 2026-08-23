package roomsdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// ErrUnauthorized is returned when a connection carries no valid session.
var ErrUnauthorized = errors.New("roomsdk: unauthorized")

// Identity is the authenticated user behind one connection.
type Identity struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
}

// Authenticator turns an HTTP request into an Identity. The host application
// supplies its own so the SDK never owns the session format.
type Authenticator interface {
	Authenticate(ctx context.Context, r *http.Request) (Identity, error)
}

// AuthenticatorFunc adapts a function to the Authenticator interface.
type AuthenticatorFunc func(ctx context.Context, r *http.Request) (Identity, error)

func (f AuthenticatorFunc) Authenticate(ctx context.Context, r *http.Request) (Identity, error) {
	return f(ctx, r)
}

// DevAuthenticator trusts a canvas-dev WebSocket subprotocol credential or the
// X-User-Id header. Use it for local runs only. It refuses an empty user id.
func DevAuthenticator() Authenticator {
	return AuthenticatorFunc(func(_ context.Context, r *http.Request) (Identity, error) {
		identity := Identity{
			UserID:      strings.TrimSpace(r.Header.Get("X-User-Id")),
			DisplayName: strings.TrimSpace(r.Header.Get("X-Display-Name")),
		}
		for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			encoded, ok := strings.CutPrefix(strings.TrimSpace(protocol), "canvas-dev.")
			if !ok {
				continue
			}
			raw, err := base64.RawURLEncoding.DecodeString(encoded)
			if err != nil || json.Unmarshal(raw, &identity) != nil {
				return Identity{}, ErrUnauthorized
			}
			break
		}
		identity.UserID = strings.TrimSpace(identity.UserID)
		identity.DisplayName = strings.TrimSpace(identity.DisplayName)
		if identity.UserID == "" {
			return Identity{}, ErrUnauthorized
		}
		if identity.DisplayName == "" {
			identity.DisplayName = identity.UserID
		}
		return identity, nil
	})
}
