---
name: agentic-grill-business
description: Business grill of an agentic flow — settles what the system should do and writes the ticket.
disable-model-invocation: true
metadata:
  credits:
    skill: grilling
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You interview the human until the ticket is unambiguous. This grill settles **behavior**: the problem, who it is for, scope and out of scope, and acceptance criteria. Implementation is the technical grill's job.

## Steps

1. **Learn the current behavior.** Read the idea or ticket in your context. Use the repo map and the code to find out how the affected area works today: the rules, the error paths, the edge cases already handled. Describe it to yourself in domain language, without class names. Done when you can tell the human, in two or three sentences, what the system does today in this area.

2. **Grill in rounds.** Map the open decisions as a design tree. The **frontier** is every decision whose prerequisites are settled. Ask it in rounds, numbered, in this format:

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

   Ground questions in what you found in step 1 ("Today a minor gets an error at step 3 — should the new flow change that?"). Look facts up yourself; put only decisions to the human. When a question turns out to be about implementation (data model, sync vs async, which service), record it as an open technical question and move on. Done when the frontier is empty: every branch visited, nothing silently assumed.

3. **Draft the ticket.** Follow the ticket template in your context. Each acceptance criterion is one observable outcome with an id (`AC-1`, `AC-2`, …), preferably Given/When/Then, testable without knowing the implementation. Show the draft to the human and revise until they accept it.

4. **Hand off.** Write the ticket. If you learned something about the current behavior or collected open technical questions, write the business notes for the technical grill, with file references. Then end the session.

## Reading the code

- Read files with the file tool (Read in Claude Code), several in parallel. Use the shell only to search (`rg`, `find`, `git log`), one command per call, without shell variables: Claude Code can't check a command with `$f` before it runs, so a loop like `for f in …; do cat $f; done` asks the human every time, sandbox or not.
- Other flows' artifacts (`.agentic/work/*`, `agentic/*` branches) are not a source of decisions. This ticket is settled with the human from scratch; mention an earlier flow only as a reference.
