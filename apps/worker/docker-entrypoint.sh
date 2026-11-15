#!/bin/sh
# The worker image's commands: `start` (the default) runs the job runner, `setup` readies the database for this
# version (bootstrap when DATABASE_ADMIN_URL is set, migrations, queues). Anything else runs as given.
set -e
# A certificate authority to trust beyond Node's own, as PEM text: a managed Postgres that signs with its own CA, on a
# platform with no file mounts. Node reads NODE_EXTRA_CA_CERTS when it starts, so the file is written first.
if [ -n "${OPENDASH_EXTRA_CA_CERTS:-}" ]; then
  printf '%s\n' "$OPENDASH_EXTRA_CA_CERTS" > /tmp/opendash-extra-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/opendash-extra-ca.pem
fi
case "$1" in
  start) exec node --import tsx src/index.ts ;;
  setup) exec node --import tsx scripts/setup.ts ;;
  *) exec "$@" ;;
esac
