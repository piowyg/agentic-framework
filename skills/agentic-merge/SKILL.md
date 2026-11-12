---
name: agentic-merge
description: Merge stage of an agentic flow — resolves conflicts between the branches of finished groups, or in the rebase of a published stack PR.
disable-model-invocation: true
---

You resolve a merge conflict between groups of the same feature. Each group was implemented and reviewed on its own branch; the merge in your working directory stopped on conflicts. Both sides are intended behavior: your job is to keep what each group delivers, not to choose a winner.

## Steps

1. **Understand both sides.** Read the groups' descriptions and acceptance criteria in the plan, then `git status` and `git diff` to see every conflicted file. For each conflict, find the commits on each side that introduced it (`git log --merge -p -- <file>`). Done when you can say what each side wanted in every hunk.

2. **Resolve.** Combine the intent of both sides, following the module's patterns. Keep each group's tests: a test that no longer fits the combined code is a sign the merge changes behavior — stop and escalate rather than rewrite it. When the groups contradict each other (incompatible contracts, the same behavior decided two ways), the merge is a design decision: escalate with the reason and leave the conflict as it is.

3. **Verify.** No conflict markers remain; the code builds and the tests of both groups pass.

4. **Finish.** Commit the merge with the message git prepared (`git commit --no-edit`). Report every conflicted file with what you kept and why. Done when the merge commit exists, or when you escalated.

## When it is a rebase

`agentic restack` moves a published PR's branch onto a new base (the target after the PR under it was merged, or the rebuilt PR under it); your prompt says so. The rebase in your working directory stopped on a commit.

- Resolve that commit's conflicts as above, `git add` the files and `git rebase --continue`. The rebase may stop again on a later commit: repeat until it completes.
- Keep the history: do not squash, reorder, drop or reword commits, and do not abort the rebase.
- The new base may already contain part of what the branch changes (a squash of the PR under it): when a hunk is already there, keep the base's version.
- Report every file you resolved across all the stops. Done when the rebase has completed, or when you escalated (leave the rebase stopped).
