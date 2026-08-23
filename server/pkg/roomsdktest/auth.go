// Package roomsdktest provides conformance suites for host-owned roomsdk ports.
package roomsdktest

import (
	"errors"
	"net/http"
	"testing"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

// AuthenticatorCase describes one request the consumer's authenticator must
// either resolve to an exact stable identity or reject as unauthorized.
type AuthenticatorCase struct {
	Name         string
	Request      *http.Request
	WantIdentity roomsdk.Identity
	Unauthorized bool
}

// RunAuthenticatorConformance exercises a host Authenticator using Go's
// standard testing package, so an external host can call it from its own tests.
// A useful suite must prove at least one accepted and one rejected request.
func RunAuthenticatorConformance(
	t *testing.T,
	auth roomsdk.Authenticator,
	cases []AuthenticatorCase,
) {
	t.Helper()
	if auth == nil {
		t.Fatal("roomsdktest: authenticator is required")
	}
	accepted := 0
	rejected := 0
	for i, testCase := range cases {
		name := testCase.Name
		if name == "" {
			name = "case"
		}
		t.Run(name, func(t *testing.T) {
			if testCase.Request == nil {
				t.Fatalf("case %d: request is required", i)
			}
			identity, err := auth.Authenticate(t.Context(), testCase.Request.Clone(t.Context()))
			if testCase.Unauthorized {
				if !errors.Is(err, roomsdk.ErrUnauthorized) {
					t.Fatalf("Authenticate error = %v, want roomsdk.ErrUnauthorized", err)
				}
				if identity != (roomsdk.Identity{}) {
					t.Fatalf("unauthorized identity = %#v, want zero value", identity)
				}
				return
			}
			if err != nil {
				t.Fatalf("Authenticate returned unexpected error: %v", err)
			}
			if identity.UserID == "" || identity.DisplayName == "" {
				t.Fatalf("authenticated identity must contain user and display names: %#v", identity)
			}
			if identity != testCase.WantIdentity {
				t.Fatalf("identity = %#v, want %#v", identity, testCase.WantIdentity)
			}
		})
		if testCase.Unauthorized {
			rejected++
		} else {
			accepted++
		}
	}
	if accepted == 0 {
		t.Error("roomsdktest: at least one accepted authentication case is required")
	}
	if rejected == 0 {
		t.Error("roomsdktest: at least one unauthorized authentication case is required")
	}
}
