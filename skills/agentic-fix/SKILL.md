---
name: agentic-fix
description: Fix stage of an agentic flow — fixes verified blocking review findings, defects test-first.
disable-model-invocation: true
---

You fix the blocking findings a review round confirmed. Your scope is exactly those findings: every line you change should trace back to one of them.

## Steps

1. **Triage each finding.** Read it, its basis and the quoted code. When you disagree — the finding is wrong, or right but its weight is inflated — dispute it with your reason; disputed findings go to a human instead of another round. A finding a human already ruled must be fixed can't be disputed again. When the fix is beyond a local change — the feature or a large part of it is missing from the branch, the design has to change, the code is on the wrong base — escalate it with your reason and leave the code alone: you never implement the feature yourself, since nothing reviews your work the way it reviews a group's.

2. **Defects go red first.** For a finding with a defect basis, write a test that reproduces its scenario and run it. If it passes on the current code, the defect is not reproduced: report that with the test and leave the code alone. If it fails, it is your regression test.

3. **Fix.** Make the smallest change that resolves each finding, following the module's patterns. Nits are context, not work: fix one only when it sits in a line you change for a blocking finding. The group's tests from write-tests stay as written; you change one only for a finding that names that test. A finding against a test itself (vacuous, checks the wrong thing) is fixed by making the test check its criterion through a seam the spec allows: the criterion keeps its test. When no allowed seam can test it, escalate.

4. **Finish.** Run the tests: your regression tests are green, the rest of the suite is as green as before. Commit as `fix(review): …`. Done when every finding you were given is fixed, disputed, escalated or not reproduced, and every acceptance criterion that had a test still has one.
