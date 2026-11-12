---
name: agentic-clean-code
description: Self-documenting code — descriptive names instead of comments. Use when writing, fixing or reviewing code.
---

Code explains itself through names and structure. These rules apply to production code and tests alike; repo standards that say otherwise win.

## Rules

- **AG-CODE-01 Names carry the meaning.** When a block needs explaining, extract it into a function whose name says what it does, or name the variable for what it holds. A comment that restates the code is removed.
- **AG-CODE-02 Descriptive names.** Full words that say what a thing is or does — `order`, `verificationResult`, `remainingAttempts` — including lambda parameters, loop variables and test fixtures. Abbreviations and single letters (`a`, `r`, `ctx`, `e`) are renamed.
- **AG-CODE-03 Comments say why.** A comment earns its place when it records something the code cannot: why a non-obvious choice was made, a workaround with a link to its issue, a constraint from outside the code. Comments a repo requires (public API docs) follow the repo's conventions.
