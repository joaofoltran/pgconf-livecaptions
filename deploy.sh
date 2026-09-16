#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
cd "$ROOT"

info() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Read a dotenv value as data. Never source .env: provider JSON and secrets must
# not be interpreted as shell code.
env_get() {
  local key="$1"
  local value
  value="$(
    awk -v key="$key" '
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
        line = $0
        sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
        sub(/\r$/, "", line)
        print line
        exit
      }
    ' "$ENV_FILE"
  )"
  value="$(trim "$value")"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

env_upsert() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

random_secret() {
  openssl rand -hex 24
}

token_var_name() {
  printf 'TOKEN_%s' "$(
    printf '%s' "$1" |
      tr '[:lower:]' '[:upper:]' |
      sed -E 's/[^A-Z0-9]+/_/g'
  )"
}

if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Created .env from .env.example."
fi

chmod 600 "$ENV_FILE"
require_command openssl "Install OpenSSL and run ./deploy.sh again."

rooms="$(env_get ROOMS)"
rooms="${rooms:-room-1,room-2,room-3,room-4}"

admin_password="$(env_get ADMIN_PASSWORD)"
if [[ -z "$admin_password" || "$admin_password" == "change-me" ]]; then
  env_upsert ADMIN_PASSWORD "$(random_secret)"
  info "Generated ADMIN_PASSWORD in .env."
fi

session_secret="$(env_get SESSION_SECRET)"
if [[ -z "$session_secret" ]]; then
  env_upsert SESSION_SECRET "$(random_secret)"
  info "Generated SESSION_SECRET in .env."
fi

IFS=',' read -r -a room_list <<< "$rooms"
normalized_rooms=()
for raw_room in "${room_list[@]}"; do
  room="$(trim "$raw_room")"
  [[ -z "$room" ]] && continue
  normalized_rooms+=("$room")
  token_var="$(token_var_name "$room")"
  if [[ -z "$(env_get "$token_var")" ]]; then
    env_upsert "$token_var" "$(random_secret)"
    info "Generated $token_var in .env."
  fi
done

[[ ${#normalized_rooms[@]} -gt 0 ]] || fail "ROOMS must contain at least one room slug."

domain="$(env_get DOMAIN)"
deepgram_key="$(env_get DEEPGRAM_API_KEY)"
openai_key="$(env_get OPENAI_API_KEY)"
admin_password="$(env_get ADMIN_PASSWORD)"
session_secret="$(env_get SESSION_SECRET)"

[[ -n "$domain" ]] || fail "Set DOMAIN in .env."
[[ "$domain" != "captions.example.com" ]] || fail "Replace the DOMAIN placeholder in .env."
[[ ${#domain} -le 253 &&
  "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]] ||
  fail "DOMAIN must be a bare hostname such as captions.example.com."
[[ -n "$deepgram_key" ]] || fail "Set DEEPGRAM_API_KEY in .env."
[[ -n "$openai_key" ]] || fail "Set OPENAI_API_KEY in .env."
[[ ${#admin_password} -ge 16 ]] || fail "ADMIN_PASSWORD must be at least 16 characters."
[[ ${#session_secret} -ge 32 ]] || fail "SESSION_SECRET must be at least 32 characters."

for room in "${normalized_rooms[@]}"; do
  [[ ${#room} -le 64 && "$room" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    fail "Invalid room slug '$room'. Separate lowercase words or numbers with single hyphens."
  token_var="$(token_var_name "$room")"
  token="$(env_get "$token_var")"
  [[ ${#token} -ge 16 ]] || fail "$token_var must be at least 16 characters."
done

require_command docker \
  "Install Docker Engine and the Docker Compose v2 plugin, then run ./deploy.sh again."
docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose v2 is unavailable. Install the docker compose plugin."

info "Validating Docker Compose configuration."
docker compose config --quiet

info "Pulling current base and proxy images."
docker compose pull caddy

info "Building the application image."
docker compose build --pull app

info "Checking application configuration before replacing the running service."
docker compose run --rm --no-deps app node dist/check-config.js

info "Starting the stack."
docker compose up -d

container_id="$(docker compose ps -q app)"
[[ -n "$container_id" ]] || fail "The app container was not created."

info "Waiting for the app health check."
state=""
health=""
for _ in {1..60}; do
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  health="$(
    docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container_id" 2>/dev/null || true
  )"
  case "$state" in
    restarting | exited | dead)
      docker compose logs --tail 100 app >&2 || true
      fail "The app container entered state $state."
      ;;
  esac
  case "$health" in
    healthy)
      break
      ;;
    unhealthy | exited | dead)
      docker compose logs --tail 100 app >&2 || true
      fail "The app container became $health."
      ;;
  esac
  sleep 2
done

if [[ "$health" != "healthy" ]]; then
  docker compose logs --tail 100 app >&2 || true
  fail "The app did not become healthy within 120 seconds."
fi

caddy_id="$(docker compose ps -q caddy)"
[[ -n "$caddy_id" ]] || fail "The Caddy container was not created."
for _ in {1..10}; do
  caddy_state="$(docker inspect --format '{{.State.Status}}' "$caddy_id" 2>/dev/null || true)"
  [[ "$caddy_state" == "running" ]] && break
  [[ "$caddy_state" == "exited" || "$caddy_state" == "dead" ]] && break
  sleep 1
done
if [[ "${caddy_state:-}" != "running" ]]; then
  docker compose logs --tail 100 caddy >&2 || true
  fail "Caddy is not running."
fi

public_health="not checked"
if command -v curl >/dev/null 2>&1 && [[ "$domain" != "localhost" ]]; then
  info "Checking the public HTTPS health endpoint."
  public_health="unreachable"
  for _ in {1..10}; do
    if curl -fsS --max-time 5 "https://$domain/health" >/dev/null 2>&1; then
      public_health="healthy"
      break
    fi
    sleep 3
  done
fi

printf '\nApplication and proxy containers are healthy.\n'
if [[ "$public_health" == "healthy" ]]; then
  printf 'Public HTTPS health check passed.\n'
elif [[ "$public_health" == "unreachable" ]]; then
  printf 'Warning: https://%s/health is not reachable yet. Check DNS, firewall, and Caddy logs.\n' "$domain"
fi
printf '\n'
printf 'Capture pages (Chrome):\n'
for room in "${normalized_rooms[@]}"; do
  token_var="$(token_var_name "$room")"
  printf '  https://%s/r/%s?k=%s\n' "$domain" "$room" "$(env_get "$token_var")"
done

printf '\nOverlays (OBS Browser Source, 1920x1080):\n'
for room in "${normalized_rooms[@]}"; do
  token_var="$(token_var_name "$room")"
  printf '  https://%s/r/%s/overlay?k=%s\n' "$domain" "$room" "$(env_get "$token_var")"
done

printf '\nAdmin:\n  https://%s/admin\n' "$domain"
printf '\nThe generated admin password is stored in .env (mode 600).\n'
printf 'Treat every printed room URL as a bearer credential.\n'
