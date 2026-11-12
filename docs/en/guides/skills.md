English | [Polski](../../pl/guides/skills.md)

# Skills

**The flow uses skills from the team and repo config (`stages.<stage>.skills`), not from your personal choice.**
`agentic skills` (selecting skills and packs) applies only to your own Claude Code / Codex sessions —
deselecting a skill on your machine doesn't disable it in the flow. Want to change the flow's skills: an MR to the
team config.

Sources: the framework (no prefix), `org:` (company, directories by technology), `ext:` (external, pinned),
`team:` (workspace), `repo:`, `me:` (private).

**Practices in your own sessions**: `agentic skills install` links the framework's practice skills into
`~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex) — symlinks, so framework updates reach them.
Idempotent; it doesn't touch a file or directory of the same name. `agentic skills` shows what is where;
`agentic skills uninstall` removes only those links. Stage skills (`agentic-implement`, `agentic-review-*`…) are
contracts of flow sessions — they aren't installed.

**Skills you run yourself** (outside the flow, after `agentic skills install`: `/skill-name`):

- `agentic-context-map` — a context map of the repo in two passes: a draft from the code (contexts, DDD
  relationships, contracts, data ownership, hotspots from git history) with a list of uncertainties and glossary
  candidates, then a grill — question by question with a human — that resolves them. The result goes to
  `.agentic/context-map.md` (+ a file per context in a monolith).
- `agentic-coverage-filler` — when the repo has a coverage threshold (a KPI, e.g. JaCoCo), it generates *fillers*:
  tests that only execute code up to the threshold (+2 points of margin). A separate name and tag, a "don't copy
  this" header, and a `Coverage fillers` section in `testing.md` that keeps review from judging them. After a
  refactor you regenerate the whole set instead of fixing it; the report lists classes covered only by fillers
  (behavior-test debt).

Practice-skill rules and disabling them: [config.md](config.md#framework-rules-and-how-to-disable-them).
