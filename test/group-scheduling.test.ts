import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TtyGates } from '../src/cli/tty-gates.js';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import type { Group } from '../src/orchestrator/artifacts.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import type { GroupOutcome } from '../src/orchestrator/group-runner.js';
import { scheduleGroups } from '../src/orchestrator/schedule.js';
import { committedRepo, tmpDir, NO_STACK_CONFIG, TEST_CONFIG, QUOTED } from './helpers.js';

const group = (id: string, dependsOn: string[] = []): Group => ({ id, repo: '.', rationale: 'r', depends_on: dependsOn, tasks: [] });

const done: GroupOutcome = { status: 'done' };

/** g1 and g3 are independent; g2 waits for g1. */
const THREE_GROUPS = `groups:
  - id: g1
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: a, tier: standard, acceptance: [AC-1] }
  - id: g2
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    depends_on: [g1]
    tasks:
      - { id: t1, title: b, tier: standard, acceptance: [AC-1] }
  - id: g3
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: c, tier: standard, acceptance: [AC-1, AC-2] }
`;

const blockingFinding = {
  findings: [{ id: 'B1', severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': THREE_GROUPS } }, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(NO_STACK_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const groupCalls = () => harnesses.calls().filter((call) => call.kind === 'implement').map((call) => call.group);
  return { run, gates, groupCalls };
}

describe('scheduleGroups', () => {
  it('runs at most `limit` groups at a time, each after its dependencies', async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const outcomes = await scheduleGroups({
      groups: [group('g1'), group('g2'), group('g3', ['g1']), group('g4')],
      limit: 2,
      settled: () => undefined,
      runGroup: async (scheduled) => {
        started.push(scheduled.id);
        maxActive = Math.max(maxActive, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return done;
      },
    });
    expect(maxActive).toBe(2);
    expect(started.indexOf('g3')).toBeGreaterThan(started.indexOf('g1'));
    expect([...outcomes.values()].every((outcome) => outcome.status === 'done')).toBe(true);
  });

  it('settled groups are not rerun; a group whose dependency stopped gets no outcome', async () => {
    const started: string[] = [];
    const failure: GroupOutcome = { status: 'failed', pause: { reason: 'review_failed', group: 'g1' } };
    const outcomes = await scheduleGroups({
      groups: [group('g1'), group('g2', ['g1']), group('g3')],
      limit: 1,
      settled: (scheduled) => (scheduled.id === 'g1' ? failure : undefined),
      runGroup: async (scheduled) => {
        started.push(scheduled.id);
        return done;
      },
    });
    expect(started).toEqual(['g3']);
    expect(outcomes.get('g1')).toBe(failure);
    expect(outcomes.has('g2')).toBe(false);
  });

  it('after an abort nothing new starts; a thrown error blocks only its group', async () => {
    const started: string[] = [];
    const outcomes = await scheduleGroups({
      groups: [group('g1'), group('g2'), group('g3')],
      limit: 1,
      settled: () => undefined,
      runGroup: async (scheduled) => {
        started.push(scheduled.id);
        if (scheduled.id === 'g1') throw new Error('boom');
        return { status: 'aborted', pause: { reason: 'gate', group: scheduled.id } };
      },
    });
    expect(started).toEqual(['g1', 'g2']);
    expect(outcomes.get('g1')).toEqual({ status: 'blocked', pause: { reason: 'error', group: 'g1', message: 'boom' } });
  });
});

describe('groups in the flow', () => {
  it('a blocked group pauses the flow only after independent groups ran; resume reruns just it', async () => {
    let first = true;
    const { run, groupCalls } = setup({
      script: {
        implement: (request) => {
          if (request.group === 'g1' && first) {
            first = false;
            return { report: { status: 'spec_issue', summary: 'x', issue: 'brak AC', tests_added: [] } };
          }
          return { output: 'ok' };
        },
      },
    });
    const paused = await run();
    expect(paused.status).toBe('paused');
    expect(paused.paused).toMatchObject({ reason: 'spec_issue', group: 'g1', message: 'brak AC' });
    expect(paused.groups.g1!.blocked).toMatchObject({ reason: 'spec_issue' });
    expect(paused.groups.g3).toMatchObject({ status: 'done', gate: 'passed' });
    expect(paused.groups.g2!.status).toBe('pending');
    expect(groupCalls()).toEqual(['g1', 'g3']);

    const resumed = await run();
    expect(resumed.status).toBe('done');
    expect(resumed.groups.g1!.blocked).toBeUndefined();
    expect(groupCalls()).toEqual(['g1', 'g3', 'g1', 'g2']);
  });

  it('on_stop: fail fails the group, not the flow — independent groups finish, dependents never start', async () => {
    const { run, groupCalls } = setup({
      config: { review: { on_stop: ['fail'], max_rounds: 1 } },
      script: { 'review-spec': (request) => ({ report: request.group === 'g1' ? blockingFinding : { findings: [] } }) },
    });
    const state = await run();
    expect(state.status).toBe('failed');
    expect(state.paused).toMatchObject({ reason: 'review_failed', group: 'g1' });
    expect(state.groups.g1).toMatchObject({ status: 'failed', failure: { reason: 'review_failed', gate: 'group' } });
    expect(state.groups.g3).toMatchObject({ status: 'done', gate: 'passed' });
    expect(state.groups.g2!.status).toBe('pending');
    expect(groupCalls()).toEqual(['g1', 'g3']);
  });

  it('abort at a group gate aborts the flow and starts no further group', async () => {
    const { run, groupCalls } = setup({ config: { autonomy: 'strict' }, gates: { group: [{ action: 'abort' }] } });
    const state = await run();
    expect(state.status).toBe('aborted');
    expect(state.paused).toMatchObject({ reason: 'gate', gate: 'group', group: 'g1' });
    expect(groupCalls()).toEqual(['g1']);
  });

  it('parallel_groups: 2 runs independent groups side by side', async () => {
    const { run, groupCalls } = setup({ config: { parallel_groups: 2 } });
    const state = await run();
    expect(state.status).toBe('done');
    // g3 starts before g1 finishes; g2 still waits for g1
    expect(groupCalls().slice(0, 2).sort()).toEqual(['g1', 'g3']);
    expect(groupCalls().at(-1)).toBe('g2');
  });
});

describe('TtyGates', () => {
  it('asks gates of parallel groups one at a time, in arrival order', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const gates = new TtyGates(Readable.from(['1\n', '4\n']));
    const request = (groupId: string) => ({ gate: 'group' as const, group: groupId, slug: 's', workDir: '', summary: '', actions: ['continue', 'retry', 'stop', 'abort'] as GateDecision['action'][] });
    const decisions = await Promise.all([gates.decide(request('g1')), gates.decide(request('g3'))]);
    gates.close();
    vi.restoreAllMocks();
    expect(decisions).toEqual([{ action: 'continue' }, { action: 'abort' }]);
  });
});
