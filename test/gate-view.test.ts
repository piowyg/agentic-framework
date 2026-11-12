import { describe, expect, it } from 'vitest';
import { parseTasks } from '../src/orchestrator/artifacts.js';
import { PLAIN, renderGate, wrap, type Styles } from '../src/cli/gate-view.js';
import { plural } from '../src/plural.js';
import type { GateView } from '../src/orchestrator/gates.js';

const PLAN = parseTasks(`groups:
  - id: g1
    repo: .
    title: admission paging API
    summary: Paginacja kursorem w API zaproszeń
    rationale: Backend first, because the panel depends on the HTTP contract.
    tasks:
      - id: t1
        title: Repository port and both adapters. Add InvitationKey and the seek queries.
        summary: Port repozytorium i oba adaptery
        tier: standard
        acceptance: [AC-3]
      - id: t2
        title: Paged facade, wiring and HTTP in one step. Add the cursor codec.
        tier: domain
        acceptance: [AC-1, AC-2]
  - id: g2
    repo: web
    rationale: The panel section on top of g1's contract.
    depends_on: [g1]
    tasks:
      - { id: t1, title: Invited students section, tier: standard, acceptance: [AC-4] }
`);

const breakdown: GateView = { kind: 'breakdown', file: '/flow/tasks.yaml', groups: PLAN.groups, acceptance: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], warnings: [] };

describe('gate view', () => {
  it('breakdown: counts, the human summary leads, agent details follow under their item', () => {
    const lines = renderGate('breakdown', undefined, breakdown, PLAIN, 100).split('\n');
    expect(lines[0]).toBe('━━ Gate: breakdown ━━  2 groups · 3 tasks · covers AC-1, AC-2, AC-3, AC-4');
    expect(lines).toContain('▸ g1  Paginacja kursorem w API zaproszeń  standard');
    expect(lines).toContain('  admission paging API');
    expect(lines).toContain('  ├─ t1   standard   Port repozytorium i oba adaptery  AC-3');
    expect(lines).toContain('  │                  Repository port and both adapters. Add InvitationKey and the seek queries.');
    // without a summary the first sentence leads, the rest is detail
    expect(lines).toContain('  └─ t2   domain     Paged facade, wiring and HTTP in one step.  AC-1 AC-2');
    expect(lines).toContain('                     Add the cursor codec.');
    // without a title the rationale leads
    expect(lines).toContain('▸ g2  The panel section on top of g1\'s contract.  repo web · standard · after g1');
    expect(lines.at(-1)).toBe('Full plan: /flow/tasks.yaml');
  });

  it('breakdown: each group’s estimate beside it; one over a threshold is flagged with its reason', () => {
    const estimated = parseTasks(`groups:
  - { id: g1, repo: ., summary: Port, rationale: r, estimate: { prod: 120, tests: 200 }, tasks: [{ id: t1, title: x, tier: standard }] }
  - { id: g2, repo: ., summary: Migracja, rationale: r, depends_on: [g1], estimate: { prod: 520, tests: 100 }, oversize_reason: one migration with its backfill, tasks: [{ id: t1, title: y, tier: standard }] }
  - { id: g3, repo: ., summary: Panel, rationale: r, depends_on: [g2], estimate: { prod: 300, tests: 600 }, tasks: [{ id: t1, title: z, tier: standard }] }
`);
    const view = { ...breakdown, groups: estimated.groups, limits: { prod: 400, total: 800 } };
    const lines = renderGate('breakdown', undefined, view, PLAIN, 100).split('\n');
    expect(lines).toContain('▸ g1  Port  standard · ~120 prod / 200 test');
    expect(lines).toContain('  ⚠ over the publish.size threshold (400 prod, 800 with tests): one migration with its backfill');
    expect(lines).toContain('  ⚠ over the publish.size threshold (400 prod, 800 with tests) with no reason given');
    // a plan from before estimates shows none
    expect(renderGate('breakdown', undefined, { ...breakdown, limits: { prod: 400, total: 800 } }, PLAIN)).not.toContain('prod');
  });

  it('long text wraps within the terminal width, under its item', () => {
    const long = parseTasks(`groups:
  - id: g1
    repo: .
    rationale: r
    tasks:
      - { id: t1, title: ${'word '.repeat(60).trim()}, summary: Krótko, tier: standard, acceptance: [AC-1] }
`);
    const lines = renderGate('breakdown', undefined, { ...breakdown, groups: long.groups, acceptance: ['AC-1'] }, PLAIN, 60).split('\n');
    const details = lines.filter((line) => line.includes('word'));
    expect(details.length).toBeGreaterThan(3);
    for (const line of details) {
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line.startsWith('                     word')).toBe(true);
    }
  });

  it('a long criteria list goes under the task title instead of squeezing it', () => {
    const many = Array.from({ length: 11 }, (_, index) => `AC-${index + 1}`);
    const long = parseTasks(`groups:
  - id: g1
    repo: .
    rationale: r
    tasks:
      - { id: t1, title: Full course refused as course_full, tier: domain, acceptance: [${many.join(', ')}] }
`);
    const lines = renderGate('breakdown', undefined, { ...breakdown, groups: long.groups, acceptance: many }, PLAIN, 80).split('\n');
    expect(lines).toContain('  └─ t1   domain     Full course refused as course_full');
    const criteria = lines.filter((line) => /^ {21}AC-/.test(line));
    expect(criteria.join(' ').split(/\s+/).filter(Boolean)).toEqual(many);
    for (const line of criteria) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('a long group headline wraps, the meta stays on its first line', () => {
    const long = parseTasks(`groups:
  - id: g1
    repo: .
    tier: domain
    summary: ${'słowo '.repeat(30).trim()}
    rationale: r
    tasks:
      - { id: t1, title: t, acceptance: [AC-1] }
`);
    const lines = renderGate('breakdown', undefined, { ...breakdown, groups: long.groups, acceptance: ['AC-1'] }, PLAIN, 60).split('\n');
    const headline = lines.filter((line) => line.includes('słowo'));
    expect(headline.length).toBeGreaterThan(2);
    expect(headline[0]).toMatch(/^▸ g1  słowo .*  domain$/);
    for (const line of headline) expect(line.length).toBeLessThanOrEqual(60);
    for (const line of headline.slice(1)) expect(line.startsWith('    słowo')).toBe(true);
  });

  it('agent text cannot move the cursor or break the layout', () => {
    const hostile = parseTasks(`groups:
  - id: g1
    repo: .
    rationale: r
    summary: "Grupa\\u001b[2J\\nfałszywa linia"
    tasks:
      - { id: t1, title: t, tier: standard }
`);
    const view = renderGate('breakdown', undefined, { ...breakdown, groups: hostile.groups, acceptance: [] }, PLAIN);
    expect(view).not.toContain('\u001b');
    expect(view).toContain('▸ g1  Grupa fałszywa linia');
  });

  it('ticket and spec: title, summary, facts and the file', () => {
    const view: GateView = { kind: 'document', file: '/flow/spec.md', title: 'Spec: paginacja', summary: 'Cursor zamiast numerów stron.', facts: ['repositories: .'] };
    expect(renderGate('spec', undefined, view, PLAIN)).toBe(
      ['━━ Gate: spec ━━  Spec: paginacja', '', 'Cursor zamiast numerów stron.', '', 'repositories: .', 'File: /flow/spec.md'].join('\n'),
    );
    expect(renderGate('ticket', undefined, { ...view, summary: undefined }, PLAIN)).toContain('(no summary; see the file)');
  });

  it('styles: the summary bold, details dim', () => {
    const marked: Styles = { bold: (text) => `*${text}*`, dim: (text) => `_${text}_`, warn: (text) => `!${text}!` };
    const view = renderGate('breakdown', undefined, { ...breakdown, warnings: ['oversized'] }, marked);
    expect(view).toContain('*Port repozytorium i oba adaptery*_  AC-3_');
    expect(view).toContain('!⚠ oversized!');
  });

  it('plurals and word wrap', () => {
    expect([0, 1, 2, 12].map((count) => plural(count, 'group', 'groups'))).toEqual(['0 groups', '1 group', '2 groups', '12 groups']);
    expect(wrap('aa bb cc dd', 25, '  ')).toEqual(['  aa bb cc dd']);
    expect(wrap('', 30, '  ')).toEqual(['  ']);
  });
});
