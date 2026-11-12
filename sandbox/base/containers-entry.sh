#!/bin/sh
# `sandbox.containers`: runs the session's command with a rootless Podman behind DOCKER_HOST (Testcontainers,
# docker compose). The host uid has no subordinate ids here: it gets the container's other ids. Runs after
# home-entry.sh, which gave the uid its passwd entry.
uid=$(id -u); gid=$(id -g)
name=$(getent passwd "$uid" | cut -d: -f1)
# ids 1..65535 except the user's own, which maps to itself
ranges() { if [ "$2" -gt 1 ]; then printf '%s:1:%s\n' "$1" $(($2 - 1)); fi; printf '%s:%s:%s\n' "$1" $(($2 + 1)) $((65535 - $2)); }
ranges "$name" "$uid" > /etc/subuid
ranges "$name" "$gid" > /etc/subgid

export XDG_RUNTIME_DIR="/tmp/run-$uid"
mkdir -p "$XDG_RUNTIME_DIR"
podman system service --time=0 "unix://$XDG_RUNTIME_DIR/podman.sock" > /tmp/podman-service.log 2>&1 &
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman.sock"
# Ryuk needs a privileged container; the session container is removed with everything in it anyway.
# /.dockerenv (Docker) makes Testcontainers reach containers by the gateway, which an internal network lacks.
export TESTCONTAINERS_RYUK_DISABLED=true TESTCONTAINERS_HOST_OVERRIDE=localhost
for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/podman.sock" ] && break; sleep 0.1; done
# Podman runs healthchecks from systemd timers, and there is no systemd here: `docker compose --wait` and
# `depends_on: service_healthy` would wait forever. Every second, every container's check, whatever its interval;
# while the store has no container (a directory each), a glob instead of a podman process.
store="$HOME/.local/share/containers/storage"
has_containers() { for dir in "$store"/*-containers/*/; do [ -d "$dir" ] && return 0; done; return 1; }
(while sleep 1; do
  has_containers || continue
  podman ps -q --filter health=starting --filter health=healthy --filter health=unhealthy | xargs -r -n1 podman healthcheck run > /dev/null 2>&1
done) &
exec "$@"
