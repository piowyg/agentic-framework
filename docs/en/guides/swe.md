English | [Polski](../../pl/guides/swe.md)

# SWE guide

From installation to a PR on a real repo. The concepts (flow, group, gate, review axis) are explained in
[concepts.md](../concepts.md), and what to do when something stops in [troubleshooting.md](../troubleshooting.md).

## 1. Once per machine

```bash
npm install && npm run build && npm link   # in the framework directory: the `agentic` command on PATH
agentic setup                              # Podman (brew + a machine on macOS) and a dictation app, with your consent
agentic sandbox build                      # session image: agentic/base + the stack layer of the repo you run it in
```

`npm link` points to this directory's `dist/`: after `git pull` or a branch switch, run `npm run build`, otherwise the
flow runs on older code (`agentic doctor` and flow start warn about it). Working on the framework in the same
directory? Make changes in a separate `git worktree`, so a branch in progress doesn't change the command a flow runs on.

Credentials for container sessions (the host keychain is out of the container's reach). Set them in your shell profile:

- Claude with a subscription: `claude setup-token`, then `export CLAUDE_CODE_OAUTH_TOKEN=…`; with per-token billing:
  `ANTHROPIC_API_KEY`,
- Codex: `CODEX_API_KEY` (the ChatGPT login from `~/.codex` doesn't reach the container).

Global config `~/.agentic/config.yaml`: profiles by repo remote or path, the budget and the forge for `publish`:

```yaml
profiles:
  private:
    match: { path: "~/Projects/**" }
    billing: subscription
    budget: { tokens: 2000000, minutes: 45 }
    forge: { type: github, auth: { from: gh } }   # token from `gh auth token`; GitLab: auth: { env: GITLAB_TOKEN }
default_profile: private
```

`agentic doctor` checks everything at once: config, profile, harness CLIs, engine and image, credentials in the
container, git, gitleaks, the forge token, the repo's `review.checks`. It changes nothing, and gives a fix for every
problem.

## 2. Once per repo

```bash
cd ~/Projects/my-service
agentic init        # detects the build (Gradle, Maven, npm), proposes review.checks, compile and test_reports; saves after "yes"
agentic doctor      # repo checks, stack image (JVM repo: agentic sandbox build adds agentic/jvm)
```

Review `.agentic/config.yaml`. **`review.checks` is the only thing the flow trusts**: the agent doesn't decide whether
the code works. Good checks are fast and deterministic: build, unit tests, lint. Slow e2e is better left to CI.

```yaml
review:
  checks: ["./gradlew build"]
  compile: "./gradlew testClasses"                        # the "red" gate without running the whole build
  test_reports: "**/build/test-results/test/*.xml"        # per-test results instead of just the exit code
```

At the end, `init` (also when run again, in which case it saves nothing) and `doctor` show what the repo has for
agents: config, ticket template, context map (`.agentic/context-map.md`, the `/agentic-context-map` skill),
`AGENTS.md` / `CLAUDE.md` and standards. Anything missing is just a hint: the flow works, agents know less. To an
existing `AGENTS.md` (or `CLAUDE.md`), `init` adds an `## Agentic` section with the `.agentic/` paths once, so a plain
Claude Code or Codex session finds them too.

Team standards in `.agentic/standards/*.md` (rules with their own IDs, e.g. `ARCH-01`) go to the implementer and the
`standards` axis reviewer. `init` proposes three: `architecture.md`, `testing.md`, `code.md`; your own file names
work too. Commit the config and standards to the repo: flow settings are a team matter.

Before the first real flow, do a token-free trial:

```bash
agentic new "Trial" --fake     # every stage, gate and check on your repo, agents from a script
agentic clean trial            # clean up after the trial
```

## 3. Flow

### Start

```bash
agentic new "Free shipping over $50"                   # your own idea: from the business grill
agentic new                                            # longer description: paste it, end with a line containing only `.`
agentic pick ticket.md                                 # ready ticket with AC: from the technical grill; other text: business grill offered
agentic pick                                           # pasted ticket (e.g. from Jira), end with a `.` line
```

Run it in the repo the change concerns: a flow belongs to the repo you started it in. A flow starts from the target
branch's state on origin (origin's default branch or `--base develop`), not from your local HEAD. Local unpushed
commits won't go into the PR, and the CLI warns about them.

### Grills

A grill is a conversation with the agent in the terminal. The business grill settles the behavior and the `AC-n`
criteria; the technical grill settles how to do it: the agent reads the code first, then asks only about decisions.
The most important of them are the **Test seams**, the public interfaces the tests will be written against. Bad seams
give tests glued to the implementation.

- Answer by voice: [dictation](dictation.md) is several times faster than typing.
- You end the session when the agent has saved the artifact as ready and you exit. Exiting earlier pauses the flow,
  and `agentic resume` goes back to the conversation.
- The conversation language is `language.conversation` (personal), the artifact language is `language.artifacts`
  (team).

### Gates

At a gate you see a summary of the artifact or plan and pick an action. Worth stopping at:

- **spec:** are the seams and contracts the ones you want. A fix here is cheapest.
- **breakdown:** are the groups vertical slices (one group = one PR to review) and are the difficulty tiers not
  inflated. The tier picks the model, and the model picks the cost. Each group shows its estimate (`~120 prod /
  200 tests`); a group over the `publish.size` threshold is marked ⚠ with the reason the breakdown gave.
- **final:** the full diff after the final review, before publish.

"Revise with a note" gives the agent your remark and repeats the stage. "Save and pause" leaves everything for later.

### Implementation and review

From the breakdown on, the flow runs without you until the next active gate. You can close the terminal: the flow
stops, and `agentic resume` picks it up from the last saved step.

```bash
agentic status                  # flows of this repo and others
agentic status <slug>           # stages, groups (size, ⚠ over the estimate), review rounds, pause with reason, usage
agentic usage <slug>            # cost: stage → group → task / review round / fix
```

At a review-loop gate (`final`, with `strict` also `group`) you see the findings confirmed, rejected and disputed by
the fixer. Your options:

- **continue:** you accept the state,
- **revise with a note:** another fix round with your hint,
- **roll back to a review round:** when the fixer went the wrong way.

### Pauses

A flow stops on its own when it needs a decision: red base, `spec_issue`, `test_issue`, budget exceeded, rate limit,
session timeout. `agentic status <slug>` says why, and [troubleshooting.md](../troubleshooting.md) suggests what to
do. Then `agentic resume <slug>`.

## 4. Publish

```bash
git log --oneline agentic/<slug>/_final   # or the diff at the final gate: this goes into the PR
agentic publish <slug>                    # gitleaks → push → PR/MR → cleanup
agentic publish <slug> --base develop     # a different target branch than the one chosen at start
agentic publish <slug> --single           # one PR of the whole flow, as with publish.stack: false
```

If the target branch has moved since the flow started, `publish` first moves the work onto its new state (rebase in a
clean clone) and runs `review.checks`. A conflict or red checks stop it before the push, and
[troubleshooting.md](../troubleshooting.md) describes what to do then.

The PR gets the `agentic` label, a description in `language.pr` (summary, risks, open nits, accepted and deferred
findings) and a **Merge danger** section. A change in paths from `publish.one_way_paths` (migrations, contracts) is
marked as one-way. The plan and the description show the size of the change: production / tests / excluded lines
(added + deleted; lockfiles, generated files and files marked `linguist-generated` in `.gitattributes` are excluded,
docs count as production). Above the soft thresholds of `publish.size` (by default 400 production lines, 800 with
tests) you get a warning, nothing stops. A ticket from this repo's issue (`tracker_key: "#5"` or a title ending in `(#5)`) gets
`Closes #5` in the description, so the merge closes the issue. Without a `forge` in the profile, `publish` only pushes
and gives a link to open the PR. Running `publish` again updates the same PR.

With `publish.stack` (on by default) and a plan whose groups form a chain, `publish` opens a **stack**: one PR per
group, each on the branch of the one before it, all at once. The lowest is ready for review, the rest are drafts. Each
description lists the stack's PRs in merge order (`PR 2/3`, links) and shows the group's goal, its own size, Merge
danger and nits (a group without commits of its own gets no PR; its nits go to the PR above it), and the plan's
estimate when the group outgrew it. The spec's summary and risks are only in the first PR, and only the last one closes the issue. The
final review's fixes go to the PR whose lines they touch: before publish, at the end of the final review, `git blame`
assigns each hunk to its group, which gets it as a commit marked `(final review)`, and the stack is rebuilt (a
conflict goes to a `merge` session and the `merge` gate, as in `restack`). Lines of several groups or from before the
feature, new files, and the fixes of a group whose fixes turn `review.checks` red (on its PR or one above it) stay in the last PR; the PR
description says where they went. A moved target rebases the whole stack, and `review.checks` run on every PR's head, bottom first.
Running `publish` again updates every branch (`--force-with-lease`) and the same PRs; a draft that has just become the lowest is marked ready for review, while a lowest PR you turned into a draft stays one. A branch already on `origin`
that this flow didn't push stops `publish` before the plan. `--single` gives one PR instead of a stack. After a successful push the framework
cleans up the working branches and working directories, and the audit artifacts stay in the flow directory.

After a PR of the stack is merged (a squash too), or after you push commits onto a lower PR, run `agentic restack <slug>`.
It reads the PRs' state from the forge and rebuilds the open ones bottom first with `rebase --onto`: onto the target
once the PR under it merged, onto the lower branch with your commits otherwise. Your commits on a PR's branch ride
along. `review.checks` run on every rebuilt branch (no new review). A conflict goes to a `merge` session; the `merge`
gate shows how each commit changed (`git range-diff`), and "I'll resolve it" leaves the stopped rebase in a clone for
you. After your confirmation, one `push --force-with-lease` (on what `origin` had), the new lowest PR moves onto the
target and out of draft, and every list marks the merged PRs. A stop (a gate, your own resolution) keeps the progress:
running `restack` again continues. A PR closed without merging, or a branch whose history someone rewrote, stops it
before anything is pushed. From the first restack on, the stack is updated by `restack`, not `publish`.

A human reviews the PR, like any other. The agent never pushes on its own.

## 5. Cleanup

An aborted or `failed` flow asks at the end whether to clean up. `agentic clean` handles the rest:

```bash
agentic clean --dry-run    # what finished flows of this repo left behind and how much space it takes
agentic clean              # asks for each flow
agentic clean <slug>       # one flow, also a paused one (it then ends and can't be resumed)
```

A branch with commits that exist nowhere else is deleted only if you pick "together with them". `--yes` never deletes it.

## 6. Skills: the flow versus your sessions

**The flow uses skills from the team and repo config (`stages.<stage>.skills`), not from your personal choice.**
`agentic skills install` links the framework's practice skills into `~/.claude/skills` and `~/.agents/skills`, but
only for your own Claude Code and Codex sessions. Uninstalling a skill on your machine doesn't disable it in the flow,
and installing one doesn't add it to the flow.

The reason: the same task should produce the same process for everyone on the team, and review judges the code by the
same standards the implementer used. Want to change the flow's skills or rules: change the repo's
`.agentic/config.yaml` (or the team workspace config) through an MR. Disabling skills and individual rules is
described in [config.md](config.md#framework-rules-and-how-to-disable-them).

## 7. Cost and pace

- **Difficulty tiers:** `tiers` maps `mechanical | standard | domain | design` to an executor. A cheap model for
  `mechanical` and `standard` makes the biggest difference, because there are the most tasks of those.
- **Budget** in the profile (`budget: { usd | tokens | minutes }`) stops the flow with a question before it burns more
  than you planned. `review.max_rounds` limits review rounds.
- **Parallelism:** `parallel_groups: 2` runs independent groups at once: groups of different repos, or of one repo
  with `publish.stack: false`. On a machine with 8 GB RAM and a JVM build in a container, stay at 1.
- `agentic usage <slug> --by model` shows which model cost the most.
