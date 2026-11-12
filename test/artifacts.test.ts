import { describe, expect, it } from 'vitest';
import { ArtifactError, groupTier, parseTasks, topoOrder, validateSpec, validateTicket, type BreakdownRules } from '../src/orchestrator/artifacts.js';
import { prSummaryLanguage } from '../src/config/language.js';
import { FAKE_TASKS, FAKE_TICKET } from '../src/harness/fake.js';

const ticket = validateTicket(FAKE_TICKET);

function problems(yaml: string): string[] {
  try {
    parseTasks(yaml, ticket);
    return [];
  } catch (error) {
    return (error as ArtifactError).problems;
  }
}

describe('ticket.md', () => {
  it('extracts AC and requires status: ready', () => {
    expect(ticket.acceptance).toEqual(['AC-1', 'AC-2']);
    expect(() => validateTicket('# brak frontmattera\n- AC-1: x')).toThrow(/status: ready/);
  });
});

describe('tasks.yaml', () => {
  it('valid file', () => {
    const file = parseTasks(FAKE_TASKS, ticket);
    expect(topoOrder(file.groups).map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(groupTier(file.groups[0]!)).toBe('domain');
  });

  it('task executor uses the config executor schema', () => {
    const withExecutor = (executor: string) =>
      problems(`groups:\n  - { id: g1, repo: ., rationale: r, tasks: [{ id: t1, title: a, tier: standard, acceptance: [AC-1, AC-2], executor: ${executor} }] }\n`);
    expect(withExecutor('{ model: sonnet, effort: xhigh }')).toEqual([]);
    expect(withExecutor('{ effort: turbo }')).toEqual(['groups[0].tasks[0].executor.effort: allowed values: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`']);
    expect(withExecutor('{ modle: sonnet }')).toEqual(['groups[0].tasks[0].executor.modle: unknown field (did you mean `model`?)']);
  });

  it('unknown dependency, cycle, AC outside the ticket, missing tier, uncovered AC', () => {
    expect(problems('groups:\n  - { id: g1, repo: ., rationale: r, depends_on: [gx], tasks: [{ id: t1, title: a, tier: standard, acceptance: [AC-1, AC-2] }] }\n')).toEqual([
      'g1.depends_on: unknown group `gx`',
    ]);
    expect(
      problems(`groups:
  - { id: a, repo: ., rationale: r, depends_on: [b], tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
  - { id: b, repo: ., rationale: r, depends_on: [a], tasks: [{ id: t1, title: y, tier: standard }] }
`),
    ).toEqual(['dependency cycle: a → b → a']);
    expect(problems('groups:\n  - { id: g1, repo: ., rationale: r, tasks: [{ id: t1, title: a, acceptance: [AC-1, AC-9] }] }\n')).toEqual([
      'g1.t1: no `tier` (neither on the task nor on the group)',
      'g1.t1: `AC-9` does not exist in ticket.md',
      'criteria without tasks: AC-2',
    ]);
  });

  it('text cut off by a YAML comment is rejected; a spaced comment is fine', () => {
    const titled = (title: string) => `groups:
  - id: g1 # first group
    repo: .
    rationale: r
    tasks:
      - id: t1
        title: ${title}
        tier: standard
        acceptance: [AC-1, AC-2]
`;
    expect(problems(titled('client function (panel UI moves to #10)'))).toEqual([
      '`client function (panel UI moves to` loses `#10)`: YAML reads ` #` as a comment; quote the value',
    ]);
    expect(problems(titled('"client function (panel UI moves to #10)"'))).toEqual([]);
    expect(problems(titled('client function # the agent left a note'))).toEqual([]);
  });

  it('unknown field and wrong class', () => {
    const found = problems('groups:\n  - { id: g1, repo: ., rationale: r, tasks: [{ id: t1, title: a, tier: hard, model: opus }] }\n');
    expect(found).toContain('groups[0].tasks[0].model: unknown field');
    expect(found.some((problem) => problem.startsWith('groups[0].tasks[0].tier: allowed values'))).toBe(true);
  });
});

describe('spec.md: what the grill writes today', () => {
  const sections = ['Decisions', 'Affected repos', 'Contracts', 'Test seams', 'Risks', 'Out of scope'];
  const spec = (frontmatter: string, assets = '## External assets\n\nNone\n') =>
    `---\nstatus: ready\nsummary: "Po polsku."\n${frontmatter}---\n# x\n\n${sections.map((section) => `## ${section}\n\n- .\n`).join('\n')}\n${assets}`;

  it('pr_summary is required in the PR language only when the grill was asked for it', () => {
    expect(() => validateSpec(spec(''), undefined, { prSummary: 'en' })).toThrow(/no `pr_summary` \(a summary in `en`/);
    expect(validateSpec(spec('pr_summary: "In English."\n'), undefined, { prSummary: 'en' })).toMatchObject({ summary: 'Po polsku.', prSummary: 'In English.' });
    expect(() => validateSpec(spec(''))).not.toThrow();
  });

  it('External assets is required of a spec the grill has just written, not of one a flow resumes on', () => {
    expect(() => validateSpec(spec('', ''), undefined, {})).toThrow(/missing section `## External assets`/);
    expect(validateSpec(spec('', '')).externalAssets).toEqual([]);
    expect(validateSpec(spec(''), undefined, {}).externalAssets).toEqual([]);
  });

  it('External assets: each top-level bullet whole, for the spec gate', () => {
    const assets = '## External assets\n\n- Noto Sans TTF (github.com/notofonts) — the human commits it to `public/fonts`\n  - regular and bold\n- `pdfjs-dist` 6.4 from npm\n';
    expect(validateSpec(spec('', assets)).externalAssets).toEqual(['Noto Sans TTF (github.com/notofonts) — the human commits it to `public/fonts`', '`pdfjs-dist` 6.4 from npm']);
  });

  it('the PR language follows the artifacts unless set; a summary in it is needed when the conversation differs', () => {
    expect(prSummaryLanguage({ artifacts: 'en', conversation: 'pl' })).toBe('en');
    expect(prSummaryLanguage({ artifacts: 'en', conversation: 'pl', pr: 'pl' })).toBeUndefined();
    expect(prSummaryLanguage({ artifacts: 'en' })).toBeUndefined();
    expect(prSummaryLanguage({ artifacts: 'pl', pr: 'en' })).toBe('en');
  });
});

describe('tasks.yaml: what the breakdown writes today', () => {
  const FRESH: BreakdownRules = { limits: { prod: 400, total: 800 }, stack: true };
  const fresh = (yaml: string, rules: BreakdownRules = FRESH) => {
    try {
      parseTasks(yaml, ticket, rules);
      return [];
    } catch (error) {
      return (error as ArtifactError).problems;
    }
  };
  const group = (id: string, fields = '') =>
    `  - { id: ${id}, repo: ., rationale: r, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }]${fields} }\n`;

  it('a plan just written without an estimate goes back to the breakdown', () => {
    expect(fresh(`groups:\n${group('g1')}`)).toEqual(['g1: no `estimate` (line estimate: `prod`, `tests`)']);
  });

  it('a plan a flow resumes on needs no estimate', () => {
    expect(problems(`groups:\n${group('g1')}`)).toEqual([]);
  });

  it('the estimate is read as written', () => {
    expect(parseTasks(`groups:\n${group('g1', ', estimate: { prod: 120, tests: 200 }')}`, ticket, FRESH).groups[0]!.estimate).toEqual({ prod: 120, tests: 200 });
  });

  it.each([
    ['over the production threshold', '{ prod: 401, tests: 0 }', '', ['g1: estimate 401 prod / 0 test over the `publish.size` threshold (400 prod, 800 with tests) without `oversize_reason`']],
    ['over the total threshold', '{ prod: 300, tests: 501 }', '', ['g1: estimate 300 prod / 501 test over the `publish.size` threshold (400 prod, 800 with tests) without `oversize_reason`']],
    ['over, with a reason', '{ prod: 300, tests: 501 }', ', oversize_reason: one migration with its backfill', []],
    ['at both thresholds', '{ prod: 400, tests: 400 }', '', []],
  ])('an estimate %s: oversize_reason needed or not', (_case, estimate, reason, expected) => {
    expect(fresh(`groups:\n${group('g1', `, estimate: ${estimate}${reason}`)}`)).toEqual(expected);
  });

  it('a blank oversize_reason is no reason', () => {
    expect(fresh(`groups:\n${group('g1', ', estimate: { prod: 500, tests: 0 }, oversize_reason: " "')}`)).toHaveLength(1);
  });

  const estimate = ', estimate: { prod: 100, tests: 100 }';
  const after = (...ids: string[]) => `${estimate}, depends_on: [${ids.join(', ')}]`;
  const hint = 'the groups of one repo form a chain, each on the previous one (`publish.stack`)';

  it.each([
    ['a chain passes', `${group('g1', estimate)}${group('g2', after('g1'))}${group('g3', after('g2'))}`, []],
    ['two first groups', `${group('g1', estimate)}${group('g2', estimate)}`, [`repo \`.\`: groups without a predecessor from this repo: g1, g2 — ${hint}`]],
    ['two predecessors', `${group('g1', estimate)}${group('g2', after('g1'))}${group('g3', after('g1', 'g2'))}`, [`g3: more than one predecessor from repo \`.\` (g1, g2); ${hint}`]],
    ['a shared predecessor', `${group('g1', estimate)}${group('g2', after('g1'))}${group('g3', after('g1'))}`, [`g2, g3: a shared predecessor \`g1\` from repo \`.\`; ${hint}`]],
  ])('the groups of one repo form a chain: %s', (_case, groups, expected) => {
    expect(fresh(`groups:\n${groups}`)).toEqual(expected);
  });

  it('without a stack, groups of one repo may run side by side as before', () => {
    expect(fresh(`groups:\n${group('g1', estimate)}${group('g2', estimate)}`, { ...FRESH, stack: false })).toEqual([]);
  });

  it('two names of one repo are one chain', () => {
    const plan = `groups:\n${group('g1', estimate)}${group('g2', estimate).replace('repo: .', 'repo: shop')}`;
    const repoKey = (name: string) => (name === 'shop' ? '.' : name);
    expect(fresh(plan, { ...FRESH, repoKey })).toEqual([`repo \`.\`: groups without a predecessor from this repo: g1, g2 — ${hint}`]);
  });

  it('a plan missing estimates and a chain hears about both at once', () => {
    expect(fresh(`groups:\n${group('g1')}${group('g2')}`)).toEqual([
      `repo \`.\`: groups without a predecessor from this repo: g1, g2 — ${hint}`,
      'g1: no `estimate` (line estimate: `prod`, `tests`)',
      'g2: no `estimate` (line estimate: `prod`, `tests`)',
    ]);
  });

  it('a dependency on another repo leaves each repo its own chain', () => {
    const plan = `groups:
  - { id: api, repo: ., rationale: r, estimate: { prod: 80, tests: 60 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1] }] }
  - { id: web, repo: web, rationale: r, estimate: { prod: 90, tests: 40 }, depends_on: [api], tasks: [{ id: t1, title: y, tier: standard, acceptance: [AC-2] }] }
  - { id: web-2, repo: web, rationale: r, estimate: { prod: 30, tests: 20 }, depends_on: [web, api], tasks: [{ id: t1, title: z, tier: standard }] }
`;
    expect(fresh(plan)).toEqual([]);
  });
});
