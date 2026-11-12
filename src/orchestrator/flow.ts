import fs from 'node:fs';
import path from 'node:path';
import { enabledAxes } from '../config/review-axes.js';
import { prSummaryLanguage } from '../config/language.js';
import type { GateName } from '../config/types.js';
import { errorMessage } from '../errors.js';
import { writeFileSafe } from '../fsutil.js';
import { mergeDanger } from '../publish/merge-danger.js';
import type { SessionMode } from '../harness/types.js';
import {
  APPROVED_TASKS,
  APPROVED_TICKET,
  ArtifactError,
  IDEA,
  parseTasks,
  breakdownRules,
  chainProblems,
  type BreakdownRules,
  topoOrder,
  validateSpec,
  validateTicket,
  type GrillAsks,
  type Group,
  type Spec,
  type TasksFile,
} from './artifacts.js';
import type { FlowEvent } from './events.js';
import { BranchChain, type ChainSource } from './branch-chain.js';
import { checksReportName } from './checks.js';
import { CloneWork } from './clone-work.js';
import { FinalSplit } from './final-split.js';
import { featureExecutor, fixExecutor, groupExecutor, mergeExecutor, stageExecutor, taskExecutor } from './executors.js';
import { GateKeeper } from './gatekeeper.js';
import type { GateSummary } from './gates.js';
import { GroupRunner, verificationNotes, type GroupOutcome } from './group-runner.js';
import { acquireLock, flowRunning } from './lock.js';
import { writeTestsEnabled } from './write-tests.js';
import { resolveRepo } from './repos.js';
import { ReviewLoop, reviewSummaryName } from './review-loop.js';
import { FlowRun, Halt, type FlowContext } from './run.js';
import { scheduleGroups } from './schedule.js';
import { reportName, SessionRunner } from './session-runner.js';
import { linesText } from '../publish/size.js';
import {
  knownRed,
  listFlows,
  loadState,
  newState,
  reviewedRound,
  roundNumber,
  saveState,
  STAGE_GATE,
  STAGES,
  uniqueSlug,
  type Entry,
  type FlowOrigin,
  type FlowState,
  type FlowTarget,
  type GroupState,
  type StageId,
} from './state.js';

export type { FlowContext } from './run.js';

export function createFlow(input: {
  workRoot: string;
  /** Roots of earlier flows (`workRoots`): the new slug is free in them too. */
  otherRoots?: string[];
  title: string;
  entry: Entry;
  origin: FlowOrigin;
  /** The PR's target branch (`flowTarget`): the first groups start at its tip. */
  target?: FlowTarget;
  ticket?: string;
  /** `new`: the pasted idea, for the business grill. */
  idea?: string;
  overrides?: FlowState['overrides'];
}): { slug: string; workDir: string; state: FlowState } {
  if (input.entry === 'pick') {
    if (!input.ticket) throw new Error('`pick` needs the ticket text');
    validateTicket(input.ticket);
  }
  const slug = uniqueSlug([input.workRoot, ...(input.otherRoots ?? [])], input.title);
  const workDir = path.join(input.workRoot, slug);
  fs.mkdirSync(workDir, { recursive: true });
  // flows (clones, reports, state) never show up as untracked files, also with the global dir kept in git (dotfiles)
  const ignoreFile = path.join(input.workRoot, '.gitignore');
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n');
  if (input.ticket) writeFileSafe(path.join(workDir, 'ticket.md'), input.ticket);
  if (input.idea) writeFileSafe(path.join(workDir, IDEA), input.idea);
  const state = newState({ slug, title: input.title, entry: input.entry, origin: input.origin, target: input.target, overrides: input.overrides });
  saveState(workDir, state);
  return { slug, workDir, state };
}

/**
 * Paused or interrupted `pick` flows of the same ticket in this repo, newest first: a second `pick` after a pause
 * starts a new flow, easily by mistake (smoke 92-3). A flow running right now isn't one.
 */
export function unfinishedPicks(workRoots: string[], title: string, origin: FlowOrigin): FlowState[] {
  return unfinishedFlows(workRoots, origin).filter((state) => state.entry === 'pick' && state.title === title);
}

/** Paused or interrupted flows of this repo that no process runs now, newest first: what `resume` can pick up. */
export function unfinishedFlows(workRoots: string[], origin: FlowOrigin): FlowState[] {
  return workRoots
    .flatMap((root) =>
      listFlows(root).flows.filter(
        (state) =>
          (state.status === 'paused' || state.status === 'running') &&
          path.resolve(state.origin.repoRoot) === path.resolve(origin.repoRoot) &&
          !flowRunning(path.join(root, state.slug)),
      ),
    )
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
}

/**
 * Idempotent over state.json: finished stages, tasks and review phases are skipped,
 * so `resume` is just another run.
 */
export async function runFlow(context: FlowContext): Promise<FlowState> {
  const release = acquireLock(context.workDir);
  try {
    return await runLocked(context);
  } finally {
    release();
  }
}

async function runLocked(context: FlowContext): Promise<FlowState> {
  const state = loadState(context.workDir, context.log);
  if (['done', 'aborted', 'failed'].includes(state.status)) return state;
  if (state.stages.implement.status !== 'done') await assertTestAuthor(context);
  const flow = new FlowRun(context, state);
  const resumed = Object.values(state.stages).some((stageState) => !['pending', 'skipped'].includes(stageState.status));
  flow.emit({ type: 'flow_started', resumed });
  state.status = 'running';
  delete state.paused;
  flow.save();
  try {
    await new FlowRunner(flow).all();
    state.status = 'done';
    state.outcome = 'ready_to_publish';
    context.log?.(`Flow ${state.slug} ready; review the changes and run \`agentic publish\`.`);
  } catch (error) {
    if (error instanceof Halt) {
      state.status = error.status;
      if (error.pause) state.paused = error.pause;
      if (error.outcome) state.outcome = error.outcome;
    } else {
      state.status = 'paused';
      state.paused = { reason: 'error', message: errorMessage(error) };
    }
  }
  flow.save();
  flow.emit(finalEvent(state));
  return state;
}

/**
 * The test author's harness is checked before the flow starts, not when the first group needs it:
 * a missing Codex would otherwise stop the flow after the grill, ticket and spec.
 */
async function assertTestAuthor(context: FlowContext): Promise<void> {
  const { config, catalog } = context;
  if (!writeTestsEnabled(config)) return;
  const executor = stageExecutor(config, 'write-tests', catalog);
  if ((await context.harnesses[executor.harness].status()).installed) return;
  throw new Error(
    [
      `\`stages.write-tests\` uses ${executor.harness}:${executor.model}, but \`${executor.harness}\` is not installed.`,
      'Install it or set the test author in the global config (`~/.agentic/config.yaml`), e.g.:',
      '  stages:',
      '    write-tests: { harness: claude, model: opus }',
      'or turn the stage off: `stages.write-tests.enabled: false`.',
    ].join('\n'),
  );
}

function finalEvent(state: FlowState): FlowEvent {
  const { reason = 'error', group, message } = state.paused ?? {};
  switch (state.status) {
    case 'done':
      return { type: 'flow_done', outcome: state.outcome ?? 'ready_to_publish' };
    case 'failed':
      return { type: 'flow_failed', reason, group, message };
    case 'aborted':
      return { type: 'flow_aborted', message };
    default:
      return { type: 'flow_paused', reason, group, message };
  }
}

class FlowRunner {
  private readonly sessions: SessionRunner;
  private readonly gatekeeper: GateKeeper;

  constructor(private readonly flow: FlowRun) {
    this.gatekeeper = new GateKeeper(flow);
    this.sessions = new SessionRunner(flow, this.gatekeeper);
  }

  private get state(): FlowState {
    return this.flow.state;
  }

  private get context(): FlowContext {
    return this.flow.context;
  }

  private rules?: BreakdownRules;

  /** What the breakdown's plan is held to; repo names resolved against the flow's origin. */
  private get breakdownRules(): BreakdownRules {
    return (this.rules ??= breakdownRules(this.context.config, (name) => resolveRepo(name, this.state.origin)));
  }

  /** With a stack, where the plan's groups of one repo are not a chain (after a human's edit at the gate). */
  private brokenChain(tasks: TasksFile): string[] {
    return this.breakdownRules.stack ? chainProblems(tasks.groups, this.breakdownRules.repoKey) : [];
  }

  async all(): Promise<void> {
    for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex++) {
      const stage = STAGES[stageIndex]!;
      const stageState = this.state.stages[stage];
      if (stageState.status === 'skipped') continue;
      this.state.stage = stage;
      if (stageState.status !== 'done') {
        stageState.status = 'running';
        stageState.started_at ??= new Date().toISOString();
        this.flow.save();
        this.flow.emit({ type: 'stage_started', stage });
        await this.runStage(stage);
        stageState.status = 'done';
        stageState.finished_at = new Date().toISOString();
        this.flow.save();
        this.flow.emit({ type: 'stage_done', stage });
      }
      const gate = STAGE_GATE[stage];
      if (gate && stageState.gate !== 'passed') {
        const decision = await this.gatekeeper.gate(gate, () => this.summary(gate));
        if (decision.action === 'retry') {
          this.flow.note(stage, decision.note);
          stageState.status = 'pending';
          delete stageState.session_done;
          stageIndex--;
          continue;
        }
        if (stage === 'breakdown') this.approveTasks();
        stageState.gate = 'passed';
        this.flow.save();
      }
    }
  }

  private async runStage(stage: StageId): Promise<void> {
    switch (stage) {
      case 'ticket':
        return this.stageSession('grill-business', 'interactive', () => validateTicket(this.flow.read('ticket.md')));
      case 'spec':
        // only the grill's own artifact must carry them: a flow started before `pr_summary` or `External assets` resumes on its spec
        return this.stageSession('grill-technical', 'interactive', () => this.spec({ prSummary: prSummaryLanguage(this.context.config.language) }));
      case 'breakdown':
        return this.stageSession('breakdown', 'headless', () => this.checkPlan(this.tasks('tasks.yaml', this.breakdownRules)));
      case 'implement':
        return this.implement();
      case 'final-review':
        return this.finalReview();
    }
  }

  /** The same review loop as a group's, over the whole feature, in its own clone at the merged group branches. */
  private async finalReview(): Promise<void> {
    const finalState = (this.state.final_review ??= {});
    // interrupted between the gate and the end of the stage: the work is on the branch already
    if (!(finalState.gate === 'passed' && finalState.clone_removed)) await this.finalReviewLoop(finalState);
    await new FinalSplit(this.flow, this.gatekeeper, this.sessions).run(this.featureBranches(), this.featureBase());
  }

  private async finalReviewLoop(finalState: NonNullable<FlowState['final_review']>): Promise<void> {
    const { config, catalog } = this.context;
    const owner = { name: '_final', label: 'final review', repo: '.' };
    const work = new CloneWork(this.flow, this.sessions, owner, finalState);
    const chained = !work.prepared || finalState.chain?.conflict;
    work.prepare(chained ? await new BranchChain(this.flow, this.gatekeeper, work, finalState).base(this.featureBranches()) : undefined);
    const base = this.featureBase();
    // a revert won't undo a migration or a changed contract: the human sees them before publish, whatever the preset
    const oneWay = () => {
      const files = mergeDanger(work.changedFiles(work.head!, base), config.publish.one_way_paths).oneWay.map((file) => file.path);
      return files.length ? `one-way change (publish.one_way_paths): ${files.join(', ')}` : undefined;
    };
    const loop = new ReviewLoop(this.flow, this.sessions, this.gatekeeper, {
      gate: 'final',
      label: 'feature',
      state: finalState,
      axes: [['final', config.review.final]],
      acceptance: [],
      fixer: fixExecutor(config, featureExecutor(config, this.approvedTasks().groups), catalog),
      work,
      base,
      forceGate: oneWay,
      notes: () => {
        const warning = oneWay();
        return [...verificationNotes(config.review.checks, knownRed(this.state)), ...(warning ? [`⚠ ${warning}`] : [])];
      },
      flowFiles: this.groupReports(),
    });
    for (;;) {
      await loop.run();
      if (await loop.gate()) break;
    }
    work.remove();
  }

  /** Where the feature starts: the base of its first group in the origin repo (later ones start at the groups they depend on). */
  private featureBase(): string | undefined {
    const [first] = this.featureBranches();
    return first && this.state.groups[first.group.id]?.baseRef;
  }

  /** Every group of the origin repo, in plan order: the whole feature is their merge. */
  private featureBranches(): ChainSource[] {
    const { origin, groups } = this.state;
    return topoOrder(this.approvedTasks().groups).flatMap((group) => {
      const head = groups[group.id]?.head ?? groups[group.id]?.baseRef;
      return head && resolveRepo(group.repo, origin) === origin.repoRoot ? [{ group, head }] : [];
    });
  }

  /**
   * What the final reviewer builds on: each axis's last report per group, every fix report (disputed findings)
   * and the group's last checks results.
   */
  private groupReports(): string[] {
    return Object.entries(this.state.groups).flatMap(([groupId, groupState]) => {
      const lastRound = roundNumber(groupState);
      const reviews = enabledAxes(this.context.config.review).flatMap(([axis]) => {
        const round = reviewedRound(groupState, axis);
        return round ? [reportName(`review-${axis}`, groupId, round)] : [];
      });
      const fixes = Array.from({ length: lastRound }, (_unused, index) => reportName('fix', groupId, index + 1));
      return [...(lastRound ? [...reviews, ...fixes, reviewSummaryName(groupId)] : []), checksReportName(groupId)];
    });
  }

  /**
   * After a validation pause, resume accepts the artifact if the human fixed it by hand;
   * only a still-invalid artifact reruns the session.
   */
  private async stageSession(kind: 'grill-business' | 'grill-technical' | 'breakdown', mode: SessionMode, validate: () => void): Promise<void> {
    const stageState = this.state.stages[this.state.stage];
    let problems: string | undefined;
    if (stageState.session_done) {
      try {
        return validate();
      } catch (error) {
        delete stageState.session_done;
        problems = (error as Error).message;
      }
    }
    const earlier = problems && mode === 'interactive' ? stageState.session_id : undefined;
    const resume =
      earlier &&
      (await this.context.gates.confirm?.(
        `The previous ${kind} session ended without a finished artifact. Continue that conversation (your answers stay)? Otherwise ${kind} starts over.`,
      ));
    const outcome = await this.sessions.run(
      kind,
      mode,
      stageExecutor(this.context.config, kind, this.context.catalog),
      resume ? { resume: earlier, extra: problems } : {},
    );
    stageState.session_done = true;
    // Codex reports no id for an interactive session: nothing to continue
    if (mode === 'interactive') stageState.session_id = outcome.sessionId;
    this.flow.save();
    if (outcome.confirmed !== false) return validate();
    try {
      validate();
    } catch {
      // left before the human confirmed (smoke 92-3: Ctrl+C read as a broken artifact); resume offers to continue it
      throw new Halt('paused', {
        reason: 'human',
        message: `${kind} session closed before approval (Ctrl+C or exit); resuming offers to continue the conversation`,
      });
    }
  }

  /**
   * Groups run in dependency order, `parallel_groups` at a time. A blocked or failed group doesn't stop
   * independent ones; the flow stops once nothing more can run: aborted, else paused (blocked groups
   * rerun on resume), else failed.
   */
  private async implement(): Promise<void> {
    const groups = topoOrder(this.approvedTasks().groups);
    const groupStates = new Map(groups.map((group) => [group.id, this.groupState(group)]));
    const outcomes = await scheduleGroups({
      groups,
      limit: this.context.config.parallel_groups,
      settled: (group) => settledOutcome(groupStates.get(group.id)!),
      runGroup: async (group) => {
        const outcome = await new GroupRunner(this.flow, this.sessions, this.gatekeeper, group, groupStates.get(group.id)!, groups).run();
        if (outcome.status === 'aborted') this.flow.stopRequested = true;
        return outcome;
      },
    });
    const stopped = (status: GroupOutcome['status']) =>
      groups.flatMap((group) => {
        const outcome = outcomes.get(group.id);
        return outcome?.status === status && 'pause' in outcome ? [outcome.pause] : [];
      });
    const waiting = groups.filter((group) => !outcomes.has(group.id)).map((group) => group.id);
    const [aborted] = stopped('aborted');
    if (aborted) throw new Halt('aborted', aborted);
    const blocked = stopped('blocked');
    const failed = stopped('failed');
    if (blocked.length + failed.length > 1 || (waiting.length && (blocked.length || failed.length))) {
      const list = (label: string, ids: Array<string | undefined>) => (ids.length ? [`${label}: ${ids.join(', ')}`] : []);
      this.flow.log(
        [...list('Paused groups', blocked.map((pause) => pause.group)), ...list('failed', failed.map((pause) => pause.group)), ...list('waiting', waiting)].join('; '),
      );
    }
    if (blocked.length) throw new Halt('paused', blocked[0]);
    if (failed.length) throw new Halt('failed', failed[0]);
  }

  /** Before the gate, so a bad override or unknown repo can't deadlock implementation. */
  private checkPlan(tasks: TasksFile): void {
    const affected = fs.existsSync(path.join(this.context.workDir, 'spec.md'))
      ? new Set(this.spec().affectedRepos.map((name) => resolveRepo(name, this.state.origin)))
      : undefined;
    const outsideSpec = tasks.groups.filter((group) => affected && !affected.has(resolveRepo(group.repo, this.state.origin)));
    if (outsideSpec.length) {
      throw new ArtifactError('tasks.yaml', outsideSpec.map((group) => `${group.id}: repo \`${group.repo}\` is not in \`## Affected repos\` in spec.md`));
    }
    for (const group of tasks.groups) {
      for (const task of group.tasks) taskExecutor(this.context.config, group, task, this.context.catalog);
      fixExecutor(this.context.config, groupExecutor(this.context.config, group), this.context.catalog);
    }
    fixExecutor(this.context.config, featureExecutor(this.context.config, tasks.groups), this.context.catalog);
    mergeExecutor(this.context.config, tasks.groups, this.context.catalog);
  }

  /** Snapshot of the plan as seen at the gate, including the human's edits. */
  private approveTasks(): void {
    const text = this.flow.read('tasks.yaml');
    const ticket = this.flow.read('ticket.md');
    const tasks = parseTasks(text, validateTicket(ticket));
    this.checkPlan(tasks);
    // the human's edit may break the chain the breakdown was held to: their call, the flow only records it
    for (const problem of this.brokenChain(tasks)) this.flow.log(`⚠ plan approved despite: ${problem}`);
    writeFileSafe(path.join(this.context.workDir, APPROVED_TASKS), text);
    // the plan is validated against the ticket it was approved with; later ticket edits (spec_issue) don't strand it
    writeFileSafe(path.join(this.context.workDir, APPROVED_TICKET), ticket);
    this.state.groups = Object.fromEntries(
      tasks.groups.map((group) => [group.id, { status: 'pending', tasks: Object.fromEntries(group.tasks.map((task) => [task.id, 'pending'])) }]),
    );
  }

  private groupState(group: Group): GroupState {
    const groupState = this.state.groups[group.id];
    if (!groupState) throw new Error(`group \`${group.id}\` is not in the flow state; ${APPROVED_TASKS} doesn't match state.json`);
    return groupState;
  }

  private spec(grill?: GrillAsks): Spec {
    return validateSpec(this.flow.read('spec.md'), (name) => resolveRepo(name, this.state.origin), grill);
  }

  private tasks(file: string, rules?: BreakdownRules): TasksFile {
    return parseTasks(this.flow.read(file), validateTicket(this.flow.read('ticket.md')), rules);
  }

  private approvedTasks(): TasksFile {
    const hasTicketSnapshot = fs.existsSync(path.join(this.context.workDir, APPROVED_TICKET));
    return parseTasks(this.flow.read(APPROVED_TASKS), validateTicket(this.flow.read(hasTicketSnapshot ? APPROVED_TICKET : 'ticket.md')));
  }

  private summary(gate: GateName): GateSummary {
    const { workDir } = this.context;
    if (gate === 'breakdown') {
      const ticket = validateTicket(this.flow.read('ticket.md'));
      const tasks = parseTasks(this.flow.read('tasks.yaml'), ticket);
      const groups = tasks.groups.map(
        (group) =>
          `${group.id} (${group.repo}${group.depends_on.length ? `, after ${group.depends_on.join(', ')}` : ''}${group.estimate ? `, ~${linesText(group.estimate.prod, group.estimate.tests)}` : ''}): ${group.summary ?? group.title ?? ''}\n` +
          (group.oversize_reason ? `  over the threshold because: ${group.oversize_reason}\n` : '') +
          `  why this way: ${group.rationale}\n` +
          group.tasks.map((task) => `  - ${task.id} [${task.tier ?? '-'}] ${task.summary ?? task.title} ${task.acceptance.join(' ')}`).join('\n'),
      );
      const warnings = [...tasks.warnings, ...this.brokenChain(tasks)];
      return {
        text: [...warnings.map((warning) => `⚠ ${warning}`), ...groups].join('\n'),
        view: {
          kind: 'breakdown',
          file: path.join(workDir, 'tasks.yaml'),
          groups: tasks.groups,
          acceptance: ticket.acceptance,
          warnings,
          limits: this.breakdownRules.limits,
        },
      };
    }
    if (gate === 'ticket') {
      const file = path.join(workDir, 'ticket.md');
      const ticket = validateTicket(this.flow.read('ticket.md'));
      const facts = [`acceptance criteria: ${ticket.acceptance.join(', ')}`, ...(ticket.trackerKey ? [`tracker: ${ticket.trackerKey}`] : [])];
      return { text: file, view: { kind: 'document', file, title: ticket.title, summary: ticket.summary, facts } };
    }
    if (gate === 'spec') {
      const file = path.join(workDir, 'spec.md');
      const spec = this.spec();
      const repos = spec.affectedRepos.map((name) => path.basename(resolveRepo(name, this.state.origin)));
      // the sessions after this gate run unattended in the sandbox: nobody there can fetch a font or approve a host
      const assets = spec.externalAssets.length ? [`external (deliver before implementation): ${spec.externalAssets.join('; ')}`] : [];
      return { text: file, view: { kind: 'document', file, title: spec.title, summary: spec.summary, facts: [`repositories: ${repos.join(', ')}`, ...assets] } };
    }
    return { text: '' };
  }
}

/** A group finished in an earlier run isn't run again; a blocked one is. */
function settledOutcome(groupState: GroupState): GroupOutcome | undefined {
  if (groupState.status === 'done' && groupState.gate === 'passed') return { status: 'done' };
  if (groupState.status === 'failed') return { status: 'failed', pause: groupState.failure ?? { reason: 'error' } };
  return undefined;
}
