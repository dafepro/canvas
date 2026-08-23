package roomsdktest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

func TestRunAuthenticatorConformance(t *testing.T) {
	auth := roomsdk.AuthenticatorFunc(func(_ context.Context, request *http.Request) (roomsdk.Identity, error) {
		if request.Header.Get("Authorization") != "room-ticket" {
			return roomsdk.Identity{}, roomsdk.ErrUnauthorized
		}
		return roomsdk.Identity{UserID: "participant-1", DisplayName: "Ada"}, nil
	})
	authorized := httptest.NewRequest(http.MethodGet, "https://host.test/realtime", nil)
	authorized.Header.Set("Authorization", "room-ticket")

	RunAuthenticatorConformance(t, auth, []AuthenticatorCase{
		{
			Name:         "valid ticket",
			Request:      authorized,
			WantIdentity: roomsdk.Identity{UserID: "participant-1", DisplayName: "Ada"},
		},
		{
			Name:         "missing ticket",
			Request:      httptest.NewRequest(http.MethodGet, "https://host.test/realtime", nil),
			Unauthorized: true,
		},
	})
}

func TestDevAuthenticatorConforms(t *testing.T) {
	authorized := httptest.NewRequest(http.MethodGet, "https://host.test/realtime", nil)
	authorized.Header.Set("X-User-Id", "dev-user")
	authorized.Header.Set("X-Display-Name", "Dev User")

	RunAuthenticatorConformance(t, roomsdk.DevAuthenticator(), []AuthenticatorCase{
		{
			Name:         "development headers",
			Request:      authorized,
			WantIdentity: roomsdk.Identity{UserID: "dev-user", DisplayName: "Dev User"},
		},
		{
			Name:         "missing identity",
			Request:      httptest.NewRequest(http.MethodGet, "https://host.test/realtime", nil),
			Unauthorized: true,
		},
	})
}
