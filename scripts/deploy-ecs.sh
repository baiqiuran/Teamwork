#!/usr/bin/env bash
# Dedicated simple SSH/SCP release for 120.25.176.6; not the managed production host.
set -Eeuo pipefail
umask 027
export PATH=/usr/local/bin:/usr/bin:/bin
ROOT=/bim/new-chat
UNIT=new-chat.service
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm
ARCHIVE=${1:?Usage: deploy-ecs.sh /tmp/new-chat-upload.XXXXXXXX/application.tar.gz}
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ $ARCHIVE =~ ^/tmp/new-chat-upload\.[a-zA-Z0-9]+/application\.tar\.gz$ && -f $ARCHIVE ]]
for command in tar curl flock runuser systemctl; do command -v "$command" >/dev/null; done
[[ -x $NODE && -x $NPM && -f /etc/new-chat/new-chat.env ]]
id new-chat >/dev/null
[[ $(systemctl show "$UNIT" -p LoadState --value) == loaded ]]
[[ $(systemctl show "$UNIT" -p WorkingDirectory --value) == "$ROOT/current" ]]
[[ $(systemctl show "$UNIT" -p User --value) == new-chat ]]
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<15)process.exit(1)'
install -d -m 755 "$ROOT" "$ROOT/releases"
install -d -m 700 "$ROOT/snapshots"
install -d -o new-chat -g new-chat -m 750 "$ROOT/data"
exec 9>"$ROOT/release.lock"
flock -n 9 || { echo 'Another release is running.' >&2; exit 1; }
# A failed start may have migrated the database; require manual inspection before retry.
[[ ! -e $ROOT/NEEDS_ATTENTION ]] || { echo "Inspect $ROOT/NEEDS_ATTENTION before another release." >&2; exit 1; }
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
RELEASE="$ROOT/releases/$ID"
SNAPSHOT="$ROOT/snapshots/$ID"
STOPPED=0
on_error() {
  result=$?
  trap - ERR HUP INT TERM
  if [[ $STOPPED == 1 ]]; then
    systemctl stop "$UNIT" || true
    printf 'Release %s failed. Inspect data and snapshot %s before restarting.\n' "$ID" "$SNAPSHOT" >"$ROOT/NEEDS_ATTENTION"
  fi
  echo "Release failed; files retained. Logs: journalctl -u $UNIT -n 100" >&2
  exit "$result"
}
trap on_error ERR
trap 'false' HUP INT TERM

# Install Linux runtime dependencies in an isolated release, before stopping the app.
install -d -o new-chat -g new-chat -m 750 "$RELEASE"
install -o new-chat -g new-chat -m 640 "$ARCHIVE" "$RELEASE/application.tar.gz"
runuser -u new-chat -- tar -xzf "$RELEASE/application.tar.gz" -C "$RELEASE" --no-same-owner
[[ -f $RELEASE/build/server/main.js && -f $RELEASE/dist/index.html ]]
runuser -u new-chat -- "$NPM" ci --prefix "$RELEASE" --omit=dev --ignore-scripts --no-bin-links --cache "$RELEASE/.npm-cache"
# The application needs write access only to the persistent data directory.
chown -R root:new-chat "$RELEASE"
chmod -R g+rX,o-rwx "$RELEASE"

# Stop before copying SQLite, WAL/SHM and attachments together.
STOPPED=1
systemctl stop "$UNIT"
[[ $(systemctl show "$UNIT" -p MainPID --value) == 0 ]]
install -d -m 700 "$SNAPSHOT"
cp -a "$ROOT/data" "$SNAPSHOT/data"
cp -a /etc/new-chat "$SNAPSHOT/config"
systemctl cat "$UNIT" >"$SNAPSHOT/service.txt"
"$NODE" --version >"$SNAPSHOT/node-version.txt"
if [[ -L $ROOT/current ]]; then
  PREVIOUS=$(readlink -f "$ROOT/current")
  [[ $PREVIOUS == "$ROOT/releases/"* && -d $PREVIOUS ]]
  printf '%s\n' "$PREVIOUS" >"$SNAPSHOT/previous-release.txt"
elif [[ -e $ROOT/current ]]; then
  echo "$ROOT/current must be a symlink, not an existing directory." >&2
  false
fi
ln -s "$RELEASE" "$ROOT/current.$ID"
mv -Tf "$ROOT/current.$ID" "$ROOT/current"
systemctl start "$UNIT"
READY=0
for attempt in {1..30}; do
  if systemctl is-active --quiet "$UNIT" && curl --fail --silent --max-time 2 http://127.0.0.1:4312/health/ready >"$RELEASE/health.json"; then
    READY=1
    break
  fi
  sleep 1
done
[[ $READY == 1 ]]
STOPPED=0
printf 'Release: %s\nSnapshot: %s\n' "$RELEASE" "$SNAPSHOT"
echo 'Service ready on 127.0.0.1:4312. Configure HTTPS proxy for public access.'
