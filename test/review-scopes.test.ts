import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TtyGates } from '../src/cli/tty-gates.js';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { loadState, saveState } from '../src/orchestrator/state.js';
import { committedRepo, tmpDir, TEST_CONFIG, QUOTED, git } from './helpers.js';


const blocking = {
  findings: [{ id: 'B1', severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};
// a later round answers on the previous round's open findings (frozen scope)
const clean = { findings: [], previous: [{ id: 'B1', status: 'fixed' }] };

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  return { repo, workDir, harnesses, gates, run };
}

describe('final review as a review loop', () => {
  it('blocking findings go to a fixer in the feature clone, then the feature is reviewed again', async () => {
    const { workDir, harnesses, run } = setup({ script: { 'review-final': (_request, call) => ({ report: call === 1 ? blocking : clean }) } });
    const state = await run();
    expect(state.status).toBe('done');

    const finalClone = path.join(workDir, 'clones', '_final');
    const featureFixes = harnesses.calls().filter((call) => call.kind === 'fix' && !call.group);
    expect(featureFixes).toHaveLength(1);
    expect(featureFixes[0]).toMatchObject({ cwd: finalClone });
    expect(featureFixes[0]!.prompt).toContain('brak walidacji');
    // the fixer of the whole feature takes the plan's most demanding tier (g1 is `domain`)
    expect(featureFixes[0]!.executor).toEqual(TEST_CONFIG.tiers.domain);

    expect(state.final_review?.review?.rounds.map((record) => record.round)).toEqual([1, 2]);
    expect(state.final_review).toMatchObject({ phase: 'done', gate: 'passed' });
    for (const report of ['review-final-r1.json', 'review-final-r2.json']) expect(fs.existsSync(path.join(workDir, report))).toBe(true);
  });

  it('an escalated finding goes to a human after the rest of the fix is reviewed, not to another fix', async () => {
    const escalated = { report: { findings: [{ id: 'B1', status: 'escalated', reason: 'the branch has none of the feature' }] } };
    const { harnesses, gates, run } = setup({
      script: { 'review-final': { report: blocking }, fix: escalated },
      gates: { final: [{ action: 'stop' }] },
    });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'human', gate: 'final' });
    expect(gates.seen.find((gate) => gate.gate === 'final')!.summary).toBe(
      'feature: fixer escalated B1 (the branch has none of the feature); 1 open blocking finding after 2 rounds; see fix-r1.json, review-final-r1.json',
    );
    // the fixer changed nothing, so round 2 doesn't run the same reviewer on the same code again
    expect(harnesses.calls().filter((call) => call.kind === 'review-final')).toHaveLength(1);
    expect(harnesses.calls().filter((call) => call.kind === 'fix')).toHaveLength(1);
    expect(state.final_review!.review!.rounds[1]).toMatchObject({ skipped: ['final'], findings: [{ id: 'B1', carried_from: 1 }] });
    expect(state.final_review).toMatchObject({ phase: 'decide', escalated: { fixRound: 1, findings: [{ id: 'B1' }] } });
  });

  it('the final reviewer reads the groups\' last review round and their fix reports', async () => {
    const { workDir, harnesses, run } = setup({
      script: { 'review-spec': (request, call) => ({ report: request.group === 'g1' && call === 1 ? blocking : clean }) },
    });
    expect((await run()).status).toBe('done');
    const finalReview = harnesses.calls().find((call) => call.kind === 'review-final')!;
    const reports = ['review-spec-g1-r2.json', 'review-standards-g1-r2.json', 'fix-g1-r1.json', 'review-spec-g2-r1.json', 'review-standards-g2-r1.json'];
    for (const report of reports) expect(finalReview.prompt).toContain(path.join(workDir, report));
    expect(finalReview.prompt).not.toContain('review-spec-g1-r1.json');
  });

  it('on_stop: fail fails the flow at the final review', async () => {
    const { run } = setup({ config: { review: { on_stop: ['fail'], max_rounds: 1 } }, script: { 'review-final': { report: blocking } } });
    const state = await run();
    expect(state.status).toBe('failed');
    expect(state.paused).toMatchObject({ reason: 'review_failed', gate: 'final' });
    expect(state.paused?.group).toBeUndefined();
  });

  it('a spec_issue from the final reviewer pauses the flow', async () => {
    const { run } = setup({ script: { 'review-final': { report: { findings: [], spec_issue: 'AC-2 sprzeczne z AC-1' } } } });
    expect((await run()).paused).toMatchObject({ reason: 'spec_issue', message: 'AC-2 sprzeczne z AC-1' });
  });
});

describe('rollback', () => {
  /** g1's spec review is blocking for the first `blockingRounds` calls; the loop stops at the decision. */
  async function pausedAtDecision(blockingRounds: number, decisions: GateDecision[]) {
    const flow = setup({
      script: { 'review-spec': (request, call) => ({ report: request.group === 'g1' && call <= blockingRounds ? blocking : clean }) },
      gates: { group: [{ action: 'stop' }, ...decisions] },
    });
    expect((await flow.run()).paused).toMatchObject({ reason: 'human', gate: 'group', group: 'g1' });
    return flow;
  }

  it('is offered for earlier rounds; each round’s commit is kept under a hidden ref', async () => {
    const { repo, workDir, gates } = await pausedAtDecision(2, []);
    const groupGates = gates.seen.filter((request) => request.gate === 'group');
    expect(groupGates[0]).toMatchObject({ actions: ['continue', 'retry', 'rollback', 'stop', 'abort'], rounds: [1] });
    const rounds = loadState(workDir).groups.g1!.review!.rounds;
    expect(rounds.map((record) => git(repo, ['rev-parse', `refs/agentic/flow/g1/r${record.round}`]))).toEqual(rounds.map((record) => record.commit));
  });

  it('restarts the clone from the round commit and fixes that round again', async () => {
    const fixSawEarlierFix: boolean[] = [];
    const flow = setup({
      script: {
        'review-spec': (request, call) => ({ report: request.group === 'g1' && call <= 2 ? blocking : clean }),
        fix: (request, call) => {
          fixSawEarlierFix.push(fs.existsSync(path.join(request.cwd, 'fix.txt')));
          return { commit: { 'fix.txt': `fix ${call}\n` } };
        },
      },
      gates: { group: [{ action: 'stop' }, { action: 'rollback', round: 1 }] },
    });
    expect((await flow.run()).paused).toMatchObject({ reason: 'human', gate: 'group', group: 'g1' });
    const paused = loadState(flow.workDir).groups.g1!;
    const [roundOne, roundTwo] = paused.review!.rounds;
    // round 2 reviewed the fixer's commit
    expect(roundTwo!.commit).not.toBe(roundOne!.commit);
    expect(git(flow.repo, ['show', `${roundTwo!.commit}:fix.txt`])).toBe('fix 1');

    const resumed = await flow.run();
    expect(resumed.status).toBe('done');
    // the second fix ran in a clone rebuilt at round 1: the first fix is gone
    expect(fixSawEarlierFix).toEqual([false, false]);
    expect(resumed.groups.g1!.review!.rounds.map((record) => record.round)).toEqual([1, 2]);
    expect(resumed.groups.g1!.review!.rounds[1]!.findings).toEqual([]);
    expect(git(flow.repo, ['log', '--format=%s', `${roundOne!.commit}..agentic/flow/g1`])).toBe('fake: fix.txt');
    const g1Fixes = flow.harnesses.calls().filter((call) => call.kind === 'fix' && call.group === 'g1');
    expect(g1Fixes.map((call) => call.prompt.includes('brak walidacji'))).toEqual([true, true]);
  });

  it('a round that cannot be rolled back to blocks the group instead of guessing', async () => {
    const { run } = await pausedAtDecision(2, [{ action: 'rollback', round: 2 }]);
    const resumed = await run();
    expect(resumed.paused).toMatchObject({ reason: 'error', group: 'g1' });
    expect(resumed.paused?.message).toMatch(/can't roll back to round 2 \(available: 1\)/);
  });
});

describe('TtyGates', () => {
  it('rollback asks for one of the offered rounds', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const gates = new TtyGates(Readable.from(['3\n', '7\n', '2\n']));
    const decision = await gates.decide({
      gate: 'group',
      group: 'g1',
      slug: 's',
      workDir: '',
      summary: '',
      actions: ['continue', 'retry', 'rollback', 'stop', 'abort'],
      rounds: [1, 2],
    });
    gates.close();
    vi.restoreAllMocks();
    expect(decision).toEqual({ action: 'rollback', round: 2 });
  });
});
