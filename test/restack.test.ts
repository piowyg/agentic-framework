import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig, ForgeConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { readEvents } from '../src/orchestrator/events.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { rebuildStack } from '../src/orchestrator/restack-rebase.js';
import type { FlowContext } from '../src/orchestrator/run.js';
import { loadState } from '../src/orchestrator/state.js';
import type { Fetch } from '../src/publish/forge.js';
import { publishFlow, type PublishPlan } from '../src/publish/publish.js';
import { restackFlow, type RestackPlan } from '../src/publish/restack.js';
import { committedRepo, GIT_IDENTITY, QUOTED_FILE, tmpDir, TEST_CONFIG } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...gitEnv(), ...GIT_IDENTITY }, encoding: 'utf8' }).trim();

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
}

/** A GitHub that remembers its PRs and their states; heads are read from the bare `origin`. */
function githubFake(bare: string) {
  const pulls: FakePull[] = [];
  const html = (number: number) => `https://github.com/acme/shop/pull/${number}`;
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const headOf = (branch: string) => {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: bare, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const view = (pull: FakePull) => ({
    number: pull.number,
    node_id: `PR_${pull.number}`,
    html_url: html(pull.number),
    draft: pull.draft,
    state: pull.state,
    merged_at: pull.merged ? '2026-11-08T12:00:00Z' : null,
    base: { ref: pull.base },
    ...(headOf(pull.head) && { head: { sha: headOf(pull.head) } }),
  });
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string | boolean | object>) : {};
    const byHead = /[?&]head=([^&]+)/.exec(url);
    if (method === 'GET' && byHead) {
      const branch = decodeURIComponent(byHead[1]!).split(':')[1];
      const all = /state=all/.test(url);
      return respond(pulls.filter((pull) => pull.head === branch && (all || pull.state === 'open')).reverse().map(view));
    }
    if (method === 'POST' && url.endsWith('/graphql')) {
      const id = String((body.variables as unknown as { id: string }).id);
      pulls[Number(id.replace('PR_', '')) - 1]!.draft = false;
      return respond({ data: {} });
    }
    if (method === 'POST' && url.endsWith('/pulls')) {
      const pull: FakePull = { number: pulls.length + 1, head: String(body.head), base: String(body.base), title: String(body.title), body: String(body.body), draft: body.draft === true, state: 'open', merged: false };
      pulls.push(pull);
      return respond({ number: pull.number, html_url: html(pull.number) }, 201);
    }
    const patched = /\/pulls\/(\d+)$/.exec(url);
    if (method === 'PATCH' && patched) {
      const pull = pulls[Number(patched[1]) - 1]!;
      Object.assign(pull, { title: body.title, body: body.body }, body.base && { base: body.base });
      return respond({ number: pull.number, html_url: html(pull.number) });
    }
    return respond({});
  };
  return { fetcher, pulls };
}

/** A finished two-group chain (g1: two tasks, g2: one) published as a stack: PR 1 ready on main, PR 2 a draft on PR 1. */
async function publishedStack(options: { script?: FakeScript; gates?: Partial<Record<string, GateDecision[]>>; config?: AgenticConfig } = {}) {
  const config = options.config ?? TEST_CONFIG;
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { env: gitEnv() });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
  git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/shop.git');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
  const context: FlowContext = { workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, checksTrusted: true };
  expect((await runFlow({ ...context, config: TEST_CONFIG })).outcome).toBe('ready_to_publish');
  const github = githubFake(bare);
  const common = { workDir, config, forge: { type: 'github', auth: { env: 'GH' } } as ForgeConfig, framework: '0.1.0', fetcher: github.fetcher, token: async () => 'tok' };
  const plans: PublishPlan[] = [];
  await publishFlow({ ...common, confirm: async (plan) => (plans.push(plan), true), log: () => {}, scan: async () => [] });
  const published = loadState(workDir).published!;
  const lower = published.stack![0]!;
  const upper = published.stack![1]!;
  const other = path.join(root, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { env: gitEnv() });

  const restackLog: string[] = [];
  const restackPlans: RestackPlan[] = [];
  const restack = (overrides: { confirm?: boolean; context?: FlowContext; whileConfirming?: () => void } = {}) =>
    restackFlow({
      ...common,
      log: (message) => restackLog.push(message),
      rebuild: (request) => rebuildStack(overrides.context ?? context, request),
      confirm: async (plan) => {
        restackPlans.push(plan);
        overrides.whileConfirming?.();
        return overrides.confirm ?? true;
      },
    });

  /** The human squash-merges PR 1 on GitHub: one commit on main with its diff, the PR merged, its branch deleted. */
  const squashLower = () => {
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-B', 'main', 'origin/main');
    execFileSync('git', ['merge', '-q', '--squash', `origin/${lower.branch}`], { cwd: other, env: { ...gitEnv(), ...GIT_IDENTITY }, stdio: 'ignore' });
    git(other, 'commit', '-q', '-m', 'Cart limit (1/2): Limit rule (#1)');
    git(other, 'push', '-q', 'origin', 'main', `:refs/heads/${lower.branch}`);
    github.pulls[0]!.state = 'closed';
    github.pulls[0]!.merged = true;
    // GitHub moves a PR whose base branch was deleted onto that branch's base
    github.pulls[1]!.base = 'main';
    return git(other, 'rev-parse', 'HEAD');
  };

  /** Someone else's commit on main. */
  const advanceMain = (file: string, content: string) => {
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-B', 'main', 'origin/main');
    fs.writeFileSync(path.join(other, file), content);
    git(other, 'add', file);
    git(other, 'commit', '-q', '-m', `other: ${file}`);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };

  /** The human pushes a commit onto a PR's branch. */
  const humanCommit = (branch: string, file: string, content: string) => {
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    fs.writeFileSync(path.join(other, file), content);
    git(other, 'add', file);
    git(other, 'commit', '-q', '-m', `review: ${file}`);
    git(other, 'push', '-q', 'origin', branch);
    return git(other, 'rev-parse', 'HEAD');
  };

  return { root, repo, bare, workDir, context, harnesses, gates, github, lower, upper, plans, restack, restackLog, restackPlans, squashLower, advanceMain, humanCommit };
}

const subjects = (cwd: string, range: string) => git(cwd, 'log', '--format=%s', range).split('\n').filter(Boolean);

describe('agentic restack', () => {
  it('after a squash of the lowest PR: the next one rebuilt onto main with only its own commits, moved onto main and out of draft', async () => {
    const stack = await publishedStack({ config: { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['test -f g1-t1.txt'] } } });
    const squash = stack.squashLower();

    const result = await stack.restack();

    expect(result!.pushed).toBe(true);
    const upperHead = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);
    expect(git(stack.bare, 'rev-parse', `${upperHead}~1`)).toBe(squash);
    expect(subjects(stack.bare, `${squash}..${upperHead}`)).toEqual(['fake: g2-t1.txt']);
    expect(stack.restackPlans[0]).toMatchObject({
      newlyMerged: [stack.lower.branch],
      push: [stack.upper.branch],
      pulls: [
        { group: 'g1', status: 'merged' },
        { group: 'g2', status: 'rebuilt', head: upperHead, humanCommits: 0, becomesLowest: true },
      ],
    });
    expect(stack.github.pulls[1]).toMatchObject({ base: 'main', draft: false, title: 'Cart limit (2/2): Configuration' });
    expect(stack.github.pulls[1]!.body).toContain('1. ~~[Limit rule](https://github.com/acme/shop/pull/1)~~ ✓ merged');
    const state = loadState(stack.workDir);
    expect(state.published).toMatchObject({ head: upperHead, lowest: stack.upper.branch, url: 'https://github.com/acme/shop/pull/2', restacked: expect.any(String) });
    expect(state.published!.stack).toMatchObject([
      { group: 'g1', merged: true },
      { group: 'g2', base: 'main', head: upperHead },
    ]);
    expect(state.target).toEqual({ branch: 'main', commit: squash });
    expect(state.restack).toBeUndefined();
    // checks ran on the rebuilt code, which has g1's files through the squash
    expect(readEvents(stack.workDir)).toContainEqual(expect.objectContaining({ type: 'checks_done', owner: 'restack-1' }));
    expect(readEvents(stack.workDir).at(-1)).toMatchObject({ type: 'flow_restacked', merged: 1, pushed: 1, url: 'https://github.com/acme/shop/pull/2' });
    expect(git(stack.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/')).toBe('');
  });

  it('the human\'s commit on a lower open PR: the PR above rebuilt onto it; the lower one is not pushed', async () => {
    const stack = await publishedStack();
    const reviewed = stack.humanCommit(stack.lower.branch, 'review.txt', 'fixed after review\n');

    await stack.restack();

    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.lower.branch}`)).toBe(reviewed);
    const upperHead = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);
    expect(subjects(stack.bare, `${reviewed}..${upperHead}`)).toEqual(['fake: g2-t1.txt']);
    expect(stack.restackPlans[0]).toMatchObject({ newlyMerged: [], push: [stack.upper.branch], pulls: [{ status: 'unchanged', humanCommits: 1 }, { status: 'rebuilt' }] });
    expect(stack.restackPlans[0]!.pulls[1]!.becomesLowest).toBeUndefined();
    expect(stack.github.pulls[1]).toMatchObject({ base: stack.lower.branch, draft: true });
  });

  it('the human\'s commit on the top PR rides along onto main after the squash', async () => {
    const stack = await publishedStack();
    stack.humanCommit(stack.upper.branch, 'nit.txt', 'nit\n');
    const squash = stack.squashLower();

    await stack.restack();

    const upperHead = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);
    expect(subjects(stack.bare, `${squash}..${upperHead}`)).toEqual(['review: nit.txt', 'fake: g2-t1.txt']);
    expect(stack.restackPlans[0]!.pulls[1]).toMatchObject({ humanCommits: 1 });
  });

  it('nothing merged and nothing pushed onto the PRs: the stack is up to date, nothing asked, nothing pushed', async () => {
    const stack = await publishedStack();
    stack.advanceMain('other.txt', 'theirs\n');
    const before = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);

    const result = await stack.restack();

    expect(result).toMatchObject({ pushed: false, plan: { push: [], newlyMerged: [] } });
    expect(stack.restackPlans).toEqual([]);
    expect(stack.restackLog).toContainEqual(expect.stringMatching(/^Stack up to date/));
    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(before);
    expect(loadState(stack.workDir).published!.restacked).toBeUndefined();
  });

  it('declined: nothing is pushed, the rebuilt branch waits and the next run takes it without rebuilding', async () => {
    const stack = await publishedStack();
    stack.squashLower();
    const before = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);

    expect(await stack.restack({ confirm: false })).toMatchObject({ pushed: false });
    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(before);
    const kept = loadState(stack.workDir).restack!.branches[0]!;
    expect(kept).toMatchObject({ branch: stack.upper.branch, rebuilt: expect.any(String) });

    await stack.restack();
    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(kept.rebuilt);
    expect(readEvents(stack.workDir).filter((event) => event.type === 'checks_done' && event.owner === 'restack-1')).toHaveLength(0);
  });

  it('a conflict with main goes to a merge session; the merge gate shows the range-diff, the resolution is pushed', async () => {
    const stack = await publishedStack({
      script: {
        merge: {
          commit: { 'g2-t1.txt': 'both\n' },
          report: { status: 'resolved', files: [{ path: 'g2-t1.txt', decision: 'both combined', rationale: 'AC-1 needs the group line, main its own' }] },
        },
      },
    });
    stack.advanceMain('g2-t1.txt', 'theirs\n');
    stack.squashLower();

    await stack.restack();

    const [merge] = stack.harnesses.calls().filter((call) => call.kind === 'merge');
    expect(merge!.cwd).toMatch(/clones\/restack-1$/);
    expect(merge!.prompt).toMatch(/This is a rebase, not a merge[\s\S]*git rebase --continue/);
    const [gate] = stack.gates.seen.filter((request) => request.gate === 'merge');
    expect(gate!.group).toBe('g2');
    expect(gate!.summary).toMatch(/g2-t1\.txt: both combined — AC-1 needs the group line/);
    expect(gate!.summary).toMatch(/git range-diff[\s\S]*fake: g2-t1\.txt/);
    const upperHead = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);
    expect(git(stack.bare, 'show', `${upperHead}:g2-t1.txt`)).toBe('both');
    expect(stack.restackPlans[0]!.pulls[1]).toMatchObject({ resolved: ['g2-t1.txt'] });
  });

  it('stop at the merge gate: nothing pushed, the progress kept; the next run takes the accepted session, no second one', async () => {
    const stack = await publishedStack({ script: { merge: { commit: { 'g2-t1.txt': 'both\n' } } }, gates: { merge: [{ action: 'stop' }] } });
    stack.advanceMain('g2-t1.txt', 'theirs\n');
    stack.squashLower();
    const before = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);

    await expect(stack.restack()).rejects.toThrow(/paused at gate merge\nNothing pushed; to finish: agentic restack cart-limit/);
    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(before);
    expect(loadState(stack.workDir).restack!.branches[0]!.conflict!.report).toBeDefined();

    await stack.restack();
    expect(stack.harnesses.calls().filter((call) => call.kind === 'merge')).toHaveLength(1);
    expect(git(stack.bare, 'show', `refs/heads/${stack.upper.branch}:g2-t1.txt`)).toBe('both');
    expect(loadState(stack.workDir).restack).toBeUndefined();
  });

  it('"I\'ll resolve it": a clone with the stopped rebase for the human; the finished rebase is taken on the next run', async () => {
    const stack = await publishedStack({ script: { merge: { report: { status: 'escalated', files: [], reason: 'main changed the contract' } } }, gates: { merge: [{ action: 'manual' }] } });
    stack.advanceMain('g2-t1.txt', 'theirs\n');
    stack.squashLower();

    await expect(stack.restack()).rejects.toThrow(/finish the rebase in .*manual\/restack-1/);
    const manual = path.join(stack.workDir, 'manual', 'restack-1');
    await expect(stack.restack()).rejects.toThrow(/unfinished \(rebase in progress\)/);

    fs.writeFileSync(path.join(manual, 'g2-t1.txt'), 'by hand\n');
    git(manual, 'add', 'g2-t1.txt');
    execFileSync('git', ['rebase', '--continue'], { cwd: manual, env: { ...gitEnv(), ...GIT_IDENTITY, GIT_EDITOR: 'true' }, stdio: 'ignore' });
    await stack.restack();

    expect(git(stack.bare, 'show', `refs/heads/${stack.upper.branch}:g2-t1.txt`)).toBe('by hand');
    expect(fs.existsSync(manual)).toBe(false);
  });

  it('checks red on the rebuilt code stop before the push', async () => {
    const stack = await publishedStack({ config: { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: ['test ! -f breaker.txt'] } } });
    stack.advanceMain('breaker.txt', 'x\n');
    stack.squashLower();
    const before = git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`);

    await expect(stack.restack()).rejects.toThrow(/checks red on feat\/cart-limit-2 after moving[\s\S]*test ! -f breaker\.txt/);
    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(before);
  });

  it('the merge session may not change the group\'s frozen tests to get through the conflict', async () => {
    const original = QUOTED_FILE.content;
    const stack = await publishedStack({
      script: {
        merge: (_request, call) =>
          call === 1
            ? { commit: { 'g2-t1.txt': 'both\n', [QUOTED_FILE.path]: 'weakened\n' }, report: { status: 'resolved', files: [{ path: 'g2-t1.txt', decision: 'both', rationale: 'both needed' }] } }
            : { commit: { [QUOTED_FILE.path]: original }, report: { status: 'resolved', files: [{ path: 'g2-t1.txt', decision: 'both', rationale: 'both needed' }] } },
      },
    });
    const state = loadState(stack.workDir);
    const frozenBlob = git(stack.repo, 'rev-parse', `${stack.upper.head}:${QUOTED_FILE.path}`);
    state.groups.g2!.write_tests = { report: { tests: [] } as never, frozen: { [QUOTED_FILE.path]: frozenBlob }, commit: stack.upper.head };
    fs.writeFileSync(path.join(stack.workDir, 'state.json'), JSON.stringify(state));
    stack.advanceMain('g2-t1.txt', 'theirs\n');
    stack.squashLower();

    await stack.restack();

    const merges = stack.harnesses.calls().filter((call) => call.kind === 'merge');
    expect(merges).toHaveLength(2);
    expect(merges[1]!.prompt).toMatch(/You changed tests the group's test author wrote/);
    expect(merges[1]!.prompt).toContain(QUOTED_FILE.path);
    expect(git(stack.bare, 'show', `refs/heads/${stack.upper.branch}:${QUOTED_FILE.path}`)).toBe(original.trim());
  });

  it('refuses a PR closed without merging; nothing is pushed', async () => {
    const stack = await publishedStack();
    stack.github.pulls[0]!.state = 'closed';
    await expect(stack.restack()).rejects.toThrow(/PR 1\/2 \(feat\/cart-limit-1, https:\/\/github\.com\/acme\/shop\/pull\/1\) closed without a merge/);
    expect(stack.restackPlans).toEqual([]);
  });

  it('refuses a branch whose history someone rewrote; nothing is pushed', async () => {
    const stack = await publishedStack();
    const root = git(stack.bare, 'rev-parse', 'refs/heads/main');
    git(stack.repo, 'push', '-q', '--force', 'origin', `${root}:refs/heads/${stack.lower.branch}`);
    await expect(stack.restack()).rejects.toThrow(/origin\/feat\/cart-limit-1 doesn't contain .* someone rewrote its history/);
    expect(stack.restackPlans).toEqual([]);
  });

  it('refuses a PR merged while the one under it is still open; nothing is pushed', async () => {
    const stack = await publishedStack();
    stack.github.pulls[1]!.state = 'closed';
    stack.github.pulls[1]!.merged = true;
    await expect(stack.restack()).rejects.toThrow(/PR 2\/2 .* merged while the PR below it is open/);
    expect(stack.restackPlans).toEqual([]);
  });

  it('refuses a PR merged into another branch than the target; nothing is pushed', async () => {
    const stack = await publishedStack();
    Object.assign(stack.github.pulls[0]!, { state: 'closed', merged: true, base: 'develop' });
    await expect(stack.restack()).rejects.toThrow(/PR 1\/2 .* merged into develop, not into main/);
    expect(stack.restackPlans).toEqual([]);
  });

  it('a push onto a PR while the restack waits for confirmation: the lease refuses, the human\'s commit stays', async () => {
    const stack = await publishedStack();
    stack.squashLower();
    let pushedMeanwhile = '';

    await expect(stack.restack({ whileConfirming: () => (pushedMeanwhile = stack.humanCommit(stack.upper.branch, 'late.txt', 'late\n')) })).rejects.toThrow(/stale info|rejected/);

    expect(git(stack.bare, 'rev-parse', `refs/heads/${stack.upper.branch}`)).toBe(pushedMeanwhile);
    expect(loadState(stack.workDir).published!.restacked).toBeUndefined();
  });

  it('after a restack, publish refuses: the stack is the restack\'s to update', async () => {
    const stack = await publishedStack();
    stack.squashLower();
    await stack.restack();
    await expect(
      publishFlow({ workDir: stack.workDir, config: TEST_CONFIG, forge: { type: 'github', auth: { env: 'GH' } }, framework: '0.1.0', confirm: async () => true, log: () => {}, scan: async () => [], fetcher: stack.github.fetcher, token: async () => 'tok' }),
    ).rejects.toThrow(/`agentic restack` rebuilt the stack/);
  });

  it('every PR merged: nothing to rebuild', async () => {
    const stack = await publishedStack();
    stack.squashLower();
    stack.github.pulls[1]!.state = 'closed';
    stack.github.pulls[1]!.merged = true;
    expect(await stack.restack()).toBeUndefined();
    expect(stack.restackLog).toContain('All PRs of the stack merged (2); nothing to rebuild.');
    expect(loadState(stack.workDir).published!.stack!.every((pull) => pull.merged)).toBe(true);
  });

  it('a flow without a published stack is refused', async () => {
    const stack = await publishedStack();
    const state = loadState(stack.workDir);
    delete state.published!.stack;
    fs.writeFileSync(path.join(stack.workDir, 'state.json'), JSON.stringify(state));
    await expect(stack.restack()).rejects.toThrow(/has no published stack of PRs/);
  });
});
