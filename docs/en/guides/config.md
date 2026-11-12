English | [Polski](../../pl/guides/config.md)

# Config

## Minimal config

`~/.agentic/config.yaml` (private, global):

```yaml
profiles:
  work:
    match: { remote: "*gitlab.company.com*" }
    billing: api
    budget: { usd: 5, minutes: 30 }
  private:
    match: { path: "~/Projects/**" }
    billing: subscription
    budget: { tokens: 2000000, minutes: 45 }
default_profile: private
```

Service repo, `.agentic/config.yaml`:

```yaml
review:
  checks: ["./gradlew build", "./gradlew test"]
```

`agentic init` detects the build (Gradle, Maven, npm), proposes `review.checks`, `compile` and `test_reports`, shows
the file and saves it only after your "yes" (without a terminal: `--yes`). It doesn't overwrite existing files.

## Difficulty tiers

Tasks in `tasks.yaml` have a **difficulty tier** (`mechanical | standard | domain | design`), and config maps it
to an executor — model IDs never end up in `tasks.yaml`:

```yaml
tiers:
  mechanical: { harness: codex,  model: luna,  effort: low }
  standard:   { harness: codex,  model: luna,  effort: medium }
  domain:     { harness: codex,  model: sol,   effort: high }
  design:     { harness: claude, model: opus,  effort: high }
```

## Layers

Layers (a lower one overrides a higher one): global (+ profile) → team workspace → repo → flow.
Full list of fields: [reference/config.md](../../reference/config.md).

## Framework rules and how to disable them

The framework's practice skills carry rules with IDs that agents apply and review cites: `AG-CODE-nn`
(`agentic-clean-code`), `AG-TQ-nn` (`agentic-test-quality`). The `AG-` prefix is reserved for the framework —
team standards (`.agentic/standards/*.md`) and repo skills use their own, e.g. `ARCH-01`, `TEST-03`, `CODE-01`;
a rule with `AG-` in the repo standards stops the flow from starting.

Not every team wants every rule. Three ways, from the broadest:

```yaml
# .agentic/config.yaml (repo) or the team workspace config
skills:
  disabled: [agentic-clean-code]   # the skill disappears from all stages (implement, fix, review-standards…)
rules:
  disabled: [AG-TQ-04]             # the skill stays, this one rule doesn't: agents don't apply it, review doesn't report it
stages:
  implement:
    skills: [agentic-test-quality] # the skill list of one stage (replaces the default)
```

How it works:

- **Arrays replace, they don't add up.** `skills.disabled` from the repo config replaces the list from the workspace —
  to add a disabled skill to the team's list, rewrite the whole list.
- **The stage skill** (`agentic-implement`, `agentic-review-standards`…) always stays — its output is the
  orchestrator's contract; `stages.<stage>.stage_skill` replaces it.
- **A disabled rule** goes into the session prompt as "don't apply, don't cite", and a review finding that cites it
  drops to a nit with a reason.
- **`Checked by:`** on a standards rule (e.g. `_Checked by:_ ArchUnit`) hands it to a tool from `review.checks`:
  the reviewer doesn't report it. With `review.checks: none` the rule stays with the reviewer (nothing else checks it).
  The `agentic-arch-tests` skill moves architecture rules over this way: from `ARCH-nn` in the standards it writes
  ArchUnit tests (or the repo's tool outside the JVM), checks each against a planted violation and adds
  `_Checked by:_`. You run it yourself in your own Claude Code session (`/agentic-arch-tests`, after
  `agentic skills install`).
- `agentic doctor` shows how many framework rules are active, what's disabled and which config layer
  (global / workspace / repo) set it, and warns about typos in IDs.

## Where things live

| What | Where |
|---|---|
| Flow artifacts (`ticket.md`, `spec.md`, `tasks.yaml`, `state.json`, `usage.jsonl`, review reports) | `~/.agentic/work/<repo>-<hash>/<slug>/` (outside the repo; flows from before 2026-10 stay in `<repo>/.agentic/work/`) |
| Global config | `~/.agentic/config.yaml` (or `$AGENTIC_HOME`) |
| Repo config | `<repo>/.agentic/config.yaml` |
| Team workspace | a directory with `repos.yaml` and `.agentic/config.yaml` (or `$AGENTIC_WORKSPACE`) |
