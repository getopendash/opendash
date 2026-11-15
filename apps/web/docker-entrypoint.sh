#!/bin/sh
# The web image's start: the standalone server, given as the image's command.
set -e
# A certificate authority to trust beyond Node's own, as PEM text: a managed Postgres that signs with its own CA, on a
# platform with no file mounts. Node reads NODE_EXTRA_CA_CERTS when it starts, so the file is written first.
if [ -n "${OPENDASH_EXTRA_CA_CERTS:-}" ]; then
  printf '%s\n' "$OPENDASH_EXTRA_CA_CERTS" > /tmp/opendash-extra-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/opendash-extra-ca.pem
fi
exec "$@"
