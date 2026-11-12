---
name: agentic-context-map
description: Builds a repo's context map (bounded contexts, relations, contracts, data ownership, hotspots) in two passes - a drafted map with its open questions from the code, then a grilling that settles them with the human - plus glossary candidates.
disable-model-invocation: true
---

You map the bounded contexts of a repository so that agents and newcomers know, before touching code, what each part is for, who it talks to and what is dangerous to change. The map says _why_ and _where_; anything an agent reads faster from the code (fields, signatures, call details) stays out.

The work has two passes, and the human may run them in separate sessions:

1. **Draft** — you read the code and write the map, the list of things you could not verify, and glossary candidates. You collect evidence; you do not guess confidently.
2. **Grill** — you settle the open questions with the human, one at a time, and finish the map.

Start with the draft unless `.agentic/context-map-uncertainties.md` already exists; then ask the human whether to continue grilling or redraft.

Talk to the human in the language they write in; write every file in English. Do not modify code: only the files named here.

## Files

| File | What |
|---|---|
| `.agentic/context-map.md` | Several contexts (a monolith, a modular repo): an index, ≤ ~100 lines, linking one file per context. A single service: the whole map, ≤ ~200 lines, focused on its neighbours and contracts. |
| `.agentic/context-map/<context>.md` | One context, ≤ ~200 lines; only when the index exists. |
| `.agentic/context-map-uncertainties.md` | Numbered open questions (U1, U2…). |
| `.agentic/glossary-candidates.md` | Candidate domain terms, every entry "to confirm". |
| `.agentic/glossary-confirmed.md` | Terms the human confirmed in the grill. |

If the repo already has a context map elsewhere (`CONTEXT-MAP.md`, `docs/`), read it first and ask the human whether to extend it in place or move it; do not keep two maps.

## Pass 1: draft

### What to read

- Module and package structure, and the dependencies between them (who imports whom).
- Entry points: HTTP/RPC endpoints, message consumers and producers (with topic or queue names), scheduled jobs, CLI commands.
- Contracts: API specs (OpenAPI, proto, GraphQL schemas), event schemas, published client libraries — with paths.
- Persistence: tables or collections, and every place that **writes** to each (repositories, raw SQL, migrations).
- Integrations: clients of other services and third-party systems, with their side effects (sends e-mails, moves money, publishes events other teams consume).
- Docs the human points you to (ADRs, architecture diagrams, a docs repo added as a read-only directory): use them as input and cite paths; do not copy diagrams.
- Git history: the most-changed files of the last 12 months and reverts or hotfixes, as hotspot candidates:
  `git log --since=12.months --name-only --format= | sort | uniq -c | sort -rn | head -30` and `git log -i --grep=revert --oneline`.

### Finding boundaries

Boundaries come from the code structure **and** the domain language. The strongest signal is one word meaning different things in two places (an Order in sales is not an Order in fulfilment). Data ownership is evidence, not the criterion: two contexts writing to the same table is a leaking boundary — record it as an uncertainty, do not decide it.

A module with no domain language of its own, which only translates an external system's model (sign-in, payments, a partner's API) into questions a context answers, is an adapter, not a context. Every boundary with a system outside the repo gets its pattern too (conformist, anticorruption layer, open host) and the name of the module that is the adapter.

A context or relation an ADR decides but the code does not have yet goes into the map as **planned** (dashed in the diagram), citing the ADR. Name every party the ADR names: every producer of an event, not only the first one you found.

### A context's section

The same fields in the index and in a per-context file; leave out a field with nothing to say.

- **Type:** core / supporting / generic, with one line why.
- **Owner:** a team name, never a person. Unknown: an uncertainty.
- **Purpose:** 1–3 sentences on why the context exists.
- **Entry points:** API (path to the contract), events consumed and produced (topic), jobs.
- **Aggregates / key entities:** name and path only.
- **Relations:** one line each — `<this> → <other>`: the DDD pattern (customer/supplier, conformist, anticorruption layer, open host, published language, shared kernel, partnership, separate ways), the technical link (HTTP/RPC/event, sync/async, which side is upstream), and why, when it is not obvious.
- **Contracts:** paths of the specs others depend on. Changing them is a one-way door.
- **Data:** tables the context owns; tables it reads or writes that belong to someone else (debt — name the owner).
- **External systems:** with their side effects.
- **Hotspots:** path — why it is dangerous — what to check when changing it. No incident stories.
- **Direction:** where the context is heading, if anyone has decided (stays, being extracted, extracted to `<service>`), and the rule that follows (no new logic of an extracted context in the old place).
- **Decisions:** links to ADRs; without one, a line on why it is this way, if known.
- **Glossary:** a link to the glossary that defines this context's terms.

At the top of the index (or the single file): a Mermaid diagram of the contexts and their relations, for humans, at most ~15 nodes.

### Uncertainties

Number them U1, U2… in the order they appear, with no gaps; when you drop or merge one, renumber before you finish. When two items are about the same term or entity (which context owns a Customer's address, and what Customer means), say so in both and ask them one after the other. Each item: what you saw (paths), the two or more readings, and the question that decides between them. Group them: boundaries, ownership (team and data), relations, language and terms, hotspots, direction. Questions only the business can answer go under **Ask business**. Aim for questions that unblock the map, not trivia.

### Glossary candidates

Per term: the code name, the business name if visible (comments, UI strings, ticket titles), a one-line guess at the meaning, where it is used, and ambiguities (the same term with another meaning elsewhere). Do not write a `GLOSSARY.md`.

### Rules of the draft

- Every path you write exists. Every "A calls B" is backed by an import, a client class or configuration — cite it. A planned relation is backed by its ADR instead.
- What you cannot verify goes to the uncertainties, not into the map.

**Before you finish the draft**, run these checks and fix what fails:

1. Every path in the map and the uncertainties exists (check each one, e.g. `ls`).
2. Every relation cites its evidence; one without it moves to the uncertainties.
3. The uncertainties run U1…Un with no gaps.
4. The sizes hold (index ≤ ~100 lines, context file ≤ ~200).

Then summarize: the number of contexts, the top five uncertainties, anything surprising, and what the checks fixed.

## Pass 2: grill

Read the map, the uncertainties and the glossary candidates.

- Ask **one question at a time**, numbered (Q1, Q2…). For each: the question, the options you see with their evidence (paths), and your recommendation. Then wait.
- Ask only about the uncertainties, the boundary terms among the glossary candidates, and what the map marks as a guess. What you can check in the code, check yourself.
- Order: boundaries, then ownership, relations, contracts, direction, hotspots, terms. A question whose answer depends on an open one waits.
- "Don't know" or "ask X": record it in the uncertainties as `ask <X>` and move on.
- After each answer, update the files at once and say in one line what changed. The answer may settle more than the question (a relation's pattern, a term): update that too, and when it settles part of a later question, ask only the rest.

**Terms.** Confirm only boundary terms now: the same word with different meanings, or a code name that differs from the business name. Each confirmed term goes to `.agentic/glossary-confirmed.md` in this form:

```markdown
**<Term>** (code: `<CodeName>`, business: <name the business uses>) — <definition, 1–2 sentences>.
_Avoid_: <synonyms not to use>. ≠ <Term> in <other context>, when it exists there with another meaning.
```

The rest stays in the candidates: the glossary grows from later work, not up front.

**Before you finish:**

1. Check that every path in the map exists.
2. List every relation without evidence (import, client, configuration).
3. Check the sizes (index ≤ ~100 lines, context file ≤ ~200); over the limit, propose a split.
4. Summarize: what changed, the remaining `ask <X>` items, and a checklist for a 15-minute team review — the 5–10 statements in the map most worth a second pair of eyes.
