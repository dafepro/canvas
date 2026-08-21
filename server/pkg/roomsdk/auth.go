package roomsdk

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

// ErrUnauthorized is returned when a connection carries no valid session.
var ErrUnauthorized = errors.New("roomsdk: unauthorized")

// Identity is the authenticated user behind one connection.
type Identity struct {
	UserID      string
	DisplayName string
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

// DevAuthenticator trusts the `user` query parameter or the `X-User-Id` header.
// Use it for local runs only. It refuses an empty user id.
func DevAuthenticator() Authenticator {
	return AuthenticatorFunc(func(_ context.Context, r *http.Request) (Identity, error) {
		userID := r.URL.Query().Get("user")
		if userID == "" {
			userID = r.Header.Get("X-User-Id")
		}
		userID = strings.TrimSpace(userID)
		if userID == "" {
			return Identity{}, ErrUnauthorized
		}
		name := r.URL.Query().Get("name")
		if name == "" {
			name = userID
		}
		return Identity{UserID: userID, DisplayName: name}, nil
	})
}
