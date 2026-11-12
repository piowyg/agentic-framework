---
name: agentic-arch-tests
description: Turns a repo's architecture rules (ARCH-nn in .agentic/standards/) into architecture tests (ArchUnit or the repo's equivalent) and marks each enforced rule `Checked by:`.
disable-model-invocation: true
---

You turn architecture rules that reviewers check by reading into tests the build runs. A rule enforced by a test gets `_Checked by:_`, and the review stops citing it: from then on the test is the only guard, so a test that passes while the rule is broken silently drops the rule. Every test you add has to go **red** on a violation.

The tool follows the repo's stack: ArchUnit on the JVM (Java, Kotlin, Groovy; [references/archunit.md](references/archunit.md)), otherwise the repo's existing architecture-test tool (ArchUnitTS or dependency-cruiser for TypeScript, import-linter for Python, ArchUnitNET for .NET). No tool in the repo and none listed here: ask the human which one to add.

## Steps

1. **Collect the rules.** Read every file in `.agentic/standards/` and list each architecture rule (a list item opening with a bold id, such as `- **ARCH-03 Domain is framework-free.** …`). Skip rules that already carry `Checked by:`. When the standards name an architecture style (hexagonal, onion, layered) but have no numbered rules for its core constraints, propose them as new `ARCH-nn` rules from the style's rule set in the tool reference; they enter the standards only after the human accepts them. Done when you have the list of rules to check, with their ids and text.

2. **Classify each rule.** A rule is _checkable_ when a static check over classes and imports decides it: dependency direction, package placement, naming, annotations, cycles, forbidden APIs. It is _partial_ when only part of it is (“the domain is framework-free and models the ubiquitous language”), and _judgment_ when no static check decides it. Done when every rule has a verdict and, for _partial_ and _judgment_, the reason.

3. **Map the rule's terms to the code.** For each checkable rule, find what its words mean in this repo: which packages are “the domain”, which are adapters, which annotations mark a use case. Read the layout; do not guess from names alone. A term that maps to more than one reading is a question for the human.

4. **Agree the plan with the human.** Show a table: rule id, verdict, the check you will write (in a sentence, with the packages from step 3), and for each _partial_ rule a proposed split into a checkable rule and a judgment rule. Write nothing until the human confirms; they may drop rules, fix a mapping or reject a split.

5. **Write the tests.** One test per rule, in one architecture-test class or file in the repo's test sources. The test name and its failure message carry the rule id (`ARCH-03`), so a red build points at the rule. Add the tool as a test dependency if the build lacks it. Done when every confirmed rule has its test and the tests compile.

6. **Prove each test red.** For every test, add a minimal violation in the production code (an import or a class the rule forbids), run the test, see it fail with the rule id in the message, and remove the violation. A test that stays green under its violation checks nothing (a package pattern that matches no class is the usual cause): fix it. Done when each test has failed once on a planted violation and the working tree has none left.

7. **Run them on the real code.** A test red on the current code found existing violations; list them for the human, who decides per rule: fix the code now, freeze the current violations so only new ones fail (ArchUnit `FreezingArchRule`), or leave the rule unmarked. Done when every test is green on the current code, frozen or not.

8. **Mark the rules.** Under each rule now enforced, add an indented line inside its list item, naming the tool and the test:

   ```markdown
   - **ARCH-nn Domain is framework-free.** Domain classes import no Spring, JPA or Jackson types.
     _Checked by:_ ArchUnit, `ArchitectureTest.archNN_domain_is_framework_free`
   ```

   A split rule becomes two rules, the checkable one marked; renumber nothing, give the new rule the next free id. The marking takes effect only when the repo's `review.checks` runs the tests (with `review.checks: none` the reviewer keeps the rule); check `.agentic/config.yaml` and tell the human if the architecture tests are outside it.

9. **Commit and report.** One commit with the tests, the build change and the standards edit. Report per rule: marked (with the test), split, frozen (with the count of frozen violations), or left with the reviewer and why.
