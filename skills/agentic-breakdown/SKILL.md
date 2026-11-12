---
name: agentic-breakdown
description: Breakdown stage of an agentic flow — cuts the spec into groups and tasks with difficulty tiers.
disable-model-invocation: true
metadata:
  credits:
    skill: to-tickets
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You cut the spec into a plan the orchestrator runs unattended. A **group** is one repo and a review unit: its diff is reviewed and committed as a whole. A **task** is the smallest step, run in a fresh session that sees the spec, the task and the diff of earlier tasks in its group.

## Steps

1. **Slice vertically.** Follow the spec's `## Slices` when it has one. Each group is a **tracer bullet**: a narrow but complete path through every layer it needs, ending in behavior an acceptance criterion describes. Contracts other groups depend on (proto, API, events) go in the first group. The exception is a **wide refactor** (a rename or retype whose blast radius breaks every call site at once): sequence it as **expand–contract** — add the new form beside the old, migrate in batches, then remove the old.

2. **Size the groups.** A group becomes one pull request, so it has one goal a reviewer can name. Aim for 3–5 tasks per group; a diff a reviewer can hold in their head. Estimate the lines each group's diff will add and delete — production code (docs included) and tests apart, lockfiles and generated files left out. A group over a threshold is cut thinner (fewer acceptance criteria per group), never split into layers; when it can't be, say why in `oversize_reason`. Fewer groups is better while each stays reviewable. When the ticket needs many groups, say so in the rationale of the first group — the human may split the ticket.

3. **Chain the groups of a repo.** With a PR stack (the output contract says so), each group is a pull request on top of the one before: one first group, every next one depends on the one before it. Groups run side by side only across repos.

4. **Tier each task** by what the work demands, not by its size:

   | Tier | When |
   |---|---|
   | mechanical | config, 1:1 mappings, boilerplate, following an existing pattern exactly |
   | standard | typical code along an existing pattern, with new logic |
   | domain | new business rules, edge cases, non-trivial tests |
   | design | a new module or contract, a decision with no pattern in the repo |

5. **Keep every task green.** Each task runs in its own session and ends with a commit: after it, the build compiles and the tests pass. A change to a contract (an interface, a constructor, a schema) lands in one task together with every call site and implementation it breaks — never "change the port in t1, adapt the adapters in t2".

6. **Check the plan.** Every acceptance criterion is covered by a task; `depends_on` reflects real ordering; every group has an estimate and its rationale says why it is cut this way. Done when you could defend each cut to a reviewer. Write the plan.
