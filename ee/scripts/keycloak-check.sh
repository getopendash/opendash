#!/bin/sh
# Single sign-on against a real identity provider (ee/test/keycloak.test.ts): a throwaway Keycloak in Docker on
# 127.0.0.1:${KEYCLOAK_PORT:-8792}, development mode, removed afterwards. Needs Docker and the test database.
set -eu
PORT="${KEYCLOAK_PORT:-8792}"
NAME="opendash-keycloak-check-$$"
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.0.7 start-dev >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
echo "Waiting for Keycloak on $PORT"
i=0
until curl -sf "http://127.0.0.1:$PORT/realms/master" >/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo "Keycloak didn't start"; exit 1; fi
  sleep 1
done
OPENDASH_KEYCLOAK_URL="http://127.0.0.1:$PORT" pnpm exec vitest run test/keycloak.test.ts
