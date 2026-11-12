English | [Polski](../../pl/guides/containers.md)

# Container sessions

By default (`sandbox.mode: container`) each agent session starts in a throwaway container. In it, the session has the
group's clone and its own `out/`, the flow's artifacts read-only, the source repo (grills) read-only, and network only
through a proxy to hosts from `sandbox.network.allow` (HTTPS). Proxy denials land in `out/<session>.egress.log`.
`review.checks` also runs in the container, through the proxy as well.

The image depends on the repo (`sandbox.image.stack: auto`). A repo with Gradle or Maven, also in a first-level
directory (e.g. `backend/`), gets the `agentic/jvm` layer with JDK 17, 21 and 25. Other repos get `agentic/base` (Node
with corepack). The proxy adds the hosts the layer needs (Maven Central, Gradle, npm, yarn) by itself, even when the
repo has its own `network.allow`. Downloaded dependencies stay in shared `agentic-cache-*` volumes, so the second
build doesn't go to the network.

Tests with Testcontainers or `docker compose` need an engine in the session: `sandbox.containers: true` (global config
or workspace) runs a rootless Podman in the session container, with `DOCKER_HOST` pointing at its socket. It works on
Podman and Docker Desktop. Isolation is weaker then ([security.md](../security.md)), so turn it on only where tests
require it. On macOS, the engine's virtual machine needs about 4 GB RAM for a JVM build with a database in compose;
two machines at once (Podman and Docker Desktop) on 8 GB is too much.

E2e tests with Playwright: the image has the Chromium libraries, and the repo's Playwright downloads the browser — add
`npx playwright install chromium` before e2e in `review.checks` (in the container it goes into a shared volume). Hosts
the application itself needs (e.g. `next/font` fetches fonts from `fonts.googleapis.com` and `fonts.gstatic.com`)
go into `sandbox.network.allow`.

```bash
agentic setup                      # Podman (brew + a machine on macOS), with your consent; Docker: sandbox.engine: docker
agentic sandbox build              # agentic/base (git, Claude Code, Codex, Node) + this repo's stack layer
claude setup-token                 # subscription: a token for the container (the host keychain is out of its reach)
export CLAUDE_CODE_OAUTH_TOKEN=…   # in your shell profile; or ANTHROPIC_API_KEY. Codex: CODEX_API_KEY
agentic doctor                     # engine, image (up to date?), harness credentials, leftovers after a crash
agentic sandbox clean              # containers and networks after interrupted agentic processes (--caches: dependency caches too)
```

Without a container: `sandbox: { mode: none }` in `~/.agentic/config.yaml`. The boundary is then the harness's own
sandbox ([security.md](../security.md)).
