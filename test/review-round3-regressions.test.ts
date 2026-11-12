import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig, Executor } from '../src/config/types.js';
import { TtyGates } from '../src/cli/tty-gates.js';
import { fakeRegistry, FAKE_TASKS, FAKE_TICKET, type FakeScript } from '../src/harness/fake.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { appendUsage, readUsage, usageFile } from '../src/orchestrator/usage.js';
import { committedRepo, tmpDir, TEST_CONFIG, QUOTED } from './helpers.js';

// Third review (durability D1–D7).

function setup(options: { script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const kinds = () => harnesses.calls().map((call) => call.kind);
  return { workDir, gates, run, kinds };
}

const finalBlocking = {
  findings: [{ id: 'B', severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};

describe('final review', () => {
  it('D1: retry at the final gate reruns the review with the note', async () => {
    const { run, kinds, gates } = setup({ gates: { final: [{ action: 'retry', note: 'sprawdź ponownie' }, { action: 'continue' }] } });
    expect((await run()).status).toBe('done');
    expect(kinds().filter((kind) => kind === 'review-final')).toHaveLength(2);
    expect(gates.seen.filter((gate) => gate.gate === 'final')).toHaveLength(2);
  });

  it('D1: blocking → stop → manual fix → resume offers retry, which runs a fresh review', async () => {
    let call = 0;
    const { run, kinds, gates } = setup({
      // blocking in every round up to the limit, so the loop stops at the decision
      script: { 'review-final': () => ({ report: ++call <= TEST_CONFIG.review.max_rounds ? finalBlocking : { findings: [], previous: [{ id: 'B', status: 'fixed' }] } }) },
      gates: { final: [{ action: 'stop' }, { action: 'retry', note: 'poprawione ręcznie' }] },
    });
    expect((await run()).status).toBe('paused');
    expect(await run()).toMatchObject({ status: 'done' });
    expect(gates.seen.find((gate) => gate.gate === 'final')!.actions).toContain('retry');
    expect(kinds().filter((kind) => kind === 'review-final')).toHaveLength(TEST_CONFIG.review.max_rounds + 1);
  });
});

describe('resume after a validation pause', () => {
  it('D3: a hand-fixed tasks.yaml is not overwritten by another breakdown', async () => {
    const badTasks = FAKE_TASKS.replace('tier: mechanical', 'tier: mechanical\n        executor: { model: no-such-model }');
    const { run, kinds, workDir } = setup({ script: { breakdown: { files: { 'tasks.yaml': badTasks } } } });
    expect((await run()).paused?.reason).toBe('error');
    fs.writeFileSync(path.join(workDir, 'tasks.yaml'), FAKE_TASKS + '# human-fixed\n');
    expect((await run()).status).toBe('done');
    expect(kinds().filter((kind) => kind === 'breakdown')).toHaveLength(1);
    expect(fs.readFileSync(path.join(workDir, 'tasks.approved.yaml'), 'utf8')).toContain('# human-fixed');
  });

  it('D3: a fixed ticket.md does not rerun grilling, but a retry at the gate does', async () => {
    const { run, kinds, workDir } = setup({
      script: { 'grill-business': (_request, call) => (call === 1 ? { files: { 'ticket.md': FAKE_TICKET.replace('status: ready', 'status: draft') } } : {}) },
      gates: { ticket: [{ action: 'continue' }] },
    });
    expect((await run()).paused?.reason).toBe('error');
    fs.writeFileSync(path.join(workDir, 'ticket.md'), FAKE_TICKET);
    expect((await run()).status).toBe('done');
    expect(kinds().filter((kind) => kind === 'grill-business')).toHaveLength(1);

    const retried = setup({ gates: { spec: [{ action: 'retry', note: 'doprecyzuj' }] } });
    await retried.run();
    expect(retried.kinds().filter((kind) => kind === 'grill-technical')).toHaveLength(2);
  });
});

describe('usage and gates', () => {
  it('D2: a truncated usage line does not swallow the next record', () => {
    const workDir = tmpDir();
    const executor: Executor = { harness: 'claude', model: 'opus', effort: 'high' };
    const result = { exitCode: 0, output: '', usage: { inputTokens: 1000, outputTokens: 200 }, durationMs: 1 };
    appendUsage(workDir, { stage: 'spec', kind: 'grill-technical', executor, result });
    fs.appendFileSync(usageFile(workDir), '{"at":"2026-10-03T00:00:00Z","stage":"implement","inp');
    appendUsage(workDir, { stage: 'implement', kind: 'implement', executor, result });
    expect(readUsage(workDir)).toHaveLength(2);
  });

  it('a resumed session logs only its own cost: the harness reports the whole session so far', () => {
    const workDir = tmpDir();
    const executor: Executor = { harness: 'claude', model: 'sonnet', effort: 'medium' };
    const run = (costUsd: number, sessionId: string) =>
      appendUsage(workDir, { stage: 'implement', kind: 'write-tests', executor, sessionId, result: { exitCode: 0, output: '', usage: { inputTokens: 1, outputTokens: 1, costUsd }, durationMs: 1 } });
    // smoke 92-2: one write-tests session, resumed twice
    run(0.717, 'author');
    run(0.925, 'author');
    run(0.4, 'implementer');
    run(1.055, 'author');
    // a harness reporting each run alone: a total below what was logged stays as is
    run(0.1, 'author');
    expect(readUsage(workDir).map((record) => record.cost_usd)).toEqual([0.717, expect.closeTo(0.208), 0.4, expect.closeTo(0.13), 0.1]);
  });

  it('D7: EOF at the note prompt means stop, not retry', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const gates = new TtyGates(Readable.from(['2\n']));
    const request = { gate: 'group', slug: 's', workDir: '', summary: '', actions: ['continue', 'retry', 'stop', 'abort'] } as const;
    const decision = await gates.decide({ ...request, actions: [...request.actions] });
    // stdin stays closed: every later gate stops too, without throwing
    const nextDecision = await gates.decide({ ...request, actions: [...request.actions] });
    gates.close();
    vi.restoreAllMocks();
    expect(decision).toEqual({ action: 'stop' });
    expect(nextDecision).toEqual({ action: 'stop' });
  });
});
