import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import type { Finding } from '../src/review/findings.js';
import { rejectionCounts, stopReasons } from '../src/review/stop.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { roundRecord, type ReviewLoopState, type RoundRecord } from '../src/orchestrator/state.js';
import { committedRepo, tmpDir, TEST_CONFIG, QUOTED } from './helpers.js';

const finding = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id,
  severity: 'blocking',
  message: `problem ${id}`,
  file: 'src/A.java',
  line: 1,
  quote: `code ${id}`,
  basis: { type: 'standard', ref: 'AG-CODE-01' },
  verdict: { status: 'confirmed' },
  ...overrides,
});

function round(number: number, findings: Finding[], extra: Partial<RoundRecord> = {}): RoundRecord {
  return { ...roundRecord(number, { standards: { findings, blocking: [] } }), ...extra };
}

const loop = (...rounds: RoundRecord[]): ReviewLoopState => ({ review: { rounds } });
const triggers = (state: ReviewLoopState, ...on: Parameters<typeof stopReasons>[0]) => stopReasons(on, state).map((reason) => reason.trigger);

describe('stop_on triggers', () => {
  it('repeated_finding: a finding the fixer reported fixed is open again', () => {
    const first = round(1, [finding('A'), finding('B')]);
    first.fixed = [first.findings[0]!.fingerprint];
    expect(triggers(loop(first, round(2, [finding('A')])), 'repeated_finding')).toEqual(['repeated_finding']);
    expect(triggers(loop(first, round(2, [finding('B')])), 'repeated_finding')).toEqual([]);
    expect(stopReasons(['repeated_finding'], loop(first, round(2, [finding('A')])))[0]!.detail).toBe('came back after the fix: A');
  });

  it('no_progress: every open finding of the previous round is still open; set-aside ones left the loop', () => {
    const first = round(1, [finding('A'), finding('B')]);
    expect(triggers(loop(first, round(2, [finding('A'), finding('B'), finding('C')])), 'no_progress')).toEqual(['no_progress']);
    expect(triggers(loop(first, round(2, [finding('A')])), 'no_progress')).toEqual([]);
    const setAside: ReviewLoopState = { ...loop(first, round(2, [finding('A')])), set_aside: [{ kind: 'severity', finding: first.findings[1]!, reason: 'r', fixRound: 1 }] };
    expect(triggers(setAside, 'no_progress')).toEqual(['no_progress']);
  });

  it('diff_growth: the scope’s diff outgrew round 1 by more than x', () => {
    const first = round(1, [finding('A')], { diff_lines: 100 });
    expect(triggers(loop(first, round(2, [finding('A')], { diff_lines: 151 })), { diff_growth: 1.5 })).toEqual(['diff_growth']);
    expect(triggers(loop(first, round(2, [finding('A')], { diff_lines: 150 })), { diff_growth: 1.5 })).toEqual([]);
    // nothing open: the growth doesn't matter
    expect(triggers(loop(first, round(2, [], { diff_lines: 400 })), { diff_growth: 1.5 })).toEqual([]);
  });

  it('rejection_rate: counted from 3 written blocking findings, even with nothing left open', () => {
    const rejected = (id: string) => finding(id, { verdict: { status: 'rejected', reason: 'cytat' } });
    expect(triggers(loop(round(1, [rejected('A'), rejected('B')])), { rejection_rate: 0.5 })).toEqual([]);
    expect(triggers(loop(round(1, [rejected('A'), rejected('B'), finding('C')])), { rejection_rate: 0.5 })).toEqual(['rejection_rate']);
    expect(triggers(loop(round(1, [rejected('A'), finding('B'), finding('C')])), { rejection_rate: 0.5 })).toEqual([]);
  });

  it('rejection counts leave out carried and out-of-scope findings; downgraded ones count', () => {
    const counted = round(2, [
      finding('A', { carried_from: 1 }),
      finding('B', { verdict: { status: 'rejected', reason: 'poza', out_of_scope: true } }),
      finding('C', { severity: 'nit', degraded: 'reguła nie istnieje', verdict: { status: 'rejected', reason: 'reguła' } }),
      finding('D'),
      finding('E', { severity: 'nit' }),
    ]);
    expect(rejectionCounts(counted)).toEqual({ reported: 2, rejected: 1 });
  });
});

const blocking = (id: string, quote = QUOTED.quote) => ({ id, severity: 'blocking', message: `m ${id}`, ...QUOTED, quote, weight: 'medium', impact: 'x', basis: { type: 'defect', scenario: `s ${id}` } });

function setup(script: FakeScript, gates: Record<string, GateDecision[]>, review: Partial<AgenticConfig['review']> = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(script);
  const scripted = new ScriptedGates(gates);
  const config = deepMerge(TEST_CONFIG, { review: { ...TEST_CONFIG.review, ...review } }) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(path.join(root, 'repo')) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: scripted });
  return { run, gates: scripted, harnesses };
}

describe('stop_on in the review loop', () => {
  it('a finding back after its fix stops the loop before the round limit', async () => {
    const { run, gates, harnesses } = setup(
      {
        'review-spec': (request, call) => ({
          report: request.group !== 'g1' ? { findings: [] } : call === 1 ? { findings: [blocking('B1')] } : { findings: [], previous: [{ id: 'B1', status: 'not_fixed' }] },
        }),
        fix: { report: { findings: [{ id: 'B1', status: 'fixed' }] }, commit: { 'Fix.java': 'x\n' } },
      },
      { group: [{ action: 'stop' }] },
      { max_rounds: 5 },
    );
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'human', group: 'g1' });
    expect(harnesses.calls().filter((call) => call.kind === 'fix' && call.group === 'g1')).toHaveLength(1);
    const summary = gates.seen.find((gate) => gate.group === 'g1')!.summary;
    expect(summary).toContain('stop_on repeated_finding: came back after the fix: B1');
    expect(summary).toContain('stop_on no_progress: the round fixed nothing');
    expect(state.groups.g1!.review!.rounds[0]!.diff_lines).toBeGreaterThan(0);
  });

  it('a noisy round stops for a human even with nothing left open', async () => {
    const wrongQuote = (id: string) => blocking(id, `not in the file ${id}`);
    const { run, gates } = setup(
      { 'review-spec': (request) => ({ report: request.group === 'g1' ? { findings: [wrongQuote('A'), wrongQuote('B'), blocking('C')] } : { findings: [] } }), fix: { report: { findings: [{ id: 'C', status: 'fixed' }] } } },
      { group: [{ action: 'continue' }] },
    );
    const state = await run();
    expect(state.status).toBe('done');
    const summary = gates.seen.find((gate) => gate.group === 'g1')!.summary;
    expect(summary).toContain('stop_on rejection_rate: rejected 2 of 3 blocking findings (limit 50%)');
    // the human stopped it after round 1, before any fix
    expect(state.groups.g1!.review!.rounds).toHaveLength(1);
  });
});
