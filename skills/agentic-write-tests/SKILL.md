---
name: agentic-write-tests
description: Write-tests stage of an agentic flow — writes the failing tests for a group's acceptance criteria before implementation.
disable-model-invocation: true
metadata:
  credits:
    skill: tdd
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You write the tests a group's implementation must turn green. Another model implements against them and may not change them, so they are the group's executable acceptance criteria. Writing the group's tests up front is deliberate here: the seams were agreed in the spec.

## Steps

1. **Read the testing ground rules.** The repo's testing standards decide the test shape (pyramid, diamond, trophy), the school (classicist or mockist) and the tools; they win over the practice skill wherever the two differ, and you follow them explicitly. Without testing standards, infer the style from the existing tests and report it.

2. **Map criteria to seams.** For each acceptance criterion in scope, pick the agreed seam from the spec's `Test seams` and the cases: the criterion itself, plus edge cases the spec names or that equivalence classes, boundary values and decision tables reveal. Done when every criterion has at least one case at an agreed seam.

3. **Write the tests.** Put the AC id in each test's name or display name (`AC-1 …`, or `ac1_…` where the language forbids dashes), and report each test under the name the test report shows. Expected values come from the ticket and the spec — known-good literals, worked examples; the reference assets the prompt lists give the visible names (labels, headings, buttons) the tests can rely on where the ticket doesn't fix them. When the code under test does not exist yet, add the smallest stubs the contracts in the spec describe (empty bodies returning a default value) so the tests compile and fail on their assertions.

4. **Prove them red.** Run the new tests. Each one fails on an assertion about the missing behavior — a compile error, a missing class, an exception from a stub or a crash in setup is not red yet; fix the test or the stub until it is. A test that passes before any implementation tests nothing new: rewrite it — unless the base code already does what its criterion asks; then keep it as a regression test and list the criterion in `already_met` with the evidence (file and line). Done when every new test is red for the right reason and the rest of the suite is unchanged. Commit the tests and stubs: the orchestrator runs them again and freezes the test files.

5. **Answer a test issue.** An implementer may later report one of your tests as wrong; the orchestrator resumes this session with the argument. Judge it against the ticket and the spec, not against the implementation. Wrong test: fix it, commit, answer `fixed`. Right test: change nothing and answer `upheld` with why — a human then decides.
