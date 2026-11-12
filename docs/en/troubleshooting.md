English | [Polski](../pl/troubleshooting.md)

# Troubleshooting

Start with two commands:

```bash
agentic doctor            # environment: config, harnesses, engine, image, credentials, checks; gives a fix for each problem
agentic status <slug>     # where the flow stands and why (pause reason, group, message)
```

A flow's logs are in its directory (`~/.agentic/work/<repo>-<hash>/<slug>/`): `events.jsonl` (what happened),
`checks/` (full output of the `review.checks` commands), `out/<session>.egress.log` (proxy denials in the container).

CLI messages are in Polish for now; messages quoted below are translated.

## Paused flow

`agentic status <slug>` shows the pause reason. After a fix: `agentic resume <slug>`.

| Reason | What happened | What to do |
|---|---|---|
| `baseline` | `review.checks` were already red on the base code, before the agent changed anything | Fix the base (or wait for a fix on main) and resume: the group starts from the new base. At the prompt you can also pick "continue": the red commands become known red and won't verify any group of the flow (later groups don't ask about them again). |
| `red_gate` | Write-tests tests don't compile or pass without an implementation, despite resuming the test author | Check the log from the message. A test green on the base usually means the behavior already exists or the test checks nothing: fix the AC or seams in the spec. No compilation: check `review.compile`. |
| `checks_failing` | After a session (task, fix) checks are still red, despite resuming with the output | Read the log in `checks/`. Common causes: a test that depends on the environment (network, port, time zone), a host missing from `sandbox.network.allow`, a `review.checks_timeout` that's too short. The resume limit is set by `review.stop_on: [{checks_failing: N}]`. |
| `test_issue` | The implementer thinks a write-tests test is wrong, and the test author upheld it or has already revised it several times | Decide yourself: fix the test on the branch or leave it. With "continue" at the prompt, the implementer has to satisfy the test as it is. |
| `spec_issue` | The agent judged the spec wrong or infeasible and didn't improvise | Fix `spec.md` in the flow directory and resume. For a review finding, the whole round runs again. |
| `human` | Someone picked "save and pause", exited a grill, or the flow is waiting for a merge conflict to be resolved | Resume. On a conflict: commit the merge in the clone named in the message, then resume. |
| `budget` | `budget` exceeded (minutes, tokens or USD) and you picked "pause" | `resume` asks again: continuing raises every limit by 50%. Where the money went: `agentic usage <slug>`. |
| `timeout` | A session exceeded `session_timeout` (45 min by default) and was killed | Resume: the session comes back with its uncommitted changes. When it repeats on the same task, the task is too big (split it at the breakdown gate) or the agent is looping: check the transcript in `transcripts/`. |
| `rate_limit` | The harness subscription limit | Resume after the limit resets. Waiting without a pause: `on_rate_limit: wait` in the profile (at most 5 h). |
| `error` | A transient API or network error (3 retries didn't help), the harness exited with an error, or checks are waiting for consent on the host | Read the message. Transient errors usually go away after resuming. No consent for checks: `resume` asks for it. |

A `failed` flow (`review_failed`) ended the review loop with `on_stop: fail` and can't be resumed. After reviewing
the `review-*.json` reports, start a new flow or finish the work by hand on the `agentic/<slug>/<group>` branch.
Branches and clones stay until you choose to clean up.

## Flow start

**`The flow is already running (pid N).`**: another `agentic` process holds this flow's lock. If
none is running (e.g. after a hard machine restart), delete the lock file named in the message.

**No `review.checks`**: a flow doesn't start without verification. `agentic init` proposes commands for the detected
build. Deliberately without verification: `review.checks: none` (groups will be marked unverified).

**A rule with the `AG-` prefix in the repo standards** stops the start: the prefix is reserved for framework rules.
Give the rule its own ID (e.g. `CODE-01`).

**`pick` started the business grill, but the ticket was ready**: only a ticket with `status: ready` in the frontmatter
and `AC-n` criteria starts from the technical grill. Template: `.agentic/templates/` after `agentic init`.

## Sandbox (container)

| Symptom | What to do |
|---|---|
| `doctor`: engine unavailable | Podman: `agentic setup` or `podman machine start`. Docker: start Docker Desktop. Without a container: `sandbox: { mode: none }` in the global config. |
| `doctor`: no image, or an image from a different framework version | `agentic sandbox build` (also after every framework update). |
| `doctor`: the harness in the container won't log in | Claude: `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`. Codex: `CODEX_API_KEY`. Set the variables in the profile of the shell you run `agentic` from. |
| Claude or Codex in the container can't reach the company gateway | `doctor` shows the gateway and its source (`~/.claude/settings.json` or the shell; for Codex the provider from `~/.codex/config.toml`, whose `env_key` must be exported in the shell). The gateway must be at `https://` on port 443 (the session proxy doesn't let others through). Proxy denials are in `out/<session>.egress.log`. You don't need to add it to the allowlist by hand. |
| The build in the container doesn't fetch dependencies, the session "has no network" | Check `out/<session>.egress.log`: every proxy denial has its host there. Add it to `sandbox.network.allow`. The stack layer adds Maven, Gradle and npm repositories itself. |
| Testcontainers or `docker compose` in tests don't work | In `container` mode: `sandbox.containers: true` (global config or a workspace from the `workspaces` list). Isolation is weaker then. In `none` mode tests run on the host: start Docker or Podman. `doctor` and `init` detect Testcontainers and `docker compose` in build files (a dependency under another name, e.g. a company library, slips through). |
| Playwright has no browser | Add `npx playwright install chromium` before e2e in `review.checks`. |
| The JVM build fails for lack of memory, the virtual machine slows down | The engine machine needs about 4 GB RAM for a JVM build with a database in compose. On 8 GB don't run Podman and Docker Desktop at once. `doctor` suggests resizing the machine. |
| `doctor`: leftovers after a crash | `agentic sandbox clean` removes containers and networks left by processes that no longer run. |
| Running out of disk space | `agentic clean` (working directories of old flows), `agentic sandbox clean --caches` (dependency caches; the next build fetches them again), old engine images (`podman image prune` / `docker image prune`). |

Without a container (`sandbox.mode: none`), the first flow in a repo asks for consent to run `review.checks` on the
host: it's code the agent may have changed. The consent is saved per repo in `~/.agentic/trusted-checks.yaml` and
expires when the command list changes.

## Publish

| Symptom | What to do |
|---|---|
| gitleaks found secrets | Remove them from the history of the `agentic/<slug>/_final` branch or add false positives to `.gitleaksignore` in the repo, then run `publish` again. |
| `doctor`: no gitleaks | `brew install gitleaks`. Without it, `publish` won't push the branch. |
| `doctor`: forge without a token, or unknown host | `profiles.<name>.forge` in the global config: `{ type: github, auth: { from: gh } }` (token from `gh auth token`) or `{ type: gitlab, auth: { env: GITLAB_TOKEN } }`. Self-hosted instance without `origin`: `forge.url`. |
| "origin/… has moved, and the flow's work conflicts with it" | Someone changed the same lines on the target branch. Move the work yourself with the command from the message (rebase the `agentic/<slug>/_final` branch onto `origin/<target>`), run the checks, then `publish` again: the branch already contains the target, so it goes through without a rebase. |
| "checks red after rebase onto origin/…" | The flow's work is green, but not together with the target's new commits. Logs are in the message. Fix it on the `agentic/<slug>/_final` branch after the rebase (as with a conflict) or publish to another target (`--base`). |
| "checks red on <branch> after moving onto …" (`restack`) | The PR's code is green on its old base, not on the new one. Logs are in the message. Push a fix onto the PR's branch, then `agentic restack <slug>` again: your commit rides along. |
| "… closed without merging" / "… someone rewrote its history" (`restack`) | `restack` only rebuilds open PRs on branches that still hold what it pushed. Reopen the PR, or put the branch back (`git push --force-with-lease` of the published head), then run it again. |
| `publish` after `restack`: "the stack was rebuilt by `agentic restack`" | From the first restack on, the stack is updated by `restack`. |
| "HEAD has N commits that aren't on origin/…" at start | A flow starts from the target on origin, not from your local HEAD. Those commits won't go into the PR. Want to build on them: push them and pass their branch as `--base`. |
| "No flows ready to publish" | Only flows with status `done` are published. `agentic status` shows where the others stand. |
| `publish` left a branch with a warning | Its commits exist nowhere else (e.g. a group from another repo, which `publish` doesn't push yet). Decide yourself, then `agentic clean <slug>`. |

## Cleanup

**`No terminal to ask in; use --dry-run or --yes.`**: `agentic clean` without a
terminal (e.g. in a script) needs one of these flags. `--yes` doesn't delete branches holding the only copy of work.

**A paused flow isn't on the `agentic clean` list**: without a slug, `clean` only lists it, because cleaning it up ends
the flow for good. Deliberately: `agentic clean <slug>`.

**`agentic/<x>/*` branches without a flow** (flow directory deleted by hand): `agentic clean` without a slug shows
them as orphaned and deletes them together with the hidden refs.
