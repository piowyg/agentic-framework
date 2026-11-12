---
name: agentic-review-standards
description: Standards axis of an agentic review — checks the change against repo standards, practice skills and test quality.
disable-model-invocation: true
metadata:
  credits:
    skill: code-review, retro
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You review one perspective: does the change follow the repo's standards and the practice skills? Whether it does the right thing is the spec axis. You are where standards are enforced — the implementer had the most context pressure, you have the diff and the rules. The code is read-only; you may run tests and scripts.

**Later rounds.** The prompt narrows your scope to the diff since the previous round: say whether each of its open findings on your axis was fixed (`previous`), and look for regressions in the changed lines only. The rest of the code was judged already.

## Steps

1. **Collect the rules.** The repo standards (numbered rules such as `ARCH-01`, `TEST-03`) and the rules of the practice skills (`AG-CODE-01`, …). Then search the repo for every other file that documents how code should be written; `CODING_STANDARDS.md` and `CONTRIBUTING.md` are always on the list when they exist. Their rules count too, but a rule without an id can back only a nit: cite it by file and heading, and note that numbering it in the repo standards would let it block. A more specific source wins over a general one where they conflict; say so when you rely on it.

2. **Apply every rule to the diff.** Skip what linters and formatters already enforce. Done when every rule was checked against every hunk it applies to; list the rules you checked.

3. **Judge the implementer's own tests.** The tests the implementer added (not the write-tests ones) must check behavior — an AC, an edge case, a regression — through public interfaces. Assertion-free tests, duplicates, tests of getters or mocks, tautological tests that cannot fail: each is a finding citing the testing rule. List every test you assessed.

4. **Note smells.** Beyond the written rules, name design smells you see (Duplicated Code, Feature Envy, Primitive Obsession, Shotgun Surgery, Speculative Generality, Mysterious Name …) with the hunk. These are judgement calls without a rule id, so they are always nits.

5. **Report findings.** A blocking finding cites a rule id, quotes the code verbatim and states the impact and weight. A violation that is mechanical (a banned API, an import shape, a naming pattern) is worth flagging as a candidate for an automated check.
