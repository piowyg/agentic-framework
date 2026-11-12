import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { hostSettings } from '../src/harness/claude.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { importBundle } from '../src/orchestrator/bundles.js';
import { hostPaths, pauseDetails } from '../src/orchestrator/clone-work.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { readEvents } from '../src/orchestrator/events.js';
import { loadState } from '../src/orchestrator/state.js';
import { committedRepo, tmpDir, NO_STACK_CONFIG, TEST_CONFIG, QUOTED, git } from './helpers.js';


/** One group, one task: every control after the session is about t1. */
const ONE_TASK = `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
`;

const TWO_INDEPENDENT = `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1] }] }
  - { id: g2, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: y, tier: standard, acceptance: [AC-2] }] }
`;

/** Green on the base; red once `broken.txt` is committed, until `fixed.txt` is too. */
const CHECK = 'test ! -f broken.txt || test -f fixed.txt';

function setup(options: { checks?: string[] | 'none'; tasks?: string; script?: FakeScript; gates?: Record<string, GateDecision[]>; trusted?: boolean; config?: object } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': options.tasks ?? ONE_TASK } }, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(deepMerge(NO_STACK_CONFIG, { review: { checks: options.checks ?? [CHECK] } }), options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () =>
    runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, checksTrusted: options.trusted ?? true });
  const calls = (kind: string) => harnesses.calls().filter((call) => call.kind === kind);
  return { repo, workDir, harnesses, gates, run, calls };
}

const implementReport = { status: 'done', summary: 'ok', tests_added: [] };

describe('control after a session', () => {
  it('uncommitted changes go back to the same session, which commits them', async () => {
    const { run, calls, repo } = setup({
      script: { implement: (_request, call) => (call === 1 ? { uncommitted: { 'A.java': 'a' } } : { commit: { 'A.java': 'a' } }) },
    });
    expect((await run()).status).toBe('done');
    const [first, resumed] = calls('implement');
    expect(resumed!.resumeSessionId).toBe(first!.sessionId);
    expect(resumed!.prompt).toMatch(/Uncommitted changes[\s\S]*A\.java/);
    expect(resumed!.prompt).toMatch(/Do not amend, rebase or reset/);
    expect(git(repo, ['show', 'agentic/flow/g1:A.java'])).toBe('a');
  });

  it('red checks go back to the session with the output tail; green ones let the group on to review', async () => {
    const { run, calls, workDir } = setup({
      script: { implement: (_request, call) => ({ report: implementReport, commit: { [call === 1 ? 'broken.txt' : 'fixed.txt']: 'x' } }) },
    });
    expect((await run()).status).toBe('done');
    const [first, resumed] = calls('implement');
    expect(first!.prompt).toContain(`1. \`${CHECK}\``);
    expect(first!.prompt).toContain(`Run them only through \`${first!.checksRunner}\``);
    // the session reads the log in its own out/, not in the flow's checks/
    const logCopy = path.join(workDir, 'out', 'implement-g1-t1', 'checks', 'orchestrator', 'g1-t1-retry-1-test-f-broken-txt-test-f-fixed-txt.log');
    expect(resumed!.prompt).toContain(`(exit 1) — full log: ${logCopy}`);
    expect(fs.existsSync(logCopy)).toBe(true);
    expect(fs.readdirSync(path.join(workDir, 'checks')).sort()).toEqual([
      'g1-baseline-1-test-f-broken-txt-test-f-fixed-txt.log',
      'g1-t1-1-test-f-broken-txt-test-f-fixed-txt.log',
      // red once more before the session is woken
      'g1-t1-retry-1-test-f-broken-txt-test-f-fixed-txt.log',
    ]);
    // the transcript of the resumed run doesn't replace the first one
    expect(calls('review-spec')).toHaveLength(1);
  });

  it('after `checks_failing` failed controls the group pauses instead of resuming forever', async () => {
    const { run, calls } = setup({
      config: { review: { stop_on: [{ checks_failing: 2 }] } },
      script: { implement: (_request, call) => ({ report: implementReport, commit: { 'broken.txt': `${call}` } }) },
    });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'checks_failing', group: 'g1' });
    expect(state.paused?.message).toMatch(/implement t1: 2 failed checks after the session \(limit `checks_failing: 2`\)/);
    expect(calls('implement')).toHaveLength(2);
    expect(calls('review-spec')).toHaveLength(0);
  });

  it('a pause names the logs the sandboxed agent read in /out by their host path', () => {
    const message = 'implement t1 — Checks failed\n  ✗ `npm test` (exit 1) — full log: /out/checks/orchestrator/g1-t1-1-npm-test.log';
    expect(hostPaths(message, { agentOutDir: '/out', outDir: '/flow/out/implement-g1-t1' })).toBe(
      'implement t1 — Checks failed\n  ✗ `npm test` (exit 1) — full log: /flow/out/implement-g1-t1/checks/orchestrator/g1-t1-1-npm-test.log',
    );
  });

  it('a fixer goes through the same control', async () => {
    const blocking = { findings: [{ id: 'B1', severity: 'blocking', message: 'm', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }] };
    const { run, calls } = setup({
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? blocking : { findings: [] } }),
        fix: (_request, call) => ({ commit: { [call === 1 ? 'broken.txt' : 'fixed.txt']: 'x' } }),
      },
    });
    expect((await run()).status).toBe('done');
    const fixes = calls('fix').filter((call) => call.group === 'g1');
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.resumeSessionId).toBe(fixes[0]!.sessionId);
  });

  it('a fix session that changed nothing skips the checks: they were green on the same commit', async () => {
    const blocking = { findings: [{ id: 'B1', severity: 'blocking', message: 'm', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }] };
    const { run, workDir } = setup({
      script: {
        'review-spec': (_request, call) => ({ report: call === 1 ? blocking : { findings: [] } }),
        fix: { report: { findings: [{ id: 'B1', status: 'disputed', disputed_on: 'finding', reason: 'validated upstream' }] } },
      },
      gates: { group: [{ action: 'continue' }] },
    });
    expect((await run()).status).toBe('done');
    expect(fs.readdirSync(path.join(workDir, 'checks')).filter((file) => file.startsWith('g1-'))).toEqual([
      'g1-baseline-1-test-f-broken-txt-test-f-fixed-txt.log',
      'g1-t1-1-test-f-broken-txt-test-f-fixed-txt.log',
    ]);
  });

  it('on the host, sessions that build and test get run-checks as their one sandbox exception, out of their reach', async () => {
    const { run, harnesses, workDir } = setup();
    expect((await run()).status).toBe('done');
    const call = (kind: string) => harnesses.calls().find((candidate) => candidate.kind === kind)!;
    const runner = call('implement').checksRunner!;
    expect(runner).toBe(path.join(workDir, 'bin', 'implement-g1-t1', 'run-checks'));
    expect(call('review-spec').checksRunner).toBe(path.join(workDir, 'bin', 'review-spec-g1-r1', 'run-checks'));
    expect(call('review-spec').prompt).toContain('To check a claim about the build or the tests');
    expect(call('grill-business').checksRunner).toBeUndefined();
    // neither the clone nor out/ — both are writable for the session
    expect(path.relative(path.join(workDir, 'out'), runner)).toMatch(/^\.\./);
    expect(path.relative(path.join(workDir, 'clones'), runner)).toMatch(/^\.\./);
    expect(hostSettings(call('implement'))).toMatchObject({ sandbox: { excludedCommands: [runner, `${runner} *`] } });
  });

  it('the work branch is in the repo from the start: a final review without a fix still leaves one to publish', async () => {
    const { run, repo } = setup({ script: { implement: { report: implementReport, commit: { 'A.java': 'a' } } } });
    const state = await run();
    expect(state.status).toBe('done');
    expect(state.final_review!.head).toBe(state.final_review!.baseRef);
    expect(git(repo, ['rev-parse', 'agentic/flow/_final'])).toBe(state.groups.g1!.head);
  });

  it('reviewers read the last control’s results; the final reviewer those of every group', async () => {
    const { run, calls, workDir } = setup({ script: { implement: { report: implementReport, commit: { 'A.java': 'a' } } } });
    const state = await run();
    expect(state.status).toBe('done');
    const report = fs.readFileSync(path.join(workDir, 'checks-g1.md'), 'utf8');
    expect(report).toContain(`commit \`${state.groups.g1!.head}\``);
    expect(report).toMatch(new RegExp(`✓ \`${CHECK.replace(/[|!.]/g, '\\$&')}\` \\(exit 0, \\d+ s\\)`));
    const mounted = (kind: string) => calls(kind)[0]!.contextFiles.map((file) => path.basename(file));
    expect(mounted('review-spec')).toContain('checks-g1.md');
    expect(mounted('review-final')).toContain('checks-g1.md');
  });

  it('the control is visible: events with each command’s result, and a line in the terminal', async () => {
    const { run, workDir } = setup();
    expect((await run()).status).toBe('done');
    const events = readEvents(workDir).filter((event) => event.type.startsWith('checks_'));
    expect(events.map((event) => [event.type, 'label' in event && event.label])).toEqual([
      ['checks_started', 'baseline'],
      ['checks_done', 'baseline'],
      ['checks_started', 't1'],
      ['checks_done', 't1'],
    ]);
    expect(events[3]).toMatchObject({ group: 'g1', owner: 'g1', passed: true, results: [{ command: CHECK, exit_code: 0 }] });
  });

  it('without consent to run checks on the host, the flow pauses before running any', async () => {
    const { run, workDir } = setup({ trusted: false });
    const state = await run();
    expect(state.paused?.message).toMatch(/without consent to run on the host/);
    expect(fs.existsSync(path.join(workDir, 'checks'))).toBe(false);
  });

  it('`checks: none` runs nothing and the gate says the group is unverified', async () => {
    const { run, gates, workDir } = setup({ checks: 'none', config: { autonomy: 'strict' } });
    expect((await run()).status).toBe('done');
    expect(fs.existsSync(path.join(workDir, 'checks'))).toBe(false);
    expect(gates.seen.find((request) => request.gate === 'group')!.summary).toMatch(/unverified: `review.checks: none`/);
  });
});

describe('pauseDetails', () => {
  it('lists the failed tests and commands under the headline, at most twelve', () => {
    const tests = Array.from({ length: 14 }, (_unused, index) => `- \`t${index}\`: passes on the base code`);
    const details = pauseDetails(['The red gate: …\n' + tests.join('\n') + '\nFix the test.', 'Checks failed:\n\n✗ `npm test` (exit 1) — full log: x.log\nexcerpt']);
    expect(details.split('\n').slice(1, 3)).toEqual(['  - `t0`: passes on the base code', '  - `t1`: passes on the base code']);
    expect(details).not.toContain('Fix the test');
    expect(details.endsWith('\n  … and 3 more')).toBe(true);
    expect(pauseDetails(['Uncommitted changes in the working directory'])).toBe('');
  });
});

describe('baseline', () => {
  const RED_ON_BASE = 'test -f never.txt';

  it('checks red on the base ask a human; known red does not count in the group and shows at its gate', async () => {
    const { run, gates, calls } = setup({ checks: [RED_ON_BASE, CHECK], config: { autonomy: 'strict' }, gates: { group: [{ action: 'continue' }] } });
    const state = await run();
    expect(state.status).toBe('done');
    const [question, groupGate] = gates.seen.filter((request) => request.gate === 'group');
    expect(question!.summary).toMatch(/`test -f never.txt` already red on the base/);
    expect(question!.actions).toEqual(['continue', 'stop', 'abort']);
    expect(state.groups.g1!.known_red).toEqual([RED_ON_BASE]);
    expect(calls('implement')).toHaveLength(1);
    expect(calls('implement')[0]!.prompt).not.toContain(RED_ON_BASE);
    expect(groupGate!.summary).toMatch(/known red .*`test -f never.txt`/);
  });

  it('stop to fix the base drops the clone, so resume starts the group from the fixed base', async () => {
    const { run, repo, workDir } = setup({ checks: [RED_ON_BASE], gates: { group: [{ action: 'stop' }] } });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'baseline', group: 'g1' });
    expect(paused.groups.g1!.clonePath).toBeUndefined();
    expect(fs.existsSync(path.join(workDir, 'clones', 'g1'))).toBe(false);

    fs.writeFileSync(path.join(repo, 'never.txt'), 'x');
    git(repo, ['add', 'never.txt']);
    git(repo, ['commit', '-q', '-m', 'fix the base']);
    const resumed = await run();
    expect(resumed.status).toBe('done');
    expect(resumed.groups.g1!.baseRef).toBe(git(repo, ['rev-parse', 'HEAD']));
  });

  it('red is not cached: once the human fixed the environment, resume runs the command again', async () => {
    const ready = path.join(tmpDir(), 'docker-up');
    const { run } = setup({ checks: [`test -f ${ready}`], gates: { group: [{ action: 'stop' }] } });
    expect((await run()).paused).toMatchObject({ reason: 'baseline' });
    fs.writeFileSync(ready, '');
    const resumed = await run();
    expect(resumed.status).toBe('done');
    expect(resumed.baselines?.[resumed.groups.g1!.baseRef!]).toEqual({ [`test -f ${ready}`]: 0 });
  });

  it('is computed once per base commit', async () => {
    const { run, workDir } = setup({ tasks: TWO_INDEPENDENT });
    const state = await run();
    expect(state.status).toBe('done');
    expect(state.groups.g1!.baseRef).toBe(state.groups.g2!.baseRef);
    expect(Object.keys(state.baselines ?? {})).toEqual([state.groups.g1!.baseRef]);
    expect(fs.readdirSync(path.join(workDir, 'checks')).filter((file) => file.includes('baseline'))).toEqual(['g1-baseline-1-test-f-broken-txt-test-f-fixed-txt.log']);
  });

  it('groups running side by side on the same base commit compute it once too', async () => {
    const { run, workDir } = setup({ tasks: TWO_INDEPENDENT, config: { parallel_groups: 2 } });
    expect((await run()).status).toBe('done');
    expect(fs.readdirSync(path.join(workDir, 'checks')).filter((file) => file.includes('baseline'))).toHaveLength(1);
  });
});

describe('reviewers', () => {
  it('a reviewer that changes code has it discarded; the round and the gate carry a warning', async () => {
    const { run, gates, repo } = setup({
      checks: 'none',
      config: { autonomy: 'strict' },
      script: { 'review-spec': { report: { findings: [] }, commit: { 'reviewer.txt': 'x' } } },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const round = state.groups.g1!.review!.rounds[0]!;
    expect(round.warnings).toEqual([expect.stringMatching(/axis spec changed code in the clone \(HEAD .*\); changes discarded/)]);
    expect(gates.seen.find((request) => request.gate === 'group')!.summary).toMatch(/⚠ axis spec changed code/);
    expect(() => git(repo, ['show', 'agentic/flow/g1:reviewer.txt'])).toThrow();
  });
});

describe('bundles', () => {
  function cloneWithCommit() {
    const root = tmpDir();
    const repo = committedRepo(path.join(root, 'repo'));
    const base = git(repo, ['rev-parse', 'HEAD']);
    const clone = path.join(root, 'clone');
    git(root, ['clone', '-q', repo, clone]);
    git(clone, ['commit', '-q', '--allow-empty', '-m', 'one']);
    const bundle = (name: string, range = `${base}..HEAD`) => {
      const file = path.join(root, `${name}.bundle`);
      git(clone, ['bundle', 'create', '-q', file, range]);
      return file;
    };
    return { repo, base, clone, bundle };
  }

  it('moves the work branch; rewritten history is accepted with a flag', () => {
    const { repo, base, clone, bundle } = cloneWithCommit();
    const first = importBundle(repo, bundle('one'), { baseRef: base, branch: 'agentic/s/g1' });
    expect(first).toEqual({ commit: git(clone, ['rev-parse', 'HEAD']), rewritten: false });
    expect(git(repo, ['rev-parse', 'agentic/s/g1'])).toBe(first.commit);

    git(clone, ['commit', '-q', '--amend', '--allow-empty', '-m', 'one, amended']);
    const amended = importBundle(repo, bundle('amended'), { baseRef: base, branch: 'agentic/s/g1', previous: first.commit });
    expect(amended.rewritten).toBe(true);
    expect(git(repo, ['rev-parse', 'agentic/s/g1'])).toBe(amended.commit);
    expect(git(repo, ['for-each-ref', 'refs/agentic/incoming'])).toBe('');
  });

  it('rejects a bundle with other refs or a head that does not grow from the base', () => {
    const { repo, base, clone, bundle } = cloneWithCommit();
    git(clone, ['branch', 'extra']);
    expect(() => importBundle(repo, bundle('two-refs', '--all'), { baseRef: base, branch: 'agentic/s/g1' })).toThrow(/expected one HEAD ref/);

    git(clone, ['checkout', '-q', '--orphan', 'unrelated']);
    git(clone, ['commit', '-q', '--allow-empty', '-m', 'unrelated']);
    expect(() => importBundle(repo, bundle('unrelated', 'HEAD'), { baseRef: base, branch: 'agentic/s/g1' })).toThrow(/does not grow from the group base/);
    expect(() => git(repo, ['rev-parse', '--verify', '-q', 'agentic/s/g1'])).toThrow();
  });
});
