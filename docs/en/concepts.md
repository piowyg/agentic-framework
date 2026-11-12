English | [Polski](../pl/concepts.md)

# Concepts

The framework's vocabulary and model of operation in one place.
Step-by-step practice: [guides/swe.md](guides/swe.md).

## Flow

A **flow** is one ticket's path from an idea to a PR. It has a **slug** (from the title, e.g. `cart-limit`) and its
own directory of artifacts: `~/.agentic/work/<repo>-<hash>/<slug>/`, outside the repo tree (`$AGENTIC_HOME` moves it all).

```
agentic new / pick
  → business grill   → ticket.md   [ticket gate]
  → technical grill  → spec.md     [spec gate]
  → breakdown        → tasks.yaml  [breakdown gate]
  → per group: write-tests → tasks → checks → review ⇄ fix   [group gate]
  → merging the groups (_final)                               [merge gate]
  → final review ⇄ fix                                        [final gate]
  → status done, outcome ready_to_publish
agentic publish (human only)
```

- `new` starts with the business grill. `pick` with a ready ticket (`status: ready`, `AC-n` criteria) starts with the
  technical grill; any other text goes into `idea.md` and also goes through the business grill.
- A flow's **state** lives in `state.json`: stage, groups, rounds, pause. The orchestrator is a deterministic CLI. It
  spends no tokens itself and saves state after every step, so a flow can be resumed after an interruption, a closed
  terminal or a crash.
- **Statuses:** `running`, `paused` (waiting for `agentic resume`), `done`, `aborted` (stopped by a human),
  `failed` (review loop ended with `on_stop: fail`, or a rate limit with `on_rate_limit: fail`).
- **Events** are appended to `events.jsonl`: stage and session starts and ends, gate decisions, review rounds.
  It's a log. Where the flow stands is decided by `state.json`.

## Stages and artifacts

| Stage | Session | Result |
|---|---|---|
| business grill | interactive, in the terminal | `ticket.md`: the "what" (behavior), `AC-n` criteria |
| technical grill | interactive | `spec.md`: the "how", including **Test seams** (public interfaces the tests are written against) and **Contracts** |
| breakdown | no human | `tasks.yaml`: groups with a size estimate, tasks with a difficulty tier |
| write-tests | no human, sandbox | tests from the group's AC that must be red on the base code |
| implementation | fresh session per task | commits in the group's clone until the write-tests tests pass |
| review / fix | separate session per axis | `review-<group>-r<N>.json` reports, fixer changes |
| final review | on the full diff | `review-final-r<N>.json` |

An interactive stage ends when the agent saves the artifact with `status: ready` in the frontmatter and you exit the
session. The orchestrator checks the artifact (format, AC IDs) and only then shows the gate.

## Group and task

- A **task** is the smallest step. It points to `acceptance: [AC-n]` and has a **difficulty tier** (`mechanical`,
  `standard`, `domain`, `design`). Config maps the tier to an executor, so model IDs never end up in `tasks.yaml`.
- A **group** is 3–5 tasks in one repo: a coherent vertical slice of the change. It's the unit of review, commit and
  clone, and it becomes one PR. Groups can depend on each other (`depends_on`).
- Each group has an **estimate** of the lines its diff changes (`estimate: { prod, tests }`). A group over a
  `publish.size` threshold (400 production lines, 800 with tests by default) needs an `oversize_reason` in the plan,
  otherwise the plan goes back to the breakdown session. A finished group's diff is measured too: if it crosses a
  threshold its estimate stayed under (or goes past twice an estimate already over one), the log, `group_done` and `agentic status` say so (a warning, nothing stops).
  The technical grill may give the order of the work in the
  spec's `## Slices` section: a prefactor first, then thin vertical slices.
- **References** tie the work to material the spec lists under `## External assets` that the result must match (a
  clickable prototype, a design, a sample file). The breakdown reads each one in full and records, per group or task,
  which parts it covers and what must match (`references: [{ asset, parts, match }]`). write-tests, implement and fix
  get those parts in their prompt to read before they start; the spec and final reviewers compare the change with them,
  and a screen that ignores its reference is a blocking finding. A reference to an asset the spec doesn't list sends
  the plan back; an asset no group references is a warning at the breakdown gate.
- With `publish.stack` (on by default) the groups of one repo form a **chain**: one first group, every next one
  depends on the one before, so each PR can sit on top of the previous one. Groups in different repos run in parallel
  when `parallel_groups` > 1. With `publish.stack: false`, independent groups of one repo run in parallel too.
- Each group works in its own **clone** of the repo inside the flow directory, never in your working tree. The result
  lands on the `agentic/<slug>/<group>` branch in your repo. A dependent group starts from its predecessors' merged
  branches. At the end, the `agentic/<slug>/_final` branch holds everything, and that's what `publish` publishes.

## Executor: harness, model, effort

Every session has an **executor**: `harness` (agent CLI: `claude` or `codex`), `model` (an alias from the registry,
`agentic models`) and `effort`. Grills and breakdown take their executor from `stages.<stage>`, tasks from `tiers`
by difficulty tier, and review from `review.<axis>`. The fixer gets the group's model by default.

## Gates and autonomy

A **gate** is where a flow waits for a human: `ticket`, `spec`, `breakdown`, `group`, `merge`, `final`.
The `autonomy` preset picks which ones are active:

| Preset | Gates |
|---|---|
| `strict` | all |
| `standard` (default) | ticket, spec, breakdown, merge, final |
| `autopilot` | breakdown, final (merge passes on its own when checks are green) |
| `custom` | the list from `gates` |

Exception: when the feature's diff touches paths from `publish.one_way_paths` (migrations, contracts), the `final`
gate asks in every preset and lists those files. A revert restores the code, but it won't undo what such a change has
already done.

At a document gate you choose: **continue**, **revise with a note** (the agent revises the artifact), **save and
pause** or **abort the flow**. Review-loop gates (`group`, `final`) add **roll back to a review round**: the code
returns to its state from round N, and the fixer addresses that round's findings again. At the `merge` gate, on a
conflict, you can resolve it yourself in a clean clone and resume the flow.

The review loop can stop the flow even when the gate is disabled (`review.on_stop: human`).

## Verification: checks, baseline, the "red" gate

The agent doesn't decide whether the code works. Commands from the repo config do:

- **`review.checks`** are build, tests and lint run via `sh -c` in the group's clone, in a container or on the host.
  They're required to start a flow. `none` means deliberately no verification: groups are then marked "unverified"
  at gates.
- **Baseline:** before a group starts, checks run on a clean base. If something is already red there, you decide:
  accept it as **known red** (it doesn't count toward verification anywhere in the flow — in groups or in the final
  review and its merges — so later groups don't ask about it again) or fix the base and resume the flow.
- **The "red" gate:** write-tests tests must compile (`review.compile`) and fail on the base code. A test that's green
  without an implementation goes back to the test author.
- **Write-tests tests are frozen:** the implementer doesn't change them (the orchestrator checks the diff). If it
  thinks a test is wrong, it raises a `test_issue`. It may add its own tests.
- `review.test_reports` (JUnit XML) lets the orchestrator check individual tests instead of just command exit codes.

## Review and the loop with safeguards

Review works in **axes**, each in a separate session, usually on a different model than the implementation:
`spec` (does the code deliver the ticket and the spec), `standards` (conventions, quality, tests added by the
implementer) and optionally `security`. Each axis also reports what it checked, even when it found nothing.

A **blocking** finding needs a basis, otherwise it drops to a **nit**:

- `basis: spec`: a criterion ID or a spec item,
- `basis: standard`: a rule ID (e.g. `ARCH-01`, `AG-TQ-04`),
- `basis: defect`: a concrete "input → wrong result" scenario and `file:line`.

The orchestrator checks findings mechanically, without tokens: whether the basis exists (AC or rule ID) and whether
the quoted code is at the given `file:line`. A finding without an existing basis drops to a nit; one with a misplaced
quote is dropped before the fixer. From round 2, the scope is frozen to what was fixed, what wasn't fixed and
regressions in the new diff. The fixer can **dispute** a finding (`disputed`). Such a finding goes to the human and
doesn't come back in the loop.

The loop ends when all axes are covered and there are no confirmed blocking findings. It's stopped by the
`review.stop_on` triggers (e.g. `max_rounds`, `repeated_finding`, `no_progress`), and `review.on_stop` picks the
response: `escalate` (a fixer on a stronger model from `review.escalation`), `human` or `fail`.

## Sandbox

Agent sessions without a human run in a **sandbox**. By default (`sandbox.mode: container`) each session starts in a
throwaway container (Podman or Docker), where it has:

- the group's clone and its own `out/` directory for results,
- the flow's artifacts, read-only,
- network only through a proxy, to hosts from `sandbox.network.allow`.

The agent never pushes: the sandbox has no remote, no git credentials and no open network. With `sandbox.mode: none`
the only boundary is the harness's own sandbox, and `review.checks` on the host need your per-repo consent
(`~/.agentic/trusted-checks.yaml`).

## Config: layers and profiles

Config has four layers. A lower one overrides a higher one:

```
global ~/.agentic/config.yaml (+ active profile) → team workspace → repo .agentic/config.yaml → flow
```

Objects merge recursively, arrays are replaced as a whole. A **profile** (e.g. `work`, `private`) is picked by the
repo's remote or path. It sets billing (`billing: api | subscription`), the budget, the forge for `publish` and the
reaction to rate limits. The merged result: `agentic config show`. All fields: [reference/config.md](../reference/config.md).

## Skills and rules

- A **stage skill** (`agentic-implement`, `agentic-review-standards`…) is the session's contract: inputs, outputs and
  the format the orchestrator parses. It always stays; only `stages.<stage>.stage_skill` replaces it.
- **Practice skills** carry rules with IDs that agents apply and review cites. Framework rules have the `AG-` prefix
  (e.g. `AG-CODE-nn`, `AG-TQ-nn`), team standards (`.agentic/standards/*.md`) have their own prefixes.
- **The flow takes skills only from the team and repo config** (`stages.<stage>.skills`). Your personal choice
  (`agentic skills install`) applies only to your own Claude Code and Codex sessions. The same task should produce the
  same process for everyone, and review judges the code by the same standards the implementer used.
- Disabling: `skills.disabled` (the skill disappears from all stages), `rules.disabled` (one rule),
  `_Checked by:_` on a rule (a tool from `review.checks` checks it, not the reviewer).

## Budget and usage

Every session records tokens (and cost, when the profile has `pricing`) to `usage.jsonl`. The **flow budget**
(`budget`: minutes, tokens, USD) is checked before every session. Minutes are the total time of sessions without a
human. Grills and waiting at a gate don't count. When it's exceeded, you decide: continue (every limit +50%) or pause.
`session_timeout` (45 min by default) kills a single hung session. Cost breakdown: `agentic usage <slug>`.

## Publish and cleanup

The PR's **target branch** (`--base` on `new`/`pick`, by default origin's default branch) is chosen when the flow
starts: groups start from its state on origin, not from your local HEAD. Tests, baseline and review concern the code
the PR will go into from the start.

`agentic publish` is run by a human only:

0. when the target has moved since the flow started: rebase of the work onto its new state and `review.checks`
   (a conflict or red checks stop publish before the push),
1. secret scan (gitleaks) on the flow's commits,
2. push of branches named by `git.branch_pattern` (`{type}`, `{ticket}`, `{title}`, `{slug}`, `{group}`). With
   `publish.stack`, a chain of groups goes out as a **PR stack**: one PR per group, each on the branch of the one
   before it, the lowest ready for review and the rest as drafts. `{group}` is the group's title; a pattern without
   it gets `-1`, `-2`, …. `--single`, `publish.stack: false`, a single group, no approved plan, a plan that isn't a chain or only one group
   with commits of its own give one PR
   for the whole flow (`{group}` = the ticket title), and the plan says why,
3. PR/MR through the profile's **forge** (`github`, `gitlab`; `none` just prints a link). The PR description has a
   summary, risks, open nits, a **Merge danger** section (one-way changes according to `publish.one_way_paths`) and
   the size (production / tests / excluded lines, warning above `publish.size`),
4. cleanup: the `agentic/<slug>/*` working branches, hidden rollback refs and working directories.

**Audit artifacts stay** (ticket, spec, tasks, review reports, `usage.jsonl`, `events.jsonl`). The framework doesn't
delete a branch with commits that exist nowhere else (another branch, a tag, a remote) without your confirmation.
The same rule applies in `agentic clean` for aborted and abandoned flows.

## Fake harness

`--fake` on `new`, `pick` and `resume` replaces the agents with a script: the flow goes through every stage without
tokens. Use it to try out the config, gates and checks on a real repo before you pay for real sessions.
