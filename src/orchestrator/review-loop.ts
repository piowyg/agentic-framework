import path from 'node:path';
import type { Executor, GateName } from '../config/types.js';
import { parseFix } from '../contracts/index.js';
import { writeFileSafe } from '../fsutil.js';
import { plural } from '../plural.js';
import type { FixArtifact } from '../contracts/schemas.js';
import { ArtifactError } from './artifacts.js';
import type { CloneWork } from './clone-work.js';
import { escalatedFixer } from './executors.js';
import type { GateKeeper, GateScope } from './gatekeeper.js';
import { isOpen, type ReviewReport } from '../review/findings.js';
import { stopReasons } from '../review/stop.js';
import { SCOPE_MARGIN, type ChangedLines, type FrozenScope } from '../review/scope.js';
import { sourceReads, sourceReadsWarning } from '../review/signals.js';
import { Halt, type FlowRun } from './run.js';
import { reportName, type SessionRunner } from './session-runner.js';
import {
  lastRound,
  openFindings,
  pendingDisputes,
  reviewedRound,
  reviewSummary,
  roundNumber,
  roundRecord,
  type FindingRecord,
  type ReviewLoopState,
  type SetAside,
  type SetAsideKind,
  type ScopeAxis,
} from './state.js';

/** What a review loop works on: one group, or the whole feature before the `final` gate. */
export interface ReviewScope {
  /** Absent for the whole feature. */
  group?: string;
  gate: Extract<GateName, 'group' | 'final'>;
  /** Names the scope for the human: `group g1`, `feature`. */
  label: string;
  state: ReviewLoopState;
  axes: Array<[ScopeAxis, Executor]>;
  /** The spec axis must assess each; empty for the whole feature. */
  acceptance: string[];
  fixer: Executor;
  /** The scope's clone and work branch: where its sessions run, round snapshots, rollback. */
  work: CloneWork;
  /** Where the scope's diff starts, when not at its clone's base (the final clone starts at the merged groups). */
  base?: string;
  /** Flow files the reviewers read besides the ticket, spec and plan (the whole feature: the groups' reports). */
  flowFiles?: string[];
  /** Why the scope's gate asks even when the preset skips it; checked when the loop reaches the gate. */
  forceGate?(): string | undefined;
  /** Lines the scope's gate shows above the review summary (e.g. unverified, known red checks). */
  notes?(): string[];
  /** Called when a decision reopens the loop, before the state is saved. */
  reopened?(): void;
  /** One more condition on the fixer's commits (`VerifiedSession.verify`), given the findings it fixed. */
  verifyFix?(head: string, findings: FindingRecord[]): string | undefined;
}

/**
 * Persisted phases: review → (fix → review)* → decide → done, then the scope's gate.
 * Rounds accumulate across resume and retry; rollback drops the rounds after the one it goes back to.
 * Each round reviews the commit snapshotted at its start; fixes go through the control after the session (`CloneWork`).
 * The fixer may set findings aside (`set_aside`): disputed ones stop the loop after the next round for a human,
 * disputed weights and unreproduced defects only go to the gate report.
 * Round 2+ has a frozen scope: the reviewers judge only what changed since the previous round (src/review/scope.ts).
 * After each round the `stop_on` triggers (src/review/stop.ts) may send the loop to a human before the round limit.
 */
export class ReviewLoop {
  constructor(
    private readonly flow: FlowRun,
    private readonly sessions: SessionRunner,
    private readonly gatekeeper: GateKeeper,
    private readonly scope: ReviewScope,
  ) {}

  /** Returns once nothing blocking is open or a human accepted the findings. */
  async run(): Promise<void> {
    const { flow, scope } = this;
    const { state, group } = scope;
    const { review } = flow.context.config;
    state.phase ??= 'review';
    state.round_limit ??= roundNumber(state) + review.max_rounds;
    for (;;) {
      switch (state.phase) {
        case 'review': {
          const round = roundNumber(state) + 1;
          if (state.round_reports?.round !== round) {
            const commit = scope.work.snapshot(round);
            const signal = sourceReadsWarning(sourceReads(scope.work.diffText(commit, scope.base)));
            state.round_reports = { round, commit, reports: {}, diff_lines: scope.work.diffLines(commit, scope.base), ...(signal && { warnings: [signal] }) };
          }
          const inProgress = state.round_reports;
          const done = inProgress.reports;
          const warn = (warning: string) => (inProgress.warnings = [...(inProgress.warnings ?? []), warning]);
          const since = lastRound(state);
          const changed = since?.commit ? scope.work.changedSince(since.commit) : undefined;
          for (const [axis, executor] of scope.axes) {
            if (done[axis]) continue;
            const reviewer = `${executor.harness}:${executor.model}`;
            if (inProgress.commit && this.alreadyReviewed(axis, reviewer, inProgress.commit)) {
              // the same model judging the same code again only adds noise
              done[axis] = this.carriedReport(axis);
              inProgress.skipped = [...(inProgress.skipped ?? []), axis];
              flow.log(`${scope.label}: axis ${axis} skipped; no new diff since its last review (${reviewer})`);
              flow.save();
              continue;
            }
            const frozen = since?.commit && changed ? this.frozenScope(axis, since.round, changed) : undefined;
            const reviewScope = frozen ? frozenScopeText(frozen, since!.commit!, state.set_aside ?? []) : `Review scope: the commits of this ${group ? 'group' : 'feature'} — \`git diff ${scope.base ?? scope.work.baseRef}..HEAD\`.`;
            const extra = [reviewScope, axis === 'standards' ? this.signalsText(inProgress.commit) : ''].filter(Boolean).join('\n\n');
            done[axis] = await scope.work.review(axis, executor, { group, round, acceptance: scope.acceptance, flowFiles: scope.flowFiles, extra, frozen }, warn);
            inProgress.reviewers = { ...inProgress.reviewers, [axis]: reviewer };
            flow.save();
          }
          const specIssue = Object.values(done).find((report) => report.specIssue)?.specIssue;
          if (specIssue) {
            // the spec gets fixed before resume, so the whole round is reviewed again
            delete state.round_reports;
            flow.save();
            throw new Halt('paused', { reason: 'spec_issue', group, message: specIssue });
          }
          state.review = { rounds: [...(state.review?.rounds ?? []), roundRecord(round, done, inProgress)] };
          delete state.round_reports;
          const blocking = openFindings(state).length;
          const disputes = this.stopsOnDisputes() ? pendingDisputes(state).length : 0;
          // a fixer that escalated or disputed already said why nothing changed
          const triggers = flow.context.config.review.stop_on.filter((trigger) => trigger !== 'no_progress' || (!state.escalated && !pendingDisputes(state).length));
          const reasons = stopReasons(triggers, state).map((reason) => `${reason.trigger}: ${reason.detail}`);
          if (reasons.length) state.stop_reasons = reasons;
          if (!blocking) delete state.escalated;
          const stop = round >= state.round_limit! || state.escalated || disputes || reasons.length;
          state.phase = !blocking && !disputes && !reasons.length ? 'done' : stop ? 'decide' : 'fix';
          flow.save();
          flow.emit({ type: 'review_round', group, round, blocking });
          break;
        }
        case 'decide': {
          const round = roundNumber(state);
          const { escalated } = state;
          const disputes = this.stopsOnDisputes() ? pendingDisputes(state) : [];
          const triggered = state.stop_reasons?.length;
          // the fixer's own escalations and disputes are questions for a human, not for a stronger model
          const stronger = !escalated && !disputes.length ? this.fixer((state.escalation ?? 0) + 1) : undefined;
          const decision = await this.gatekeeper.onStop(scope.gate, this.decisionMessage(disputes), ['continue', 'retry', 'stop', 'abort'], {
            ...this.gateScope(),
            canEscalate: !!stronger,
          });
          delete state.escalated;
          delete state.stop_reasons;
          if (decision.action === 'escalate') {
            state.escalation = (state.escalation ?? 0) + 1;
            state.round_limit = round + 1;
            state.phase = 'fix';
            flow.log(`${scope.label}: on_stop escalate; a fixer round on ${stronger!.harness}:${stronger!.model}/${stronger!.effort}`);
            flow.save();
          } else if (decision.action === 'continue') {
            for (const dispute of disputes) dispute.ruling = 'accepted';
            if (disputes.length && !escalated && !triggered && openFindings(state).length && round < state.round_limit!) {
              // only the disputes stopped the loop: the rest of the findings still go to the fixer
              state.phase = 'fix';
            } else {
              // accepting despite findings is the scope's gate decision
              const why = new Map(escalated?.findings.map((entry) => [entry.id, `fixer escalation: ${entry.reason}`]));
              const open = openFindings(state);
              if (open.length) state.accepted = open.map((finding) => ({ id: finding.id, reason: why.get(finding.id) ?? 'let through by decision' }));
              state.gate = 'passed';
              state.phase = 'done';
            }
            flow.save();
          } else if (decision.action === 'retry') {
            for (const dispute of disputes) dispute.ruling = 'fix';
            this.reopen(decision.note);
          } else if (decision.action === 'rollback') {
            this.rollback(decision.round);
          }
          break;
        }
        case 'fix': {
          const open = openFindings(state);
          const nits = (state.review?.rounds.at(-1)?.findings ?? []).filter((finding) => finding.severity === 'nit');
          const round = roundNumber(state);
          const ruled = (state.set_aside ?? []).filter((entry) => entry.ruling === 'fix').map((entry) => entry.finding.id);
          const report = await scope.work.run({
            kind: 'fix',
            executor: this.fixer(state.escalation ?? 0)!,
            label: `r${round}-fix`,
            parse: (text) => withoutRedisputes(parseFix(text), ruled),
            verify: (head: string, fix: FixArtifact | undefined) =>
              unansweredFindings(open, fix) ?? unchangedFix(head, lastRound(state)?.commit, fix) ?? scope.verifyFix?.(head, open),
            scope: {
              group,
              round,
              extra: [
                open.length ? `Blocking findings to fix:\n${JSON.stringify(open, null, 2)}` : '',
                ruled.length ? `A human ruled that ${ruled.join(', ')} must be fixed: you may not dispute them again.` : '',
                nits.length ? `Nits (fix only in lines you change anyway):\n${JSON.stringify(nits, null, 2)}` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          });
          this.setAside(report, open, round);
          const escalated = report.findings.flatMap((entry) =>
            entry.status === 'escalated' ? [{ id: entry.id, reason: entry.reason! }] : [],
          );
          // a fix beyond a local change (e.g. the whole feature missing) is a human's call after this round,
          // which still reviews what the fixer did change
          if (escalated.length) state.escalated = { fixRound: roundNumber(state), findings: escalated };
          state.phase = 'review';
          flow.save();
          break;
        }
        case 'done':
          this.writeSummary();
          return;
      }
    }
  }

  /** The scope's preset gate. `retry` and `rollback` reopen the loop and return false. */
  async gate(): Promise<boolean> {
    const { state } = this.scope;
    if (state.gate === 'passed') return true;
    const forced = this.scope.forceGate?.();
    const decision = await this.gatekeeper.gate(this.scope.gate, () => ({ text: this.summary() }), { ...this.gateScope(), ...(forced && { forced }) });
    if (decision.action === 'retry') {
      this.reopen(decision.note);
      return false;
    }
    if (decision.action === 'rollback') {
      this.rollback(decision.round);
      return false;
    }
    state.gate = 'passed';
    this.flow.save();
    return true;
  }

  /** Persisted before the fix, so an interruption resumes fix → review, not the decision. */
  private reopen(note: string): void {
    const { flow, scope } = this;
    flow.note(flow.state.stage, note, scope.group);
    this.reopenFrom(roundNumber(scope.state));
  }

  /** The code goes back to what `round` reviewed; its findings go to the fixer again. */
  private rollback(round: number): void {
    const { flow, scope } = this;
    const rounds = scope.state.review?.rounds ?? [];
    const commit = rounds.find((record) => record.round === round)?.commit;
    if (!commit) throw new Error(`${scope.label}: round ${round} has no commit; can't roll back`);
    scope.work.restartAt(commit);
    scope.state.review = { rounds: rounds.filter((record) => record.round <= round) };
    // what the fixer set aside from that round on is undone together with its code
    if (scope.state.set_aside) scope.state.set_aside = scope.state.set_aside.filter((entry) => entry.fixRound < round);
    delete scope.state.round_reports;
    flow.log(`${scope.label}: rolled back to round ${round}`);
    this.reopenFrom(round);
  }

  private reopenFrom(round: number): void {
    const { state } = this.scope;
    state.phase = 'fix';
    state.round_limit = round + this.flow.context.config.review.max_rounds;
    delete state.gate;
    delete state.accepted;
    this.scope.reopened?.();
    this.flow.save();
  }

  /** The axis's last actual review was of `commit`, by the same harness and model. */
  private alreadyReviewed(axis: ScopeAxis, reviewer: string, commit: string): boolean {
    const rounds = this.scope.state.review?.rounds ?? [];
    const last = rounds.findLast((record) => record.reviewers?.[axis]);
    return last?.commit === commit && last.reviewers![axis] === reviewer;
  }

  /** A skipped axis's findings of the last round stand as they were. */
  private carriedReport(axis: ScopeAxis): ReviewReport {
    const last = lastRound(this.scope.state);
    const findings = (last?.findings ?? [])
      .filter((finding) => finding.axis === axis)
      .map(({ axis: _axis, fingerprint: _fingerprint, ...finding }) => ({ ...finding, carried_from: finding.carried_from ?? last!.round }));
    return { findings, blocking: findings.filter(isOpen) };
  }

  private frozenScope(axis: ScopeAxis, sinceRound: number, changed: ChangedLines): FrozenScope {
    const { state } = this.scope;
    return {
      sinceRound,
      previous: openFindings(state).filter((finding) => finding.axis === axis),
      changed,
      setAside: new Set((state.set_aside ?? []).filter((entry) => entry.ruling !== 'fix').map((entry) => entry.finding.fingerprint)),
    };
  }

  private stopsOnDisputes(): boolean {
    return this.flow.context.config.review.stop_on.includes('disputed');
  }

  /**
   * The fix report's verdicts on the findings the fixer got: whatever isn't fixed or escalated leaves the loop.
   * A fixed finding that had been set aside (a human ruled `fix`) is back in the loop like any other.
   */
  private setAside(report: FixArtifact, open: FindingRecord[], round: number): void {
    const { state } = this.scope;
    const byId = new Map(open.map((finding) => [finding.id, finding]));
    const reviewed = lastRound(state);
    const fixed = report.findings.flatMap((entry) => (entry.status === 'fixed' && byId.get(entry.id) ? [byId.get(entry.id)!.fingerprint] : []));
    if (reviewed && fixed.length) reviewed.fixed = fixed;
    for (const entry of report.findings) {
      const finding = byId.get(entry.id);
      if (!finding || entry.status === 'escalated') continue;
      const kept = (state.set_aside ?? []).filter((setAside) => setAside.finding.fingerprint !== finding.fingerprint);
      const kind: SetAsideKind | undefined =
        entry.status === 'not_reproduced' ? 'not_reproduced' : entry.status === 'disputed' ? (entry.disputed_on === 'severity' ? 'severity' : 'disputed') : undefined;
      state.set_aside = kind
        ? [...kept, { kind, finding, reason: entry.reason!, fixRound: round, ...(entry.regression_test && { regression_test: entry.regression_test }) }]
        : kept;
    }
    if (!state.set_aside?.length) delete state.set_aside;
  }

  /** The diff's signals for the standards reviewer to judge: hints the orchestrator found, not findings. */
  private signalsText(commit: string | undefined): string {
    if (!commit) return '';
    const reads = sourceReads(this.scope.work.diffText(commit, this.scope.base));
    if (!reads.length) return '';
    return [
      'The orchestrator found test lines that read production source as a file — check them against AG-TQ-05 (a test runs the code, it never reads it as text):',
      ...reads.map((read) => `- ${read.file}:${read.line}: ${read.code}`),
    ].join('\n');
  }

  /** The fixer `steps` rungs up `review.escalation`; undefined past the top. */
  private fixer(steps: number): Executor | undefined {
    const { context } = this.flow;
    return steps ? escalatedFixer(context.config, this.scope.fixer, steps, context.catalog) : this.scope.fixer;
  }

  private decisionMessage(disputes: SetAside[]): string {
    const { state, label, group } = this.scope;
    const round = roundNumber(state);
    // a disputed finding is out of the open ones, not gone: the gate is about it
    const open = plural(openFindings(state).length, 'open blocking finding', 'open blocking findings');
    const disputed = disputes.length ? ` and ${disputes.length} disputed` : '';
    const blocking = `${open}${disputed} after ${plural(round, 'round', 'rounds')}`;
    const { escalated } = state;
    const climbed = state.escalation ? this.fixer(state.escalation) : undefined;
    const reasons = [
      climbed && `fixer already escalated (on_stop) to ${climbed.harness}:${climbed.model}/${climbed.effort}`,
      escalated && `fixer escalated ${escalated.findings.map((entry) => `${entry.id} (${entry.reason})`).join('; ')}`,
      disputes.length && `fixer disputed ${disputes.map((entry) => `${entry.finding.id} (${entry.reason})`).join('; ')}`,
      ...(state.stop_reasons ?? []).map((reason) => `stop_on ${reason}`),
    ].filter(Boolean);
    const fixRounds = [...new Set([escalated?.fixRound, ...disputes.map((entry) => entry.fixRound)].filter((value) => value !== undefined))];
    const files = [...fixRounds.map((fixRound) => reportName('fix', group, fixRound)), this.reports()].join(', ');
    if (!reasons.length) return `${label}: ${blocking} (limit ${state.round_limit}); see ${files}`;
    const help = disputes.length ? '\ncontinue = accept the dispute; fix with a note = the fixer must fix it (no right to dispute again)' : '';
    return `${label}: ${reasons.join('; ')}; ${blocking}; see ${files}${help}`;
  }

  private gateScope(): GateScope {
    return { group: this.scope.group, rollbackRounds: this.rollbackRounds() };
  }

  /** Earlier rounds with a recorded commit; the last round's code is the current one. */
  private rollbackRounds(): number[] {
    const rounds = this.scope.state.review?.rounds ?? [];
    return rounds.slice(0, -1).flatMap((record) => (record.commit ? [record.round] : []));
  }

  private summary(): string {
    const { state, label } = this.scope;
    const warnings = (lastRound(state)?.warnings ?? []).map((warning) => `⚠ ${warning}`);
    return [
      ...(this.scope.notes?.() ?? []),
      ...warnings,
      ...setAsideLines(state.set_aside ?? []),
      `${label}: ${reviewSummary(state)}${roundNumber(state) ? ` — zobacz ${this.reports()}` : ''}`,
    ].join('\n');
  }

  /**
   * `review-summary-<group>.md` for the final reviewer: what the group's loop ended with, including what never
   * reached the fixer (set aside, out of scope) — the round reports alone don't say how a human ruled.
   */
  private writeSummary(): void {
    const { state, label, group } = this.scope;
    if (!group) return;
    const findings = lastRound(state)?.findings ?? [];
    const outOfScope = findings.filter((finding) => finding.verdict?.out_of_scope);
    const accepted = (state.accepted ?? []).map((entry) => {
      const finding = findings.find((candidate) => candidate.id === entry.id);
      return `- ${entry.id}${finding?.file ? ` ${finding.file}:${finding.line}` : ''} — ${finding?.message ?? ''} (${entry.reason})`;
    });
    const lines = [
      `# Review ${label}`,
      '',
      reviewSummary(state),
      ...(accepted.length ? ['', 'Open, let through by a human:', ...accepted] : []),
      ...(state.set_aside?.length ? ['', ...setAsideLines(state.set_aside)] : []),
      ...(outOfScope.length
        ? ['', 'Out of scope (not sent to the fixer):', ...outOfScope.map((finding) => `- ${finding.id} ${finding.file}:${finding.line} — ${finding.message}`)]
        : []),
    ];
    writeFileSafe(path.join(this.flow.context.workDir, reviewSummaryName(group)), lines.join('\n') + '\n');
  }

  /** Each axis's latest report file. */
  private reports(): string {
    const { state, group } = this.scope;
    return this.scope.axes.map(([axis]) => reportName(`review-${axis}`, group, reviewedRound(state, axis))).join(', ');
  }
}

export function reviewSummaryName(group: string): string {
  return `review-summary-${group}.md`;
}

const SET_ASIDE_LABEL: Record<SetAsideKind, string> = {
  disputed: 'disputed by the fixer',
  severity: 'weight disputed',
  not_reproduced: 'not reproduced',
};

/** The gate report of what left the loop without a fix. */
export function setAsideLines(setAside: SetAside[]): string[] {
  const shown = setAside.filter((entry) => entry.ruling !== 'fix');
  if (!shown.length) return [];
  return [
    'Set aside by the fixer:',
    ...shown.map((entry) => {
      const kind = entry.kind === 'disputed' ? `${SET_ASIDE_LABEL.disputed}${entry.ruling === 'accepted' ? ' (accepted)' : ' (no ruling)'}` : SET_ASIDE_LABEL[entry.kind];
      const where = entry.finding.file ? ` ${entry.finding.file}:${entry.finding.line}` : '';
      const test = entry.regression_test ? ` (test: ${entry.regression_test})` : '';
      return `- ${entry.finding.id}${where} — ${kind}${test}: ${entry.reason}`;
    }),
  ];
}

/** A finding a human ruled must be fixed can't be disputed again: the session is resumed with this problem. */
function withoutRedisputes(report: FixArtifact, ruled: string[]): FixArtifact {
  const redisputed = report.findings.filter((entry) => entry.status === 'disputed' && ruled.includes(entry.id)).map((entry) => entry.id);
  if (redisputed.length) {
    throw new ArtifactError('fix-report.json', [`${redisputed.join(', ')}: a human ruled these must be fixed — fix them or escalate, do not dispute them again`]);
  }
  return report;
}

/** What a reviewer of round 2+ is told: the diff since the previous round and what to answer about its open findings. */
function frozenScopeText(frozen: FrozenScope, since: string, setAside: SetAside[]): string {
  const compact = (finding: FindingRecord | FrozenScope['previous'][number]) => ({
    id: finding.id,
    file: finding.file,
    line: finding.line,
    quote: finding.quote,
    basis: finding.basis,
    message: finding.message,
  });
  const decided = setAside.filter((entry) => entry.ruling !== 'fix');
  return [
    `Frozen scope: this round reviews only what changed since round ${frozen.sinceRound} — \`git diff ${since}..HEAD\`.`,
    frozen.previous.length
      ? `Open findings of round ${frozen.sinceRound} on your axis — give each a verdict in \`previous\` (\`fixed\` | \`not_fixed\`) and do not repeat them in \`findings\`:\n${JSON.stringify(frozen.previous.map(compact), null, 2)}`
      : `Round ${frozen.sinceRound} left no open findings on your axis: \`previous\` stays empty.`,
    `New blocking findings are regressions or incomplete fixes in the changed lines (±${SCOPE_MARGIN}); anything else is rejected as out of scope.`,
    decided.length ? `Already decided — do not report again:\n${decided.map((entry) => `- ${entry.finding.file}:${entry.finding.line} ${entry.finding.message}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A fixer that leaves some of its findings without a status (live: it answers the ones it fixed). */
function unansweredFindings(open: FindingRecord[], fix: FixArtifact | undefined): string | undefined {
  const answered = new Set(fix?.findings.map((entry) => entry.id));
  const missing = open.filter((finding) => !answered.has(finding.id)).map((finding) => finding.id);
  if (!fix || !missing.length) return undefined;
  return `Your report gives no status for ${missing.join(', ')}: add one for every blocking finding you were given — \`fixed\`, \`not_reproduced\`, \`disputed\` or \`escalated\`.`;
}

/** A fixer that calls findings fixed without committing anything (never caught by the next round: it has no new diff to review). */
function unchangedFix(head: string, reviewed: string | undefined, fix: FixArtifact | undefined): string | undefined {
  const fixed = fix?.findings.filter((entry) => entry.status === 'fixed').map((entry) => entry.id) ?? [];
  if (!fixed.length || head !== reviewed) return undefined;
  return `You report ${fixed.join(', ')} as fixed, but you committed no change since the review. Fix them in the code and commit, or report their real status.`;
}
