#!/usr/bin/env bash
# Generates the Go bindings from the shared .proto contract of record.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v protoc-gen-go >/dev/null; then
  echo "installing protoc-gen-go" >&2
  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
fi
export PATH="$(go env GOPATH)/bin:${PATH}"

protoc \
  --go_out=gen \
  --go_opt=module=github.com/dafepro/canvas/server/gen \
  --proto_path=../packages/protocol/proto \
  ../packages/protocol/proto/room.proto

echo "generated gen/canvasphysicsv1/room.pb.go"
