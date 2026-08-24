#!/usr/bin/env bash
# Generates the Go bindings from the shared .proto contract of record.
set -euo pipefail
cd "$(dirname "$0")/.."

PROTOC_GEN_GO_VERSION="v1.36.12"
export PATH="$(go env GOPATH)/bin:${PATH}"
if ! command -v protoc-gen-go >/dev/null || \
  [[ "$(protoc-gen-go --version)" != "protoc-gen-go ${PROTOC_GEN_GO_VERSION}" ]]; then
  echo "installing protoc-gen-go ${PROTOC_GEN_GO_VERSION}" >&2
  go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
fi

protoc \
  --go_out=gen \
  --go_opt=module=github.com/dafepro/canvas/server/gen \
  --proto_path=../packages/protocol/proto \
  ../packages/protocol/proto/room.proto

echo "generated gen/canvasphysicsv1/room.pb.go"
