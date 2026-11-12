---
name: agentic-grill-technical
description: Technical grill of an agentic flow — explores the code, settles how to build the ticket and writes the spec.
disable-model-invocation: true
metadata:
  credits:
    skill: grilling, to-spec
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You turn an accepted ticket into a spec the rest of the flow builds from without asking anyone. This grill settles **realization**: where the change lives, contracts, data, test seams, risks.

## Steps

1. **Explore first.** Read the ticket and, if present, the business notes (current behavior, open technical questions). Explore the code the ticket touches: entry points, the modules involved, existing patterns for similar features, existing tests and how they are written, the repo standards. Done when you can name every module the change touches and the pattern each part should follow.

2. **Grill in rounds, decisions only.** Questions the code answers are yours to answer. Put to the human only what the code leaves open: trade-offs, contracts with other teams, migrations, behavior the ticket does not pin down. Start from the open technical questions. Map the open decisions as a design tree; the **frontier** is every decision whose prerequisites are settled. Ask it in rounds, numbered, in this format:

   ```
   ❓ **Q1** - **<title>**: <the decision and why it matters, grounded in what you found in the code>

   - **A: <option>.** Gains: … Costs: … Hurts when: …
   - **B: <option>.** Gains: … Costs: … Hurts when: …

   ➡️ **A**: <why A, weighed against the costs above>

   ---

   ✅ **Defaults, unless you object:**
   - <decision>: <one-line why>
   ```

   Each question gives 2–3 real options, and each option its cost: what we gain, what we pay, when it hurts. Only then your recommendation, with the reason it wins. Word each question so a plain "yes" accepts your recommendation. A decision with no real alternative is not a question: put it in the defaults list. A round asks at most 5 questions, the ones that shape the most of what follows; the rest of the frontier waits for the next round. Wait for the answers before the next round: each one moves the frontier. The design tree and the frontier are your working terms: never name them to the human; say which decisions are left, or that none are.

   **What comes from outside the repo.** List every file the change needs that the repo doesn't have (a font, an image, a data set, a binary) and every new dependency. The sessions after the spec run unattended in a sandbox whose network reaches only `sandbox.network.allow` and the stack's package registries: anything from elsewhere stops a task. For each one, agree with the human how it arrives: they add it to the repo before implementation, or its host goes into `sandbox.network.allow`. A new package from the registry the repo already uses needs no question: put it in the defaults list.

   If the ticket itself has a gap (a missing or contradictory AC), resolve it with the human here and update the ticket.

3. **Agree the test seams.** A **seam** is the public interface a test drives and observes behavior through: an HTTP endpoint, a module's public API, a message consumer — never a private method or the database behind the interface. Propose the seams for each part of the change, each with a one-line note on what it catches and what it misses, and agree them with the human. Tests are written only at these seams, so pick the level that survives a rewrite of the internals. Done when every acceptance criterion maps to at least one agreed seam.

4. **Order the increments.** When the change is bigger than one reviewable pull request, write `## Slices`: first a prefactor if one makes the change easier (a rename, an extracted seam, with no behavior change), then thin vertical slices — each a narrow path through every layer it needs, ending in behavior an acceptance criterion describes (for example: main path end to end → edge cases → error handling). Not layers: a "model only" slice shows nothing a reviewer can check. This orders the work; the ticket stays one.

5. **Write the spec.** Each decision carries a short why. Contracts are concrete (signatures, message shapes, schema changes). Show it to the human, revise until accepted, write it, end the session.

## Reading the code

- Read files with the file tool (Read in Claude Code), several in parallel. Use the shell only to search (`rg`, `find`, `git log`), one command per call, without shell variables: Claude Code can't check a command with `$f` before it runs, so a loop like `for f in …; do cat $f; done` asks the human every time, sandbox or not.
- Other flows' artifacts (`.agentic/work/*`, `agentic/*` branches) are not a source of decisions. This ticket is settled with the human from scratch; mention an earlier flow only as a reference.
