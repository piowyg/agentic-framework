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
import type { SessionRequest } from '../src/harness/types.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { refreeze } from '../src/orchestrator/write-tests.js';
import { redGate } from '../src/orchestrator/test-gates.js';
import type { TestCase } from '../src/orchestrator/test-reports.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { committedRepo, tmpDir, TESTS_FIRST_CONFIG } from './helpers.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();

const ONE_TASK = `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
`;

const REPORTS = 'build/test-results/*.xml';

/**
 * A test run that leaves a JUnit report, ignored by git as a real build's would be. `legacy` always passes; once
 * `CartTest.java` is committed, `… opens` fails until `impl.txt` is, `… errors` throws, `… already` passes.
 * Its exit code follows `… opens`: green on the base, red with the new tests, green once implemented.
 */
const TEST_COMMAND = [
  'echo build/ >> .git/info/exclude',
  'mkdir -p build/test-results',
  `if test -f impl.txt; then OPENS=''; else OPENS='<failure message="expected an empty cart"/>'; fi`,
  `NEW=''; if test -f CartTest.java; then NEW="<testcase classname=\\"CartTest\\" name=\\"AC-1 AC-2 opens\\">$OPENS</testcase><testcase classname=\\"CartTest\\" name=\\"AC-1 AC-2 errors\\"><error message=\\"NullPointerException\\"/></testcase><testcase classname=\\"CartTest\\" name=\\"AC-1 AC-2 already\\"/>"; fi`,
  `echo "<testsuite>$NEW<testcase classname=\\"CartTest\\" name=\\"legacy\\"/></testsuite>" > build/test-results/TEST-CartTest.xml`,
  '! test -f CartTest.java || test -f impl.txt',
].join('; ');

/** The author's reply: one test of both criteria by `name`, committed in `CartTest.java`. */
function tests(name: string, extra: Record<string, unknown> = {}, content = `// ${name}\n`): FakeReply {
  return {
    report: { tests: [{ path: 'CartTest.java', name, ac: ['AC-1', 'AC-2'] }], stubs: [], ...extra },
    commit: { 'CartTest.java': content },
  };
}

const implementDone: FakeReply = { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { 'impl.txt': 'x' } };

function setup(options: { script?: FakeScript; config?: object; gates?: Record<string, GateDecision[]>; tasks?: string; command?: string } = {}) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': options.tasks ?? ONE_TASK } }, implement: implementDone, 'write-tests': tests('AC-1 AC-2 opens'), ...options.script });
  const gates = new ScriptedGates(options.gates);
  const base = deepMerge(TESTS_FIRST_CONFIG, { review: { checks: [options.command ?? TEST_COMMAND], test_reports: REPORTS } });
  const config = deepMerge(base, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates, checksTrusted: true });
  const calls = (kind: string) => harnesses.calls().filter((call) => call.kind === kind);
  return { repo, workDir, harnesses, gates, run, calls, config };
}

const contextNames = (call: SessionRequest) => call.contextFiles.map((file) => path.basename(file));

describe('write-tests', () => {
  it('writes the group’s tests first; red on the base, they are frozen and read by implementers and the spec reviewer', async () => {
    const { run, harnesses, calls, workDir, repo } = setup();
    const state = await run();
    expect(state.paused).toBeUndefined();
    expect(state.status).toBe('done');
    expect(harnesses.calls().map((call) => call.kind).slice(3, 5)).toEqual(['write-tests', 'implement']);
    const [author] = calls('write-tests');
    expect(author!.executor).toEqual({ harness: 'codex', model: 'sol', effort: 'medium' });
    expect(author!.prompt).toMatch(/expects every new test to fail/);
    expect(author!.prompt).toMatch(/fail on an assertion — not error, not be skipped, not pass/);
    expect(calls('write-tests')).toHaveLength(1);
    const testsFile = git(repo, ['rev-parse', 'agentic/flow/g1:CartTest.java']);
    expect(state.groups.g1!.write_tests).toMatchObject({ frozen: { 'CartTest.java': testsFile }, session: author!.sessionId });
    expect(state.groups.g1!.write_tests!.warnings).toBeUndefined();
    // what was green before the tests stays green after every task
    const green = JSON.parse(fs.readFileSync(path.join(workDir, 'tests-green-g1.json'), 'utf8'));
    expect(green).toEqual(['#CartTest#AC-1 AC-2 already', '#CartTest#legacy']);
    expect(contextNames(calls('implement')[0]!)).toContain('write-tests-g1.json');
    expect(contextNames(calls('review-spec')[0]!)).toContain('write-tests-g1.json');
  });

  it('a test green on the base goes back to its author; a criterion already met, with evidence, may stay green', async () => {
    const { run, calls } = setup({
      script: {
        'write-tests': (_request, call) => (call === 1 ? tests('AC-1 AC-2 already') : tests('AC-1 AC-2 already', { already_met: [{ ac: 'AC-1', evidence: 'Cart.java:2 keeps the total' }, { ac: 'AC-2', evidence: 'Cart.java:4' }] })),
      },
    });
    expect((await run()).status).toBe('done');
    const [first, resumed] = calls('write-tests');
    expect(resumed!.resumeSessionId).toBe(first!.sessionId);
    expect(resumed!.prompt).toMatch(/`AC-1 AC-2 already` \(CartTest\.java\) passes on the base code/);
    expect(resumed!.prompt).toMatch(/list the criterion in `already_met` with evidence/);
  });

  it('an error is not red; once the author’s resumes run out the group pauses', async () => {
    const { run, calls } = setup({ script: { 'write-tests': tests('AC-1 AC-2 errors') } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'red_gate', group: 'g1' });
    expect(state.paused!.message).toMatch(/3 failed checks after the session \(the "red" gate: 2 test author resumes\)/);
    // the pause names the tests, not just the gate (smoke 92-2)
    expect(state.paused!.message).toContain('\n  - `AC-1 AC-2 errors` (CartTest.java) errors instead of failing on an assertion: NullPointerException');
    expect(calls('write-tests')).toHaveLength(3);
    expect(calls('write-tests')[1]!.prompt).toMatch(/`AC-1 AC-2 errors` \(CartTest\.java\) errors instead of failing on an assertion: NullPointerException/);
    expect(calls('implement')).toHaveLength(0);
  });

  it('a `checks` edit after a red gate pause runs the new baseline on the base, not on the committed tests', async () => {
    const { run, calls, config, gates, workDir } = setup({ script: { 'write-tests': (_request, call) => tests(call <= 3 ? 'AC-1 AC-2 errors' : 'AC-1 AC-2 opens') } });
    expect((await run()).paused).toMatchObject({ reason: 'red_gate' });
    // smoke 92-2: the human fixes a command and resumes; the clone holds the author's red tests
    config.review.checks = ['true', TEST_COMMAND];
    const state = await run();
    expect(state.status).toBe('done');
    expect(gates.seen.map((request) => request.summary).join('\n')).not.toMatch(/already red on the base/);
    expect(state.groups.g1!.known_red).toBeUndefined();
    expect(calls('write-tests')).toHaveLength(4);
    expect(fs.existsSync(path.join(workDir, 'clones', 'g1.baseline'))).toBe(false);
  });

  it('a test missing from the reports or from the commits goes back to the author', async () => {
    const { run, calls } = setup({
      script: {
        'write-tests': (_request, call) =>
          call === 1 ? { report: { tests: [{ path: 'CartTest.java', name: 'AC-1 AC-2 opens', ac: ['AC-1', 'AC-2'] }], stubs: [] } } : call === 2 ? tests('AC-1 AC-2 renamed') : tests('AC-1 AC-2 opens'),
      },
    });
    expect((await run()).status).toBe('done');
    const [, notCommitted, notReported] = calls('write-tests');
    expect(notCommitted!.prompt).toMatch(/not in your commits: `CartTest\.java`/);
    // the report has the file under other names: a wrong name, and what the report calls its tests
    expect(notReported!.prompt).toMatch(/`AC-1 AC-2 renamed` \(CartTest\.java\): not in the test reports under this name .* the report has from its file: `/);
  });

  it('a test missing from the reports while a command failed: the author and the paused flow see that its suite may not have run', async () => {
    const { run, calls } = setup({ script: { 'write-tests': tests('AC-1 AC-2 integration') } });
    const state = await run();
    expect(calls('write-tests')[1]!.prompt).toMatch(/may also not have run: a command that fails can stop before the suite/);
    expect(calls('write-tests')[1]!.prompt).toMatch(/✗ `echo build\/ .*` \(exit 1\) — full log: .*\.log/);
    expect(state.paused!.message).toMatch(/\n  - `AC-1 AC-2 integration` \(CartTest\.java\): not in the test reports/);
    expect(state.paused!.message).toMatch(/\n  ✗ `echo build\/ .*` \(exit 1\) — full log: /);
  });

  it('without reports a red check is enough, and the group’s gate says how little was checked', async () => {
    const { run, gates, calls } = setup({ config: { review: { test_reports: 'nowhere/*.xml' }, autonomy: 'strict' }, gates: { group: [{ action: 'continue' }] } });
    expect((await run()).status).toBe('done');
    expect(calls('write-tests')).toHaveLength(1);
    const groupGate = gates.seen.find((request) => request.gate === 'group');
    expect(groupGate!.summary).toMatch(/the "red" gate without JUnit reports \(glob `nowhere\/\*\.xml` found nothing\)/);
  });

  it('a stage switched off leaves the tasks to their implementers', async () => {
    const { run, calls } = setup({ config: { stages: { 'write-tests': { enabled: false } } } });
    expect((await run()).status).toBe('done');
    expect(calls('write-tests')).toHaveLength(0);
    expect(contextNames(calls('implement')[0]!)).not.toContain('write-tests-g1.json');
  });

  it('a test author whose harness is not installed stops the flow before it starts, saying what to set', async () => {
    const { run, harnesses, calls } = setup();
    harnesses.codex.status = async () => ({ installed: false });
    await expect(run()).rejects.toThrow(/`stages.write-tests` uses codex:sol, but `codex` is not installed[\s\S]*write-tests: \{ harness: claude, model: opus \}/);
    expect(calls('grill-business')).toHaveLength(0);
  });
});

describe('frozen tests and test issues', () => {
  const testIssue: FakeReply = { report: { status: 'test_issue', summary: 's', issue: 'AC-2 test expects 500, the spec says 400', tests_added: [] } };

  it('an implementer who changes a frozen test is sent back to restore it', async () => {
    const { run, calls, repo } = setup({
      script: {
        implement: (_request, call): FakeReply =>
          call === 1
            ? { report: implementDone.report, commit: { 'impl.txt': 'x', 'CartTest.java': '// weakened\n' } }
            : { report: implementDone.report, commit: { 'CartTest.java': '// AC-1 AC-2 opens\n' } },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [, resumed] = calls('implement');
    expect(resumed!.prompt).toMatch(/You changed tests the group's test author wrote, which stay exactly as written: `CartTest\.java`/);
    expect(resumed!.prompt).toContain(`git checkout ${state.groups.g1!.write_tests!.commit} -- <file>`);
    expect(git(repo, ['show', 'agentic/flow/g1:CartTest.java'])).toBe('// AC-1 AC-2 opens');
  });

  it('a test issue goes to the test author; a fixed test goes through the red gate and back to the implementer', async () => {
    const { run, calls } = setup({
      script: {
        implement: (_request, call) => (call === 1 ? testIssue : implementDone),
        'write-tests': (_request, call) => (call === 1 ? tests('AC-1 AC-2 opens') : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: 'expects 400 now' } }, '// AC-1 AC-2 opens, 400\n')),
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [author, answer] = calls('write-tests');
    expect(answer!.resumeSessionId).toBe(author!.sessionId);
    expect(answer!.prompt).toMatch(/implementer of task t1 \(x\) reports[\s\S]*AC-2 test expects 500/);
    expect(calls('implement')[1]!.prompt).toMatch(/The test author changed the test you reported \(expects 400 now\)/);
    // frozen anew: the implementer's next control accepts the changed file
    expect(state.groups.g1!.write_tests!.report.test_issue).toEqual({ verdict: 'fixed', reason: 'expects 400 now' });
  });

  it('an implementer reports a test issue with its work in progress committed, and is resumed with the answer', async () => {
    const issue = (extra: FakeReply): FakeReply => ({ ...testIssue, ...extra });
    const { run, calls } = setup({
      script: {
        // live: the implementer leaves its changes uncommitted, then makes a WIP commit when told to
        implement: (_request, call) => [issue({ uncommitted: { 'Wip.java': 'wip' } }), issue({ commit: { 'Wip.java': 'wip' } }), implementDone][call - 1]!,
        'write-tests': (_request, call) => (call === 1 ? tests('AC-1 AC-2 opens') : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: 'expects 400 now' } }, '// AC-1 AC-2 opens, 400\n')),
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [reported, committed, resumed] = calls('implement');
    expect(committed!.prompt).toMatch(/before you report, commit your work so far \(a work-in-progress commit is fine\) or remove it:\n- \?\? Wip\.java/);
    // the author answers on a clean tree: nothing of the implementer's is put to it
    expect(calls('write-tests')).toHaveLength(2);
    expect(resumed!.resumeSessionId).toBe(reported!.sessionId);
    expect(resumed!.prompt).toMatch(/The test author changed the test you reported \(expects 400 now\)/);
  });

  it('a test fixed after the implementer committed its code goes through the red gate on the code before it', async () => {
    // acceptance smoke: the implementer implements, commits, sees a wrong test fail and only then reports it
    const issueAfterImpl: FakeReply = { ...testIssue, commit: { 'impl.txt': 'x' } };
    const { run, calls } = setup({
      // like `npm run typecheck`: needs what the checks installed in the clone, which git doesn't hold
      config: { review: { compile: 'test -d build' } },
      script: {
        implement: (_request, call) => (call <= 2 ? (call === 1 ? issueAfterImpl : testIssue) : implementDone),
        'write-tests': (_request, call) =>
          call === 1 ? tests('AC-1 AC-2 opens') : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: `fix ${call}` } }, `// AC-1 AC-2 opens, fix ${call}\n`),
      },
    });
    const state = await run();
    expect(state.paused).toBeUndefined();
    expect(state.status).toBe('done');
    // one answer per issue: none of them was sent back for passing on the implemented code
    expect(calls('write-tests')).toHaveLength(3);
    expect(calls('implement')).toHaveLength(3);
  });

  it('a pause in the author’s answer resumes with the author, not with a new implementer', async () => {
    const { run, calls } = setup({
      script: {
        implement: (_request, call) => (call === 1 ? testIssue : implementDone),
        'write-tests': (_request, call) =>
          call === 1 ? tests('AC-1 AC-2 opens') : tests(call <= 4 ? 'AC-1 AC-2 errors' : 'AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: 'r' } }, `// fix ${call}\n`),
      },
    });
    expect((await run()).paused).toMatchObject({ reason: 'red_gate' });
    expect(calls('implement')).toHaveLength(1);
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('write-tests')).toHaveLength(5);
    expect(calls('write-tests')[4]!.prompt).toMatch(/implementer of task t1 \(x\) reports/);
    // the author's fix is frozen: the implementer isn't told to restore it
    expect(calls('implement')).toHaveLength(2);
    expect(calls('implement')[1]!.prompt).not.toMatch(/You changed tests/);
    expect(state.groups.g1!.open_test_issue).toBeUndefined();
  });

  it('after two fixed tests the next test issue of the task pauses the group', async () => {
    const { run, calls } = setup({
      script: {
        implement: testIssue,
        'write-tests': (_request, call) => (call === 1 ? tests('AC-1 AC-2 opens') : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: 'expects 400 now' } }, `// AC-1 AC-2 opens, fix ${call}\n`)),
      },
    });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'test_issue', group: 'g1', message: "AC-2 test expects 500, the spec says 400 (the test author has already fixed this task's tests 2 times)" });
    expect(calls('write-tests')).toHaveLength(3);
    expect(calls('implement')).toHaveLength(3);
  });

  it('an upheld test goes to a human; after `continue` a second test issue of the task pauses the group', async () => {
    const { run, calls, gates } = setup({
      script: {
        implement: testIssue,
        'write-tests': (_request, call) => (call === 1 ? tests('AC-1 AC-2 opens') : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'upheld', reason: 'the spec says 500' } })),
      },
      gates: { group: [{ action: 'continue' }] },
    });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'test_issue', group: 'g1', message: 'AC-2 test expects 500, the spec says 400' });
    const question = gates.seen.find((request) => request.gate === 'group')!;
    expect(question.summary).toMatch(/implementer: AC-2 test expects 500[\s\S]*test author: the spec says 500/);
    expect(calls('implement')[1]!.prompt).toMatch(/its author upheld it \(the spec says 500\) and a human agreed/);
    expect(calls('write-tests')).toHaveLength(2);
  });

  it('an answer must match what the author did; an upheld test with `continue` holds the implementer to it', async () => {
    const { run, calls } = setup({
      script: {
        implement: (_request, call) => (call === 1 ? testIssue : implementDone),
        'write-tests': (_request, call) =>
          call === 1 ? tests('AC-1 AC-2 opens') : call === 2 ? tests('AC-1 AC-2 opens', { test_issue: { verdict: 'fixed', reason: 'r' } }) : tests('AC-1 AC-2 opens', { test_issue: { verdict: 'upheld', reason: 'r' } }),
      },
    });
    expect((await run()).status).toBe('done');
    expect(calls('write-tests')[2]!.prompt).toMatch(/Your answer is `fixed`, but no test file changed/);
    expect(calls('implement')[1]!.prompt).toMatch(/do not report a test_issue again/);
  });

  it('a fixer may change a frozen test only when a finding it fixes points at it', async () => {
    const finding = (file: string) => ({
      findings: [{ id: 'B1', severity: 'blocking', message: 'm', file, line: 1, quote: '// AC-1 AC-2 opens', weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
    });
    const { run, calls, repo } = setup({
      script: {
        'review-spec': (_request, call) => (call === 1 ? { report: finding('CartTest.java') } : { report: { findings: [], previous: [{ id: 'B1', status: 'fixed' }] } }),
        fix: { report: { findings: [{ id: 'B1', status: 'fixed' }] }, commit: { 'CartTest.java': '// AC-1 AC-2 opens, stricter\n' } },
      },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('fix')).toHaveLength(1);
    expect(state.groups.g1!.write_tests!.frozen['CartTest.java']).toBe(git(repo, ['rev-parse', 'agentic/flow/g1:CartTest.java']));
  });

  it('a fixer changing a frozen test no finding points at is sent back', async () => {
    const { run, calls } = setup({
      script: {
        'review-spec': (_request, call) =>
          call === 1
            ? { report: { findings: [{ id: 'B1', severity: 'blocking', message: 'm', file: 'src/Cart.java', line: 2, quote: 'long total;', weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }] } }
            : { report: { findings: [], previous: [{ id: 'B1', status: 'fixed' }] } },
        fix: (_request, call): FakeReply =>
          call === 1
            ? { report: { findings: [{ id: 'B1', status: 'fixed' }] }, commit: { 'CartTest.java': '// gone\n' } }
            : { report: { findings: [{ id: 'B1', status: 'fixed' }] }, commit: { 'CartTest.java': '// AC-1 AC-2 opens\n', 'src/Cart.java': 'class Cart {}\n' } },
      },
    });
    expect((await run()).status).toBe('done');
    expect(calls('fix')[1]!.prompt).toMatch(/You changed tests the group's test author wrote/);
  });
});

describe('the gate after a task', () => {
  const TWO_TASKS = `groups:
  - id: g1
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: open, tier: standard, acceptance: [AC-1] }
      - { id: t2, title: close, tier: standard, acceptance: [AC-2] }
`;

  /** `AC-1 opens` passes once `impl1.txt` is committed, `AC-2 closes` once `impl2.txt` is; `legacy` until `broken.txt` is. */
  const COMMAND = [
    'echo build/ >> .git/info/exclude',
    'mkdir -p build/test-results',
    `report_case() { if test -f "$2"; then echo "<testcase classname=\\"CartTest\\" name=\\"$1\\"/>"; else echo "<testcase classname=\\"CartTest\\" name=\\"$1\\"><failure message=\\"not yet\\"/></testcase>"; fi; }`,
    `NEW=''; if test -f CartTest.java; then NEW="$(report_case 'AC-1 opens' impl1.txt)$(report_case 'AC-2 closes' impl2.txt)"; fi`,
    `if test -f broken.txt; then LEGACY='<failure message="broke"/>'; else LEGACY=''; fi`,
    `echo "<testsuite>$NEW<testcase classname=\\"CartTest\\" name=\\"legacy\\">$LEGACY</testcase></testsuite>" > build/test-results/TEST-CartTest.xml`,
    '! grep -q failure build/test-results/TEST-CartTest.xml',
  ].join('; ');

  const twoTests: FakeReply = {
    report: {
      tests: [
        { path: 'CartTest.java', name: 'AC-1 opens', ac: ['AC-1'] },
        { path: 'CartTest.java', name: 'AC-2 closes', ac: ['AC-2'] },
      ],
      stubs: [],
    },
    commit: { 'CartTest.java': '// AC-1 opens, AC-2 closes\n' },
  };

  const done = (commit: Record<string, string>): FakeReply => ({ report: { status: 'done', summary: 'ok', tests_added: [] }, commit });

  function tasksSetup(implement: FakeScript['implement'], config: object = {}) {
    return setup({ tasks: TWO_TASKS, command: COMMAND, config, script: { 'write-tests': twoTests, implement } });
  }

  it('an earlier task needs its own tests green, not the later ones; the last one the whole group', async () => {
    const { run, calls } = tasksSetup((request) => done({ [request.task === 't1' ? 'impl1.txt' : 'impl2.txt']: 'x' }));
    const state = await run();
    expect(state.status).toBe('done');
    // the fixture's command is green on the base: it verifies every task
    expect(state.groups.g1!.known_red).toBeUndefined();
    const [first, last] = calls('implement');
    expect(calls('implement')).toHaveLength(2);
    expect(first!.prompt).toMatch(/More tasks of the group follow yours[\s\S]*- `AC-1 opens` \(CartTest\.java\)/);
    expect(first!.prompt).not.toMatch(/`AC-2 closes` \(CartTest/);
    expect(last!.prompt).not.toMatch(/More tasks of the group follow yours/);
  });

  it('a task whose tests still fail goes back to its implementer', async () => {
    const { run, calls } = tasksSetup((request, call) => (request.task === 't1' && call === 1 ? done({ 'other.txt': 'x' }) : done({ [request.task === 't1' ? 'impl1.txt' : 'impl2.txt']: 'x' })));
    expect((await run()).status).toBe('done');
    expect(calls('implement')[1]!.prompt).toMatch(/Tests of the criteria implemented so far that still fail:\n- `AC-1 opens` \(CartTest\.java\): failed \(not yet\)/);
  });

  it('a test green before the group that fails after a task is a regression', async () => {
    const { run, calls } = tasksSetup((request, call) =>
      request.task === 't1' && call === 1 ? done({ 'impl1.txt': 'x', 'broken.txt': 'x' }) : request.task === 't1' ? { ...done({}), commit: undefined, uncommitted: undefined } : done({ 'impl2.txt': 'x' }),
    );
    const state = await run();
    expect(calls('implement')[1]!.prompt).toMatch(/Tests that passed before your task fail now:\n- CartTest › legacy: failed \(broke\)/);
    expect(state.paused?.reason).toBe('checks_failing');
  });

  it('a task whose tests an earlier task already made pass gets no session; the gate says the split was too fine', async () => {
    const threeTasks = `${TWO_TASKS}      - { id: t3, title: polish, tier: standard, acceptance: [AC-2] }\n`;
    // smoke 92-2: on shared code the first implementer makes every test pass
    const { run, calls } = setup({
      tasks: threeTasks,
      command: COMMAND,
      script: { 'write-tests': twoTests, implement: (request) => done(request.task === 't1' ? { 'impl1.txt': 'x', 'impl2.txt': 'x' } : { 'polish.txt': 'x' }) },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(calls('implement').map((call) => call.task)).toEqual(['t1', 't3']);
    expect(state.groups.g1!.tasks).toEqual({ t1: 'done', t2: 'skipped', t3: 'done' });
    expect(state.groups.g1!.write_tests!.warnings).toContain('⚠ t2 skipped: its tests already passed after t1 (group split into tasks too finely?)');
  });

  it('a task done by an earlier task of a lower tier gets a session on its own tier to review that work', async () => {
    const threeTasks = `groups:
  - id: g1
    repo: .
    rationale: r
    estimate: { prod: 50, tests: 50 }
    tasks:
      - { id: t1, title: open, tier: standard, acceptance: [AC-1] }
      - { id: t2, title: lock, tier: design, acceptance: [AC-2] }
      - { id: t3, title: polish, tier: standard, acceptance: [AC-2] }
`;
    // acceptance smoke: the first implementer, on the cheaper tier, also wrote the design task's transaction
    const { run, calls, config } = setup({
      tasks: threeTasks,
      command: COMMAND,
      script: { 'write-tests': twoTests, implement: (request) => done(request.task === 't1' ? { 'impl1.txt': 'x', 'impl2.txt': 'x' } : {}) },
    });
    const state = await run();
    expect(state.status).toBe('done');
    const [, review] = calls('implement');
    expect(calls('implement').map((call) => call.task)).toEqual(['t1', 't2', 't3']);
    expect(review!.executor).toEqual(config.tiers.design);
    expect(review!.prompt).toMatch(/task t1 \(open\), planned for a weaker tier \(standard\), implemented your criteria[\s\S]*review that code/);
    expect(state.groups.g1!.tasks).toEqual({ t1: 'done', t2: 'done', t3: 'done' });
    expect(state.groups.g1!.write_tests!.warnings).toContain('⚠ t2 [design]: its tests already passed after t1 [standard]; a session at its tier reviewed that code');
  });

  it('an earlier task is told which tasks follow, with their tiers, to leave their work to them', async () => {
    const { run, calls } = tasksSetup((request) => done({ [request.task === 't1' ? 'impl1.txt' : 'impl2.txt']: 'x' }));
    await run();
    expect(calls('implement')[0]!.prompt).toMatch(/Leave the work of the tasks that follow to them[^\n]*\n- t2 \[standard\] close: AC-2/);
  });

  it('without reports a task is checked by the compilation only, and the gate says so', async () => {
    const { run, calls } = tasksSetup(
      (request, call) => (request.task === 't1' && call === 1 ? done({ 'impl1.txt': 'x', 'syntax-error.txt': 'x' }) : request.task === 't1' ? done({ 'fixed-syntax.txt': 'x' }) : done({ 'impl2.txt': 'x' })),
      { review: { compile: 'test ! -f syntax-error.txt || test -f fixed-syntax.txt', test_reports: 'nowhere/*.xml' } },
    );
    const state = await run();
    expect(calls('implement')[1]!.prompt).toMatch(/The code doesn't compile/);
    expect(state.status).toBe('done');
    expect(state.groups.g1!.write_tests!.warnings).toContain('⚠ the gate after the task without JUnit reports (glob `nowhere/*.xml` found nothing): compilation only, tests at the end of the group');
  });
});


describe('red gate: a test missing from the reports', () => {
  const written = { tests: [{ path: 'frontend/src/upload.test.ts', name: 'AC-1 uploads', ac: ['AC-1'] }], stubs: [] } as unknown as Parameters<typeof redGate>[0];
  const run = (cases: TestCase[]) => ({ runs: [], cases });

  it('no case from its file: a missing report, not a wrong name — no renaming (a pilot flow)', () => {
    const [problem] = redGate(written, run([{ classname: 'com.shop.CartTest', name: 'opens()', status: 'passed' }]), (log) => log);
    expect(problem).toMatch(/`AC-1 uploads` \(frontend\/src\/upload\.test\.ts\): no test report has any test of its file .* Don't rename it/);
  });

  it('its file under other names: a wrong name, with the names the report shows', () => {
    const cases: TestCase[] = [{ classname: 'frontend/src/upload.test.ts', name: 'upload > AC-1 stores the file', status: 'failed' }];
    expect(redGate(written, run(cases), (log) => log)[0]).toMatch(/not in the test reports under this name .* from its file: `upload > AC-1 stores the file`/);
  });
});

describe('refreeze', () => {
  it('a changed frozen test takes its new blob; one deleted leaves the frozen set; the others stay', () => {
    const frozen = { 'A.java': 'a1', 'B.java': 'b1', 'C.java': 'c1' };

    expect(refreeze(frozen, { 'A.java': 'a2', 'B.java': undefined }, ['A.java', 'B.java'])).toEqual({ 'A.java': 'a2', 'C.java': 'c1' });
  });
});
