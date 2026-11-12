import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { FAKE_TASKS, fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { resolveRepo } from '../src/orchestrator/repos.js';
import { loadState } from '../src/orchestrator/state.js';
import { committedRepo, gitRepo, tmpDir, TEST_CONFIG } from './helpers.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();

function setup(options: { tasks?: string; script?: FakeScript; repo?: (root: string) => string } = {}) {
  const root = tmpDir();
  const repo = (options.repo ?? committedRepo)(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ ...options.script, ...(options.tasks && { breakdown: { files: { 'tasks.yaml': options.tasks } } }) });
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  return { root, repo, workDir, harnesses, run };
}

describe('group clones', () => {
  it('a flow inside the repo leaves no untracked files there', async () => {
    const root = tmpDir();
    const repo = committedRepo(path.join(root, 'repo'));
    const harnesses = fakeRegistry();
    const { workDir } = createFlow({ workRoot: path.join(repo, '.agentic', 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('each group works in its own clone; its commits come back as agentic/<slug>/<group> and the clone goes', async () => {
    const { repo, workDir, harnesses, run } = setup();
    const head = git(repo, ['rev-parse', 'HEAD']);
    expect((await run()).status).toBe('done');

    const state = loadState(workDir);
    const g1 = state.groups.g1!;
    expect(g1).toMatchObject({ repo: '.', branch: 'agentic/cart-limit/g1', baseRef: head, clone_removed: true });
    expect(g1.clonePath).toBeUndefined();
    expect(fs.existsSync(path.join(workDir, 'clones', 'g1'))).toBe(false);
    // both tasks' commits, on the work branch in the user's repo
    expect(git(repo, ['rev-parse', 'agentic/cart-limit/g1'])).toBe(g1.head);
    expect(git(repo, ['log', '--format=%s', `${head}..${g1.head}`]).split('\n')).toEqual(['fake: g1-t2.txt', 'fake: g1-t1.txt']);
    // the reviewed commit of each round, under a ref `git branch` doesn't list
    expect(g1.review!.rounds[0]!.commit).toBe(g1.head);
    expect(git(repo, ['rev-parse', 'refs/agentic/cart-limit/g1/r1'])).toBe(g1.head);

    const cwdOf = (kind: string, group?: string) => harnesses.calls().find((call) => call.kind === kind && call.group === group)!.cwd;
    expect(cwdOf('implement', 'g1')).toBe(path.join(workDir, 'clones', 'g1'));
    expect(cwdOf('review-spec', 'g2')).toBe(path.join(workDir, 'clones', 'g2'));
    expect(cwdOf('breakdown')).toBe(repo);
    // the whole feature is reviewed and fixed in a clone of its own
    expect(cwdOf('review-final')).toBe(path.join(workDir, 'clones', '_final'));
    expect(state.final_review).toMatchObject({ branch: 'agentic/cart-limit/_final', clone_removed: true });
    // the final clone starts at the merged groups: its diff is the feature's, from where the first group started
    const finalReview = harnesses.calls().find((call) => call.kind === 'review-final')!;
    expect(finalReview.prompt).toContain(`Review scope: the commits of this feature — \`git diff ${head}..HEAD\``);
    expect(state.final_review!.review!.rounds[0]!.diff_lines).toBeGreaterThan(0);
    // the user's checkout itself is untouched
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('resume reuses the clone; a vanished clone pauses instead of starting the group over', async () => {
    const failFirstT2 = { implement: (request: { task?: string }, call: number) => (request.task === 't2' && call <= 2 ? { exitCode: 1 } : {}) };
    const sawMarker: boolean[] = [];
    const { workDir, run } = setup({
      script: {
        implement: (request, call) => {
          sawMarker.push(fs.existsSync(path.join(request.cwd, '.git', 'agentic-test-marker')));
          return failFirstT2.implement(request, call);
        },
      },
    });
    expect((await run()).status).toBe('paused');
    fs.writeFileSync(path.join(loadState(workDir).groups.g1!.clonePath!, '.git', 'agentic-test-marker'), 'x');
    expect((await run()).status).toBe('done');
    // t1 and the failed t2 before the marker; the resumed t2 in the same clone
    expect(sawMarker.slice(0, 3)).toEqual([false, false, true]);

    const vanished = setup({ script: failFirstT2 });
    await vanished.run();
    fs.rmSync(loadState(vanished.workDir).groups.g1!.clonePath!, { recursive: true });
    const paused = await vanished.run();
    expect(paused.status).toBe('paused');
    expect(paused.paused?.message).toMatch(/clone group g1 is gone/);
  });

  it('an unknown repo in tasks.yaml is caught at breakdown, before the gate', async () => {
    const { run } = setup({ tasks: FAKE_TASKS.replace('repo: .', 'repo: billing') });
    const state = await run();
    expect(state.status).toBe('paused');
    expect(state.stage).toBe('breakdown');
    expect(state.paused?.message).toMatch(/repo `billing` unknown/);
  });

  it('an origin without commits pauses the group with a clear message', async () => {
    const { run } = setup({ repo: gitRepo });
    const state = await run();
    expect(state.paused?.message).toMatch(/not a git repository with at least one commit/);
  });
});

describe('resolveRepo', () => {
  it('`.` and the origin repo name resolve to the origin repo', () => {
    expect(resolveRepo('.', { repoRoot: '/code/orders' })).toBe('/code/orders');
    expect(resolveRepo('orders', { repoRoot: '/code/orders' })).toBe('/code/orders');
  });

  it('in a workspace, other names resolve to services/<name> repos', () => {
    const workspace = tmpDir();
    const billing = gitRepo(path.join(workspace, 'services', 'billing'));
    const origin = { repoRoot: path.join(workspace, 'services', 'orders'), workspaceRoot: workspace };
    expect(resolveRepo('billing', origin)).toBe(billing);
    expect(() => resolveRepo('payments', origin)).toThrow(/repo `payments` unknown/);
  });

  it('outside a workspace only the origin repo is known', () => {
    expect(() => resolveRepo('billing', { repoRoot: '/code/orders' })).toThrow(/allowed: `.` or `orders`/);
  });
});
