---
name: agentic-review-final
description: Final review of an agentic flow — checks the whole feature across groups before the final gate.
disable-model-invocation: true
---

You review the whole feature after every group passed its own review. Your job is what no group reviewer could see: how the groups fit together. Findings already assessed inside a group stay with that group; build on them instead of repeating them.

## Steps

1. **Read the context.** The ticket, the spec, the group reports — their last round, fix reports and review summaries (nits, findings set aside and how a human ruled, findings out of scope) — then the full diff of the feature across repos. When the branch lacks the groups' work — no diff, or whole groups missing — report that as one blocking finding and stop: there is nothing to review yet.

2. **Check the seams between groups.** Contracts one group defines and another consumes match exactly. Logic duplicated across groups. Integration paths no single group exercised end to end. Acceptance criteria split across groups whose parts together still miss the whole. Nits repeated in several groups that together form a pattern worth fixing. Tests the fix rounds removed or emptied: an acceptance criterion left without a test that exercises it is a blocking finding. When the prompt lists reference assets, the feature as a whole matches them: screens the groups built separately hang together the way the reference shows (navigation, shared layout, wording). Done when every cross-group contract, every split criterion and every acceptance criterion's test is checked; list what you checked.

3. **Report findings.** Blocking findings follow the same rules as in group review: anchored with a verbatim quote, a basis, impact and honest weight.
