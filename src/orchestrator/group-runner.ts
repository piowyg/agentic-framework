import { enabledAxes } from '../config/review-axes.js';
import { TIERS } from '../config/schema.js';
import { errorMessage } from '../errors.js';
import { parseImplement } from '../contracts/index.js';
import { groupAcceptance, taskTier, type Group, type Task } from './artifacts.js';
import { BranchChain, type ChainSource } from './branch-chain.js';
import type { CheckRun } from './checks.js';
import { CloneWork } from './clone-work.js';
import { fixExecutor, groupExecutor, taskExecutor } from './executors.js';
import type { GateKeeper } from './gatekeeper.js';
import { resolveRepo } from './repos.js';
import { ReviewLoop } from './review-loop.js';
import { Halt, type FlowRun } from './run.js';
import { GroupTests, isImplemented, TEST_ISSUE_FIXES, writeTestsEnabled, writeTestsReportName } from './write-tests.js';
import type { SessionRunner } from './session-runner.js';
import { diffSizeAt, sizeWarning, type LineCounts } from '../publish/size.js';
import { knownRed, type GroupSize, type GroupState, type Pause } from './state.js';

/** How a group's run ended; only `aborted` stops the other groups. */
export type GroupOutcome = { status: 'done' } | { status: 'blocked' | 'failed' | 'aborted'; pause: Pause };

/**
 * One implementation group — clone, tasks, review loop, group gate — and the unit of parallelism.
 * Never throws: every stop becomes an outcome, recorded in the group's state.
 */
export class GroupRunner {
  constructor(
    private readonly flow: FlowRun,
    private readonly sessions: SessionRunner,
    private readonly gatekeeper: GateKeeper,
    private readonly group: Group,
    private readonly groupState: GroupState,
    /** The whole approved plan: the group's predecessors and their descriptions. */
    private readonly plan: Group[],
  ) {}

  async run(): Promise<GroupOutcome> {
    delete this.groupState.blocked;
    try {
      await this.pipeline();
    } catch (error) {
      return this.settle(error);
    }
    const { size } = this.groupState;
    this.flow.emit({ type: 'group_done', group: this.group.id, ...(size && groupDoneSize(size)) });
    return { status: 'done' };
  }

  private settle(error: unknown): GroupOutcome {
    const halt = error instanceof Halt ? error : undefined;
    const pause: Pause = {
      ...(halt?.pause ?? { reason: 'error', message: errorMessage(error) }),
      group: this.group.id,
    };
    const status = halt?.status === 'failed' ? 'failed' : halt?.status === 'aborted' ? 'aborted' : 'blocked';
    if (status === 'failed') {
      this.groupState.status = 'failed';
      this.groupState.failure = pause;
    } else if (status === 'blocked') {
      this.groupState.blocked = pause;
    }
    this.flow.save();
    if (status !== 'aborted') {
      this.flow.emit({ type: 'group_blocked', group: this.group.id, reason: pause.reason, ...(status === 'failed' && { failed: true as const }), message: pause.message });
    }
    return { status, pause };
  }

  private async pipeline(): Promise<void> {
    const { group, groupState, flow } = this;
    const { config, catalog } = flow.context;
    const owner = { name: group.id, label: `group ${group.id}`, repo: group.repo };
    const work = new CloneWork(flow, this.sessions, owner, groupState);
    const testsFirst = writeTestsEnabled(config);
    const tests = new GroupTests(flow, work, group, groupState);
    // the tests' report: implementers find their target in it, the spec axis checks `already_met`
    const flowFiles = testsFirst ? [writeTestsReportName(group.id)] : [];
    const loop = new ReviewLoop(flow, this.sessions, this.gatekeeper, {
      group: group.id,
      gate: 'group',
      label: `group ${group.id}`,
      state: groupState,
      axes: enabledAxes(config.review),
      acceptance: groupAcceptance(group),
      fixer: fixExecutor(config, groupExecutor(config, group), catalog),
      work,
      notes: () => [...verificationNotes(config.review.checks, knownRed(this.flow.state)), ...(groupState.write_tests?.warnings ?? [])],
      flowFiles,
      // a fixer may change a frozen test only when a finding it fixes points at it
      verifyFix: (head, findings) => tests.frozenProblem(head, findings.map((finding) => finding.file).filter((file): file is string => !!file)),
      reopened: () => {
        groupState.status = 'running';
      },
    });
    while (groupState.status !== 'done' || groupState.gate !== 'passed') {
      if (groupState.status !== 'done') {
        groupState.status = 'running';
        const chained = !work.prepared || groupState.chain?.conflict;
        work.prepare(chained ? await new BranchChain(flow, this.gatekeeper, work, groupState, group.id).base(this.predecessors()) : undefined);
        if (group.tasks.every((task) => groupState.tasks[task.id] === 'pending')) await this.baseline(work);
        if (testsFirst && !tests.written) await tests.write();
        for (const task of group.tasks) {
          if (isImplemented(groupState.tasks[task.id])) continue;
          const doneBy = tests.partial(task) ? tests.doneBy(task) : undefined;
          if (doneBy && !outranks(group, task, doneBy)) {
            tests.skip(task, doneBy);
            groupState.tasks[task.id] = 'skipped';
            flow.save();
            continue;
          }
          groupState.tasks[task.id] = 'running';
          flow.save();
          await this.implement(work, tests, task, flowFiles, doneBy && tests.reviewNote(task, doneBy));
          groupState.tasks[task.id] = 'done';
          flow.save();
        }
        await loop.run();
        groupState.status = 'done';
        flow.save();
      }
      await loop.gate();
    }
    this.measure(work);
    work.remove();
  }

  /**
   * One task's implementer, through the control after the session; frozen tests stay as written.
   * A `test_issue` goes to the test author: a fixed test sends the task back to its implementer, an upheld one
   * to a human — whose `continue` holds the implementer to the test. Past `TEST_ISSUE_FIXES` fixes the task pauses.
   */
  private async implement(work: CloneWork, tests: GroupTests, task: Task, flowFiles: string[], review?: string): Promise<void> {
    const { group, groupState, flow } = this;
    const { config, catalog } = flow.context;
    let note = review;
    let fixes = 0;
    // after the test author's answer: the implementer that reported, to be resumed with `note`
    let reporter: { session?: string } | undefined;
    for (;;) {
      if (groupState.open_test_issue?.task !== task.id) {
        // the last task leaves the whole group green; earlier ones only their part
        const partial = tests.partial(task) ? tests.taskControl(task) : undefined;
        const extra = [partial?.note, note].filter(Boolean).join('\n\n');
        const handedOver = groupState.handed_over?.task === task.id ? groupState.handed_over : undefined;
        const resume = handedOver
          ? { sessionId: handedOver.session, message: [handBackMessage(handedOver.issue), extra].filter(Boolean).join('\n\n') }
          : reporter && { sessionId: reporter.session, message: extra };
        const { report, sessionId } = await work.runSession({
          kind: 'implement',
          executor: taskExecutor(config, group, task, catalog),
          label: task.id,
          parse: parseImplement,
          handsOver: (implemented) => implemented.status !== 'done',
          cleanHandOver: true,
          skipChecks: !!partial,
          verify: (head, _implemented, logPath) => (partial ? partial.verify(head, logPath) : tests.frozenProblem(head)),
          scope: { group: group.id, task: task.id, taskTitle: task.title, acceptance: task.acceptance, flowFiles, ...(extra && { extra }) },
          ...(resume && { resume }),
        });
        reporter = undefined;
        if (handedOver) {
          delete groupState.handed_over;
          flow.save();
        }
        if (report.status === 'done') return;
        const issue = report.issue!;
        if (report.status === 'spec_issue' || !tests.written || groupState.upheld_tests?.includes(task.id)) {
          groupState.handed_over = { task: task.id, issue, ...(sessionId && { session: sessionId }) };
          flow.save();
          throw new Halt('paused', { reason: report.status, group: group.id, message: issue });
        }
        if (fixes === TEST_ISSUE_FIXES) {
          throw new Halt('paused', { reason: 'test_issue', group: group.id, message: `${issue} (the test author has already fixed this task's tests ${fixes} times)` });
        }
        groupState.open_test_issue = { task: task.id, issue, since: await work.cloneHead(), ...(sessionId && { session: sessionId }) };
        flow.save();
      }
      const open = groupState.open_test_issue!;
      flow.log(`! ${group.id}/${task.id}: test_issue; asking the test author`);
      const answer = await tests.answer(task, open.issue, open.since);
      delete groupState.open_test_issue;
      flow.save();
      reporter = { ...(open.session && { session: open.session }) };
      if (answer.verdict === 'fixed') {
        fixes++;
        note = `The test author changed the test you reported (${answer.reason}). Implement the task against the tests as they are now.`;
        continue;
      }
      await this.gatekeeper.ask(
        'group',
        [
          `group ${group.id}, task ${task.id}: the implementer thinks the test is wrong, the test author upholds it.`,
          `implementer: ${open.issue}`,
          `test author: ${answer.reason}`,
          'continue = the test stays and the implementer must pass it; pause = decide yourself and `agentic resume`.',
        ].join('\n'),
        ['continue', 'stop', 'abort'],
        { group: group.id },
      );
      groupState.upheld_tests = [...(groupState.upheld_tests ?? []), task.id];
      flow.save();
      note = `You reported a test as wrong; its author upheld it (${answer.reason}) and a human agreed. Make it pass as written; do not report a test_issue again.`;
    }
  }

  /**
   * The group's diff from its base, against the thresholds and its estimate: the reviewer reads this, not the plan.
   * Only a warning, so a failed measurement (e.g. git without `check-attr --source`) is logged, never a stop.
   */
  private measure(work: CloneWork): void {
    const head = work.head;
    if (!head || !work.baseRef) return;
    try {
      const { prod, tests, excluded, limits } = diffSizeAt(work.repoPath, head, work.changedFiles(head), this.flow.context.config.publish.size);
      const warning = sizeWarning({ prod, tests }, this.group.estimate, limits);
      this.groupState.size = { prod, tests, excluded, ...(warning && { warning }) };
      this.flow.save();
      if (warning) this.flow.log(`! group ${this.group.id}: ${warning}`);
    } catch (error) {
      this.flow.log(`! group ${this.group.id}: size not measured; ${errorMessage(error)}`);
    }
  }

  /** Finished groups this one depends on, in the same repo: their branches are its base. */
  private predecessors(): ChainSource[] {
    const { origin } = this.flow.state;
    const repo = resolveRepo(this.group.repo, origin);
    return this.plan.flatMap((candidate) => {
      const candidateState = this.flow.state.groups[candidate.id];
      const head = candidateState?.head ?? candidateState?.baseRef;
      if (!this.group.depends_on.includes(candidate.id) || !head || resolveRepo(candidate.repo, origin) !== repo) return [];
      return [{ group: candidate, head }];
    });
  }

  /**
   * `checks` red on the clean base would fail every task. A human decides: known red (it doesn't count in the
   * flow's groups), or stop to fix the base — the clone goes, so `resume` starts the group from the new base.
   * Groups ask one at a time, so a command accepted for one group isn't asked about again for the next.
   */
  private async baseline(work: CloneWork): Promise<void> {
    const red = await work.baseline();
    if (!red.length) return;
    const turn = this.flow.baselineQuestions.then(() => this.askAboutBaseline(work, red));
    this.flow.baselineQuestions = turn.catch(() => undefined);
    await turn;
  }

  private async askAboutBaseline(work: CloneWork, allRed: CheckRun[]): Promise<void> {
    const { group, groupState } = this;
    // another group, asking meanwhile, accepted it
    const accepted = new Set(knownRed(this.flow.state));
    const known = allRed.filter((run) => accepted.has(run.command)).map((run) => run.command);
    if (known.length) this.flow.log(`group ${group.id}: ${known.map((command) => `\`${command}\``).join(', ')} red on the base; known red, accepted in another group`);
    const red = allRed.filter((run) => !accepted.has(run.command));
    if (!red.length) return;
    const commands = red.map((run) => `\`${run.command}\``).join(', ');
    const message = [
      `group ${group.id}: ${commands} already red on the base ${work.baseRef?.slice(0, 12)}, before the agent changed anything.`,
      ...red.flatMap((run) => (run.log ? [`  log: ${run.log}`] : [])),
      "continue = known red (they don't count towards verification in this flow's groups); pause = fix the base and `agentic resume` (the group starts from the new base).",
    ].join('\n');
    try {
      await this.gatekeeper.ask('group', message, ['continue', 'stop', 'abort'], { group: group.id });
    } catch (error) {
      if (error instanceof Halt && error.status === 'paused') {
        work.discard();
        throw new Halt('paused', { reason: 'baseline', group: group.id, message: `${commands} red on the base; fix the base and resume` });
      }
      throw error;
    }
    groupState.known_red = [...(groupState.known_red ?? []), ...red.map((run) => run.command)];
    this.flow.save();
  }
}

/** Resumes an implementer that handed its task to a human. */
function handBackMessage(issue: string): string {
  return [
    `You stopped and reported: "${issue}". A human has dealt with it and resumed the flow; the ticket and the spec in your context files are their current versions, so read them again — they may have changed.`,
    'Your commits from before, work in progress included, are still on the branch: finish the task from there, keeping what still holds and undoing what no longer does.',
  ].join(' ');
}

/** `task` was planned for a stronger tier than `other`. */
function outranks(group: Group, task: Task, other: Task): boolean {
  return TIERS.indexOf(taskTier(group, task)) > TIERS.indexOf(taskTier(group, other));
}

/** What the gate says about how far the group's code was verified. */
export function verificationNotes(checks: string[] | 'none', knownRed: string[] = []): string[] {
  if (checks === 'none') return ['⚠ unverified: `review.checks: none`; nobody ran the build or the tests'];
  return knownRed.length ? [`⚠ known red (already on the base, ignored): ${knownRed.map((command) => `\`${command}\``).join(', ')}`] : [];
}

/** `group_done`'s size fields: the counts, and the warning as the event's `message`. */
function groupDoneSize({ warning, ...size }: GroupSize): { size: LineCounts; message?: string } {
  return { size, ...(warning && { message: warning }) };
}
