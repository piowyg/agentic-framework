import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, NO_PROFILE } from '../src/config/load.js';
import { checkExecutor, loadCatalog } from '../src/config/models.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig } from '../src/config/types.js';
import { FAKE_TASKS, fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { fixExecutor, groupExecutor } from '../src/orchestrator/executors.js';
import { APPROVED_TASKS } from '../src/orchestrator/artifacts.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { acquireLock } from '../src/orchestrator/lock.js';
import { listFlows, loadState } from '../src/orchestrator/state.js';
import { readUsage } from '../src/orchestrator/usage.js';
import { committedRepo, gitRepo, sandboxEnv, tmpDir, write, TEST_CONFIG, QUOTED } from './helpers.js';

// Regression tests for findings U1–U26 from the independent review experiment.

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const kinds = () => harnesses.calls().map((call) => `${call.kind}${call.group ? ':' + call.group : ''}`);
  return { workDir, harnesses, gates, run, kinds };
}

const blocking = {
  findings: [{ id: 'B', severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};
const clean = { findings: [] };

describe('review loop state on resume', () => {
  it('U1: interruption after retry at the group gate resumes fix → review, not straight back to the gate', async () => {
    let limited = true;
    const { run, kinds } = setup({
      config: { autonomy: 'strict' },
      gates: { group: [{ action: 'retry', note: 'popraw nazwy' }] },
      script: {
        'review-spec': (request, call) => {
          if (request.group === 'g1' && call === 2 && limited) {
            limited = false;
            return { rateLimited: true };
          }
          return { report: clean };
        },
      },
    });
    expect((await run()).paused?.reason).toBe('rate_limit');
    expect((await run()).status).toBe('done');
    const g1ReviewKinds = kinds().filter((kind) => kind.endsWith(':g1') && !kind.startsWith('implement'));
    expect(g1ReviewKinds).toEqual(['review-spec:g1', 'review-standards:g1', 'fix:g1', 'review-spec:g1', 'review-spec:g1', 'review-standards:g1']);
  });

  it('U6: rounds are counted across resume; reports are not overwritten', async () => {
    const { run, workDir, harnesses } = setup({
      script: { 'review-standards': (request) => ({ report: request.group === 'g1' ? blocking : clean }) },
      gates: { group: [{ action: 'stop' }, { action: 'continue' }] },
    });
    expect((await run()).paused?.reason).toBe('human');
    const before = harnesses.calls().length;
    const state = await run();
    expect(state.status).toBe('done');
    // resume asks immediately — no extra review rounds on unchanged code
    expect(harnesses.calls().slice(before).some((call) => call.group === 'g1')).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'review-standards-g1-r2.json'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'review-standards-g1-r3.json'))).toBe(false);
  });

  it('U7: acceptance in on_stop passes the gate — no second question', async () => {
    const { run, gates } = setup({ config: { autonomy: 'strict' }, script: { 'review-final': { report: blocking } } });
    await run();
    expect(gates.seen.filter((gate) => gate.gate === 'final')).toHaveLength(1);
    const strict = setup({ config: { autonomy: 'strict' }, script: { 'review-standards': (request) => ({ report: request.group === 'g1' ? blocking : clean }) } });
    await strict.run();
    expect(strict.gates.seen.filter((gate) => gate.gate === 'group' && gate.group === 'g1')).toHaveLength(1);
  });

  it("U9: the human's note goes into the fixer prompt once", async () => {
    const { run, harnesses } = setup({
      script: { 'review-standards': (request, call) => ({ report: request.group === 'g1' && call <= 2 ? blocking : clean }) },
      gates: { group: [{ action: 'retry', note: 'UNIKALNA-NOTKA' }] },
    });
    await run();
    const fix = harnesses.calls().filter((call) => call.kind === 'fix').at(-1)!;
    expect(fix.prompt.split('UNIKALNA-NOTKA')).toHaveLength(2);
  });

  it('U13 + F2: exhausted on_stop [escalate] asks a human (also after resume); [fail] → review_failed', async () => {
    const escalating = setup({
      config: { review: { ...TEST_CONFIG.review, on_stop: ['escalate'] } },
      script: { 'review-standards': { report: blocking } },
      gates: { group: [{ action: 'stop' }] },
    });
    expect((await escalating.run()).paused).toMatchObject({ reason: 'human', gate: 'group' });
    expect(await escalating.run()).toMatchObject({ status: 'done' });
    expect(escalating.gates.seen.filter((gate) => gate.gate === 'group' && gate.group === 'g1')).toHaveLength(2);
    const fail = setup({ config: { review: { ...TEST_CONFIG.review, on_stop: ['fail'] } }, script: { 'review-standards': { report: blocking } } });
    expect(await fail.run()).toMatchObject({ status: 'failed', paused: { reason: 'review_failed' } });
  });

  it('on_stop [escalate, human]: one fix round per rung up the ladder, then the human', async () => {
    const { run, harnesses, gates, workDir } = setup({
      config: { review: { ...TEST_CONFIG.review, max_rounds: 1, on_stop: ['escalate', 'human'], escalation: ['luna', 'sol', 'astra', 'opus'] } },
      script: { 'review-standards': { report: blocking } },
      gates: { group: [{ action: 'stop' }] },
    });
    expect((await run()).paused).toMatchObject({ reason: 'human', gate: 'group' });
    // the group's fixer is `sol/high`; with one round no fix runs before the first stop, then one per rung above it
    const fixers = harnesses.calls().filter((call) => call.kind === 'fix').map((call) => `${call.executor.harness}:${call.executor.model}/${call.executor.effort}`);
    expect(fixers).toEqual(['codex:astra/high', 'claude:opus/high']);
    const decisions = gates.seen.filter((gate) => gate.gate === 'group');
    expect(decisions).toHaveLength(1);
    // the human sees how far up the ladder the fixer already went
    expect(decisions[0]!.summary).toContain('fixer already escalated (on_stop) to claude:opus/high');
    expect(loadState(workDir).groups.g1!.escalation).toBe(2);
  });

  it('a fixer that escalated a finding goes to the human, not up the ladder', async () => {
    const { run, harnesses } = setup({
      config: { review: { ...TEST_CONFIG.review, on_stop: ['escalate', 'human'], escalation: ['astra'] } },
      script: { 'review-standards': { report: blocking }, fix: { report: { findings: [{ id: 'B', status: 'escalated', reason: 'no such feature' }] } } },
      gates: { group: [{ action: 'stop' }] },
    });
    expect((await run()).paused).toMatchObject({ reason: 'human' });
    expect(harnesses.calls().filter((call) => call.kind === 'fix').map((call) => call.executor.model)).toEqual(['sol']);
  });

  it('U15: the group gate shows open blocking findings', async () => {
    const { run, gates } = setup({ config: { autonomy: 'strict' } });
    await run();
    expect(gates.seen.find((gate) => gate.gate === 'group')!.summary).toContain('open blocking 0');
  });
});

describe('plan and executors', () => {
  it('U2: a bad executor override is caught at breakdown (before the gate), not during implementation', async () => {
    const invalidTasks = FAKE_TASKS.replace('acceptance: [AC-1]\n  - id: g2', 'acceptance: [AC-1]\n        executor: { model: gpt9 }\n  - id: g2');
    const { run, gates } = setup({ script: { breakdown: { files: { 'tasks.yaml': invalidTasks } } } });
    const state = await run();
    expect(state.stage).toBe('breakdown');
    expect(state.paused?.message).toMatch(/unknown model `gpt9`/);
    expect(gates.seen.map((gate) => gate.gate)).not.toContain('breakdown');
  });

  it('U11: editing tasks.yaml at the breakdown gate enters the plan; editing after the gate is ignored', async () => {
    const { run, workDir, harnesses } = setup({ gates: { breakdown: [{ action: 'stop' }] } });
    await run();
    const extra = FAKE_TASKS + `  - id: g3\n    repo: .\n    rationale: r\n    estimate: { prod: 50, tests: 50 }\n    depends_on: [g2]\n    tasks:\n      - { id: t1, title: c, tier: mechanical, acceptance: [AC-1] }\n`;
    fs.writeFileSync(path.join(workDir, 'tasks.yaml'), extra);
    const state = await run();
    expect(state.status).toBe('done');
    expect(Object.keys(state.groups)).toEqual(['g1', 'g2', 'g3']);
    expect(fs.readFileSync(path.join(workDir, APPROVED_TASKS), 'utf8')).toBe(extra);
    expect(harnesses.calls().some((call) => call.group === 'g3')).toBe(true);
  });

  it('U4: spec_issue from the implementer stops the flow; resume repeats the task', async () => {
    let once = true;
    const { run, harnesses } = setup({
      script: {
        implement: (request) => {
          if (request.task === 't2' && once) {
            once = false;
            return { report: { status: 'spec_issue', summary: 'x', issue: 'AC-2 wymaga danych, których nie ma', tests_added: [] } };
          }
          return { output: 'ok' };
        },
      },
    });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'spec_issue', message: 'AC-2 wymaga danych, których nie ma' });
    expect(paused.groups.g1!.tasks.t2).toBe('running');
    expect((await run()).status).toBe('done');
    expect(harnesses.calls().filter((call) => call.task === 't2' && call.group === 'g1')).toHaveLength(2);
  });

  it('spec_issue from a reviewer stops the flow; resume reviews the round again after the spec is fixed', async () => {
    let once = true;
    const { run, harnesses } = setup({
      script: {
        'review-spec': (request) => {
          if (request.group === 'g1' && once) {
            once = false;
            return { report: { findings: [], spec_issue: 'AC-1 sprzeczne z AC-2' } };
          }
          return { report: clean };
        },
      },
    });
    expect((await run()).paused).toMatchObject({ reason: 'spec_issue', group: 'g1', message: 'AC-1 sprzeczne z AC-2' });
    expect((await run()).status).toBe('done');
    const g1Reviews = harnesses.calls().filter((call) => call.group === 'g1' && call.kind.startsWith('review-'));
    // the whole round is reviewed again against the fixed spec, every axis included
    expect(g1Reviews.map((call) => call.kind)).toEqual(['review-spec', 'review-standards', 'review-spec', 'review-standards']);
  });

  it('U5: a model-only override takes the harness from the registry', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'review:\n  spec: { model: opus }\ntiers:\n  standard: { model: sonnet }\n');
    const { config } = loadConfig({ cwd: root, env: sandboxEnv(home) });
    expect(config.review.spec).toEqual({ harness: 'claude', model: 'opus', effort: 'medium' });
    expect(config.tiers.standard).toEqual({ harness: 'claude', model: 'sonnet', effort: 'medium' });
  });

  it("U14: stages.fix with only effort overrides the group's effort", () => {
    const config = deepMerge(TEST_CONFIG, { stages: { fix: { effort: 'xhigh' } } }) as AgenticConfig;
    const group = { id: 'g', repo: '.', rationale: 'r', depends_on: [], tasks: [{ id: 't', title: 't', tier: 'standard' as const, acceptance: [] }] };
    expect(fixExecutor(config, groupExecutor(config, group), loadCatalog())).toEqual({ harness: 'codex', model: 'luna', effort: 'xhigh' });
  });

  it('U26: prototype keys are not models', () => {
    expect(checkExecutor('x', { model: 'constructor', effort: 'high' }, loadCatalog())[0]).toMatch(/unknown model/);
    expect(checkExecutor('x', { model: 'toString' }, loadCatalog())[0]).toMatch(/unknown model/);
  });
});

describe('files and state', () => {
  it("U12: the lock holds the PID from creation; release does not remove someone else's lock", () => {
    const dir = tmpDir();
    const release = acquireLock(dir);
    expect(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).toBe(String(process.pid));
    fs.writeFileSync(path.join(dir, '.lock'), '1');
    release();
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(true);
  });

  it('U18: planted symlinks in the flow directory do not redirect writes', async () => {
    const { run, workDir } = setup();
    const victim = path.join(tmpDir(), 'victim.txt');
    fs.writeFileSync(victim, 'nietknięty');
    fs.symlinkSync(victim, path.join(workDir, 'state.json.tmp'));
    fs.symlinkSync(victim, path.join(workDir, 'review-final-r1.json'));
    await expect(run()).resolves.toBeDefined();
    expect(fs.readFileSync(victim, 'utf8')).toBe('nietknięty');
    const again = setup();
    fs.symlinkSync(victim, path.join(again.workDir, 'usage.jsonl'));
    expect((await again.run()).paused?.message).toMatch(/ELOOP|symbolic/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('nietknięty');
  });

  it('U17: a truncated usage.jsonl line and a corrupt state.json do not break status', async () => {
    const { run, workDir } = setup();
    await run();
    fs.appendFileSync(path.join(workDir, 'usage.jsonl'), '{"at":"2026');
    expect(readUsage(workDir).length).toBeGreaterThan(0);
    const root = path.dirname(workDir);
    fs.mkdirSync(path.join(root, 'zepsuty'));
    fs.writeFileSync(path.join(root, 'zepsuty', 'state.json'), '{');
    const { flows, broken } = listFlows(root);
    expect(flows).toHaveLength(1);
    expect(broken[0]).toMatch(/Corrupt/);
  });

  it('U22: state.json with another slug / without stages is rejected', () => {
    const { workDir } = setup();
    const savedState = JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(workDir, 'state.json'), JSON.stringify({ ...savedState, slug: 'inny', stages: null }));
    expect(() => loadState(workDir)).toThrow(/slug ≠ directory name, no stages/);
  });

  it('U25: repo config cannot touch the sandbox; workspace config can', () => {
    const root = tmpDir();
    const workspace = path.join(root, 'ws');
    write(workspace, 'repos.yaml', 'repos: []\n');
    write(workspace, '.agentic/config.yaml', 'sandbox: { network: { allow: [nexus.example.com] } }\n');
    const repo = gitRepo(path.join(workspace, 'services', 'svc'));
    expect(loadConfig({ cwd: repo, env: sandboxEnv(path.join(root, 'home')) }).config.sandbox.network.allow).toEqual(['nexus.example.com']);
    write(repo, '.agentic/config.yaml', 'sandbox: { image: { base: evil/img } }\n');
    expect(() => loadConfig({ cwd: repo, env: sandboxEnv(path.join(root, 'home')) })).toThrow(/sandbox: not allowed in a repo config/);
  });
});
