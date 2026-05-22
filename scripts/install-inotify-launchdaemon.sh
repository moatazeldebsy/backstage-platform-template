#!/usr/bin/env bash
# Install a macOS LaunchDaemon that raises inotify sysctls inside the Docker
# Desktop VM whenever Docker starts. This makes the kube-proxy "too many open
# files" fix durable across Docker/macOS restarts — without it, the sysctls
# revert each time the Docker VM boots.
#
# How it works: the LaunchDaemon runs a runner script that waits for Docker
# to be reachable, then launches a privileged Alpine container with --pid=host
# to set the sysctls in the VM's shared kernel.
#
# Idempotent. Re-run to update the plist or runner script.

set -euo pipefail

LABEL="com.idp.docker-inotify-bump"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
RUNNER="/usr/local/bin/idp-docker-inotify-bump.sh"
LOG="/var/log/idp-docker-inotify-bump.log"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer only applies to macOS." >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo "$0" "$@"
fi

echo "Writing runner to ${RUNNER}..."
cat > "${RUNNER}" <<'RUNNER_EOF'
#!/bin/bash
# Wait for Docker, then bump inotify sysctls in the Docker Desktop VM kernel.
# Logs to /var/log/idp-docker-inotify-bump.log.
set -u
LOG=/var/log/idp-docker-inotify-bump.log
echo "[$(date)] starting" >>"$LOG"

DOCKER=/usr/local/bin/docker
[[ -x "$DOCKER" ]] || DOCKER=/opt/homebrew/bin/docker
[[ -x "$DOCKER" ]] || DOCKER=$(command -v docker || true)

if [[ -z "${DOCKER:-}" || ! -x "$DOCKER" ]]; then
  echo "[$(date)] docker not found on PATH; exiting" >>"$LOG"
  exit 0
fi

# Wait up to 5 minutes for Docker daemon to be reachable.
for i in $(seq 1 60); do
  if "$DOCKER" info >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "[$(date)] docker still not reachable after 5min; exiting" >>"$LOG"
  exit 0
fi

# Set sysctls inside the Docker VM kernel via a privileged container.
"$DOCKER" run --rm --privileged --pid=host alpine:3.20 sysctl -w \
  fs.inotify.max_user_instances=8192 \
  fs.inotify.max_user_watches=524288 \
  >>"$LOG" 2>&1
echo "[$(date)] done" >>"$LOG"
RUNNER_EOF
chmod 755 "${RUNNER}"

echo "Writing LaunchDaemon to ${PLIST}..."
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
PLIST_EOF
chown root:wheel "${PLIST}"
chmod 644 "${PLIST}"

# Reload so changes take effect.
launchctl bootout system "${PLIST}" 2>/dev/null || true
launchctl bootstrap system "${PLIST}"
launchctl kickstart -k "system/${LABEL}"

echo
echo "Installed. The daemon will re-apply sysctls on boot, when Docker starts,"
echo "and every 5 minutes thereafter."
echo "Logs: ${LOG}"
echo
echo "To uninstall:"
echo "  sudo launchctl bootout system ${PLIST}"
echo "  sudo rm ${PLIST} ${RUNNER}"
