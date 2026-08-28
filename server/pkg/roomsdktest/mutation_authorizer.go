package roomsdktest

import (
	"testing"

	"github.com/dafepro/canvas/server/pkg/roomsdk"
)

// MutationAuthorizerConformanceFixture supplies opaque product permits for the
// security bindings Canvas cannot interpret itself. Approved is evaluated
// first so Replayed can exercise one-use reservation behavior.
type MutationAuthorizerConformanceFixture struct {
	Authorizer       roomsdk.MutationAuthorizer
	Approved         roomsdk.MutationAuthorizationRequest
	Denied           roomsdk.MutationAuthorizationRequest
	Expired          roomsdk.MutationAuthorizationRequest
	WrongRoom        roomsdk.MutationAuthorizationRequest
	WrongParticipant roomsdk.MutationAuthorizationRequest
	Replayed         roomsdk.MutationAuthorizationRequest
}

// RunMutationAuthorizerConformance proves that an application authorizer binds
// opaque evidence to the policy dimensions needed for one-use permits.
func RunMutationAuthorizerConformance(t *testing.T, fixture MutationAuthorizerConformanceFixture) {
	t.Helper()
	if fixture.Authorizer == nil {
		t.Fatal("roomsdktest: mutation authorizer is required")
	}
	tests := []struct {
		name       string
		request    roomsdk.MutationAuthorizationRequest
		authorized bool
	}{
		{name: "approved", request: fixture.Approved, authorized: true},
		{name: "denied", request: fixture.Denied},
		{name: "expired", request: fixture.Expired},
		{name: "wrong room", request: fixture.WrongRoom},
		{name: "wrong participant", request: fixture.WrongParticipant},
		{name: "replayed", request: fixture.Replayed},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := testCase.request
			if request.Participant.UserID == "" || request.RoomID == "" ||
				request.Kind == "" || request.Idempotency.Key == "" ||
				len(request.AuthorizationEvidence) == 0 {
				t.Fatalf("incomplete authorization request: %#v", request)
			}
			decision, err := fixture.Authorizer.AuthorizeMutation(t.Context(), request)
			if err != nil {
				t.Fatalf("AuthorizeMutation returned infrastructure error: %v", err)
			}
			if decision.Authorized != testCase.authorized {
				t.Fatalf("Authorized = %v, want %v (reason %q)",
					decision.Authorized, testCase.authorized, decision.Reason)
			}
		})
	}
}
