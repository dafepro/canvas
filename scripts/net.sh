#!/usr/bin/env bash
# Controls the Toxiproxy network emulator in front of canvasd.
#
# Usage:
#   scripts/net.sh status
#   scripts/net.sh clear
#   scripts/net.sh latency <ms> [jitter_ms]
#   scripts/net.sh bandwidth <kbps>
#   scripts/net.sh slowclose <ms>
#   scripts/net.sh timeout <ms>            # 0 means never respond
#   scripts/net.sh drop                    # cut the connection now
#   scripts/net.sh restore
#   scripts/net.sh preset <good|3g|bad|lossy>
set -euo pipefail

API="${TOXIPROXY_API:-http://localhost:8474}"
PROXY="${TOXIPROXY_PROXY:-canvasd}"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -fsS -X "${method}" "${API}${path}" -H 'Content-Type: application/json' -d "${body}"
  else
    curl -fsS -X "${method}" "${API}${path}"
  fi
}

pretty() {
  if command -v jq >/dev/null; then jq .; else cat; fi
}

add_toxic() {
  local name="$1" type="$2" stream="$3" attributes="$4" toxicity="${5:-1.0}"
  api DELETE "/proxies/${PROXY}/toxics/${name}" >/dev/null 2>&1 || true
  api POST "/proxies/${PROXY}/toxics" \
    "{\"name\":\"${name}\",\"type\":\"${type}\",\"stream\":\"${stream}\",\"toxicity\":${toxicity},\"attributes\":${attributes}}" \
    >/dev/null
  echo "added ${name} (${type}, ${stream})"
}

clear_toxics() {
  local names
  names="$(api GET "/proxies/${PROXY}" | tr ',' '\n' | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | grep -v "^${PROXY}$" || true)"
  for name in ${names}; do
    api DELETE "/proxies/${PROXY}/toxics/${name}" >/dev/null 2>&1 || true
    echo "removed ${name}"
  done
  echo "no impairment is active"
}

command="${1:-status}"
case "${command}" in
  status)
    api GET "/proxies/${PROXY}" | pretty
    ;;
  clear)
    clear_toxics
    ;;
  latency)
    ms="${2:?latency in milliseconds is required}"
    jitter="${3:-0}"
    # Half the round trip on each stream.
    add_toxic "latency-down" latency downstream "{\"latency\":${ms},\"jitter\":${jitter}}"
    add_toxic "latency-up" latency upstream "{\"latency\":${ms},\"jitter\":${jitter}}"
    ;;
  bandwidth)
    kbps="${2:?bandwidth in kilobytes per second is required}"
    add_toxic "bandwidth-down" bandwidth downstream "{\"rate\":${kbps}}"
    add_toxic "bandwidth-up" bandwidth upstream "{\"rate\":${kbps}}"
    ;;
  slowclose)
    ms="${2:?delay in milliseconds is required}"
    add_toxic "slow-close" slow_close downstream "{\"delay\":${ms}}"
    ;;
  timeout)
    ms="${2:-0}"
    add_toxic "timeout" timeout downstream "{\"timeout\":${ms}}"
    ;;
  drop)
    # Disabling the proxy cuts every open connection, which is what a lost
    # backend connection looks like to the client.
    api POST "/proxies/${PROXY}" '{"enabled":false}' >/dev/null
    echo "proxy disabled: every connection is cut"
    ;;
  restore)
    api POST "/proxies/${PROXY}" '{"enabled":true}' >/dev/null
    echo "proxy enabled"
    ;;
  preset)
    case "${2:?preset name is required}" in
      good)
        clear_toxics
        "$0" latency 15 5
        ;;
      3g)
        clear_toxics
        "$0" latency 100 30
        "$0" bandwidth 96
        ;;
      bad)
        clear_toxics
        "$0" latency 200 80
        "$0" bandwidth 32
        ;;
      lossy)
        clear_toxics
        "$0" latency 60 20
        # A partial timeout drops a fraction of the traffic.
        add_toxic "partial-timeout" timeout downstream '{"timeout":0}' 0.05
        ;;
      *)
        echo "unknown preset: ${2}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    sed -n '2,20p' "$0"
    exit 1
    ;;
esac
