import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { fingerprint, type Finding, type ReviewReport } from '../src/review/findings.js';
import { applyFrozenScope, inChangedLines, parseChangedLines, type FrozenScope } from '../src/review/scope.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { reviewSummary } from '../src/orchestrator/state.js';
import { committedRepo, tmpDir, TEST_CONFIG, QUOTED } from './helpers.js';

const DIFF = [
  'diff --git a/src/A.java b/src/A.java',
  '--- a/src/A.java',
  '+++ b/src/A.java',
  '@@ -10,2 +10,3 @@ class A {',
  '@@ -40 +41 @@',
  '@@ -60,4 +61,0 @@',
  'diff --git a/src/Gone.java b/src/Gone.java',
  '--- a/src/Gone.java',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
].join('\n');

describe('changed lines of a round', () => {
  it('reads the new-side ranges of each hunk; a deletion sits after its line, a deleted file has none', () => {
    expect([...parseChangedLines(DIFF)]).toEqual([['src/A.java', [[10, 12], [41, 41], [61, 62]]]]);
  });

  it('a finding is in scope within 3 lines of a changed line', () => {
    const changed = parseChangedLines(DIFF);
    const at = (line: number, file = 'src/A.java') => inChangedLines({ id: 'X', severity: 'blocking', message: 'm', file, line }, changed);
    expect([at(7), at(15), at(44), at(65)]).toEqual([true, true, true, true]);
    expect([at(6), at(16), at(30), at(66), at(10, 'src/B.java')]).toEqual([false, false, false, false, false]);
  });
});

const finding = (overrides: Partial<Finding>): Finding => ({
  id: 'F1',
  severity: 'blocking',
  message: 'm',
  file: 'src/A.java',
  line: 11,
  quote: 'q',
  weight: 'medium',
  impact: 'i',
  basis: { type: 'standard', ref: 'AG-CODE-01' },
  verdict: { status: 'confirmed' },
  ...overrides,
});
const report = (findings: Finding[]): ReviewReport => ({ findings, blocking: findings });

describe('frozen scope', () => {
  const previous = [finding({ id: 'F1', line: 80, quote: 'old one' }), finding({ id: 'F2', line: 90, quote: 'old two' })];
  const scope = (overrides: Partial<FrozenScope> = {}): FrozenScope => ({ sinceRound: 1, previous, changed: parseChangedLines(DIFF), setAside: new Set(), ...overrides });

  it('carries open findings judged not fixed — or without a verdict — as they were, and drops fixed ones', () => {
    const result = applyFrozenScope(report([]), [{ id: 'F1', status: 'fixed' }], scope());
    expect(result.findings).toMatchObject([{ id: 'F2', carried_from: 1 }]);
    expect(fingerprint(result.findings[0]!)).toBe(fingerprint(previous[1]!));
    expect(result.blocking).toHaveLength(1);
  });

  it('rejects a new blocking finding outside the changed lines as out of scope; nits and re-reports stay', () => {
    const outside = finding({ id: 'N1', line: 30 });
    const inside = finding({ id: 'N2', line: 11, quote: 'new' });
    const nit = finding({ id: 'N3', line: 30, severity: 'nit' });
    const reReport = { ...previous[0]!, id: 'N4' };
    const result = applyFrozenScope(report([outside, inside, nit, reReport]), [{ id: 'F1', status: 'fixed' }, { id: 'F2', status: 'fixed' }], scope());
    expect(result.findings.map((entry) => [entry.id, entry.verdict?.status, entry.verdict?.out_of_scope])).toEqual([
      ['N1', 'rejected', true],
      ['N2', 'confirmed', undefined],
      ['N3', 'confirmed', undefined],
      ['N4', 'confirmed', undefined],
    ]);
    expect(result.blocking.map((entry) => entry.id)).toEqual(['N2', 'N4']);
  });

  it('a carried finding reported again is kept once; a new finding reusing its id is renamed', () => {
    const repeated = { ...previous[1]!, id: 'X9' };
    const sameId = finding({ id: 'F2', line: 11, quote: 'new' });
    const result = applyFrozenScope(report([repeated, sameId]), [{ id: 'F1', status: 'fixed' }], scope());
    expect(result.findings.map((entry) => entry.id)).toEqual(['F2', 'r2-F2']);
  });

  it('a finding set aside earlier is not rejected: the loop filters it', () => {
    const setAside = finding({ id: 'S1', line: 30, quote: 'set aside' });
    const result = applyFrozenScope(report([setAside]), [], scope({ previous: [], setAside: new Set([fingerprint(setAside)]) }));
    expect(result.findings[0]!.verdict).toEqual({ status: 'confirmed' });
  });
});

const blocking = {
  findings: [{ id: 'B1', severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};
// a new finding at the same unchanged line, under another basis
const unchangedLine = { id: 'N1', severity: 'blocking', message: 'inny problem', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'defect', scenario: 'a → b' } };

function setup(script: FakeScript, gates: Record<string, GateDecision[]> = {}, options: { config: AgenticConfig } = { config: TEST_CONFIG }) {
  const root = tmpDir();
  const harnesses = fakeRegistry({ fix: { commit: { 'Fix.java': 'class Fix {}\n' } }, ...script });
  const scripted = new ScriptedGates(gates);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
  const run = () => runFlow({ workDir, config: options.config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: scripted });
  const reviews = () => harnesses.calls().filter((call) => call.kind === 'review-spec' && call.group === 'g1');
  return { run, reviews, gates: scripted };
}

describe('frozen scope in the review loop', () => {
  it('round 2 reviews the diff since round 1; a new finding on unchanged code is out of scope', async () => {
    const { run, reviews } = setup({
      'review-spec': (request, call) => ({
        report: request.group !== 'g1' ? { findings: [] } : call === 1 ? blocking : { findings: [unchangedLine], previous: [{ id: 'B1', status: 'fixed' }] },
      }),
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [first, second] = reviews();
    const [roundOne] = state.groups.g1!.review!.rounds;
    expect(first!.prompt).toContain(`Review scope: the commits of this group — \`git diff ${state.groups.g1!.baseRef}..HEAD\``);
    expect(second!.prompt).toContain(`\`git diff ${roundOne!.commit}..HEAD\``);
    expect(second!.prompt).toContain('"id": "B1"');
    expect(reviewSummary(state.groups.g1!)).toBe('rounds 2, open blocking 0, nits 0, out of scope 1');
  });

  it('an open finding the reviewer judges not fixed stays open', async () => {
    const { run, gates } = setup(
      { 'review-spec': (request, call) => ({ report: request.group !== 'g1' ? { findings: [] } : call === 1 ? blocking : { findings: [], previous: [{ id: 'B1', status: 'not_fixed' }] } }) },
      { group: [{ action: 'stop' }] },
    );
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'human', group: 'g1' });
    expect(gates.seen.at(-1)!.summary).toMatch(/1 open blocking finding after 2 rounds/);
    expect(state.groups.g1!.review!.rounds[1]!.findings).toMatchObject([{ id: 'B1', carried_from: 1 }]);
  });
});

describe('axis without a new diff', () => {
  it('is skipped when the fixer committed nothing; its findings carry over', async () => {
    const { run, reviews } = setup(
      { 'review-spec': (request) => ({ report: request.group === 'g1' ? blocking : { findings: [] } }), fix: { report: { findings: [{ id: 'B1', status: 'escalated', reason: 'needs a redesign' }] } } },
      { group: [{ action: 'stop' }] },
    );
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'human', group: 'g1' });
    expect(reviews()).toHaveLength(1);
    const [roundOne, roundTwo] = state.groups.g1!.review!.rounds;
    expect(roundOne!.reviewers).toMatchObject({ spec: `${TEST_CONFIG.review.spec!.harness}:${TEST_CONFIG.review.spec!.model}` });
    expect(roundTwo).toMatchObject({ commit: roundOne!.commit, skipped: ['spec', 'standards'], findings: [{ id: 'B1', carried_from: 1 }] });
  });

  it('runs again with another model on the same code', async () => {
    const options = { config: { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, max_rounds: 1 } } };
    const { run, reviews } = setup(
      { 'review-spec': (request) => ({ report: request.group === 'g1' ? blocking : { findings: [] } }), fix: { report: { findings: [{ id: 'B1', status: 'escalated', reason: 'needs a redesign' }] } } },
      { group: [{ action: 'stop' }, { action: 'retry', note: 'jeszcze raz' }, { action: 'stop' }] },
      options,
    );
    expect((await run()).paused).toMatchObject({ reason: 'human', group: 'g1' });
    options.config = { ...options.config, review: { ...options.config.review, spec: { harness: 'claude', model: 'opus', effort: 'high' } } };
    const state = await run();
    expect(reviews()).toHaveLength(2);
    expect(state.groups.g1!.review!.rounds[1]).toMatchObject({ reviewers: { spec: 'claude:opus' } });
    // standards kept its model: still skipped
    expect(state.groups.g1!.review!.rounds[1]!.skipped).toEqual(['standards']);
  });
});
