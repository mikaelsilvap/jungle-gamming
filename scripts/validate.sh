#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

required_bun_version="1.4.3"
actual_bun_version="$(bun --version)"
if [[ "$actual_bun_version" != "$required_bun_version" ]]; then
  printf 'Bun %s is required; found %s\n' "$required_bun_version" "$actual_bun_version" >&2
  exit 1
fi

project_suffix="${BASHPID}-$(date +%s)"
project_name="jungle-validate-${project_suffix}"
postgres_port="${VALIDATION_POSTGRES_PORT:-25432}"
localstack_port="${VALIDATION_LOCALSTACK_PORT:-24566}"
api_port="${VALIDATION_API_PORT:-23000}"
compose=(docker compose --project-name "$project_name" --file "$root_dir/docker-compose.yml")

export POSTGRES_DB="wagering"
export POSTGRES_USER="wagering_app"
export POSTGRES_PASSWORD="${VALIDATION_POSTGRES_PASSWORD:-validation_only_change_me}"
export POSTGRES_PORT="$postgres_port"
export LOCALSTACK_PORT="$localstack_port"
export API_HOST_PORT="$api_port"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="test"
export AWS_SECRET_ACCESS_KEY="test"

cleanup() {
  if [[ "${KEEP_VALIDATION_STACK:-false}" == "true" ]]; then
    printf 'Validation stack retained as Compose project %s.\n' "$project_name"
  else
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    printf 'Removed disposable Compose project %s and its volume.\n' "$project_name"
  fi
}
trap cleanup EXIT

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
export TEST_DATABASE_NAME="wagering_phase2_test"
export SQS_ENDPOINT="http://127.0.0.1:${LOCALSTACK_PORT}"
export SQS_COMMAND_QUEUE_URL="${SQS_ENDPOINT}/000000000000/wager-transactions.fifo"
export SQS_DLQ_QUEUE_URL="${SQS_ENDPOINT}/000000000000/wager-transactions-dlq.fifo"
export SQS_EVENTS_QUEUE_URL="${SQS_ENDPOINT}/000000000000/wager-events.fifo"

printf '\n== Frozen install, typecheck, and build ==\n'
bun install --frozen-lockfile
bun run typecheck
bun run build

printf '\n== Start isolated PostgreSQL and LocalStack ==\n'
"${compose[@]}" up -d --wait postgres localstack
"${compose[@]}" exec -T postgres createdb -U "$POSTGRES_USER" "$TEST_DATABASE_NAME"

printf '\n== Apply clean runtime migrations ==\n'
bun run db:migrate

printf '\n== Build and start API and workers ==\n'
"${compose[@]}" up -d --build --wait
"${compose[@]}" ps

printf '\n== PostgreSQL and LocalStack integration suite ==\n'
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${TEST_DATABASE_NAME}" bun test

printf '\n== API health smoke ==\n'
SMOKE_BASE_URL="http://127.0.0.1:${API_PORT:-$api_port}" bun run smoke
curl --fail --silent --show-error "http://127.0.0.1:${API_PORT:-$api_port}/health/ready"
printf '\n'

printf '\n== HTTP, SQS consumer, and outbox end-to-end smoke ==\n'
bun run scripts/e2e-smoke.ts

wait_for_http_status() {
  local url="$1" expected="$2" label="$3"
  local attempt actual
  for attempt in $(seq 1 40); do
    actual="$(curl --silent --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [[ "$actual" == "$expected" ]]; then
      printf 'PASS %s returned HTTP %s.\n' "$label" "$expected"
      return 0
    fi
    sleep 0.5
  done
  printf 'FAIL %s expected HTTP %s, last received %s.\n' "$label" "$expected" "${actual:-no response}" >&2
  return 1
}

printf '\n== Real PostgreSQL outage and recovery ==\n'
"${compose[@]}" stop postgres >/dev/null
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/live" 200 'API liveness with PostgreSQL stopped'
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/ready" 503 'API readiness with PostgreSQL stopped'
"${compose[@]}" start postgres >/dev/null
"${compose[@]}" up -d --wait postgres >/dev/null
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/ready" 200 'API readiness after PostgreSQL recovery'

printf '\n== Real LocalStack outage and recovery ==\n'
"${compose[@]}" stop localstack >/dev/null
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/live" 200 'API liveness with LocalStack stopped'
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/ready" 503 'API readiness with LocalStack stopped'
"${compose[@]}" start localstack >/dev/null
"${compose[@]}" up -d --wait localstack >/dev/null
wait_for_http_status "http://127.0.0.1:${API_HOST_PORT}/health/ready" 200 'API readiness after LocalStack recovery'

printf '\n== Final health and Compose status ==\n'
"${compose[@]}" ps
printf 'PASS: isolated clean-room validation completed.\n'
