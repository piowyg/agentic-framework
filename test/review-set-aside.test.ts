import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { openFindings, roundRecord } from '../src/orchestrator/state.js';
import { committedRepo, tmpDir, TEST_CONFIG, QUOTED } from './helpers.js';

const blocking = {
  findings: [{ id: 'B1', severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};
const clean = { findings: [] };
const fixReport = (entry: Record<string, unknown>) => ({ report: { findings: [{ id: 'B1', ...entry }] } });

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const fixes = () => harnesses.calls().filter((call) => call.kind === 'fix' && call.group === 'g1');
  return { harnesses, gates, run, fixes, workDir };
}

/** g1's spec reviewer keeps reporting B1 (the code it quotes never changes); g2 is clean. */
const g1Blocking: FakeScript['review-spec'] = (request) => ({ report: request.group === 'g1' ? blocking : clean });

describe('findings the fixer sets aside', () => {
  it('a disputed finding stops the group after the next round; accepting the dispute passes the group', async () => {
    const { gates, run, fixes, workDir, harnesses } = setup({
      script: { 'review-spec': g1Blocking, fix: fixReport({ status: 'disputed', disputed_on: 'finding', reason: 'the amount is validated upstream' }) },
      gates: { group: [{ action: 'continue' }] },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(fixes()).toHaveLength(1);
    const decision = gates.seen.find((request) => request.gate === 'group' && request.group === 'g1')!;
    expect(decision.summary).toContain('fixer disputed B1 (the amount is validated upstream)');
    // the disputed finding is out of the open ones, but the gate still counts it
    expect(decision.summary).toContain('0 open blocking findings and 1 disputed after 2 rounds');
    expect(decision.summary).toContain('continue = accept the dispute');
    // round 2 had no new diff to review: the reports to read are still round 1's
    expect(decision.summary).toContain('see fix-g1-r1.json, review-spec-g1-r1.json, review-standards-g1-r1.json');
    const g1 = state.groups.g1!;
    expect(g1.review!.rounds).toHaveLength(2);
    expect(g1.set_aside).toMatchObject([{ kind: 'disputed', ruling: 'accepted', fixRound: 1, finding: { id: 'B1' } }]);
    expect(openFindings(g1)).toHaveLength(0);
    // the final reviewer reads how the dispute was ruled
    const summary = fs.readFileSync(path.join(workDir, 'review-summary-g1.md'), 'utf8');
    expect(summary).toContain('B1 src/Cart.java:2 — disputed by the fixer (accepted): the amount is validated upstream');
    const finalPrompt = harnesses.calls().find((call) => call.kind === 'review-final')!.prompt;
    expect(finalPrompt).toContain(path.join(workDir, 'review-summary-g1.md'));
    expect(finalPrompt).toContain(path.join(workDir, 'review-spec-g1-r1.json'));
    expect(finalPrompt).not.toContain('review-spec-g1-r2.json');
  });

  it('“fix it” sends the disputed finding back; a second dispute goes back to the same session', async () => {
    const { run, fixes } = setup({
      script: {
        'review-spec': (request, call) => ({ report: request.group === 'g1' && call <= 2 ? blocking : clean }),
        fix: (_request, call) =>
          call <= 2 ? fixReport({ status: 'disputed', disputed_on: 'finding', reason: 'not a bug' }) : { ...fixReport({ status: 'fixed' }), commit: { 'B1.txt': 'x\n' } },
      },
      gates: { group: [{ action: 'retry', note: 'napraw B1' }] },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [first, ruled, resumed] = fixes();
    expect(first!.prompt).not.toContain('may not dispute');
    expect(ruled!.prompt).toContain('A human ruled that B1 must be fixed');
    expect(ruled!.prompt).toContain('napraw B1');
    expect(resumed!.prompt).toContain('do not dispute them again');
    expect(resumed!.resumeSessionId).toBe(ruled!.sessionId);
    expect(state.groups.g1!.set_aside).toBeUndefined();
  });

  it('a disputed weight and an unreproduced defect only go to the gate report', async () => {
    for (const entry of [
      { status: 'disputed', disputed_on: 'severity', reason: 'a cosmetic issue' },
      { status: 'not_reproduced', reason: 'the test passes', regression_test: 'CartTest#negative' },
    ]) {
      const { gates, run, fixes } = setup({
        config: { autonomy: 'strict' },
        script: { 'review-spec': g1Blocking, fix: fixReport(entry) },
      });
      const state = await run();
      expect(state.status).toBe('done');
      expect(fixes()).toHaveLength(1);
      const gate = gates.seen.find((request) => request.gate === 'group' && request.group === 'g1')!;
      expect(gate.actions).toContain('continue');
      expect(gate.summary).toContain('Set aside by the fixer:');
      expect(gate.summary).toContain(entry.status === 'not_reproduced' ? 'not reproduced (test: CartTest#negative): the test passes' : 'weight disputed: a cosmetic issue');
      expect(gate.summary).toContain('set aside 1');
    }
  });

  it('without `disputed` in stop_on a dispute only goes to the gate report', async () => {
    const { gates, run } = setup({
      config: { autonomy: 'strict', review: { ...TEST_CONFIG.review, stop_on: [] } },
      script: { 'review-spec': g1Blocking, fix: fixReport({ status: 'disputed', disputed_on: 'finding', reason: 'not a bug' }) },
    });
    expect((await run()).status).toBe('done');
    const gate = gates.seen.find((request) => request.gate === 'group' && request.group === 'g1')!;
    expect(gate.summary).toContain('disputed by the fixer (no ruling): not a bug');
  });
});

describe('review summary', () => {
  it('lists an escalated finding a human let through, with the fixer’s reason', async () => {
    const { run, workDir } = setup({
      script: { 'review-spec': g1Blocking, fix: fixReport({ status: 'escalated', reason: 'the spec moved AC-1 to another ticket' }) },
      gates: { group: [{ action: 'continue' }] },
    });
    expect((await run()).status).toBe('done');
    const summary = fs.readFileSync(path.join(workDir, 'review-summary-g1.md'), 'utf8');
    expect(summary).toContain('Open, let through by a human:\n- B1 src/Cart.java:2 — brak walidacji (fixer escalation: the spec moved AC-1 to another ticket)');
  });
});

describe('finding ids in a round', () => {
  it('the same id from two axes gets the axis in front, so the fixer can answer by id', () => {
    const finding = { id: 'F1', severity: 'blocking' as const, message: 'm' };
    const record = roundRecord(1, { spec: { findings: [finding], blocking: [] }, standards: { findings: [finding, { ...finding, id: 'F2' }], blocking: [] } });
    expect(record.findings.map((entry) => entry.id)).toEqual(['spec/F1', 'standards/F1', 'F2']);
  });
});
