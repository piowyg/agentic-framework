import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_PROFILE, type ResolvedProfile } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { eventsFile, readEvents, type FlowEventRecord } from '../src/orchestrator/events.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

// git is the boundary: an old git without `check-attr --source` makes the size measurement throw
const measureFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('../src/publish/size.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/publish/size.js')>();
  return {
    ...original,
    diffSizeAt: (...args: Parameters<typeof original.diffSizeAt>) => {
      if (measureFailure.error) throw measureFailure.error;
      return original.diffSizeAt(...args);
    },
  };
});

function setup(options: { script?: FakeScript; gates?: Record<string, GateDecision[]>; profile?: ResolvedProfile; log?: string[] } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const { workDir, slug } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const delivered: FlowEventRecord[] = [];
  const run = () =>
    runFlow({
      workDir,
      config: TEST_CONFIG,
      catalog: loadCatalog(),
      profile: options.profile ?? NO_PROFILE,
      harnesses,
      sandbox: harnesses.sandbox,
      gates,
      onEvent: (event) => delivered.push(event),
      ...(options.log && { log: (line: string) => options.log!.push(line) }),
    });
  return { workDir, slug, delivered, run };
}

const withoutSessions = (events: FlowEventRecord[]) => events.filter((event) => !event.type.startsWith('session_'));

describe('flow events (events.jsonl)', () => {
  it('records the whole flow in order and hands every record to onEvent', async () => {
    const { run, workDir, slug, delivered } = setup();
    await run();
    const events = readEvents(workDir);

    expect(events).toEqual(delivered);
    expect(events.every((event) => event.slug === slug && !Number.isNaN(Date.parse(event.at)))).toBe(true);
    expect(events[0]).toMatchObject({ type: 'flow_started', resumed: false });
    expect(events.at(-1)).toMatchObject({ type: 'flow_done', outcome: 'ready_to_publish' });

    const types = withoutSessions(events).map((event) => event.type);
    expect(types.filter((type) => type === 'stage_started')).toHaveLength(5);
    expect(types.filter((type) => type === 'human_needed')).toHaveLength(4);
    expect(types.filter((type) => type === 'gate_decided')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'group_done').map((event) => event.type === 'group_done' && event.group)).toEqual(['g1', 'g2']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'review_round', group: 'g1', round: 1, blocking: 0 }));

    const started = events.filter((event) => event.type === 'session_started');
    const finished = events.filter((event) => event.type === 'session_done');
    expect(started).toHaveLength(11);
    expect(finished).toHaveLength(11);
    expect(started[3]).toMatchObject({ kind: 'implement', group: 'g1', task: 't1', harness: expect.any(String), model: expect.any(String) });
    expect(finished[3]).toMatchObject({ kind: 'implement', group: 'g1', task: 't1', exit_code: 0 });
  });

  describe('group size', () => {
    const lines = (count: number) => 'x\n'.repeat(count);
    // g1 has two tasks, 300 production lines each; g2 one task of 5: both estimated at ~50 prod / 50 in tests
    const sizedScript: FakeScript = {
      implement: (request) => ({
        report: { status: 'done', summary: 'ok', tests_added: [] },
        commit: { [`src/${request.group}-${request.task}.txt`]: lines(request.group === 'g1' ? 300 : 5) },
      }),
    };
    const groupDone = (workDir: string) => readEvents(workDir).filter((event) => event.type === 'group_done');
    const G1_WARNING = 'over the publish.size threshold (400 prod, 800 with tests): 600 prod / 0 test, planned ~50 prod / 50 test';

    it("group_done carries the lines of the group's own diff, not its predecessor's", async () => {
      const { run, workDir } = setup({ script: sizedScript });
      await run();

      expect(groupDone(workDir)).toEqual([
        expect.objectContaining({ group: 'g1', size: { prod: 600, tests: 0, excluded: 0 } }),
        expect.objectContaining({ group: 'g2', size: { prod: 5, tests: 0, excluded: 0 } }),
      ]);
    });

    it('a group over a threshold its estimate stayed under: group_done says so, state.json keeps it, g2 under it stays quiet', async () => {
      const { run, workDir } = setup({ script: sizedScript });
      await run();
      const [g1, g2] = groupDone(workDir);
      const state = JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));

      expect(g1).toMatchObject({ message: G1_WARNING });
      expect(g2).not.toHaveProperty('message');
      expect(state.groups.g1.size).toEqual({ prod: 600, tests: 0, excluded: 0, warning: G1_WARNING });
    });

    it('a measurement that fails is logged; the group is still done, without a size', async () => {
      measureFailure.error = new Error("git check-attr: unknown option `source'");
      try {
        const log: string[] = [];
        const { run, workDir } = setup({ script: sizedScript, log });
        await run();
        const state = JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));

        expect(groupDone(workDir).map((event) => event.type === 'group_done' && [event.group, event.size])).toEqual([
          ['g1', undefined],
          ['g2', undefined],
        ]);
        expect(state.groups.g1).toMatchObject({ status: 'done' });
        expect(state.groups.g1).not.toHaveProperty('blocked');
        expect(log).toContain("! group g1: size not measured; git check-attr: unknown option `source'");
      } finally {
        measureFailure.error = undefined;
      }
    });
  });

  it('a gate stop ends with flow_paused; resume starts with resumed: true', async () => {
    const { run, workDir } = setup({ gates: { spec: [{ action: 'stop' }] } });
    await run();
    const paused = readEvents(workDir);
    expect(paused.at(-2)).toMatchObject({ type: 'gate_decided', gate: 'spec', action: 'stop' });
    expect(paused.at(-1)).toMatchObject({ type: 'flow_paused', reason: 'gate' });

    await run();
    const resumed = readEvents(workDir).slice(paused.length);
    expect(resumed[0]).toMatchObject({ type: 'flow_started', resumed: true });
    expect(resumed.at(-1)).toMatchObject({ type: 'flow_done' });
  });

  it('abort at a gate ends with flow_aborted', async () => {
    const { run, workDir } = setup({ gates: { ticket: [{ action: 'abort' }] } });
    expect((await run()).status).toBe('aborted');
    expect(readEvents(workDir).at(-1)).toMatchObject({ type: 'flow_aborted' });
  });

  it('a line truncated by a killed process does not swallow the next records', async () => {
    const { run, workDir } = setup();
    fs.writeFileSync(eventsFile(workDir), '{"type":"flow_sta');
    await run();
    const events = readEvents(workDir);
    expect(events[0]).toMatchObject({ type: 'flow_started' });
    expect(events.at(-1)).toMatchObject({ type: 'flow_done' });
  });
});

describe('profile on_rate_limit', () => {
  it('pause_and_notify (default): pauses the flow', async () => {
    const { run, workDir } = setup({ script: { breakdown: { rateLimited: true } } });
    const state = await run();
    expect(state.status).toBe('paused');
    const events = readEvents(workDir);
    expect(events.at(-2)).toMatchObject({ type: 'rate_limited' });
    expect(events.at(-1)).toMatchObject({ type: 'flow_paused', reason: 'rate_limit' });
  });

  it('fail: fails the flow instead of pausing', async () => {
    const profile: ResolvedProfile = { name: 'work', reason: 'default', on_rate_limit: 'fail' };
    const { run, workDir } = setup({ script: { breakdown: { rateLimited: true } }, profile });
    const state = await run();
    expect(state.status).toBe('failed');
    expect(state.paused).toMatchObject({ reason: 'rate_limit' });
    expect(readEvents(workDir).at(-1)).toMatchObject({ type: 'flow_failed', reason: 'rate_limit' });
    expect((await run()).status).toBe('failed');
  });
});
