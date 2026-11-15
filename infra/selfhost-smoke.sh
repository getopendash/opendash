#!/usr/bin/env bash
# The self-host smoke test (docs/operations/DEVELOPMENT.md, CI): the root docker-compose.yml with the caddy
# profile, on its own project, ports and generated settings, with no real keys. It checks that setup ran (and runs
# again cleanly), that the health route answers through Caddy over HTTPS and directly, that the sign-in page renders
# and the emails' logo is served, that pages may frame dashboards' host and a dashboard's frame opens there (and only
# there), that a sign-up email goes out over SMTP, that the worker started, and that the sample company was seeded and
# passes the app's own connection check; then it removes everything it made (containers, volumes, the settings file).
# Email goes to a Mailpit sink (infra/selfhost-smoke.compose.yml), which relays nothing; the email is checked by its
# subject and address, never opened, and its link is never printed. No model key. Prints no settings.
#   infra/selfhost-smoke.sh                    # builds the images
#   SMOKE_BUILD=0 infra/selfhost-smoke.sh      # uses OPENDASH_WEB_IMAGE / OPENDASH_WORKER_IMAGE (default *:local)
set -euo pipefail
cd "$(dirname "$0")/.."

project="${SMOKE_PROJECT:-opendash-selfhost-smoke}"
web_port="${SMOKE_WEB_PORT:-3391}"
https_port="${SMOKE_HTTPS_PORT:-8443}"
http_port="${SMOKE_HTTP_PORT:-8480}"
export SMOKE_MAILPIT_PORT="${SMOKE_MAILPIT_PORT:-8725}"
env_file="$(mktemp)"
demo_password="$(openssl rand -hex 24)"
chmod 600 "$env_file"

compose() {
  docker compose -p "$project" -f docker-compose.yml -f infra/selfhost-smoke.compose.yml --env-file "$env_file" \
    --profile caddy "$@"
}
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $1"
  compose ps -a || true
  compose logs --no-color --tail 40 setup web worker caddy || true
  exit 1
}
hex() { openssl rand -hex 24; }

{
  echo "POSTGRES_PASSWORD=$(hex)"
  for role in OWNER APP SYSTEM AUTH QUEUE; do echo "OPENDASH_DB_${role}_PASSWORD=$(hex)"; done
  echo "OPENDASH_KEK=$(openssl rand -base64 32)"
  echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
  echo "BETTER_AUTH_URL=https://localhost:${https_port}"
  echo "BETTER_AUTH_TRUSTED_ORIGINS=https://localhost:${https_port}"
  echo "OPENDASH_FRAMES_URL=https://frames.localhost:${https_port}"
  echo "EMAIL_FROM=OpenDash <smoke@opendash.test>"
  echo "SMTP_URL=smtp://mailpit:1025?requireTLS=false"
  echo "OPENDASH_SEED_DEMO=true"
  echo "OPENDASH_DEMO_READER_PASSWORD=${demo_password}"
  echo "OPENDASH_DOMAIN=localhost"
  echo "OPENDASH_PROXY_BIND=127.0.0.1"
  echo "OPENDASH_PORT=${web_port}"
  echo "OPENDASH_HTTPS_PORT=${https_port}"
  echo "OPENDASH_HTTP_PORT=${http_port}"
  if [ -n "${OPENDASH_WEB_IMAGE:-}" ]; then echo "OPENDASH_WEB_IMAGE=${OPENDASH_WEB_IMAGE}"; fi
  if [ -n "${OPENDASH_WORKER_IMAGE:-}" ]; then echo "OPENDASH_WORKER_IMAGE=${OPENDASH_WORKER_IMAGE}"; fi
} > "$env_file"

if [ "${SMOKE_BUILD:-1}" = 1 ]; then compose up -d --build; else compose up -d --no-build; fi

echo "waiting for the web app through Caddy…"
healthy=0
for _ in $(seq 1 90); do
  if curl -fsk "https://localhost:${https_port}/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" = 1 ] || fail "the health route never answered through Caddy"

setup_id="$(compose ps -aq setup)"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$setup_id")" = 0 ] || fail "setup didn't exit 0"
setup_log="$(compose logs --no-color setup)"
grep -q "setup: migrations applied" <<<"$setup_log" || fail "setup didn't apply migrations"
grep -q "setup: queues installed" <<<"$setup_log" || fail "setup didn't install the queues"
grep -q "setup: sample company seeded" <<<"$setup_log" || fail "setup didn't seed the sample company"
echo "ok: setup bootstrapped, migrated, installed the queues and seeded the sample company"

# Bodies captured first: with pipefail, `curl | grep -q` fails when grep stops reading early.
body="$(curl -fsk "https://localhost:${https_port}/api/health")" || fail "health didn't answer through Caddy"
grep -q '"ok":true' <<<"$body" || fail "health isn't ok through Caddy"
body="$(curl -fs "http://127.0.0.1:${web_port}/api/health")" || fail "health didn't answer on the web port"
grep -q '"ok":true' <<<"$body" || fail "health isn't ok on the web port"
echo "ok: health through Caddy (HTTPS) and on the web port"

code="$(curl -sk -o /dev/null -w '%{http_code}' "http://localhost:${http_port}/sign-in")"
[ "$code" = 308 ] || [ "$code" = 301 ] || [ "$code" = 302 ] || fail "plain HTTP wasn't redirected to HTTPS (got $code)"
body="$(curl -fsk "https://localhost:${https_port}/sign-in")" || fail "the sign-in page didn't answer"
grep -qi "sign in" <<<"$body" || fail "the sign-in page didn't render"
echo "ok: HTTP redirects to HTTPS; the sign-in page renders"

# The logo every email shows comes from the web app's public folder, which the image has to carry.
type="$(curl -fsk -o /dev/null -w '%{content_type}' "https://localhost:${https_port}/email/opendash-logo@2x.png")" ||
  fail "the emails' logo isn't served"
[ "$type" = image/png ] || fail "the emails' logo isn't a PNG (got $type)"
echo "ok: the emails' logo is served"

# Dashboards are drawn on their own host: every page may frame it, and a frame link signed as the app signs one opens
# there, served by Caddy for frames.localhost, and nowhere else.
frames="https://frames.localhost:${https_port}"
resolve=(--resolve "frames.localhost:${https_port}:127.0.0.1")
policy="$(curl -fsk -D - -o /dev/null "https://localhost:${https_port}/sign-in" | grep -i '^content-security-policy:')" ||
  fail "the sign-in page sent no content policy"
grep -q "frame-src ${frames}" <<<"$policy" || fail "pages may not frame dashboards' host ($policy)"
token="$(compose exec -T worker node --import tsx --input-type=module -e '
  const { dashboards } = await import("/app/packages/core/src/index.ts");
  console.log(dashboards.signFrameToken(process.env.BETTER_AUTH_SECRET, { bundleHash: null, title: "Smoke" }));
')" || fail "a frame link couldn't be signed"
frame="$(curl -fsk "${resolve[@]}" -D - "${frames}/app-frame/f/${token}")" || fail "the frame didn't open on its host"
grep -qi "frame-ancestors https://localhost:${https_port}" <<<"$frame" || fail "the frame may be shown by other sites"
runtime="$(grep -o '/app-frame/r/[0-9a-f]*/runtime.js' <<<"$frame" | head -1)"
[ -n "$runtime" ] || fail "the frame document has no runtime"
type="$(curl -fsk "${resolve[@]}" -o /dev/null -w '%{content_type}' "${frames}${runtime}")" ||
  fail "the frame's runtime isn't served on its host"
grep -q javascript <<<"$type" || fail "the frame's runtime isn't JavaScript (got $type)"
code="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:${https_port}/app-frame/f/${token}")"
[ "$code" = 404 ] || fail "a frame opened on the app's own host (got $code)"
echo "ok: pages frame dashboards' host, and a frame opens there and only there"

# A sign-up, as the form sends it. `.internal` is never delivered on the internet; here it reaches only Mailpit.
code="$(curl -sk -o /dev/null -w '%{http_code}' -X POST "https://localhost:${https_port}/api/auth/sign-in/magic-link" \
  -H 'content-type: application/json' -H "origin: https://localhost:${https_port}" \
  -d '{"email":"smoke@opendash.internal","name":"Smoke Check","callbackURL":"/","newUserCallbackURL":"/welcome"}')"
[ "$code" = 200 ] || fail "the sign-up request was refused (got $code)"
arrived=0
for _ in $(seq 1 20); do
  inbox="$(curl -fs "http://127.0.0.1:${SMOKE_MAILPIT_PORT}/api/v1/messages" || true)"
  if grep -q "smoke@opendash.internal" <<<"$inbox" && grep -q "Confirm your email for OpenDash" <<<"$inbox"; then
    arrived=1
    break
  fi
  sleep 1
done
[ "$arrived" = 1 ] || fail "the sign-up email didn't arrive over SMTP"
echo "ok: the sign-up email went out over SMTP"

[ "$(docker inspect -f '{{.State.Running}}' "$(compose ps -q worker)")" = true ] || fail "the worker isn't running"
ready=0
for _ in $(seq 1 30); do
  if grep -q "worker ready" <<<"$(compose logs --no-color worker)"; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || fail "the worker never said it was ready"
echo "ok: the worker is running with its pools"

# The app's own connection check (the one Data → Connect source runs), from the worker, against the sample.
probe="$(compose exec -T -e DEMO_PASSWORD="$demo_password" worker node --import tsx --input-type=module -e '
  const { dialectFor } = await import("/app/packages/connectors/src/index.ts");
  const r = await dialectFor("postgres").probe(
    { host: "postgres", port: 5432, database: "opendash_demo", user: "opendash_demo_reader", sslMode: "disable" },
    process.env.DEMO_PASSWORD,
    { edition: "community", connectTimeoutMs: 5000, statementTimeoutMs: 10000 },
  );
  console.log(`outcome=${r.outcome}`);
')" || fail "the connection check didn't run"
grep -q "outcome=passed" <<<"$probe" || fail "the sample company didn't pass the connection check ($probe)"
echo "ok: the sample company passes the app's connection check"

second="$(compose run --rm --no-deps setup 2>&1)" || fail "a second setup failed"
grep -q "setup: the sample company is already there" <<<"$second" || fail "a second setup re-seeded the sample company"
echo "ok: setup runs again cleanly, and leaves the sample company alone"
echo "PASS"
