#!/bin/sh
# Install root:root 0755. The SSH account can invoke only this wrapper via sudo.
set -eu
[ "$#" -eq 1 ] || exit 64
exec /usr/local/bin/node /opt/daily-flow/control/ops/gateway.mjs --config /etc/daily-flow/deploy.json --command "$1"
