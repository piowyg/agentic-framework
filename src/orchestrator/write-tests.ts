import fs from 'node:fs';
import path from 'node:path';
import type { AgenticConfig } from '../config/types.js';
import { parseWriteTests } from '../contracts/index.js';
import type { WriteTestsArtifact } from '../contracts/schemas.js';
import { writeFileSafe } from '../fsutil.js';
import { groupAcceptance, groupReferences, taskTier, type Group, type Task } from './artifacts.js';
import type { CloneWork } from './clone-work.js';
import { stageExecutor } from './executors.js';
import { hostGit, resolveRepo } from './repos.js';
import type { FlowRun } from './run.js';
import type { GroupState, StepStatus } from './state.js';
import { gatedTests, greenBefore, redGate, reportsWarning, taskGate } from './test-gates.js';
import { caseKey, casesOf, type TestCase } from './test-reports.js';
import { plural } from '../plural.js';

/** The author gets this many resumes to get the tests through the red gate, then a human decides. */
export const RED_GATE_RESUMES = 2;

/** Tests of one task the author may fix on its implementer's `test_issue`; the next one goes to a human. */
export const TEST_ISSUE_FIXES = 2;

export function writeTestsEnabled(config: AgenticConfig): boolean {
  return config.stages['write-tests'].enabled !== false;
}

/** `write-tests-<group>.json`: the author's report, read by implementers and reviewers. */
export function writeTestsReportName(group: string): string {
  return `write-tests-${group}.json`;
}

/** Keys of the test cases green at the red gate (`caseKey`): every task keeps them green. */
export function greenBeforeName(group: string): string {
  return `tests-green-${group}.json`;
}

interface AuthorRun {
  /** Resumes the author's earlier session with this message (a `test_issue`). */
  resume?: { sessionId?: string; message: string };
  label: string;
  /** The red gate runs at `at` with the changes since `since` laid over it, not in the session's clone. */
  redBase?: { at: string; since: string };
  /** The tests the red gate checks, and anything else the report must satisfy. */
  check(written: WriteTestsArtifact, changed: string[]): { gated: WriteTestsArtifact; problem?: string };
}

/**
 * The group's tests, written before its tasks by another model: the session commits tests
 * and stubs, the red gate checks them on the base code, and their files are frozen for the rest of the group.
 * An implementer who finds a test wrong reports a `test_issue`; its author fixes or upholds it.
 */
export class GroupTests {
  /** The last task gate's report cases, in memory: after a resume the next task runs its session as usual. */
  private lastGate?: { head: string; task: string; cases: TestCase[] };

  constructor(
    private readonly flow: FlowRun,
    private readonly work: CloneWork,
    private readonly group: Group,
    private readonly groupState: GroupState,
  ) {}

  get written(): boolean {
    return !!this.groupState.write_tests;
  }

  /** More tasks follow this one, so it answers for its part of the tests only (`taskControl`, `doneBy`). */
  partial(task: Task): boolean {
    return this.written && task !== this.group.tasks.at(-1);
  }

  /** Criteria of the tasks done so far. */
  private implementedAcceptance(): string[] {
    const { group, groupState } = this;
    return group.tasks.filter((other) => isImplemented(groupState.tasks[other.id])).flatMap((other) => other.acceptance);
  }

  async write(): Promise<void> {
    const { flow, group } = this;
    const { report, frozen } = await this.runAuthor({ label: 'tests', check: (written) => ({ gated: written }) });
    const met = report.already_met?.length ? `, already met: ${report.already_met.map((entry) => entry.ac).join(', ')}` : '';
    const files = Object.keys(frozen).length;
    flow.log(`✓ write-tests ${group.id}: ${plural(report.tests.length, 'test', 'tests')} in ${plural(files, 'file', 'files')}${met}`);
  }

  /**
   * An implementer's `test_issue` goes to the test author: `fixed` puts the changed tests of
   * criteria not implemented yet through the red gate again and freezes them anew; `upheld` leaves them.
   * The gate runs on the code of the first red gate, since the implementer may have committed code before reporting.
   */
  async answer(task: Task, issue: string, since: string): Promise<{ verdict: 'fixed' | 'upheld'; reason: string }> {
    const { groupState } = this;
    const tests = groupState.write_tests!;
    const implemented = new Set(this.implementedAcceptance());
    const message = [
      `The implementer of task ${task.id} (${task.title}) reports that one of your tests is wrong:`,
      '',
      issue,
      '',
      'Answer in `test_issue` of your report, keeping the rest of it up to date:',
      '- `fixed`: you changed the test and committed it; it goes through the red gate again;',
      '- `upheld`: the test is right as written — say why, answering the argument. Change nothing then.',
    ].join('\n');
    const { report } = await this.runAuthor({
      resume: { sessionId: tests.session, message },
      label: `tests-${task.id}`,
      redBase: { at: tests.red_base ?? tests.commit, since },
      check: (written, changed) => {
        const gated = { ...written, tests: written.tests.filter((test) => changed.includes(test.path) && !test.ac.every((id) => implemented.has(id))) };
        const answer = written.test_issue;
        if (!answer) return { gated, problem: 'Answer the implementer in `test_issue` of your report: `fixed` or `upheld`, with the reason.' };
        if (answer.verdict === 'fixed' && !changed.length) return { gated, problem: 'Your answer is `fixed`, but no test file changed: commit the fix, or answer `upheld`.' };
        if (answer.verdict === 'upheld' && changed.length) return { gated, problem: `Your answer is \`upheld\`, but you changed ${changed.map((file) => `\`${file}\``).join(', ')}: restore them, or answer \`fixed\`.` };
        return { gated };
      },
    });
    return report.test_issue!;
  }

  /**
   * How a task that isn't the group's last is verified: its tests and the earlier tasks' pass, nothing green
   * before broke; tests of later tasks may stay red. Without reports only the compilation.
   */
  taskControl(task: Task): { note: string; verify(head: string, logPath: (log: string) => string): Promise<string | undefined> } {
    const { flow, work, group, groupState } = this;
    const covered = new Set([...this.implementedAcceptance(), ...task.acceptance]);
    const target = groupState.write_tests!.report.tests.filter((test) => test.ac.every((id) => covered.has(id)));
    const later = group.tasks.slice(group.tasks.indexOf(task) + 1).filter((other) => !isImplemented(groupState.tasks[other.id]));
    const note = [
      'More tasks of the group follow yours, so its tests of later criteria may stay red. After your task the orchestrator checks that',
      'the code compiles, that tests green before the group started still pass, and that these tests pass:',
      ...(target.length ? target.map((test) => `- \`${test.name}\` (${test.path})`) : ['- (none yet: no criterion is fully implemented after this task)']),
      '',
      'Leave the work of the tasks that follow to them, even when their tests stay red: each has the tier the breakdown chose for it.',
      ...later.map((other) => `- ${other.id} [${taskTier(group, other)}] ${other.title}: ${other.acceptance.join(', ')}`),
    ].join('\n');
    return {
      note,
      verify: async (head, logPath) => {
        const frozen = this.frozenProblem(head);
        if (frozen) return frozen;
        const commands = work.verifiedChecks;
        if (!commands.length && !flow.context.config.review.compile) return undefined;
        const greenKeys = this.greenKeys();
        const scope = { owner: group.id, label: task.id };
        const { run, problems } = await gatedTests(flow, work.cwd, scope, commands, (tested) => taskGate(target, greenKeys, tested, logPath));
        if (run.cases) this.lastGate = { head, task: task.id, cases: run.cases };
        if (!run.cases) this.warn(reportsWarning(flow, 'the gate after the task').replace('command exit codes only', 'compilation only, tests at the end of the group'));
        return problems.length ? problems.join('\n\n') : undefined;
      },
    };
  }

  /**
   * The earlier task whose gate passed all of this task's tests, on the code as it is now: it already did this task's
   * work (tests first on shared code — smoke 92-2).
   */
  doneBy(task: Task): Task | undefined {
    const last = this.lastGate;
    if (!last || last.head !== this.work.head) return undefined;
    const own = this.groupState.write_tests!.report.tests.filter((test) => test.ac.some((id) => task.acceptance.includes(id)));
    const green = own.length > 0 && own.every((test) => {
      const found = casesOf(test, last.cases);
      return found.length > 0 && found.every((testCase) => testCase.status === 'passed');
    });
    return green ? this.group.tasks.find((other) => other.id === last.task) : undefined;
  }

  /** A task done by an earlier one of its tier or above gets no session; its gate note says the breakdown was too fine. */
  skip(task: Task, by: Task): void {
    this.flow.log(`✓ ${this.group.id}/${task.id}: tests already pass after ${by.id}; skipping`);
    this.warn(`⚠ ${task.id} skipped: its tests already passed after ${by.id} (group split into tasks too finely?)`);
  }

  /**
   * A task done by an earlier one of a lower tier gets its session anyway, to review that work on its own tier: the
   * breakdown gave it the stronger model for a reason (acceptance smoke, 2026-10-19).
   */
  reviewNote(task: Task, by: Task): string {
    const { group } = this;
    const [tier, byTier] = [taskTier(group, task), taskTier(group, by)];
    this.flow.log(`! ${group.id}/${task.id}: tests already pass after ${by.id} [${byTier}]; a review at tier ${tier}`);
    this.warn(`⚠ ${task.id} [${tier}]: its tests already passed after ${by.id} [${byTier}]; a session at its tier reviewed that code`);
    return [
      `Your task's tests already pass: task ${by.id} (${by.title}), planned for a weaker tier (${byTier}), implemented your criteria with its own.`,
      `Your task was planned for the ${tier} tier, so review that code against your criteria and the spec: fix and commit what falls short;`,
      'if it holds, report `done` without changes.',
    ].join('\n');
  }

  private greenKeys(): string[] {
    const file = path.join(this.flow.context.workDir, greenBeforeName(this.group.id));
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : [];
  }

  private warn(warning: string): void {
    const tests = this.groupState.write_tests!;
    if (tests.warnings?.includes(warning)) return;
    tests.warnings = [...(tests.warnings ?? []), warning];
    this.flow.save();
  }

  /**
   * What an implementer or fixer must undo: tests the author wrote, changed since they were frozen.
   * `allowed` files (a fixer's findings point at them) may change, and are frozen anew at `head`.
   */
  frozenProblem(head: string, allowed: string[] = []): string | undefined {
    const tests = this.groupState.write_tests;
    if (!tests) return undefined;
    const blobs = testBlobs(this.flow, this.group.repo, head, Object.keys(tests.frozen));
    const changed = Object.keys(tests.frozen).filter((file) => blobs[file] !== tests.frozen[file]);
    const refused = changed.filter((file) => !allowed.includes(file));
    if (refused.length) {
      return [
        `You changed tests the group's test author wrote, which stay exactly as written: ${refused.map((file) => `\`${file}\``).join(', ')}.`,
        `Restore them (\`git checkout ${tests.commit} -- <file>\`) and commit. If a test is wrong, finish with a \`test_issue\` saying why instead.`,
      ].join('\n');
    }
    if (changed.length) {
      tests.frozen = refreeze(tests.frozen, blobs, changed);
      tests.commit = head;
      this.flow.save();
    }
    return undefined;
  }

  private async runAuthor(run: AuthorRun): Promise<{ report: WriteTestsArtifact; frozen: Record<string, string> }> {
    const { flow, work, group, groupState } = this;
    const { config, catalog } = flow.context;
    const acceptance = groupAcceptance(group);
    const commands = work.verifiedChecks;
    const before = groupState.write_tests?.frozen ?? {};
    let frozen: Record<string, string> = {};
    let commit = '';
    let warnings: string[] = [];
    let green: string[] | undefined;
    const { report, sessionId } = await work.runSession<WriteTestsArtifact>({
      kind: 'write-tests',
      executor: stageExecutor(config, 'write-tests', catalog),
      label: run.label,
      scope: { group: group.id, acceptance, references: groupReferences(group) },
      parse: (text) => parseWriteTests(text, acceptance),
      skipChecks: true,
      ...(run.resume && { resume: run.resume }),
      limit: { failures: RED_GATE_RESUMES + 1, reason: 'red_gate', describe: `the "red" gate: ${RED_GATE_RESUMES} test author resumes` },
      verify: async (head, written, logPath) => {
        if (!written) return undefined;
        const blobs = testBlobs(flow, group.repo, head, written.tests.map((test) => test.path));
        const missing = Object.keys(blobs).filter((file) => !blobs[file]);
        if (missing.length) return `These test files are not in your commits: ${missing.map((file) => `\`${file}\``).join(', ')}. Commit them, or fix their paths in the report.`;
        const changed = Object.keys(blobs).filter((file) => blobs[file] !== before[file]);
        const { gated, problem } = run.check(written, changed);
        if (problem) return problem;
        frozen = blobs as Record<string, string>;
        commit = head;
        warnings = [];
        green = undefined;
        if (!gated.tests.length) return undefined;
        if (!commands.length) {
          if (config.review.checks !== 'none') warnings.push('⚠ "red" gate skipped: all `checks` already red on the base');
          return undefined;
        }
        const scope = { owner: group.id, label: run.label };
        const gate = (cwd: string) => gatedTests(flow, cwd, scope, commands, (testRun) => redGate(gated, testRun, logPath));
        const { run: tested, problems } = run.redBase ? await work.atCommitWith(run.redBase.at, run.redBase.since, head, gate) : await gate(work.cwd);
        if (problems.length) return problems.join('\n\n');
        if (!tested.cases) warnings.push(reportsWarning(flow, 'the "red" gate'));
        // the cases green before any test of the group: only the first run knows them
        else if (!run.resume) green = greenBefore(written, tested.cases).map(caseKey);
        return undefined;
      },
    });
    if (green) writeFileSafe(path.join(flow.context.workDir, greenBeforeName(group.id)), JSON.stringify(green, null, 2) + '\n');
    const previous = groupState.write_tests;
    const session = sessionId ?? previous?.session;
    // what the first red gate could check stays the group's story
    const kept = run.resume ? previous?.warnings : warnings;
    const redBase = run.resume ? (previous?.red_base ?? previous?.commit) : commit;
    groupState.write_tests = { report, frozen, commit, ...(redBase && { red_base: redBase }), ...(session && { session }), ...(kept?.length && { warnings: kept }) };
    flow.save();
    return { report, frozen };
  }
}

/** Done by its own session, or skipped because an earlier one did its work. */
export function isImplemented(status: StepStatus | undefined): boolean {
  return status === 'done' || status === 'skipped';
}

/** The frozen tests with `files` frozen anew at their `blobs`; a file no longer there leaves the frozen set. */
export function refreeze(frozen: Record<string, string>, blobs: Record<string, string | undefined>, files: string[]): Record<string, string> {
  const next = { ...frozen };
  for (const file of files) {
    const blob = blobs[file];
    if (blob) next[file] = blob;
    else delete next[file];
  }
  return next;
}

/** Blob of each file at `commit` in the user's repo; `undefined` for a file not there. */
export function testBlobs(flow: FlowRun, repo: string, commit: string, paths: string[]): Record<string, string | undefined> {
  const files = [...new Set(paths)].sort();
  const repoPath = resolveRepo(repo, flow.state.origin);
  const listed = new Map(
    hostGit(repoPath, ['ls-tree', '-r', '-z', commit, '--', ...files])
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split('\t');
        return [file!, meta!.split(' ')[2]!] as const;
      }),
  );
  return Object.fromEntries(files.map((file) => [file, listed.get(file)]));
}
