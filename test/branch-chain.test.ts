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
import { committedRepo, tmpDir, NO_STACK_CONFIG, TEST_CONFIG, git } from './helpers.js';


/** g1 and g2 independent, g3 on both. */
const DIAMOND = `groups:
  - { id: g1, repo: ., title: Rule, summary: the age rule, rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1] }] }
  - { id: g2, repo: ., title: Endpoint, rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: y, tier: domain, acceptance: [AC-2] }] }
  - { id: g3, repo: ., title: Wiring, rationale: r, estimate: { prod: 50, tests: 50 }, depends_on: [g1, g2], tasks: [{ id: t1, title: z, tier: standard, acceptance: [AC-1] }] }
`;

/** Both groups add `shared.txt`, differently: merging them conflicts. */
const conflicting: FakeScript['implement'] = (request) => {
  const commit: Record<string, string> = request.group === 'g3' ? { 'g3.txt': 'g3\n' } : { 'shared.txt': `${request.group}\n`, [`${request.group}.txt`]: 'x\n' };
  return { commit };
};

function setup(options: { tasks?: string; script?: FakeScript; gates?: Record<string, GateDecision[]>; config?: object } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': options.tasks ?? DIAMOND } }, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(NO_STACK_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  const calls = (kind: string) => harnesses.calls().filter((call) => call.kind === kind);
  return { repo, workDir, gates, run, calls };
}

const parents = (repo: string, commit: string) => git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);

describe('branch chain', () => {
  it('a dependent group starts from its predecessor’s branch; the feature from the last one', async () => {
    const { run, repo } = setup({
      tasks: `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
  - { id: g2, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, depends_on: [g1], tasks: [{ id: t1, title: y, tier: standard, acceptance: [AC-1] }] }
`,
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(state.groups.g2!.baseRef).toBe(state.groups.g1!.head);
    expect(git(repo, ['show', 'agentic/flow/g2:g1-t1.txt'])).toBe('t1');
    // g2 contains g1: the feature is g2 as it is, no merge commit
    expect(state.final_review!.baseRef).toBe(state.groups.g2!.head);
  });

  it('two predecessors are merged on the host, without a session or the merge gate', async () => {
    const { run, repo, gates, calls } = setup();
    const state = await run();
    expect(state.status).toBe('done');
    const base = state.groups.g3!.baseRef!;
    expect(parents(repo, base)).toEqual([state.groups.g1!.head, state.groups.g2!.head]);
    expect(git(repo, ['log', '-1', '--format=%s|%an', base])).toBe('chore(agentic): merge g1, g2|agentic');
    expect(git(repo, ['rev-parse', 'refs/agentic/flow/g3/base'])).toBe(base);
    expect(calls('merge')).toHaveLength(0);
    expect(gates.seen.filter((request) => request.gate === 'merge')).toHaveLength(0);
    expect(state.final_review!.baseRef).toBe(state.groups.g3!.head);
  });

  it('a conflict goes to a merge session in the group’s clone, then through the control and the merge gate', async () => {
    const { run, repo, gates, calls } = setup({
      script: {
        implement: conflicting,
        merge: {
          commit: { 'shared.txt': 'g1 + g2\n' },
          report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both combined', rationale: 'AC-1 and AC-2 both need it' }] },
        },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [merge] = calls('merge');
    expect(merge!.cwd).toMatch(/clones\/g3$/);
    expect(merge!.executor).toMatchObject({ model: 'sol' }); // g2's domain tier is the hardest
    expect(merge!.prompt).toMatch(/Merging group g2 into g1[\s\S]*- g1: the age rule \(acceptance: AC-1\)/);

    const base = state.groups.g3!.baseRef!;
    expect(parents(repo, base)).toEqual([state.groups.g1!.head, state.groups.g2!.head]);
    expect(git(repo, ['show', `${base}:shared.txt`])).toBe('g1 + g2');
    expect(git(repo, ['log', '-1', '--format=%s', base])).toBe('chore(agentic): merge g1, g2');
    const [mergeGate] = gates.seen.filter((request) => request.gate === 'merge');
    expect(mergeGate!.group).toBe('g3');
    expect(mergeGate!.summary).toMatch(/shared\.txt: both combined — AC-1 and AC-2 both need it/);
    expect(mergeGate!.summary).toMatch(/remerge-diff[\s\S]*<<<<<<<[\s\S]*\+g1 \+ g2/);
    // the group's own work starts in a fresh clone at the merge
    expect(calls('implement').find((call) => call.group === 'g3')!.cwd).toMatch(/clones\/g3$/);
    expect(git(repo, ['log', '--format=%s', `${base}..agentic/flow/g3`])).toBe('fake: g3.txt');
  });

  it('a merge left uncommitted goes back to the session', async () => {
    const { run, calls } = setup({
      script: {
        implement: conflicting,
        merge: (_request, call) => (call === 1 ? { uncommitted: { 'shared.txt': 'g1 + g2\n' } } : { commit: { 'shared.txt': 'g1 + g2\n' } }),
      },
    });
    expect((await run()).status).toBe('done');
    const [first, resumed] = calls('merge');
    expect(resumed!.resumeSessionId).toBe(first!.sessionId);
  });

  it('autopilot passes the merge gate on its own', async () => {
    const { run, gates } = setup({
      config: { autonomy: 'autopilot' },
      script: { implement: conflicting, merge: { commit: { 'shared.txt': 'g1 + g2\n' } } },
    });
    expect((await run()).status).toBe('done');
    expect(gates.seen.filter((request) => request.gate === 'merge')).toHaveLength(0);
  });

  it('retry at the merge gate runs a new merge session from the conflict, with the note', async () => {
    const { run, calls } = setup({
      gates: { merge: [{ action: 'retry', note: 'keep both rules' }] },
      script: { implement: conflicting, merge: (_request, call) => ({ commit: { 'shared.txt': `attempt ${call}\n` } }) },
    });
    expect((await run()).status).toBe('done');
    const merges = calls('merge');
    expect(merges).toHaveLength(2);
    expect(merges[1]!.resumeSessionId).toBeUndefined();
    expect(merges[1]!.prompt).toContain('keep both rules');
  });

  it('an escalated merge asks the human; “I’ll resolve it” leaves a clean clone with the conflict and takes the result on resume', async () => {
    const { run, repo, workDir, gates } = setup({
      gates: { merge: [{ action: 'manual' }] },
      script: { implement: conflicting, merge: { report: { status: 'escalated', files: [], reason: 'the two rules contradict' } } },
    });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'human', gate: 'merge', group: 'g3' });
    const [question] = gates.seen.filter((request) => request.gate === 'merge');
    expect(question!.summary).toMatch(/the agent escalated: the two rules contradict/);
    expect(question!.actions).toEqual(['retry', 'manual', 'stop', 'abort']);

    const manual = path.join(workDir, 'manual', 'g3-g2');
    expect(git(manual, ['status', '--porcelain'])).toMatch(/AA shared\.txt/);
    expect(fs.existsSync(path.join(workDir, 'clones', 'g3'))).toBe(false);
    // resume before resolving pauses again
    expect((await run()).paused?.message).toMatch(/unresolved/);

    fs.writeFileSync(path.join(manual, 'shared.txt'), 'by hand\n');
    git(manual, ['add', 'shared.txt']);
    git(manual, ['commit', '-q', '--no-edit']);
    const resumed = await run();
    expect(resumed.status).toBe('done');
    expect(git(repo, ['show', `${resumed.groups.g3!.baseRef}:shared.txt`])).toBe('by hand');
    expect(fs.existsSync(manual)).toBe(false);
  });
});
