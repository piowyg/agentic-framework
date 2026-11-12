#!/bin/sh
# Every session's command starts here. Java (Maven's ~/.m2, Kotlin's daemon, Testcontainers, prefs) takes the home
# from passwd, not $HOME: Podman's keep-id writes the host uid there with the workdir — the clone — as its home,
# Docker's --user leaves it without an entry. Either way the uid's one entry gets /home/agent.
uid=$(id -u); gid=$(id -g)
name=$(getent passwd "$uid" | cut -d: -f1)
others=$(grep -v "^[^:]*:[^:]*:$uid:" /etc/passwd)
# rewritten in place: /etc is not writable, the file is (mode 666 in the image)
printf '%s\n%s:x:%s:%s::/home/agent:/bin/sh\n' "$others" "${name:-agent}" "$uid" "$gid" > /etc/passwd
exec "$@"
