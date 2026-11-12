import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeReply, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { committedRepo, QUOTED, tmpDir, NO_STACK_CONFIG, TEST_CONFIG } from './helpers.js';

// Agents as the live runs showed them, not as the contracts describe them: work committed before a problem is
// reported, changes left uncommitted, the same finding again after a fix.

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();

const ONE_GROUP = `groups:
  - id: g1
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: a, tier: standard, acceptance: [AC-1] }
      - { id: t2, title: b, tier: standard, acceptance: [AC-2] }
`;

/** g1 and g2 independent, g3 on both: g3 starts from their merge. */
const DIAMOND = `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1] }] }
  - { id: g2, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: y, tier: standard, acceptance: [AC-2] }] }
  - { id: g3, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, depends_on: [g1, g2], tasks: [{ id: t1, title: z, tier: standard, acceptance: [AC-1] }] }
`;

const B1 = { findings: [{ id: 'B1', severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }] };

/** Red while `broken.txt` is in the tree: half-done work an agent left behind. */
const CHECK = 'test ! -f broken.txt';

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]>; tasks?: string } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': options.tasks ?? ONE_GROUP } }, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(deepMerge(NO_STACK_CONFIG, { review: { checks: [CHECK] } }), options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, checksTrusted: true });
  const calls = (kind: string) => harnesses.calls().filter((call) => call.kind === kind);
  return { repo, workDir, harnesses, gates, run, calls, config };
}

describe('agents as they behave live', () => {
  it('changes left uncommitted however often asked: the pause names the files', async () => {
    const { run } = setup({ script: { implement: { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { 'a.txt': 'a\n' }, uncommitted: { 'broken.txt': 'wip\n', 'src/Cart.java': 'changed\n' } } } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'checks_failing', group: 'g1' });
    expect(state.paused!.message).toContain('\n  - ?? broken.txt');
    expect(state.paused!.message).toContain('\n  - M src/Cart.java');
  });

  it('spec_issue with work in progress: committed first, then resume gives the task back to the session that reported', async () => {
    const specIssue = { status: 'spec_issue', summary: 'half', issue: 'AC-1 nie mówi, co z kontem zamkniętym', tests_added: [] };
    const { run, calls, repo } = setup({
      script: {
        implement: (request, call): FakeReply => {
          if (request.task !== 't1' || call > 3) return { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { [`${request.task}.txt`]: 'x\n' } };
          // live: changes left uncommitted; told to, a WIP commit; resumed after the human, it finishes and drops the WIP
          return [
            { report: specIssue, commit: { 'half.txt': 'started\n' }, uncommitted: { 'broken.txt': 'wip\n' } },
            { report: specIssue, commit: { 'broken.txt': 'wip\n' } },
            { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { 't1.txt': 'x\n' }, removed: ['broken.txt'] },
          ][call - 1]!;
        },
      },
    });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'spec_issue', group: 'g1', message: 'AC-1 nie mówi, co z kontem zamkniętym' });
    expect(calls('implement')[1]!.prompt).toMatch(/before you report, commit your work so far/);

    const state = await run();
    expect(state.paused).toBeUndefined();
    expect(state.status).toBe('done');
    const [first, , again] = calls('implement');
    expect(again!.task).toBe('t1');
    // the same session, told why it stopped and that the spec may have changed meanwhile
    expect(again!.resumeSessionId).toBe(first!.sessionId);
    expect(again!.prompt).toMatch(/You stopped and reported: "AC-1 nie mówi, co z kontem zamkniętym"/);
    expect(again!.prompt).toMatch(/Your commits from before, work in progress included, are still on the branch/);
    expect(state.groups.g1!.handed_over).toBeUndefined();
    expect(git(repo, ['ls-tree', '--name-only', 'agentic/flow/g1'])).not.toMatch(/broken\.txt/);
  });

  it('a merge committed with conflict markers left in a file the checks never read goes back to the session', async () => {
    const markers = '<<<<<<< HEAD\ng1\n=======\ng2\n>>>>>>> g2\n';
    const { run, calls, repo } = setup({
      tasks: DIAMOND,
      script: {
        implement: (request) => ({ commit: { [request.group === 'g3' ? 'g3.txt' : 'shared.txt']: `${request.group}\n` } }),
        merge: (_request, call) => ({
          commit: { 'shared.txt': call === 1 ? markers : 'g1 + g2\n' },
          report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both', rationale: 'r' }] },
        }),
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [, resumed] = calls('merge');
    expect(resumed!.prompt).toMatch(/shared\.txt:1: leftover conflict marker/);
    expect(git(repo, ['show', `${state.groups.g3!.baseRef}:shared.txt`])).toBe('g1 + g2');
  });

  it('a fixer that calls a finding fixed without committing is sent back, not believed until the next round', async () => {
    const { run, calls } = setup({
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? B1 : { findings: [], previous: [{ id: 'B1', status: 'fixed' }] } }),
        fix: (_request, call) => ({ report: { findings: [{ id: 'B1', status: 'fixed' }] }, ...(call > 1 && { commit: { 'validation.txt': 'x\n' } }) }),
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [first, resumed] = calls('fix');
    expect(resumed!.resumeSessionId).toBe(first!.sessionId);
    expect(resumed!.prompt).toMatch(/You report B1 as fixed, but you committed no change since the review/);
    // the second round reviewed the fix instead of carrying the first one's finding over
    expect(calls('review-spec')).toHaveLength(2);
  });

  it('a session cut off after committing — timeout or an error exit — is resumed on `resume`, not started over', async () => {
    for (const cutOff of [{ timedOut: true, exitCode: 124 }, { exitCode: 1, output: 'API Error: 500' }]) {
      const { run, calls } = setup({
        script: {
          implement: (_request, call): FakeReply =>
            call === 1
              ? { ...cutOff, commit: { 'half.txt': 'x\n' }, uncommitted: { 'broken.txt': 'wip\n' }, report: undefined }
              : { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { 'rest.txt': 'x\n' }, removed: ['broken.txt'] },
        },
      });
      expect((await run()).paused).toMatchObject({ group: 'g1' });
      const state = await run();
      expect(state.status).toBe('done');
      const [first, resumed] = calls('implement');
      expect(resumed!.resumeSessionId).toBe(first!.sessionId);
      expect(resumed!.prompt).toMatch(/Your previous run was stopped before it finished/);
    }
  });
});

const finding = (id: string, ref: string, message: string) => ({ id, severity: 'blocking', message, ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref } });
const B1_B2 = { findings: [finding('B1', 'AC-1', 'brak walidacji'), finding('B2', 'AC-2', 'brak kodu CART_LIMIT')] };
const fixed = (id: string) => ({ id, status: 'fixed' });

describe('reviewers and fixers as they behave live', () => {
  it('a disputed finding the next reviewer reports again under a new id stays with the human, not the fixer', async () => {
    const { run, calls, gates } = setup({
      config: { autonomy: 'strict' },
      script: {
        'review-spec': (_request, call) => ({
          report: [B1_B2, { findings: [finding('F1', 'AC-2', 'nadal brak kodu CART_LIMIT')], previous: [fixed('B1')] }][call - 1] ?? { findings: [] },
        }),
        fix: { report: { findings: [fixed('B1'), { id: 'B2', status: 'disputed', disputed_on: 'finding', reason: 'CART_LIMIT is AC-2 of another ticket' }] }, commit: { 'validation.txt': 'x\n' } },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('fix')).toHaveLength(1);
    const decision = gates.seen.find((request) => request.gate === 'group')!;
    expect(decision.summary).toContain('fixer disputed B2 (CART_LIMIT is AC-2 of another ticket)');
    expect(decision.summary).not.toMatch(/F1/);
  });

  it('a reviewer that leaves out its verdict on a fixed finding is asked for it, not taken for "not fixed"', async () => {
    const { run, calls, gates } = setup({
      script: {
        // an empty `previous`: the fake fills in a missing one
        'review-spec': (_request, call) => ({ report: [B1, { findings: [], previous: [] }, { findings: [], previous: [fixed('B1')] }][call - 1] ?? { findings: [] } }),
        fix: { report: { findings: [fixed('B1')] }, commit: { 'validation.txt': 'x\n' } },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('fix')).toHaveLength(1);
    const [, forgot, asked] = calls('review-spec');
    expect(asked!.resumeSessionId).toBe(forgot!.sessionId);
    expect(asked!.prompt).toMatch(/no verdict in `previous` for B1/);
    expect(gates.seen.filter((request) => request.gate === 'group' && request.summary.includes('came back'))).toHaveLength(0);
  });

  it('a fixer that answers only some of its findings is sent back for the rest', async () => {
    const { run, calls } = setup({
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? B1_B2 : { findings: [], previous: [fixed('B1'), fixed('B2')] } }),
        fix: (_request, call): FakeReply =>
          call === 1
            ? { report: { findings: [fixed('B1')] }, commit: { 'b1.txt': 'x\n' } }
            : { report: { findings: [fixed('B1'), fixed('B2')] }, commit: { 'b2.txt': 'x\n' } },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [first, resumed] = calls('fix');
    expect(resumed!.resumeSessionId).toBe(first!.sessionId);
    expect(resumed!.prompt).toMatch(/no status for B2/);
    expect(calls('review-spec')).toHaveLength(2);
  });

  it('a fixer that keeps breaking the checks pauses the group; `resume` gives the fix back to the same session', async () => {
    const { run, calls } = setup({
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? B1 : { findings: [], previous: [fixed('B1')] } }),
        fix: (_request, call): FakeReply =>
          call <= 3
            ? { report: { findings: [fixed('B1')] }, commit: { 'validation.txt': `${call}\n`, 'broken.txt': `${call}\n` } }
            : { report: { findings: [fixed('B1')] }, removed: ['broken.txt'] },
      },
    });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'checks_failing', group: 'g1' });
    const state = await run();
    expect(state.status).toBe('done');
    const fixes = calls('fix');
    expect(fixes).toHaveLength(4);
    expect(fixes[3]!.resumeSessionId).toBe(fixes[0]!.sessionId);
    expect(fixes[3]!.prompt).toMatch(/a human has looked at it and resumed the flow/);
    expect(calls('review-spec')).toHaveLength(2);
  });

  it('rollback after a fixer rewrote the branch history goes back to the reviewed code', async () => {
    const { run, calls, repo } = setup({
      config: { autonomy: 'strict' },
      gates: { group: [{ action: 'rollback', round: 1 }] },
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? B1 : { findings: [], previous: [fixed('B1')] } }),
        fix: (request, call): FakeReply => {
          if (call > 1) return { report: { findings: [fixed('B1')] }, commit: { 'second.txt': 'x\n' } };
          // live: the fixer folds its change into the implementer's commit
          fs.writeFileSync(path.join(request.cwd, 'amended.txt'), 'x\n');
          git(request.cwd, ['add', 'amended.txt']);
          git(request.cwd, ['-c', 'user.name=fake', '-c', 'user.email=fake@agentic', 'commit', '-q', '--amend', '--no-edit']);
          return { report: { findings: [fixed('B1')] } };
        },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('fix')).toHaveLength(2);
    const files = git(repo, ['ls-tree', '-r', '--name-only', 'agentic/flow/g1']);
    expect(files).toMatch(/second\.txt/);
    expect(files).not.toMatch(/amended\.txt/);
  });

  it('a check red on the base is asked about once for groups on that base, and not again for a group built on them', async () => {
    const { run, gates } = setup({ tasks: DIAMOND, config: { review: { checks: [CHECK, 'test -f never.txt'] } } });
    const state = await run();
    expect(state.status).toBe('done');
    const asked = gates.seen.filter((request) => request.summary?.includes('already red on the base'));
    expect(asked.map((request) => request.group)).toEqual(['g1']);
    expect(Object.values(state.groups).map((group) => group.known_red)).toEqual([['test -f never.txt'], undefined, undefined]);
  });

  it('a check accepted as red on the base in a group does not fail the final merge of the groups', async () => {
    const { run, calls } = setup({
      tasks: DIAMOND.split('\n').filter((line) => !line.includes('g3')).join('\n'),
      config: { review: { checks: [CHECK, 'test -f never.txt'] } },
      script: {
        implement: (request) => ({ commit: { 'shared.txt': `${request.group}\n` } }),
        merge: () => ({ commit: { 'shared.txt': 'g1 + g2\n' }, report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both', rationale: 'r' }] } }),
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('merge')).toHaveLength(1);
  });

  it('a security finding citing a CWE instead of a repo rule keeps its defect scenario and stays blocking', async () => {
    const injection = {
      id: 'S1', severity: 'blocking', message: 'SQL z konkatenacji', ...QUOTED, weight: 'high', impact: 'odczyt cudzych kont',
      basis: { type: 'standard', ref: 'CWE-89', scenario: "name = \"' OR 1=1 --\" zwraca wszystkie konta" },
    };
    const { run, calls } = setup({
      config: { review: { security: { harness: 'claude', model: 'opus', effort: 'high' } } },
      script: {
        'review-security': (_request, call) => ({ report: { coverage: { boundaries: ['HTTP'] }, ...(call === 1 ? { findings: [injection] } : { findings: [], previous: [fixed('S1')] }) } }),
        fix: { report: { findings: [fixed('S1')] }, commit: { 'query.txt': 'x\n' } },
      },
    });
    expect((await run()).status).toBe('done');
    expect(calls('fix')).toHaveLength(1);
    expect(calls('fix')[0]!.prompt).toContain('CWE-89');
  });
});
