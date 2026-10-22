#!/usr/bin/env bash
set -euo pipefail

base_url="${SMOKE_BASE_URL:-http://127.0.0.1:${PORT:-3000}}"
response="$(curl --fail --silent --show-error "${base_url}/health/live")"

if [[ "$response" != '{"status":"ok"}' ]]; then
  printf 'Unexpected liveness response: %s\n' "$response" >&2
  exit 1
fi

printf 'PASS GET %s/health/live %s\n' "$base_url" "$response"
