import fs from 'node:fs';
import path from 'node:path';
import type { Executor, StopTrigger } from '../config/types.js';
import { contractFile } from '../contracts/index.js';
import { errorMessage } from '../errors.js';
import { writeFileSafe } from '../fsutil.js';
import type { CommittingKind } from '../harness/types.js';
import type { ChangedFile } from '../publish/merge-danger.js';
import type { ReviewReport } from '../review/findings.js';
import { parseChangedLines, type ChangedLines, type FrozenScope } from '../review/scope.js';
import { ArtifactError } from './artifacts.js';
import { cloneGit, commandWorkspace, showFile } from './bundles.js';
import { checkCommands, checksReport, checksReportName, describeFailures, passed, rerunFailed, RUNNER_LOG_DIR, runChecks, type CheckRun } from './checks.js';
import { changedFiles, changedSince, diffLines, diffText, discardClone, prepareClone, removeClone, restartClone, snapshotRound, syncClone, type CloneOwner } from './clones.js';
import { cloneForGroup, hostGit, resolveRepo } from './repos.js';
import { Halt, type FlowRun } from './run.js';
import type { SessionOutcome, SessionRunner, SessionScope } from './session-runner.js';
import { knownRed, type CloneState, type Pause, type ScopeAxis } from './state.js';

/** `{checks_failing: n}` from `review.stop_on`; without it the default, so a session is never resumed forever. */
const DEFAULT_CHECKS_FAILING = 3;

export function checksFailingLimit(stopOn: StopTrigger[]): number {
  for (const trigger of stopOn) if (typeof trigger === 'object' && 'checks_failing' in trigger) return trigger.checks_failing;
  return DEFAULT_CHECKS_FAILING;
}

/** Resumes a session stopped midway (`CloneState.interrupted`). */
const INTERRUPTED_MESSAGE =
  'Your previous run was stopped before it finished (the session time limit, an API error or a rate limit), not because of anything you did. Your uncommitted changes are still in the working directory. Continue the task where you left off; everything asked before still holds.';

/** Resumes a session whose work failed its control up to the limit (`CloneState.interrupted.failed_control`). */
const FAILED_CONTROL_MESSAGE =
  'The flow paused because your work kept failing the control after the session; a human has looked at it and resumed the flow. The code or the checks may have changed meanwhile: find out what still fails, fix it and finish the task; everything asked before still holds.';

/** Lines of the last control the paused flow shows: the tests and commands that failed, not just the headline (smoke 92-2). */
const PAUSE_DETAIL_LINES = 12;

export function pauseDetails(problems: string[]): string {
  const details = problems.flatMap((problem) => problem.split('\n').slice(1)).filter((line) => /^(- |✗ )/.test(line));
  if (!details.length) return '';
  const shown = details.slice(0, PAUSE_DETAIL_LINES).map((line) => `\n  ${line}`);
  return shown.join('') + (details.length > shown.length ? `\n  … and ${details.length - shown.length} more` : '');
}

/** `text` written for the agent with its `out/` paths as the human finds them on the host (acceptance smoke, finding 10). */
export function hostPaths(text: string, outcome: Pick<SessionOutcome, 'agentOutDir' | 'outDir'>): string {
  return text.split(`${outcome.agentOutDir}/`).join(`${outcome.outDir}/`);
}

/** `git status --porcelain` as list items, which a pause shows (`pauseDetails`). */
function dirtyList(status: string): string {
  return status.split('\n').map((line) => `- ${line.trim()}`).join('\n');
}

/** A session whose commits the orchestrator verifies afterwards. */
export interface VerifiedSession<Report> {
  kind: CommittingKind;
  executor: Executor;
  scope: Omit<SessionScope, 'cwd' | 'resume' | 'attempt' | 'missingArtifactOk' | 'checks'>;
  /** Names the bundle and the checks logs: `t2`, `r3`. */
  label: string;
  parse(artifact: string): Report;
  /** A report that hands the work to a human (e.g. `spec_issue`): returned as is, nothing to verify. */
  handsOver?(report: Report): boolean;
  /** A session that hands over commits what it has first: the next one in the clone (the test author) must not find it. */
  cleanHandOver?: true;
  /** One more condition on the collected head (as the agent should be told), checked before `checks`; the report is missing when invalid. */
  verify?(head: string, report: Report | undefined, logPath: (log: string) => string): string | undefined | Promise<string | undefined>;
  /** `verify` runs the commands itself (the test gates): the control doesn't need all of `checks` green. */
  skipChecks?: boolean;
  /** Starts by resuming this earlier session with `message` instead of a fresh one. */
  resume?: { sessionId?: string; message: string };
  /** Failed controls before a human; default `checks_failing`. */
  limit?: { failures: number; reason: Pause['reason']; describe: string };
}

/** A verified session's report and the session to resume later. */
export interface VerifiedOutcome<Report> {
  report: Report;
  sessionId?: string;
}

/**
 * The code an owner (a group, the whole feature) works on: its clone, the work branch in the user's repo
 * that bundles move, and the deterministic control after each session that changes code — artifact,
 * clean tree, bundle, `checks`. What fails goes back to the same session (`--resume`), up to `checks_failing`.
 */
export class CloneWork {
  constructor(
    private readonly flow: FlowRun,
    private readonly sessions: SessionRunner,
    readonly owner: CloneOwner,
    private readonly clone: CloneState,
  ) {}

  get cwd(): string {
    if (!this.clone.clonePath) throw new Error(`clone ${this.owner.label}: no clone`);
    return this.clone.clonePath;
  }

  get baseRef(): string | undefined {
    return this.clone.baseRef;
  }

  /** The clone, made at `base` (else where the flow starts) unless it exists. */
  prepare(base?: string): string {
    if (this.clone.clone_removed) throw new Error(`clone ${this.owner.label} already removed; the work is on ${this.clone.branch}`);
    return prepareClone(this.flow, this.owner, this.clone, base);
  }

  get prepared(): boolean {
    return !!this.clone.clonePath;
  }

  /** The work branch's head: the last commit collected from the clone. */
  get head(): string | undefined {
    return this.clone.head ?? this.clone.baseRef;
  }

  async run<Report>(session: VerifiedSession<Report>): Promise<Report> {
    return (await this.runSession(session)).report;
  }

  /** `checks` that verify this owner's work: all but `none` and the known red ones. */
  get verifiedChecks(): string[] {
    const commands = checkCommands(this.flow.context.config.review);
    return commands === 'none' ? [] : commands.filter((command) => !this.knownRed.includes(command));
  }

  private get knownRed(): string[] {
    return knownRed(this.flow.state);
  }

  async runSession<Report>(session: VerifiedSession<Report>): Promise<VerifiedOutcome<Report>> {
    const { flow } = this;
    const verified = this.verifiedChecks;
    const limit = session.limit ?? {
      failures: checksFailingLimit(flow.context.config.review.stop_on),
      reason: 'checks_failing' as const,
      describe: 'limit `checks_failing: %d`',
    };
    const scope: SessionScope = { ...session.scope, cwd: this.cwd, missingArtifactOk: true, checks: verified };
    const { interrupted } = this.clone;
    const resume =
      session.resume ?? (interrupted?.kind === session.kind && interrupted.label === session.label
        ? { sessionId: interrupted.session, message: interrupted.failed_control ? FAILED_CONTROL_MESSAGE : INTERRUPTED_MESSAGE }
        : undefined);
    // kept until a run gets through: a budget stop before the session leaves it for the next one, a failed resume drops it
    const runOrRemember = async (run: Promise<SessionOutcome>) => {
      try {
        const outcome = await run;
        delete this.clone.interrupted;
        return outcome;
      } catch (error) {
        if (error instanceof Halt && (error.session || error.pause?.reason === 'error')) {
          this.clone.interrupted = error.session ? { kind: session.kind, label: session.label, session: error.session } : undefined;
          flow.save();
        }
        throw error;
      }
    };
    const resumeWith = (sessionId: string | undefined, message: string, attempt: number) =>
      runOrRemember(
        this.sessions.run(session.kind, 'headless', session.executor, {
          ...scope,
          extra: message,
          // a harness that reported no session id can't be resumed: a fresh session gets the same message
          ...(sessionId && { resume: sessionId }),
          attempt,
        }),
      );
    if (resume && !session.resume) flow.log(`! ${this.owner.label}: resuming the interrupted ${session.kind} session ${session.label}`);
    let outcome = resume ? await resumeWith(resume.sessionId, resume.message, 2) : await runOrRemember(this.sessions.run(session.kind, 'headless', session.executor, scope));
    for (let failures = 0; ; ) {
      const { report, problems } = await this.control(session, outcome, session.skipChecks ? [] : verified);
      if (!problems.length) return { report: report!, ...(outcome.sessionId && { sessionId: outcome.sessionId }) };
      failures++;
      const where = `${this.owner.label}, ${session.kind} ${session.label}`;
      if (failures >= limit.failures) {
        // `resume` gives the work back to this session, which knows what it tried
        this.clone.interrupted = outcome.sessionId ? { kind: session.kind, label: session.label, session: outcome.sessionId, failed_control: true } : undefined;
        flow.save();
        throw new Halt('paused', {
          reason: limit.reason,
          group: session.scope.group,
          message: hostPaths(
            `${where}: ${failures} failed checks after the session (${limit.describe.replace('%d', String(limit.failures))}): ${problems.map((problem) => problem.split('\n')[0]).join('; ')}${pauseDetails(problems)}`,
            outcome,
          ),
        });
      }
      flow.log(`! ${where}: the check after the session failed (${failures}/${limit.failures}); resuming the session`);
      outcome = await resumeWith(outcome.sessionId, problems.join('\n\n'), failures + (resume ? 2 : 1));
    }
  }

  /** What still blocks the session's work, as messages for the agent. */
  private async control<Report>(session: VerifiedSession<Report>, outcome: SessionOutcome, commands: string[]): Promise<{ report?: Report; problems: string[] }> {
    const problems: string[] = [];
    let report: Report | undefined;
    const file = contractFile(session.kind);
    if (outcome.artifact === undefined) {
      problems.push(`Your report \`${file}\` is missing from the output directory.`);
    } else {
      try {
        report = session.parse(outcome.artifact);
        if (session.handsOver?.(report)) {
          const dirty = session.cleanHandOver && (await this.status());
          if (!dirty) return { report, problems: [] };
          problems.push(`Uncommitted changes in the working directory: before you report, commit your work so far (a work-in-progress commit is fine) or remove it:\n${dirtyList(dirty)}`);
          return { report, problems };
        }
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        problems.push(`Your report \`${file}\` is invalid:\n${error.problems.map((problem) => `- ${problem}`).join('\n')}`);
      }
    }
    const dirty = await this.status();
    if (dirty) {
      problems.push(`Uncommitted changes in the working directory (commit them, or remove what doesn't belong):\n${dirtyList(dirty)}`);
      return { report, problems };
    }
    let head: string;
    try {
      head = await syncClone(this.flow, this.owner, this.clone, session.label);
    } catch (error) {
      problems.push(`Your commits could not be collected: ${errorMessage(error)}`);
      return { report, problems };
    }
    const unmet = await session.verify?.(head, report, (log) => this.handOverLog(log, outcome));
    if (unmet) {
      problems.push(unmet);
      return { report, problems };
    }
    const { green } = this.clone;
    if (commands.length && green?.commit === head && green.commands.join('\n') === commands.join('\n')) {
      // a session that committed nothing (a fixer who disputed every finding): the same tree, the same results
      this.flow.log(`  ${this.owner.label}, ${session.kind} ${session.label}: no code changes; checks already green on this commit`);
    } else if (commands.length) {
      const scope = { owner: this.owner.name, label: session.label };
      const runs = await rerunFailed(this.flow, this.cwd, scope, await runChecks(this.flow, this.cwd, scope, commands));
      if (!runs.every(passed)) {
        problems.push(`Checks failed:\n\n${describeFailures(runs, (log) => this.handOverLog(log, outcome))}`);
      } else {
        this.clone.green = { commit: head, commands };
        writeFileSafe(path.join(this.flow.context.workDir, checksReportName(this.owner.name)), checksReport(this.owner.name, head, runs, this.knownRed));
      }
    }
    return { report, problems };
  }

  /** A copy of a checks log in the session's `out/`, which it can read (the flow's `checks/` is outside its dirs); its path as the agent sees it. */
  private handOverLog(log: string, outcome: SessionOutcome): string {
    const name = path.basename(log);
    const copy = path.join(outcome.outDir, RUNNER_LOG_DIR, 'orchestrator', name);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(log, copy);
    return path.posix.join(outcome.agentOutDir, RUNNER_LOG_DIR, 'orchestrator', name);
  }

  /**
   * A review session; a reviewer never changes code. When HEAD or the working tree moved,
   * the clone is rebuilt from the reviewed commit and the round gets a warning.
   */
  async review(
    axis: ScopeAxis,
    executor: Executor,
    scope: Pick<SessionScope, 'group' | 'round' | 'acceptance' | 'flowFiles' | 'extra'> & { frozen?: FrozenScope },
    warn: (warning: string) => void,
  ): Promise<ReviewReport> {
    const before = await this.status();
    // the last control's results (`checks-<owner>.md`) next to the other flow files; absent when nothing ran
    const flowFiles = [...(scope.flowFiles ?? []), checksReportName(this.owner.name)];
    const expected = this.clone.head ?? this.clone.baseRef;
    // quotes are looked for in the reviewed commit, never in what the reviewer may have written into the clone
    const read = (file: string) => showFile(this.flow, commandWorkspace(this.flow, this.cwd, `git-${this.owner.name}`), expected!, file);
    const report = await this.sessions.review(axis, executor, { ...scope, flowFiles, cwd: this.cwd }, read);
    const head = await this.cloneHead();
    const after = await this.status();
    if (head !== expected || after !== before) {
      const warning = `axis ${axis} changed code in the clone (${head !== expected ? `HEAD ${head.slice(0, 12)}` : 'working tree'}); changes discarded, clone restored`;
      this.flow.log(`! ${this.owner.label}: ${warning}`);
      warn(warning);
      restartClone(this.flow, this.owner, this.clone, expected!);
    }
    return report;
  }

  /**
   * `checks` on the clean base: green results cached per base commit, red ones run again next time — after the
   * human fixed the base, the command or the environment. Returns the commands red there that no group has accepted yet.
   */
  async baseline(): Promise<CheckRun[]> {
    const commands = checkCommands(this.flow.context.config.review);
    const baseRef = this.clone.baseRef;
    if (commands === 'none' || !baseRef) return [];
    const { state } = this.flow;
    const cached = state.baselines?.[baseRef];
    if (commands.every((command) => cached?.[command] === 0)) return [];
    // a group on the same base that is computing it meanwhile shares its run
    let running = this.flow.baselineRuns.get(baseRef);
    if (!running) {
      // all of them, not only the uncached ones: a later command needs what an earlier one set up (`npm ci`)
      const scope = { owner: this.owner.name, label: 'baseline' };
      running = this.atBase(baseRef, async (cwd) => rerunFailed(this.flow, cwd, scope, await runChecks(this.flow, cwd, scope, commands)))
        .then((runs) => {
          state.baselines = { ...state.baselines, [baseRef]: Object.fromEntries(runs.filter(passed).map((run) => [run.command, 0])) };
          this.flow.save();
          return runs;
        })
        .finally(() => this.flow.baselineRuns.delete(baseRef));
      this.flow.baselineRuns.set(baseRef, running);
    }
    const runs = await running;
    return runs.filter((run) => !passed(run) && !this.knownRed.includes(run.command));
  }

  /**
   * Runs `work` in the clone while no session touched it; once one did (a resume after a `checks` edit, the
   * tests already committed), in a fresh clone at the base, removed afterwards.
   */
  private async atBase<Result>(baseRef: string, work: (cwd: string) => Promise<Result>): Promise<Result> {
    if ((this.clone.head ?? baseRef) === baseRef && !(await this.status())) return work(this.cwd);
    const basePath = path.join(this.flow.context.workDir, 'clones', `${this.owner.name}.baseline`);
    fs.rmSync(basePath, { recursive: true, force: true });
    cloneForGroup({ repoPath: this.repoPath, clonePath: basePath, branch: 'agentic-baseline', baseRef });
    try {
      return await work(basePath);
    } finally {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  }

  /**
   * Runs `work` in the clone checked out at `commit`, with the files that changed from `since` to `head` laid over
   * it as they are at `head`; then back at the branch. In the clone, not a fresh one: `compile` needs what the
   * checks installed there (`node_modules`, build caches), which git doesn't hold.
   */
  async atCommitWith<Result>(commit: string, since: string, head: string, work: (cwd: string) => Promise<Result>): Promise<Result> {
    const branch = hostGit(this.cwd, ['symbolic-ref', '--short', 'HEAD']);
    const changed = hostGit(this.cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=AM', since, head]).split('\n').filter(Boolean);
    hostGit(this.cwd, ['checkout', '--quiet', '--detach', commit]);
    try {
      if (changed.length) hostGit(this.cwd, ['checkout', head, '--', ...changed]);
      return await work(this.cwd);
    } finally {
      hostGit(this.cwd, ['checkout', '--quiet', '--force', branch]);
      hostGit(this.cwd, ['clean', '--quiet', '--force', '-d']);
    }
  }

  /** Lines the work branch changed since `commit` (an earlier round's). */
  changedSince(commit: string): ChangedLines {
    return parseChangedLines(changedSince(this.flow, this.owner, this.clone, commit));
  }

  diffLines(commit: string, base?: string): number {
    return diffLines(this.flow, this.owner, this.clone, commit, base);
  }

  diffText(commit: string, base?: string): string {
    return diffText(this.flow, this.owner, this.clone, commit, base);
  }

  /** The user's repo the work branch lives in. */
  get repoPath(): string {
    return resolveRepo(this.clone.repo ?? this.owner.repo, this.flow.state.origin);
  }

  changedFiles(commit: string, base?: string): ChangedFile[] {
    return changedFiles(this.flow, this.owner, this.clone, commit, base);
  }

  sync(label: string): Promise<string> {
    return syncClone(this.flow, this.owner, this.clone, label);
  }

  snapshot(round: number): string {
    return snapshotRound(this.flow, this.owner, this.clone, round);
  }

  restartAt(commit: string): void {
    restartClone(this.flow, this.owner, this.clone, commit);
  }

  remove(): void {
    removeClone(this.flow, this.owner, this.clone);
  }

  discard(quiet = false): void {
    discardClone(this.flow, this.owner, this.clone, quiet);
  }

  private async status(): Promise<string> {
    return cloneGit(this.flow, commandWorkspace(this.flow, this.cwd, `git-${this.owner.name}`), ['status', '--porcelain', '--untracked-files=all']);
  }

  /** The clone's HEAD, which can be ahead of `head`: a session that hands over is not collected. */
  async cloneHead(): Promise<string> {
    return cloneGit(this.flow, commandWorkspace(this.flow, this.cwd, `git-${this.owner.name}`), ['rev-parse', 'HEAD']);
  }
}
