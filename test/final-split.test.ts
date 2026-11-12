import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../src/config/git.js';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { fakeRegistry, type FakeReply, type FakeScript } from '../src/harness/fake.js';
import type { SessionRequest } from '../src/harness/types.js';
import { assignFixes } from '../src/orchestrator/final-split.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { loadState } from '../src/orchestrator/state.js';
import { reviewNotes } from '../src/publish/description.js';
import { publishFlow } from '../src/publish/publish.js';
import { committedRepo, GIT_IDENTITY, NO_STACK_CONFIG, QUOTED, tmpDir, TEST_CONFIG } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...gitEnv(), ...GIT_IDENTITY }, encoding: 'utf8' }).trim();

describe('final review fixes: whose lines each hunk changes (git blame)', () => {
  /** Commits `files` on top of HEAD; returns the commit. */
  const commit = (repo: string, message: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };

  it('a group\'s own line → that group; an addition → its neighbours\' group, next to a line from before the feature → the top; an earlier fix\'s line → where that fix went; the rest → the top', () => {
    const repo = path.join(tmpDir(), 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=main');
    commit(repo, 'base', { 'a.txt': 'b1\nb2\nb3\nb4\nb5\nb6\n' });
    const g1 = commit(repo, 'g1', { 'a.txt': 'b1\nb2\ng1\nb3\nb4\nb5\nb6\n' });
    const g2 = commit(repo, 'g2', { 'a.txt': 'b1\nb2\ng1\ng2\nb3\nb4\ng2b\ng2c\nb5\nb6\n' });
    const g3 = commit(repo, 'g3', { 'z.txt': 'z\n' });
    const fix1 = commit(repo, 'fix 1', { 'a.txt': 'b1\nb2\nG1\ng2\nb3\nb4\nG2B\ng2c\nb5\nB6\n', 'c.txt': 'new\n' });
    // `n` between the line fix 1 gave g2 and g2's own line; `m` between g2's line and one from before the feature
    const fix2 = commit(repo, 'fix 2', { 'a.txt': 'b1\nb2\nG1!\ng2\nb3\nb4\nG2B\nn\ng2c\nm\nb5\nB6\n' });
    const fix3 = commit(repo, 'fix 3', { 'a.txt': 'b1\nb2\nX\nY\nb3\nb4\nG2B\nn\ng2c\nm\nb5\nB6\n' });
    const owners = new Map([
      [g1, 'g1'],
      [g2, 'g2'],
      [g3, 'g3'],
    ]);

    const assignment = assignFixes(repo, [fix1, fix2, fix3], owners, 'g3');

    const placed = assignment.map((fix) => fix.parts.map((part) => `${'hunk' in part ? `${part.path}:${part.hunk.newStart}` : part.path} → ${part.group}${part.why ? ` (${part.why})` : ''}`));
    expect(placed).toEqual([
      ['a.txt:3 → g1', 'a.txt:7 → g2', 'a.txt:10 → g3 (lines from before the feature)', 'c.txt → g3 (new file)'],
      ['a.txt:3 → g1', 'a.txt:8 → g2', 'a.txt:10 → g3 (lines from before the feature)'],
      ['a.txt:3 → g3 (linie kilku grup (g1, g2))'],
    ]);
  });
});

/** The finding the final review raises in its first round; the second finds it fixed. */
const finalReview = (_request: SessionRequest, call: number): FakeReply =>
  call === 1
    ? { report: { findings: [{ id: 'B1', severity: 'blocking', message: 'brak walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-2' } }] } }
    : { report: { findings: [], previous: [{ id: 'B1', status: 'fixed' }] } };

/**
 * g1/t1 writes `shared.txt`; g2/t1 changes its second line — so the fix to the first line conflicts twice: laid on g1
 * (its 3-way base has g2's line) and when g2's commit is replayed onto g1's new head.
 */
const sharedFile = (request: SessionRequest): FakeReply => {
  if (request.group === 'g1' && request.task === 't1') return { commit: { 'g1-t1.txt': 't1\n', 'shared.txt': 'a\nb\n' } };
  if (request.group === 'g2') return { commit: { 'g2-t1.txt': 't1\n', 'shared.txt': 'a\nB2\n' } };
  return { commit: { [`${request.group}-${request.task}.txt`]: `${request.task}\n` } };
};

function setup(options: { script?: FakeScript; gates?: Partial<Record<string, GateDecision[]>>; config?: AgenticConfig } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ 'review-final': finalReview, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
  const log: string[] = [];
  const run = () =>
    runFlow({ workDir, config: options.config ?? TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, checksTrusted: true, log: (message) => log.push(message) });
  const show = (commit: string, file: string) => git(repo, 'show', `${commit}:${file}`);
  return { repo, workDir, harnesses, gates, run, log, show };
}

describe('final review fixes moved into the stack\'s groups', () => {
  it('each group gets the fix to its own lines as a `(final review)` commit; a new file stays on top; the top tree is the final review\'s', async () => {
    const flow = setup({ script: { fix: { commit: { 'g1-t1.txt': 'fixed g1\n', 'g2-t1.txt': 'fixed g2\n', 'fix-feature.txt': 'new\n' } } } });

    const done = await flow.run();
    expect(done.status).toBe('done');

    const state = loadState(flow.workDir);
    const g1 = state.groups.g1!.head!;
    const g2 = state.groups.g2!.head!;
    expect(flow.show(g1, 'g1-t1.txt')).toBe('fixed g1');
    expect(git(flow.repo, 'log', '-1', '--format=%s%n%an', g1)).toBe('fake: g1-t1.txt, g2-t1.txt, fix-feature.txt (final review)\nfake');
    expect(git(flow.repo, 'merge-base', '--is-ancestor', g1, g2)).toBe('');
    expect(state.final_review!.head).toBe(g2);
    expect(git(flow.repo, 'rev-parse', `refs/heads/${state.groups.g1!.branch}`)).toBe(g1);
    expect(git(flow.repo, 'rev-parse', `refs/heads/${state.final_review!.branch}`)).toBe(g2);
    expect(flow.show(g2, 'g2-t1.txt')).toBe('fixed g2');
    expect(flow.show(g2, 'fix-feature.txt')).toBe('new');
    // g2's PR (the top) carries what's left of the fix: its own line and the new file
    expect(git(flow.repo, 'diff', '--name-only', g1, g2).split('\n')).toEqual(['fix-feature.txt', 'g2-t1.txt']);
    expect(state.final_review!.split).toEqual({ done: true, moved: { g1: ['g1-t1.txt:1'] } });
    expect(flow.log.join('\n')).toMatch(/fix-feature\.txt → g2 \(new file\)[\s\S]*g1-t1\.txt:1 → g1[\s\S]*g2-t1\.txt:1 → g2[\s\S]*✓ final review fixes split into groups: g1 \(1\)/);
    expect(reviewNotes(state).filter((note) => note.scope === 'g1').map((note) => note.text)).toEqual([
      "the final review's fixes to this PR's lines are here, in the commits marked `(final review)`: `g1-t1.txt:1`",
    ]);
    expect(git(flow.repo, 'for-each-ref', '--format=%(refname)', 'refs/agentic/')).not.toMatch(/final-fix/);
    expect(fs.existsSync(path.join(flow.workDir, 'clones', 'final-fix-1'))).toBe(false);
  });

  it('one file, hunks for two groups: the lower group\'s addition lands at its own place, not shifted by the top group\'s hunk above it', async () => {
    // g1 writes a–f; g2 puts its line above them; the fix grows g2's line into three and adds a line after g1's `d`
    const implement = (request: SessionRequest): FakeReply => {
      if (request.group === 'g1' && request.task === 't1') return { commit: { 'g1-t1.txt': 't1\n', 'shared.txt': 'a\nb\nc\nd\ne\nf\n' } };
      if (request.group === 'g2') return { commit: { 'g2-t1.txt': 't1\n', 'shared.txt': 'G2\na\nb\nc\nd\ne\nf\n' } };
      return { commit: { [`${request.group}-${request.task}.txt`]: `${request.task}\n` } };
    };
    const flow = setup({ script: { implement, fix: { commit: { 'shared.txt': 'H1\nH2\nH3\na\nb\nc\nd\nNEW\ne\nf\n' } } } });

    expect((await flow.run()).status).toBe('done');

    const state = loadState(flow.workDir);
    expect(flow.show(state.groups.g1!.head!, 'shared.txt')).toBe('a\nb\nc\nd\nNEW\ne\nf');
    expect(flow.show(state.groups.g2!.head!, 'shared.txt')).toBe('H1\nH2\nH3\na\nb\nc\nd\nNEW\ne\nf');
    expect(state.final_review!.split).toEqual({ done: true, moved: { g1: ['shared.txt:8'] } });
  });

  it('publish after the move: PR 1 carries the fix to its own line, the top PR the rest', async () => {
    const root = tmpDir();
    const repo = committedRepo(path.join(root, 'repo'));
    const bare = path.join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare], { env: gitEnv() });
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/shop.git');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    const harnesses = fakeRegistry({ 'review-final': finalReview, fix: { commit: { 'g1-t1.txt': 'fixed g1\n', 'g2-t1.txt': 'fixed g2\n' } } });
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Cart limit', entry: 'new', origin: { repoRoot: repo } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });

    await publishFlow({ workDir, config: TEST_CONFIG, framework: '0.1.0', confirm: async () => true, log: () => {}, scan: async () => [] });

    const [lower, upper] = loadState(workDir).published!.stack!;
    expect(git(bare, 'show', `refs/heads/${lower!.branch}:g1-t1.txt`)).toBe('fixed g1');
    expect(git(bare, 'diff', '--name-only', `refs/heads/${lower!.branch}`, `refs/heads/${upper!.branch}`).split('\n')).toEqual(['g2-t1.txt']);
  });

  it('a fix only to the top group\'s lines, or `publish.stack: false`: nothing moves', async () => {
    const onTop = setup({ script: { fix: { commit: { 'g2-t1.txt': 'fixed g2\n' } } } });
    await onTop.run();
    const state = loadState(onTop.workDir);
    expect(state.final_review!.head).not.toBe(state.groups.g2!.head);
    expect(state.final_review!.split).toEqual({ done: true });

    const noStack = setup({ config: NO_STACK_CONFIG, script: { fix: { commit: { 'g1-t1.txt': 'fixed g1\n' } } } });
    await noStack.run();
    const unsplit = loadState(noStack.workDir);
    expect(noStack.show(unsplit.groups.g1!.head!, 'g1-t1.txt')).toBe('t1');
    expect(unsplit.final_review!.split).toEqual({ done: true });
  });

  it('conflicts while moving go to merge sessions in their own clones and through the merge gate', async () => {
    const flow = setup({
      script: {
        implement: sharedFile,
        fix: { commit: { 'shared.txt': 'A\nB2\n' } },
        merge: (request) => ({
          commit: { 'shared.txt': request.cwd?.endsWith('final-fix-1') ? 'A\nb\n' : 'A\nB2\n' },
          report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both', rationale: 'the fix and the group line' }] },
        }),
      },
    });

    expect((await flow.run()).status).toBe('done');

    const merges = flow.harnesses.calls().filter((call) => call.kind === 'merge');
    expect(merges.map((call) => path.basename(call.cwd!))).toEqual(['final-fix-1', 'final-fix-2']);
    expect(merges[0]!.prompt).toMatch(/final review's fixes to its own lines land in its PR[\s\S]*git rebase --continue/);
    const gates = flow.gates.seen.filter((request) => request.gate === 'merge');
    expect(gates.map((request) => request.group)).toEqual(['g1', 'g2']);
    expect(gates[0]!.summary).toMatch(/shared\.txt: both — the fix and the group line[\s\S]*\(final review\)/);
    const state = loadState(flow.workDir);
    expect(flow.show(state.groups.g1!.head!, 'shared.txt')).toBe('A\nb');
    expect(flow.show(state.groups.g2!.head!, 'shared.txt')).toBe('A\nB2');
    expect(state.final_review!.head).toBe(state.groups.g2!.head);
  });

  it('a resolution that loses a fix: the top tree differs from the final review\'s, the sessions run again with the diff', async () => {
    let g2Sessions = 0;
    const flow = setup({
      script: {
        implement: sharedFile,
        fix: { commit: { 'shared.txt': 'A\nB2\n' } },
        merge: (request) => {
          const g1 = request.cwd?.endsWith('final-fix-1');
          const lost = !g1 && !g2Sessions++;
          return { commit: { 'shared.txt': g1 ? 'A\nb\n' : lost ? 'a\nB2\n' : 'A\nB2\n' }, report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both', rationale: 'r' }] } };
        },
      },
    });

    expect((await flow.run()).status).toBe('done');

    // from the first conflicted branch up, each session again, told what came out different
    const merges = flow.harnesses.calls().filter((call) => call.kind === 'merge');
    expect(merges.map((call) => path.basename(call.cwd!))).toEqual(['final-fix-1', 'final-fix-2', 'final-fix-1', 'final-fix-2']);
    expect(merges[3]!.prompt).toMatch(/came out different[\s\S]*-a\n\+A/);
    expect(flow.log.join('\n')).toMatch(/the tree after the rebuild differs from the final review; merge sessions again \(1\/3\)/);
    const state = loadState(flow.workDir);
    expect(flow.show(state.groups.g2!.head!, 'shared.txt')).toBe('A\nB2');
    expect(state.final_review!.split!.attempts).toBeUndefined();
  });

  it('a resolution that loses a fix twice: the session sees only the latest difference, not every earlier one', async () => {
    let g2Sessions = 0;
    const flow = setup({
      script: {
        implement: sharedFile,
        fix: { commit: { 'shared.txt': 'A\nB2\n' } },
        merge: (request) => {
          const g1 = request.cwd?.endsWith('final-fix-1');
          const lost = !g1 && g2Sessions++ < 2;
          return { commit: { 'shared.txt': g1 ? 'A\nb\n' : lost ? 'a\nB2\n' : 'A\nB2\n' }, report: { status: 'resolved', files: [{ path: 'shared.txt', decision: 'both', rationale: 'r' }] } };
        },
      },
    });

    expect((await flow.run()).status).toBe('done');

    const lastG2 = flow.harnesses.calls().filter((call) => call.kind === 'merge' && call.cwd?.endsWith('final-fix-2')).at(-1)!;
    expect(lastG2.prompt.match(/came out different/g)).toHaveLength(1);
  });

  it('checks red on a group with its fixes: they go back to the top PR, the group stays as it was and its PR says so', async () => {
    // red only where g1's fix sits without g2's line: on g1's rebuilt head
    const check = 'test "$(cat g1-t1.txt 2>/dev/null)" != "fixed g1" || test -f g2-t1.txt';
    const config = { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: [check] } };
    const flow = setup({ config, script: { fix: { commit: { 'g1-t1.txt': 'fixed g1\n' } } } });

    expect((await flow.run()).status).toBe('done');

    const state = loadState(flow.workDir);
    expect(flow.show(state.groups.g1!.head!, 'g1-t1.txt')).toBe('t1');
    expect(flow.show(state.final_review!.head!, 'g1-t1.txt')).toBe('fixed g1');
    expect(state.final_review!.split).toEqual({ done: true, withdrawn: { g1: 'g1' } });
    expect(flow.log.join('\n')).toMatch(/the final review fixes of group g1 go back to the last PR: checks red with them on branch g1/);
    expect(reviewNotes(state).filter((note) => note.scope === 'g1').map((note) => note.text)).toEqual([
      "the final review's fixes to this PR's lines are in the last PR of the stack: checks were red with them here",
    ]);
  });

  it('fixes that end up all on the top PR: the log still says where each hunk would have gone', async () => {
    const check = 'test "$(cat g1-t1.txt 2>/dev/null)" != "fixed g1" || test -f g2-t1.txt';
    const config = { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: [check] } };
    const flow = setup({ config, script: { fix: { commit: { 'g1-t1.txt': 'fixed g1\n' } } } });

    expect((await flow.run()).status).toBe('done');

    expect(flow.log.join('\n')).toMatch(/g1-t1\.txt:1 → g1[\s\S]*go back to the last PR/);
  });

  it('checks red on a group with no fixes of its own: the nearest group under it with fixes withdraws them; a group higher up keeps its own', async () => {
    const chain = `groups:\n${['g1', 'g2', 'g3', 'g4']
      .map((id, index) => `  - { id: ${id}, repo: ., title: ${id}, rationale: r, estimate: { prod: 50, tests: 50 }, depends_on: [${index ? `g${index}` : ''}], tasks: [{ id: t1, title: x, tier: standard, acceptance: [${index === 3 ? 'AC-1, AC-2' : 'AC-1'}] }] }`)
      .join('\n')}\n`;
    // red only on g2 rebuilt over g1's fix (g3's file not there yet); g1 alone and g3 with its own fix stay green
    const check = 'test "$(cat g1-t1.txt 2>/dev/null)" != "fixed g1" || ! test -f g2-t1.txt || test -f g3-t1.txt';
    const config = { ...TEST_CONFIG, review: { ...TEST_CONFIG.review, checks: [check] } };
    const flow = setup({ config, script: { breakdown: { files: { 'tasks.yaml': chain } }, fix: { commit: { 'g1-t1.txt': 'fixed g1\n', 'g3-t1.txt': 'fixed g3\n' } } } });

    expect((await flow.run()).status).toBe('done');

    const state = loadState(flow.workDir);
    expect(flow.show(state.groups.g1!.head!, 'g1-t1.txt')).toBe('t1');
    expect(flow.show(state.groups.g3!.head!, 'g3-t1.txt')).toBe('fixed g3');
    expect(flow.show(state.final_review!.head!, 'g1-t1.txt')).toBe('fixed g1');
    expect(state.final_review!.split).toEqual({ done: true, moved: { g3: ['g3-t1.txt:1'] }, withdrawn: { g1: 'g2' } });
    expect(flow.log.join('\n')).toMatch(/the final review fixes of group g1 go back to the last PR: checks red with them on branch g2/);
    expect(reviewNotes(state).filter((note) => note.scope === 'g1').map((note) => note.text)).toEqual([
      "the final review's fixes to this PR's lines are in the last PR of the stack: checks were red with them on `g2`",
    ]);
    expect(reviewNotes(state).filter((note) => note.scope === 'g2')).toEqual([]);
  });
});
