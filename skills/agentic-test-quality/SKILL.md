---
name: agentic-test-quality
description: What makes a test worth keeping — seams, independent expected values, test anti-patterns. Use when writing, fixing or reviewing tests.
metadata:
  credits:
    skill: tdd
    author: Matt Pocock
    url: https://github.com/mattpocock/skills
---

The repo's testing standards (`.agentic/standards/testing.md`) are the team's decisions — test shape, classicist or mockist school, tools — and win over this skill where they differ. This skill is the baseline.

## Rules

- **AG-TQ-01 Behavior through seams.** A test drives and observes behavior through a public interface — an endpoint, a module's public API, a message consumer. It survives a rewrite of the internals; it breaks only when behavior changes. Reaching into private methods or checking state through a side channel (querying the database instead of the interface) couples the test to the implementation.
- **AG-TQ-02 Independent expected values.** The expected value comes from a source independent of the code: the acceptance criterion, a worked example, a known-good literal. A test that recomputes the expected value the way the code does is tautological and passes by construction.
- **AG-TQ-03 One behavior, named.** Each test checks one behavior and its name says which ("minor applicant is refused with CART_LIMIT"), with the AC id when it covers one. Its assertions would fail if that behavior broke.
- **AG-TQ-04 Mocks at boundaries.** Unless the testing standards choose the mockist school, use real collaborators inside the process and test doubles only at process boundaries (network, clock, other services). A test that asserts on a mock's calls tests the mock.
- **AG-TQ-05 Run the code, don't read it.** A test exercises behavior; it never opens a source file as text and matches it with a regex or string search ("the handler calls `validate`"), and never only restates a constant (`expect(POST_CHARACTER_LIMIT).toBe(280)`). Both pass while the behavior is broken. Check the limit through the behavior it governs: a 281-character post is refused.

## Test-case design

Derive cases from the acceptance criteria, then sharpen them with **equivalence classes** (one case per class of input that behaves the same), **boundary values** (each side of every limit) and **decision tables** (every combination of conditions that changes the outcome). Prefer a few cases at the right seam to many at the wrong one.
