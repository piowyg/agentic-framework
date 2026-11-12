import fs from 'node:fs';
import path from 'node:path';
import type { Autonomy, GateName, ReviewAxis } from '../config/types.js';
import { errorMessage } from '../errors.js';
import { writeFileSafe } from '../fsutil.js';
import type { MergeArtifact, WriteTestsArtifact } from '../contracts/schemas.js';
import type { LineCounts } from '../publish/size.js';
import { fingerprint, isOpen, type Finding, type ReviewReport } from '../review/findings.js';

/** Bump with a new entry in `MIGRATIONS` whenever the persisted shape changes. */
export const STATE_VERSION = 4;

type RawState = Record<string, unknown>;
type Migration = (raw: RawState) => RawState;

/** `MIGRATIONS[k]` turns a vK state into vK+1. */
const MIGRATIONS: Record<number, Migration> = {
  1: migrateReviewCountersToRounds,
  2: migrateCwdToOrigin,
  3: migrateFinalBlockingToLoop,
};

export const STAGES = ['ticket', 'spec', 'breakdown', 'implement', 'final-review'] as const;
export type StageId = (typeof STAGES)[number];

/** The `group` and `final` gates belong to their review loops, inside `implement` and `final-review`. */
export const STAGE_GATE: Record<StageId, GateName | undefined> = {
  ticket: 'ticket',
  spec: 'spec',
  breakdown: 'breakdown',
  implement: undefined,
  'final-review': undefined,
};

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type FlowStatus = 'running' | 'paused' | 'done' | 'aborted' | 'failed';
export type Entry = 'new' | 'pick';

export interface StageState {
  status: StepStatus;
  gate?: 'passed';
  /** The stage's agent session returned; resume validates its artifact instead of rerunning it. */
  session_done?: boolean;
  /** The stage's last interactive session; when it ended without a valid artifact, resume may continue it. */
  session_id?: string;
  started_at?: string;
  finished_at?: string;
}

/** Persisted so `resume` continues the review loop exactly where it stopped. */
export type ReviewPhase = 'review' | 'fix' | 'decide' | 'done';

/** A reviewer of a review scope: the configured axes for a group, `final` for the whole feature. */
export type ScopeAxis = ReviewAxis | 'final';

export interface FindingRecord extends Finding {
  /** Missing only in rounds migrated from v1, which didn't record the axis. */
  axis?: ScopeAxis;
  /** Identity across rounds, for `repeated_finding`. */
  fingerprint: string;
}

/** One finished review round; the history feeds `repeated_finding`, `no_progress`, `rejection_rate` and rollback. */
export interface RoundRecord {
  round: number;
  finished_at: string;
  /** Every finding of the round, nits included. */
  findings: FindingRecord[];
  /**
   * The reviewed commit, also kept as `refs/agentic/<slug>/<owner>/r<round>` in the user's repo; rollback restarts
   * the scope's clone from it. Only rounds with a commit can be rolled back to.
   */
  commit?: string;
  /** Fingerprints of this round's findings the fixer reported fixed, for `repeated_finding`. */
  fixed?: string[];
  /** E.g. a reviewer that changed the code (its changes were discarded). */
  warnings?: string[];
  /** Who reviewed the round's commit per axis (`harness:model`); an axis skipped for want of a new diff is absent. */
  reviewers?: Partial<Record<ScopeAxis, string>>;
  /** Axes not run: no new diff since their last review by the same model; their findings were carried over. */
  skipped?: ScopeAxis[];
  /** Lines added and deleted from the scope's base to `commit`, for `diff_growth`. */
  diff_lines?: number;
  /** Migrated from v1: only the open blocking findings survived, nits are lost. */
  migrated?: true;
}

/** A review loop's progress — of a group, or of the whole feature (`final_review`). */
export interface ReviewLoopState {
  phase?: ReviewPhase;
  /** Round after which the loop asks a human; moved forward on retry and rollback. */
  round_limit?: number;
  /** Finished rounds, oldest first; the last one's blocking findings are the fixer's input. */
  review?: { rounds: RoundRecord[] };
  /** Axes of the round in progress that already returned, so a pause between axes doesn't pay twice. */
  round_reports?: {
    round: number;
    commit?: string;
    reports: Partial<Record<ScopeAxis, ReviewReport>>;
    warnings?: string[];
    reviewers?: Partial<Record<ScopeAxis, string>>;
    skipped?: ScopeAxis[];
    diff_lines?: number;
  };
  /** The scope's gate (`group` / `final`) passed, or a human accepted the findings at the decision. */
  gate?: 'passed';
  /** Findings the fixer handed to a human instead of fixing; the round after the fix ends at the decision, which clears them. */
  escalated?: { fixRound: number; findings: Array<{ id: string; reason: string }> };
  /** Rungs of `review.escalation` the fixer went up (`on_stop: escalate`); its later rounds run there. */
  escalation?: number;
  /** `stop_on` triggers the last round set off (`trigger: detail`); the decision clears them. */
  stop_reasons?: string[];
  /** Findings the fixer took out of the loop; they never go to a fixer again unless a human rules `fix`. */
  set_aside?: SetAside[];
  /** Open findings a human let through at the decision, with why they stopped the loop; reopening clears them. */
  accepted?: Array<{ id: string; reason: string }>;
}

/**
 * `disputed`: the fixer rejects the finding — the loop stops after the next round for a human (`stop_on: disputed`).
 * `severity`: the fixer disputes only its weight; `not_reproduced`: the defect's regression test passes on the
 * current code. Both only go to the gate report.
 */
export type SetAsideKind = 'disputed' | 'severity' | 'not_reproduced';

export interface SetAside {
  kind: SetAsideKind;
  /** The finding as the fixer got it; a re-report with the same fingerprint stays out of the loop. */
  finding: FindingRecord;
  reason: string;
  /** The round whose findings the fixer worked on. */
  fixRound: number;
  regression_test?: string;
  /** A human's ruling on a `disputed` finding: accepted stays out, `fix` goes back to the fixer, who may not dispute it again. */
  ruling?: 'accepted' | 'fix';
}

/** Set when the clone is made: `tasks.yaml` repo name, the work branch, where it branched off and the clone. */
export interface CloneState {
  repo?: string;
  branch?: string;
  baseRef?: string;
  clonePath?: string;
  /** The work branch's head in the user's repo: the last commit a bundle brought back. */
  head?: string;
  /** The last commit the control found green, and the commands it ran: a session that leaves it unchanged isn't checked again. */
  green?: { commit: string; commands: string[] };
  /** The work is on `branch` and the clone is gone; it is never made again. */
  clone_removed?: true;
  /** Merging the predecessors' branches into the owner's base (`BranchChain`). */
  chain?: ChainState;
  /**
   * A session stopped midway, its uncommitted work left in the clone: the next run of the same session resumes it
   * instead of a fresh one that would find the changes unannounced (smoke 92-5).
   */
  interrupted?: { kind: string; label: string; session: string; failed_control?: true };
}

export interface ChainState {
  /** Groups merged so far, in plan order; the chain starts at the first one's head. */
  merged: string[];
  /** Their merge so far. */
  commit: string;
  /** The next merge stopped on conflicts: the merge session's report, or the human's own clone. */
  conflict?: { from: string; report?: MergeArtifact; manual?: string };
}

export interface GroupState extends ReviewLoopState, CloneState {
  status: StepStatus;
  tasks: Record<string, StepStatus>;
  /** Why the group is waiting for `resume`; other groups keep going meanwhile. Cleared when it restarts. */
  blocked?: Pause;
  /** Why the group failed (`status: 'failed'`, e.g. `on_stop: fail`); its dependents never start. */
  failure?: Pause;
  /** `checks` red already on the base that a human accepted at this group's question: they don't count anywhere in the flow (`knownRed`). */
  known_red?: string[];
  /** The group's tests from `write-tests`, once through the red gate. */
  write_tests?: WriteTestsState;
  /** A task whose `test_issue` the test author upheld and a human let stand: a second one goes straight to the human. */
  upheld_tests?: string[];
  /**
   * A `test_issue` its author hasn't answered yet: after a pause the resume goes back to the author, not to a new
   * implementer, who would find the author's half-done fix in frozen files. `since`: the clone's HEAD before the answer;
   * `session`: the implementer's, resumed with the answer.
   */
  open_test_issue?: { task: string; issue: string; since: string; session?: string };
  /**
   * An implementer that handed its task to a human (`spec_issue`, an upheld test questioned again), its work in
   * progress committed in the clone: `resume` goes back to that session, told what it reported, not to a new one that
   * would find the earlier attempt unannounced.
   */
  handed_over?: { task: string; issue: string; session?: string };
  /** Measured once the group is done. */
  size?: GroupSize;
}

/** A finished group's diff as `publish.size` counts it; `warning`: a threshold crossed that the plan's estimate didn't. */
export interface GroupSize extends LineCounts {
  warning?: string;
}

export interface WriteTestsState {
  report: WriteTestsArtifact;
  /** Blob of each test file at the red gate; implementers and fixers leave them so. */
  frozen: Record<string, string>;
  /** The work branch's head when they were frozen: where an agent restores them from. */
  commit: string;
  /**
   * The head of the first red gate: tests and stubs, no implementation. A test fixed on a `test_issue` is red-gated
   * there, since by then the implementer may have committed code that makes it pass. Absent: `commit`.
   */
  red_base?: string;
  /** The author's session, resumed when an implementer reports a `test_issue`. */
  session?: string;
  /** For the group's gate: how far the red gate could check the tests. */
  warnings?: string[];
}

/** Where the flow was started; groups resolve their repos against it and `resume` must run from it. */
export interface FlowOrigin {
  /** The git repo the flow was started in (outside git: the start directory). */
  repoRoot: string;
  workspaceRoot?: string;
}

/** The branch the PR goes into, chosen when the flow starts. */
export interface FlowTarget {
  branch: string;
  /** Its `origin` tip the flow's first groups start at; `publish` moves it after a rebase onto a newer one. */
  commit: string;
}

export interface PublishedState {
  /** The pushed branch on `origin` that holds the whole feature (a stack's top PR). */
  branch: string;
  /** The branch the feature goes into (a stack's lowest PR). */
  base: string;
  /** The pushed commit. */
  head: string;
  /** The PR to review first: the only one, or a stack's lowest. */
  url?: string;
  at: string;
  /** A stack: one PR per group, bottom first; each goes into the one before it. */
  stack?: PublishedPullRequest[];
  /**
   * The branch of the lowest PR as the forge last took it (the one to review first). Lags behind `stack` when a
   * publish failed before that PR opened, so the retry still sees which PR became the lowest.
   */
  lowest?: string;
  /** When `agentic restack` last rebuilt the stack: from then on the stack is updated by `restack`, not `publish`. */
  restacked?: string;
}

export interface PublishedPullRequest {
  group: string;
  branch: string;
  base: string;
  head: string;
  url?: string;
  /** Its title as published (`<ticket> (k/n): <group>`): `restack` keeps it. Absent in states from before it. */
  title?: string;
  /** Groups whose review notes its description carries (`StackPosition.notesOf`). Absent in states from before it. */
  notes_of?: string[];
  /** Merged into the target (`agentic restack` saw it): no longer pushed, still listed in the stack's PR descriptions. */
  merged?: true;
}

/**
 * `agentic restack` in progress: the open PRs' branches rebuilt bottom first, each kept until the push. A rerun reuses
 * an entry whose inputs (`onto`, `upstream`, `source`) are unchanged, so a stop at the `merge` gate continues there.
 */
export interface RestackState {
  branches: RestackBranch[];
}

export interface RestackBranch {
  group: string;
  /** The PR's branch on `origin`. */
  branch: string;
  /** Rebased onto: the rebuilt head of the PR under it, or the target's tip once the PR under it merged. */
  onto: string;
  /** The last publish's head of the PR under it: the commits after it are this branch's own. */
  upstream: string;
  /** The branch on `origin` when the restack started: the human's commits on it ride along. */
  source: string;
  /** Commits replayed after the branch's own: the final review's fixes for its group (`final-split`). */
  picks?: string[];
  /** The rebuilt head, checks green and conflicts accepted. */
  rebuilt?: string;
  /** The rebase stopped on conflicts: the `merge` session's report, or the human's own clone. */
  conflict?: { report?: MergeArtifact; manual?: string };
  /** The clone it is rebuilt in (`CloneWork`), its work branch kept in the user's repo until the push. */
  clone: CloneState;
}

/**
 * The final review's fixes moved into the stack's groups whose lines they touch (design: pr-stack, 3c), after the
 * `final` gate, before publish. `rebuild` keeps the branches rebuilt so far across a stop, like `restack`.
 */
export interface FinalSplitState {
  rebuild?: RestackState;
  /** The group heads, the final review's head and the frozen tests moved, or the fixes stayed on the top PR. */
  done?: true;
  /** Per group, the fixes it got (`file:lines`), for its PR's description. */
  moved?: Record<string, string[]>;
  /**
   * Groups whose fixes went back to the top PR → the group whose rebuilt head had red `checks` with them: the group
   * itself, or one above it with no fixes of its own to withdraw.
   */
  withdrawn?: Record<string, string>;
  /** Rebuilds whose top tree came out different from the final review's, after a `merge` session. */
  attempts?: number;
}

export interface Pause {
  reason: 'gate' | 'human' | 'error' | 'rate_limit' | 'spec_issue' | 'test_issue' | 'review_failed' | 'checks_failing' | 'baseline' | 'red_gate' | 'budget' | 'timeout';
  gate?: GateName;
  group?: string;
  message?: string;
}

export interface FlowState {
  version: number;
  slug: string;
  title: string;
  entry: Entry;
  origin: FlowOrigin;
  /** Absent when the origin repo has no `origin` remote (or the flow predates it): groups start at HEAD. */
  target?: FlowTarget;
  status: FlowStatus;
  stage: StageId;
  stages: Record<StageId, StageState>;
  groups: Record<string, GroupState>;
  /** The review loop over the whole feature, in its own clone. */
  final_review?: ReviewLoopState & CloneState & { split?: FinalSplitState };
  paused?: Pause;
  /** How many times a human let the flow past its `budget`: each time every limit grew by half. */
  budget_raises?: number;
  /** `review.checks` green (exit 0) on a clean base, per base commit: groups on the same base don't run them twice. Red ones aren't kept. */
  baselines?: Record<string, Record<string, number>>;
  /** Notes from gate retries, appended to prompts of the retried stage. */
  notes: Array<{ stage: StageId; group?: string; note: string; at: string }>;
  /** CLI overrides, kept so `resume` without flags doesn't drop them. */
  overrides?: { autonomy?: Autonomy };
  outcome?: 'ticket_only' | 'saved' | 'ready_to_publish' | 'published';
  /** Set by `agentic publish` once the branch is pushed; `url` once the forge opened the PR. */
  published?: PublishedState;
  /** `agentic restack` stopped before its push (a gate, a conflict left to the human): the next run continues it. */
  restack?: RestackState;
  created_at: string;
  updated_at: string;
}

/** `checks` a human accepted as red on the base in any group: they don't verify anything in this flow. */
export function knownRed(state: FlowState): string[] {
  return [...new Set(Object.values(state.groups).flatMap((group) => group.known_red ?? []))];
}

export function lastRound(loop: ReviewLoopState): RoundRecord | undefined {
  return loop.review?.rounds.at(-1);
}

/** Number of the last finished round, 0 before the first one. */
export function roundNumber(loop: ReviewLoopState): number {
  return lastRound(loop)?.round ?? 0;
}

/** The last round that ran `axis`, whose report file exists: a skipped round carries the findings over without one. 0 before the first. */
export function reviewedRound(loop: ReviewLoopState, axis: ScopeAxis): number {
  return loop.review?.rounds.findLast((record) => !record.skipped?.includes(axis))?.round ?? 0;
}

/**
 * Blocking findings of the last round that verification didn't reject and the fixer didn't set aside,
 * plus disputed ones a human ruled must be fixed.
 */
export function openFindings(loop: ReviewLoopState): FindingRecord[] {
  const setAside = loop.set_aside ?? [];
  const ruledFix = setAside.filter((entry) => entry.ruling === 'fix').map((entry) => entry.finding);
  const out = new Set(setAside.filter((entry) => entry.ruling !== 'fix').map((entry) => entry.finding.fingerprint));
  const reported = (lastRound(loop)?.findings ?? []).filter((finding) => isOpen(finding) && !out.has(finding.fingerprint));
  const reportedPrints = new Set(reported.map((finding) => finding.fingerprint));
  return [...reported, ...ruledFix.filter((finding) => !reportedPrints.has(finding.fingerprint))];
}

/** Disputed findings no human has ruled on yet. */
export function pendingDisputes(loop: ReviewLoopState): SetAside[] {
  return (loop.set_aside ?? []).filter((entry) => entry.kind === 'disputed' && !entry.ruling);
}

/** `rounds 2, open blocking 1, nits 3, rejected 1` — for `status` and the scope's gate. */
export function reviewSummary(loop: ReviewLoopState): string {
  const findings = lastRound(loop)?.findings ?? [];
  const nits = findings.filter((finding) => finding.severity === 'nit').length;
  const rejected = findings.filter((finding) => finding.verdict?.status === 'rejected' && !finding.verdict.out_of_scope).length;
  const outOfScope = findings.filter((finding) => finding.verdict?.out_of_scope).length;
  const setAside = loop.set_aside?.filter((entry) => entry.ruling !== 'fix').length;
  const counts = [rejected && `rejected ${rejected}`, outOfScope && `out of scope ${outOfScope}`, setAside && `set aside ${setAside}`].filter(Boolean);
  return [`rounds ${roundNumber(loop)}, open blocking ${openFindings(loop).length}, nits ${nits}`, ...counts].join(', ');
}

export function roundRecord(
  round: number,
  reports: Partial<Record<ScopeAxis, ReviewReport>>,
  extra: Pick<RoundRecord, 'commit' | 'warnings' | 'reviewers' | 'skipped' | 'diff_lines'> = {},
  now = new Date(),
): RoundRecord {
  const findings = Object.entries(reports).flatMap(([axis, report]) =>
    report!.findings.map((finding) => ({ ...finding, axis: axis as ScopeAxis, fingerprint: fingerprint(finding) })),
  );
  // ids are numbered per report (`F1`): the fixer answers by id, so the same id from two axes gets the axis in front
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.id, (counts.get(finding.id) ?? 0) + 1);
  for (const finding of findings) if (counts.get(finding.id)! > 1) finding.id = `${finding.axis}/${finding.id}`;
  return {
    round,
    finished_at: now.toISOString(),
    findings,
    ...(extra.commit && { commit: extra.commit }),
    ...(extra.warnings?.length && { warnings: extra.warnings }),
    ...(extra.reviewers && Object.keys(extra.reviewers).length && { reviewers: extra.reviewers }),
    ...(extra.skipped?.length && { skipped: extra.skipped }),
    ...(extra.diff_lines !== undefined && { diff_lines: extra.diff_lines }),
  };
}

/** v1 kept only counters and the open blocking findings of the last round. */
function migrateReviewCountersToRounds(raw: RawState): RawState {
  const groups = (raw.groups ?? {}) as Record<string, RawState>;
  const migratedGroups = Object.fromEntries(
    Object.entries(groups).map(([id, group]) => {
      group = renameRoundReportKeys(group);
      const review = group.review as { rounds?: number; open?: Finding[] } | undefined;
      if (!review || typeof review.rounds !== 'number') return [id, group];
      const record: RoundRecord = {
        round: review.rounds,
        finished_at: String(raw.updated_at ?? new Date(0).toISOString()),
        findings: (review.open ?? []).map((finding) => ({ ...finding, fingerprint: fingerprint(finding) })),
        migrated: true,
      };
      return [id, { ...group, review: { rounds: review.rounds > 0 ? [record] : [] } }];
    }),
  );
  return { ...raw, groups: migratedGroups };
}

/** v1 keyed reports of the round in progress by session kind (`review-spec`), v2 by axis. */
function renameRoundReportKeys(group: RawState): RawState {
  const inProgress = group.round_reports as { round: number; reports: Record<string, unknown> } | undefined;
  if (!inProgress?.reports) return group;
  const reports = Object.fromEntries(Object.entries(inProgress.reports).map(([kind, report]) => [kind.replace(/^review-/, ''), report]));
  return { ...group, round_reports: { ...inProgress, reports } };
}

/** v2 ran every session in `cwd`; groups already started keep working there instead of in a clone. */
function migrateCwdToOrigin(raw: RawState): RawState {
  const { cwd, ...rest } = raw;
  const groups = (raw.groups ?? {}) as Record<string, RawState>;
  const migratedGroups = Object.fromEntries(
    Object.entries(groups).map(([id, group]) => [id, group.status === 'pending' ? group : { ...group, clonePath: cwd }]),
  );
  return { ...rest, origin: { repoRoot: cwd }, groups: migratedGroups };
}

/**
 * v3 kept only the blocking count of a single final review, and asked the `final` gate after the stage.
 * A final review that hadn't passed its gate runs again as a review loop, in its own clone.
 */
function migrateFinalBlockingToLoop(raw: RawState): RawState {
  const stages = (raw.stages ?? {}) as Record<string, RawState>;
  const finalReview = stages['final-review'];
  if (!finalReview) return raw;
  const { final_blocking: _finalBlocking, ...rest } = finalReview;
  const awaitingGate = rest.status === 'done' && rest.gate !== 'passed';
  return { ...raw, stages: { ...stages, 'final-review': awaitingGate ? { ...rest, status: 'pending' } : rest } };
}

export function newState(input: {
  slug: string;
  title: string;
  entry: Entry;
  origin: FlowOrigin;
  target?: FlowTarget;
  overrides?: FlowState['overrides'];
  now?: Date;
}): FlowState {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    version: STATE_VERSION,
    slug: input.slug,
    title: input.title,
    entry: input.entry,
    origin: input.origin,
    ...(input.target && { target: input.target }),
    status: 'running',
    stage: input.entry === 'pick' ? 'spec' : 'ticket',
    stages: Object.fromEntries(
      STAGES.map((stage) => [stage, { status: input.entry === 'pick' && stage === 'ticket' ? 'skipped' : 'pending' }]),
    ) as Record<StageId, StageState>,
    groups: {},
    notes: [],
    ...(input.overrides && { overrides: input.overrides }),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function stateFile(workDir: string): string {
  return path.join(workDir, 'state.json');
}

class CorruptStateError extends Error {}

/** A corrupt state.json (e.g. a crash mid-write on a filesystem without atomic rename) falls back to state.json.prev. */
export function loadState(workDir: string, warn?: (message: string) => void): FlowState {
  const file = stateFile(workDir);
  if (!fs.existsSync(file)) throw new Error(`No flow: ${file}`);
  try {
    return readState(file, workDir);
  } catch (error) {
    const backup = `${file}.prev`;
    if (!(error instanceof CorruptStateError) || !fs.existsSync(backup)) throw error;
    let state: FlowState;
    try {
      state = readState(backup, workDir);
    } catch {
      throw error;
    }
    warn?.(`${error.message}; loaded the backup ${backup} (the last step may run again)`);
    return state;
  }
}

function readState(file: string, workDir: string): FlowState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CorruptStateError(`Corrupt ${file}: ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${file}: not an object`);
  let state: FlowState;
  try {
    state = migrateState(raw as RawState) as unknown as FlowState;
  } catch (error) {
    throw new Error(`Invalid ${file}: ${errorMessage(error)}`);
  }
  const problems = [
    state.slug !== path.basename(workDir) && 'slug ≠ directory name',
    typeof state.origin?.repoRoot !== 'string' && 'no origin',
    (!state.stages || typeof state.stages !== 'object') && 'no stages',
  ].filter(Boolean);
  if (problems.length) throw new Error(`Invalid ${file}: ${problems.join(', ')}`);
  // stages added in later versions start as pending
  for (const stage of STAGES) state.stages[stage] ??= { status: 'pending' };
  return state;
}

/** Applies `migrations[k]` for every k from the state's version up to `target`. */
export function migrateState(raw: RawState, migrations: Record<number, Migration> = MIGRATIONS, target = STATE_VERSION): RawState {
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) throw new Error('no valid `version`');
  if (version > target) {
    throw new Error(`state from a newer framework version (v${version}, supported v${target}); update agentic`);
  }
  let migrated = raw;
  for (let from = version; from < target; from++) {
    const step = migrations[from];
    if (!step) throw new Error(`no migration v${from} → v${from + 1}`);
    migrated = { ...step(migrated), version: from + 1 };
  }
  return migrated;
}

export function saveState(workDir: string, state: FlowState): void {
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(workDir, { recursive: true });
  const file = stateFile(workDir);
  // fsync costs ~4 ms on APFS and a flow saves ~70 times; the test suite opts out
  const durable = process.env.AGENTIC_NO_FSYNC !== '1';
  const previous = readIfParseable(file);
  if (previous !== undefined) writeFileSafe(`${file}.prev`, previous, { durable });
  writeFileSafe(file, JSON.stringify(state, null, 2) + '\n', { durable });
}

/** A corrupt state.json must not replace a good backup. */
function readIfParseable(file: string): string | undefined {
  try {
    const content = fs.readFileSync(file, 'utf8');
    JSON.parse(content);
    return content;
  } catch {
    return undefined;
  }
}

/** One broken state.json is reported in `broken` instead of failing the whole listing. */
export function listFlows(workRoot: string): { flows: FlowState[]; broken: string[] } {
  const flows: FlowState[] = [];
  const broken: string[] = [];
  if (!fs.existsSync(workRoot)) return { flows, broken };
  for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
    const dir = path.join(workRoot, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(stateFile(dir))) continue;
    try {
      flows.push(loadState(dir));
    } catch (error) {
      broken.push(errorMessage(error));
    }
  }
  flows.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  return { flows, broken };
}

export function slugify(title: string, maxLength = 40): string {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return base || 'flow';
}

/** A slug free in every root, so `resume <slug>` names one flow. */
export function uniqueSlug(workRoots: string[], title: string): string {
  const base = slugify(title);
  let slug = base;
  for (let suffix = 2; workRoots.some((root) => fs.existsSync(path.join(root, slug))); suffix++) slug = `${base}-${suffix}`;
  return slug;
}
