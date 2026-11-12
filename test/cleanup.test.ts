import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry } from '../src/harness/fake.js';
import { applyCleanup, flowCleanup, isEmpty, orphanCleanups } from '../src/orchestrator/cleanup.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { loadState, saveState } from '../src/orchestrator/state.js';
import { readEvents } from '../src/orchestrator/events.js';
import { cleanAll, cleanOne, formatBytes } from '../src/cli/clean.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();
const branchesOf = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentic/').split('\n').filter(Boolean);

async function finishedFlow() {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry();
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
  await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  fs.mkdirSync(path.join(workDir, 'clones', 'g1'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'clones', 'g1', 'file'), 'x'.repeat(100));
  return { root, repo, workDir };
}

describe('clean: a flow', () => {
  it('lists the work directories with sizes and the branches holding the only copy of the work', async () => {
    const { repo, workDir } = await finishedFlow();
    const cleanup = flowCleanup(workDir, loadState(workDir));

    expect(cleanup.dirs.map((dir) => path.basename(dir.path))).toContain('clones');
    expect(cleanup.dirs.find((dir) => dir.path.endsWith('clones'))!.bytes).toBeGreaterThanOrEqual(100);
    expect(cleanup.hiddenRefs).toContainEqual({ repo, ref: 'refs/agentic/cart-limit/g1/r1' });
    expect(cleanup.branches.map((branch) => branch.ref)).toEqual(['_final', 'g1', 'g2'].map((name) => `refs/heads/agentic/cart-limit/${name}`));
    expect(cleanup.branches.every((branch) => branch.onlyHere > 0 && !branch.current)).toBe(true);
  });

  it('keeps the only copy of the work unless told to drop it; audit artifacts always stay', async () => {
    const { repo, workDir } = await finishedFlow();
    const audit = fs.readdirSync(workDir).filter((name) => fs.statSync(path.join(workDir, name)).isFile());

    const kept = applyCleanup(flowCleanup(workDir, loadState(workDir)), { dropWork: false });
    expect(kept.removedBranches).toEqual([]);
    expect(branchesOf(repo)).toHaveLength(3);
    expect(git(repo, 'for-each-ref', 'refs/agentic/')).toBe('');
    expect(fs.existsSync(path.join(workDir, 'clones'))).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual(audit.sort());

    const dropped = applyCleanup(flowCleanup(workDir, loadState(workDir)), { dropWork: true });
    expect(dropped.removedBranches).toHaveLength(3);
    expect(branchesOf(repo)).toEqual([]);
    expect(isEmpty(flowCleanup(workDir, loadState(workDir)))).toBe(true);
  });

  it('a branch whose commits are on a remote goes without asking', async () => {
    const { root, repo, workDir } = await finishedFlow();
    const bare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv() });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'refs/heads/agentic/cart-limit/g1:refs/heads/g1');
    git(repo, 'fetch', '-q', 'origin');

    const cleanup = flowCleanup(workDir, loadState(workDir));
    expect(cleanup.branches.map((branch) => [path.basename(branch.ref), branch.onlyHere > 0])).toEqual([['_final', true], ['g1', false], ['g2', true]]);
    expect(applyCleanup(cleanup, { dropWork: false }).removedBranches.map((branch) => path.basename(branch.ref))).toEqual(['g1']);
  });

  it('the checked-out branch stays even when dropping work', async () => {
    const { repo, workDir } = await finishedFlow();
    git(repo, 'checkout', '-q', 'agentic/cart-limit/g1');
    const result = applyCleanup(flowCleanup(workDir, loadState(workDir)), { dropWork: true });
    expect(result.keptBranches.map((branch) => branch.ref)).toEqual(['refs/heads/agentic/cart-limit/g1']);
    expect(branchesOf(repo)).toEqual(['refs/heads/agentic/cart-limit/g1']);
  });
});

describe('clean: orphans', () => {
  it('work branches and hidden refs of a flow whose directory is gone; a known flow is not an orphan', async () => {
    const { repo } = await finishedFlow();
    git(repo, 'branch', 'agentic/92/g1', 'HEAD');
    git(repo, 'update-ref', 'refs/agentic/92/g1/r1', 'HEAD');

    const orphans = orphanCleanups(repo, new Set(['cart-limit']));
    expect(orphans).toEqual([
      { slug: '92', dirs: [], hiddenRefs: [{ repo, ref: 'refs/agentic/92/g1/r1' }], branches: [expect.objectContaining({ ref: 'refs/heads/agentic/92/g1', onlyHere: 0 })] },
    ]);
  });
});

/** Answers in order; `choose` takes an index (undefined: none), `confirm` a boolean. */
function scriptedPrompt(answers: Array<number | boolean | undefined>) {
  const asked: string[] = [];
  return {
    asked,
    confirm: async (question: string) => (asked.push(question), answers.shift() === true),
    choose: async (question: string) => (asked.push(question), answers.shift() as number | undefined),
  };
}

describe('agentic clean', () => {
  it('without a slug: finished flows and orphans, each asked; a paused flow is only named', async () => {
    const { root, repo, workDir } = await finishedFlow();
    const paused = createFlow({ workRoot: path.join(root, 'work'), title: 'Wstrzymany', entry: 'new', origin: { repoRoot: repo } });
    git(repo, 'branch', 'agentic/wstrzymany/g1', 'HEAD');
    git(repo, 'branch', 'agentic/92/g1', 'HEAD');
    const said: string[] = [];
    const prompt = scriptedPrompt([0, true]);

    await cleanAll([path.join(root, 'work')], { repoRoot: repo }, prompt, {}, (text) => said.push(text));

    expect(prompt.asked).toEqual(['Clean up cart-limit?', 'Clean up 92?']);
    expect(said.join('\n')).toMatch(/cart-limit \(done, ready_to_publish\)\n {2}work directories [\d.]+ [KM]?B: clones/);
    expect(said.join('\n')).toContain('  branch agentic/cart-limit/g1: ');
    expect(said).toContain("Paused (clean one by giving its slug; it can't be resumed afterwards): wstrzymany");
    expect(branchesOf(repo)).toEqual([
      ...['_final', 'g1', 'g2'].map((name) => `refs/heads/agentic/cart-limit/${name}`),
      'refs/heads/agentic/wstrzymany/g1',
    ]);
    expect(fs.existsSync(path.join(workDir, 'clones'))).toBe(false);
    expect(loadState(paused.workDir).status).toBe('running');
  });

  it('--dry-run lists and asks nothing; --yes keeps the only copy of the work', async () => {
    const { root, repo, workDir } = await finishedFlow();
    const prompt = scriptedPrompt([]);
    await cleanAll([path.join(root, 'work')], { repoRoot: repo }, prompt, { dryRun: true }, () => {});
    expect(fs.existsSync(path.join(workDir, 'clones'))).toBe(true);

    await cleanAll([path.join(root, 'work')], { repoRoot: repo }, prompt, { yes: true }, () => {});
    expect(prompt.asked).toEqual([]);
    expect(fs.existsSync(path.join(workDir, 'clones'))).toBe(false);
    expect(branchesOf(repo)).toHaveLength(3);
  });

  it('a paused flow by slug ends as aborted only when cleaned', async () => {
    const { workDir } = await finishedFlow();
    saveState(workDir, { ...loadState(workDir), status: 'paused' });
    const said: string[] = [];

    await cleanOne(workDir, scriptedPrompt([undefined]), {}, (text) => said.push(text));
    expect(loadState(workDir).status).toBe('paused');
    expect(said[0]).toMatch(/is paused .* it can't be resumed/);

    await cleanOne(workDir, scriptedPrompt([1]), {}, () => {});
    expect(loadState(workDir).status).toBe('aborted');
    expect(readEvents(workDir).at(-1)).toMatchObject({ type: 'flow_aborted', message: 'ended by agentic clean' });
    expect(isEmpty(flowCleanup(workDir, loadState(workDir)))).toBe(true);
  });

  it('sizes in B, KB, MB', () => {
    expect([formatBytes(512), formatBytes(1536), formatBytes(5.5 * 1024 * 1024), formatBytes(300 * 1024 * 1024)]).toEqual(['512 B', '1.5 KB', '5.5 MB', '300 MB']);
  });
});
