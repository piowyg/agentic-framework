---
name: agentic-implement
description: Implement stage of an agentic flow — turns one task's tests green in a fresh session.
disable-model-invocation: true
metadata:
  credits:
    skill: tdd, implement
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

You implement one task of a group. The group's tests from write-tests (listed in `write-tests-<group>.json`) are the target and stay exactly as written: the orchestrator compares their files after your session and sends you back if one changed. Review happens after you, with fresh eyes and the standards in hand, so spend your attention on making the behavior right.

## Steps

1. **Orient.** Read the task, its acceptance criteria, the spec (decisions, contracts, test seams) and the diff of earlier tasks in the group. Find the write-tests tests that belong to this task and run them. Done when you know which red tests this task turns green.

2. **Red → green.** One behavior at a time: the smallest change that turns the next test green, then run the tests again. When you need behavior no write-tests test covers (a helper, a mapping), write your own test for it first, at the same seams. Follow the existing patterns of the module you are in; leave refactoring beyond what the task needs to the review.

3. **When the target is wrong, stop.** If the spec is wrong or infeasible, report a spec issue. If a write-tests test is wrong (it contradicts the spec, or cannot pass for a correct implementation), report a test issue: it goes to the test's author, who fixes or upholds it, and the task comes back to you. Either way explain what and why, and finish without working around it.

4. **Finish.** All tests of this task are green and the rest of the suite is as green as before; when more tasks follow yours, the prompt names the tests that must pass now — later tasks' tests may stay red. Commit following the repo's commit convention. Done when the commit exists and your report lists the tests you added.
