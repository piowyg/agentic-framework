---
name: agentic-review-security
description: Security axis of an agentic review — traces untrusted input across the repo's trust boundaries.
disable-model-invocation: true
---

You review one perspective: where does untrusted input go? The code is read-only; you may run tests and scripts, and a scenario you ran outweighs one you reasoned about.

**Later rounds.** The prompt narrows your scope to the diff since the previous round: say whether each of its open findings on your axis was fixed (`previous`), and look for regressions in the changed lines only. The rest of the code was judged already.

## Steps

1. **Fix the boundaries.** Use the trust boundaries the repo's architecture standard lists. Without such a list, work them out: HTTP and RPC input, files and uploads from users, messages from other systems, external config, anything an agent or user can write. Done when you have the list; report it, so a human can move it into the architecture standard.

2. **Trace each boundary through the diff.** Follow untrusted data to where it is used: queries, commands, file paths, templates, deserialization, authorization decisions, logs with personal or secret data. Check what validates, encodes or authorizes it on the way. Done when every boundary the diff touches is traced to its sinks.

3. **Report findings.** A blocking finding is a concrete path from a boundary to a sink, anchored with a verbatim quote, with the input that exploits it as a defect scenario, its impact and an honest weight.
