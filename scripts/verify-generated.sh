#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @canvas-physics/protocol generate
bash server/scripts/generate.sh

git diff --exit-code -- \
  packages/protocol/src/gen/room.ts \
  server/gen/canvasphysicsv1/room.pb.go || {
  echo "Generated protocol bindings are stale. Run 'make generate' and commit the result." >&2
  exit 1
}
