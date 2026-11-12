# agentic/base — one throwaway container per session: git and both harness CLIs, nothing else.
# Runs as the host user (`--user` / `--userns=keep-id`), so HOME is open to any uid.
# Trixie for Podman 5: `sandbox.containers` runs it rootless inside the session (Podman 4 needs a writable /proc/sys).
FROM node:22-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep less procps \
    podman fuse-overlayfs passt nftables uidmap catatonit libcap2-bin aardvark-dns \
    # `docker compose` and the docker CLI talk to the session's own Podman (`sandbox.containers`)
    docker-cli docker-compose \
 && rm -rf /var/lib/apt/lists/* \
 # the clone is owned by the host uid, which has no passwd entry here
 && git config --system safe.directory '*' \
 # the entry scripts give the host uid its home and its subordinate ids
 && chmod 666 /etc/passwd /etc/subuid /etc/subgid
COPY containers.conf /etc/containers/containers.conf
COPY home-entry.sh containers-entry.sh /usr/local/lib/agentic/

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
ARG PLAYWRIGHT_VERSION=1.64.0
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 # the system libraries Chromium needs; the browser itself is the repo's Playwright's, downloaded into a cache volume
 && npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force \
 # with `sandbox.containers` on Docker there is no no-new-privileges: no setuid or setgid binary may grant anything,
 # and newuidmap/newgidmap get only the one capability each needs, as file caps. After every package install
 && find / -xdev -perm /6000 -type f -exec chmod ug-s {} + \
 && setcap cap_setuid+ep /usr/bin/newuidmap && setcap cap_setgid+ep /usr/bin/newgidmap

# first-run dialogs (theme, trust, bypass-permissions warning) would stop an interactive session; the diff panel,
# opened by itself on a wide terminal, would split the screen of a session the human only answers questions in
COPY claude.json /home/agent/.claude.json
# dependency caches are named volumes mounted here; an empty volume takes the directory's mode, so any uid can write.
# The harnesses' homes exist before their sessions directory is mounted in them, else the engine makes them root's
RUN mkdir -p /home/agent/.gradle/caches /home/agent/.gradle/wrapper /home/agent/.m2/repository /home/agent/.npm /home/agent/.local/share/containers \
    /home/agent/.cache/ms-playwright /home/agent/.claude/projects /home/agent/.codex/sessions \
 && chmod 1777 /home/agent /home/agent/.gradle /home/agent/.gradle/caches /home/agent/.gradle/wrapper /home/agent/.m2 /home/agent/.m2/repository /home/agent/.npm \
    /home/agent/.local /home/agent/.local/share /home/agent/.local/share/containers /home/agent/.cache /home/agent/.cache/ms-playwright \
    /home/agent/.claude /home/agent/.claude/projects /home/agent/.codex /home/agent/.codex/sessions \
 && chmod 666 /home/agent/.claude.json \
 && chmod 755 /usr/local/lib/agentic/home-entry.sh /usr/local/lib/agentic/containers-entry.sh

# the egress proxy (agentic's egress-proxy.ts, copied into the build context by `agentic sandbox build`)
COPY egress-proxy.mjs /usr/local/lib/agentic/egress-proxy.mjs

ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace
