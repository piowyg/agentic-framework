English | [Polski](../pl/security.md)

# Security

A document for people assessing whether agentic can run in an organization. It describes what we protect, where the
trust boundaries are, what the agent can do on its own and which risks we accept deliberately.

## What we protect

- **The user's repo code and history:** the agent works on a clone, never on the user's repo.
- **Credentials on the user's machine:** SSH keys, cloud keys, git and forge tokens, the keychain.
- **Remote and CI:** nothing reaches the forge without a human.
- **The user's machine:** an agent session doesn't run commands on the host outside the container (in the default mode).

## Who is trusted and who isn't

| Element | Trusted? | Why |
|---|---|---|
| Orchestrator (`agentic`, a TypeScript CLI) | yes | deterministic code, no model; holds state, builds commands, merges results |
| The human at gates and `publish` | yes | approves the ticket, spec, plan and every push |
| Agent session (Claude Code, Codex) | **no** | does what the model says; the model reads content we don't control |
| Ticket, spec, repo code, cloned dependencies | **no** | may contain instructions for the model (prompt injection) |
| Session output (commits, reports, `out/`) | **no** | the orchestrator verifies it before using it |

The principle: we treat every agent session like code that may be hostile. The boundary is the container and the
orchestrator, not the model's obedience.

## What the agent can and can't do

An agent in a session without a human **can**: read and change its group's clone, commit in it, run the build and
tests, connect to allowlisted hosts, write to its own `out/` directory.

The agent **can't**:

- **push** — for three independent reasons: the clone's remote points to a host path that doesn't exist in the
  container; the container has no git credentials; the network only reaches allowlisted hosts;
- change the user's repo — changes leave as a `git bundle`, which the orchestrator verifies and fetches (`git fetch`);
- read the user's home — the container has no `~/.ssh`, `~/.aws`, keychain or host container-engine socket;
- see tracker and forge tokens — only the orchestrator on the host uses them;
- leave anything for the next session — each session has a fresh container and its own harness session directory
  (no `settings.json` with hooks, `CLAUDE.md`, skills or memory from earlier sessions); the reviewer doesn't read the
  implementer's transcript.

Only a human pushes and opens the PR, through `agentic publish`.

## Session container

By default (`sandbox.mode: container`) each session starts in a throwaway container (rootless Podman or Docker):

- `--cap-drop=ALL`, `no-new-privileges`; Podman with `--userns=keep-id`, Docker with `--user <uid>:<gid>`;
- mounts: the group's clone (write), its own `out/<session>/` (write), flow artifacts and dependencies read-only; the
  user's repo (sessions before clones exist: grills, breakdown) read-only;
- the harness credential passed by variable name (`--env NAME`), never on the command line;
- after the session the container, proxy and network are removed (`rm --force`); leftovers after a crash are cleaned
  by `agentic sandbox clean`, and `doctor` detects them.

In the container, Claude Code runs with `--dangerously-skip-permissions`. That's deliberate: nobody answers permission
prompts in a session without a human, and the boundary is the container, not the harness's permissions.

Image: `agentic/base` (`sandbox/base/Dockerfile`) — Debian slim, git, Node, pinned versions of Claude Code and Codex.
A stack layer (e.g. JVM) adds a JDK. The image carries a label with a hash of its files; `doctor` detects an image
from a different version.

## Network

A session gets its own `--internal` network (no DNS and no route outside). The only other container on that network
is the proxy (`--read-only`, `--cap-drop=ALL`, user `nobody`), which:

- tunnels only `CONNECT host:443` to hosts from `sandbox.network.allow` (`.domain` = subdomains),
- rejects plain HTTP,
- logs every decision to `out/<session>.egress.log`.

Default allowlist: the model providers' APIs (`api.anthropic.com`, `api.openai.com`) and package registries
(`repo.maven.apache.org`, `registry.npmjs.org`). The organization adds its mirrors and removes what it doesn't use.
The host of a company model gateway (`ANTHROPIC_BASE_URL`, the Codex provider's `base_url`, below) is added to the
session allowlist by the framework itself; it must be reachable over HTTPS on port 443 (`doctor` warns about any
other port).

## Secrets

- Only the harness credential goes into the container, and only when it's set: `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` (Claude), `CODEX_API_KEY` / `OPENAI_API_KEY` (Codex).
- A company gateway (LiteLLM or another proxy) for Claude Code: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS` and `ANTHROPIC_DEFAULT_*_MODEL`. Taken from the shell, and when they're not there, from
  `env` in `~/.claude/settings.json` (only these names; the rest of the file doesn't reach the container). Values
  go to the engine through its environment (`--env NAME`), never on the command line.
- A company gateway for Codex: the provider from `model_provider` and `[model_providers.<name>]` in
  `~/.codex/config.toml` (or `$CODEX_HOME`) goes into the container as `--config`, only the fields describing the
  connection (`base_url`, `env_key`, `wire_api`, `env_http_headers`, `query_params`, retry limits).
  `experimental_bearer_token` and `http_headers` stay outside the container, because their values would end up on the
  command line — the token goes through the variable named by `env_key` (e.g. `LITELLM_API_KEY`), passed by name. The
  rest of `config.toml` (MCP servers, profiles) doesn't reach the container.
- Global harness settings (`~/.claude/settings.json` apart from the variables above, hooks, permissions, the
  organization's managed policies, `~/.codex/config.toml` apart from the provider) **don't apply in the container**:
  the container sees only an empty session directory. The boundary is the container, not the harness settings.
- Tracker and forge tokens (`JIRA_TOKEN`, `GITLAB_TOKEN`, `GITHUB_TOKEN`…) stay on the host.
- `agentic publish` runs gitleaks on all of the flow's commits (`--redact`, `--ignore-gitleaks-allow`, because the
  agent wrote those commits). A missing gitleaks or a finding stops publish before the push.

## Publish

`agentic publish` runs only on the host and is started by a human. In order: rebase onto the current target in a
fresh clone and `review.checks` → gitleaks → plan to confirm → push → PR/MR. The PR description includes "Merge
danger": changes in one-way paths (`publish.one_way_paths`: migrations, `.proto`, schemas) are highlighted for a full
review. The PR/MR gets the `agentic` label, so agent changes can be filtered and audited.

After publish the audit artifacts remain: ticket, spec, tasks, review reports, `usage.jsonl` (tokens, cost),
`events.jsonl` (the flow's course).

## Modes with weaker isolation

**`sandbox.mode: none`** — sessions on the host, without a container. The boundary is then Claude Code's own sandbox:
`blockReadsOutsideWorkingDirectories`, the OS sandbox with `failIfUnavailable`, the user's home closed apart from the
`sandbox.host.read` list (by default including `~/.gitconfig`, `~/.m2`, `~/.gradle`, `~/.npm`), permanently blocked
sensitive paths (`~/.ssh`, `~/.aws`, `~/.netrc`, `~/.config/gh`, `~/.npmrc`, `~/.docker`, `~/.kube`…) and variables
holding tokens. `review.checks` on the host need human consent per repo (`~/.agentic/trusted-checks.yaml`).
A workspace outside the `workspaces` list in the global config can't set `sandbox` (a repo can't turn off its own
container).

**`sandbox.containers: true`** — for tests with Testcontainers / `docker compose`. In `container` mode, build and
tests (`review.checks`, `run-checks`) run in the session container, so without this option tests that need a
container engine won't pass. With it, a separate rootless Podman runs in the session, and the session container gets:

- extra capabilities from `CONTAINERS_CAPS` (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`, `SETFCAP`,
  `SETGID`, `SETUID`, `SYS_CHROOT`) plus `/dev/fuse` and `/dev/net/tun`;
- `--security-opt=label=disable` and `unmask=ALL` (Podman) or `systempaths=unconfined` (Docker);
- on Docker, **no `no-new-privileges`** — the inner Podman's `newuidmap` gets its privileges from file capabilities,
  which that flag blocks (on Podman the flag stays);
- Docker Hub added to the allowlist (`registry-1.docker.io`, `auth.docker.io` and two CDN hosts), to pull images like
  `postgres:16`; an organization with its own registry should replace this with a mirror.

Still no `SYS_ADMIN`, `NET_ADMIN` or privileged mode; the host engine socket isn't visible. The option is set by the
global config or a workspace from the `workspaces` list (a repo can't turn it on by itself). `doctor` warns when a
repo has Testcontainers or `docker compose` and the option is off, and suggests turning it off when it's on without
such tests.

In `none` mode tests run through `run-checks` on the host, with the host's Docker and your permissions (hence the
per-repo consent); `sandbox.containers` doesn't matter there.

## Risks accepted deliberately

| Risk | What limits it |
|---|---|
| The agent can read the harness credential from the container environment and write it into a commit | gitleaks at publish; a human sees the diff before the push |
| Prompt injection from the ticket, code or dependencies steers the agent | container, network allowlist, no push, review on axes, human gate at publish |
| The agent can send data to an allowlisted host (e.g. through the model provider's API) | minimal allowlist, per-session egress log |
| Repo code reaches the model provider | the organization's decision: account, agreement, retention (below) |
| `mode: none` gives weaker isolation than a container | recommendation: only `container` in an organization |
| `sandbox.containers` widens the container's privileges (on Docker without `no-new-privileges`) and opens Docker Hub | off by default; turn on only for repos that need it (global config or a workspace from the `workspaces` list) |

## Data sent to model providers

The model doesn't run on the user's computer. At every step, the harness (Claude Code, Codex) sends the session
content to the provider's API: files the agent has read, the ticket, the spec, command and test output. Everything the
agent sees reaches the provider. The container and the allowlist don't change that — the model endpoint has to be on
the allowlist for the session to work at all. The orchestrator itself sends nothing to models.

The "provider" is the endpoint the harness connects to: a public API (`api.anthropic.com`, `api.openai.com`) or a
company gateway (`ANTHROPIC_BASE_URL`, the Codex provider) that forwards the traffic. With a gateway, retention and
terms are set by whoever runs it and their agreement with the model provider; the framework adds nothing here. The
organization decides:

- which account or gateway the team uses (company API / team plan / own gateway, not private subscriptions),
- what retention and data-processing terms apply at the provider,
- which repos may be processed.

## Recommended config for organizations

```yaml
# ~/.agentic/config.yaml (global config)
sandbox:
  mode: container            # no `none`
  network:
    allow: [api.anthropic.com, <organization artifact mirror>]   # with a gateway: no api.anthropic.com (its host is added automatically)
  containers: false          # turn on only for repos that need it
```

Plus: gitleaks installed for everyone who runs `publish`; the harness credential from the organization's account.
