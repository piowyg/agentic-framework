import fs from 'node:fs';
import path from 'node:path';
import { parseMerge } from '../contracts/index.js';
import type { MergeArtifact } from '../contracts/schemas.js';
import { approvedGroups, type Group } from './artifacts.js';
import { describeFailures, passed, rerunFailed, runChecks } from './checks.js';
import { CloneWork } from './clone-work.js';
import type { CloneOwner } from './clones.js';
import { mergeExecutor } from './executors.js';
import { GateKeeper } from './gatekeeper.js';
import type { GateDecision } from './gates.js';
import { cloneForGroup, conflictMarkers, hostGit, isAncestor, rebaseInProgress, rebaseOnto } from './repos.js';
import { FlowRun, Halt, type FlowContext } from './run.js';
import { SessionRunner } from './session-runner.js';
import { loadState, type FlowState, type RestackBranch, type RestackState } from './state.js';
import { GroupTests } from './write-tests.js';

/** One open PR of a stack, as `agentic restack` found it on `origin`. */
export interface RestackSource {
  group: string;
  branch: string;
  /** The last publish's head of the PR under it (the target's tip the flow was on, for the lowest): its own commits start after it. */
  upstream: string;
  /** Its branch on `origin` now: the last publish's head plus any commits the human pushed. */
  remoteHead: string;
  /** Commits replayed after the branch's own: the final review's fixes for its group (`final-fixes`). */
  picks?: string[];
}

/**
 * Why the stack is rebuilt: `restack` — PRs merged or the human's commits, branches from `origin`, red checks stop it;
 * `final-fixes` — the final review's fixes moved into their groups before publish (design: pr-stack, 3c), branches
 * from the flow's group branches, red checks reported back (the group's fixes go to the top PR), the top branch not
 * checked (its tree must equal the final review's, which passed).
 */
export type RebuildPurpose = 'restack' | 'final-fixes';

export interface RestackRequest {
  /** Default `restack`. */
  purpose?: RebuildPurpose;
  repo: string;
  /** The PRs' target branch, for the messages. */
  base: string;
  /** Where the lowest open PR goes: the target's tip once the PR under it merged; absent, the lowest stays as it is. */
  onto?: string;
  /** The open PRs, bottom first. */
  branches: RestackSource[];
  /** `agentic restack <slug>`, for the messages that stop it. */
  retry: string;
}

export interface RebuiltBranch {
  branch: string;
  head: string;
  /** False: the branch already sat on what is under it now — nothing to push. */
  moved: boolean;
  /** Conflicted files the `merge` session (or the human) resolved. */
  resolved?: string[];
  /** `final-fixes`: checks red on the branch rebuilt without conflicts (the description); the branches above weren't touched. */
  red?: string;
}

/** Where each purpose keeps its clones, merge sessions and progress. */
const PURPOSES: Record<RebuildPurpose, { prefix: string; label: string; progress: (state: FlowState) => { get(): RestackState | undefined; set(value: RestackState | undefined): void } }> = {
  restack: {
    prefix: 'restack',
    label: 'restack',
    progress: (state) => ({
      get: () => state.restack,
      set: (value) => (value ? (state.restack = value) : delete state.restack),
    }),
  },
  'final-fixes': {
    prefix: 'final-fix',
    label: 'final review fixes',
    progress: (state) => ({
      get: () => state.final_review?.split?.rebuild,
      set: (value) => {
        const split = ((state.final_review ??= {}).split ??= {});
        if (value) split.rebuild = value;
        else delete split.rebuild;
      },
    }),
  },
};

/** Lines of `git range-diff` the `merge` gate shows; the rest is a command away. */
const GATE_DIFF_LINES = 200;

/**
 * `agentic restack` (design: pr-stack): each open PR's branch rebuilt onto the one under it, bottom first, in a clone
 * of the user's repo — `rebase --onto <new base> <old base> <branch on origin>`, so the human's commits on it ride
 * along. No conflict: `review.checks` there (without the known red ones), no review. A conflict: a `merge` session
 * finishes the rebase, then the control after the session and the `merge` gate with the `range-diff`; `manual` hands
 * the stopped rebase to the human in a clone of their own. Progress is kept in `state.restack`: a stop (gate, human,
 * red checks) leaves it for the next run. Nothing is pushed here.
 */
export async function rebuildStack(context: FlowContext, request: RestackRequest): Promise<RebuiltBranch[]> {
  const flow = new FlowRun(context, loadState(context.workDir));
  const gatekeeper = new GateKeeper(flow);
  try {
    return await rebuildBranches(flow, gatekeeper, new SessionRunner(flow, gatekeeper), request);
  } catch (error) {
    if (error instanceof Halt) {
      if (error.status === 'aborted') throw new Error('restack aborted; nothing pushed, rebuilt branches removed.');
      // a gate, an escalation or a session limit: what's rebuilt so far stays for the next run
      throw new Error(`${error.message}\nNothing pushed; to finish: ${request.retry}`);
    }
    throw error;
  }
}

/**
 * The rebuild itself, inside a running flow (`final-fixes`) or for `restack`: a `Halt` goes up as it is (an abort first
 * removes what was rebuilt). With `final-fixes`, the first branch with red checks ends it: its result carries `red`,
 * nothing above it is rebuilt.
 */
export async function rebuildBranches(flow: FlowRun, gatekeeper: GateKeeper, sessions: SessionRunner, request: RestackRequest): Promise<RebuiltBranch[]> {
  const { state } = flow;
  const purpose = PURPOSES[request.purpose ?? 'restack'];
  const progress = purpose.progress(state);
  const saved = progress.get()?.branches ?? [];
  const entries: RestackBranch[] = [];
  const results: RebuiltBranch[] = [];
  const finish = () => {
    // entries of an earlier run whose inputs moved (the human pushed again, another PR merged) go with their clones
    for (const stale of saved.filter((entry) => !entries.includes(entry))) removeClones(stale);
    progress.set({ branches: entries });
    flow.save();
    return results;
  };
  try {
    for (const [index, source] of request.branches.entries()) {
      const onto = index ? results[index - 1]!.head : request.onto;
      const picks = source.picks ?? [];
      // what is under it didn't change, or the branch already holds it (the human merged it in): it stays as it is
      if (!onto || (!picks.length && isAncestor(request.repo, onto, source.remoteHead))) {
        results.push({ branch: source.branch, head: source.remoteHead, moved: false });
        continue;
      }
      const matching = saved.find(
        (entry) =>
          entry.branch === source.branch &&
          entry.onto === onto &&
          entry.upstream === source.upstream &&
          entry.source === source.remoteHead &&
          (entry.picks ?? []).join() === picks.join(),
      );
      const entry: RestackBranch = matching ?? {
        group: source.group,
        branch: source.branch,
        onto,
        upstream: source.upstream,
        source: source.remoteHead,
        ...(picks.length && { picks }),
        clone: {},
      };
      entries.push(entry);
      progress.set({ branches: [...entries] });
      flow.save();
      const last = index === request.branches.length - 1;
      const rebuilder = new BranchRebuilder(flow, gatekeeper, sessions, request, entry, index + 1, last);
      const outcome = entry.rebuilt ? { head: entry.rebuilt } : await rebuilder.rebuild();
      if ('red' in outcome) {
        entries.pop();
        removeClones(entry);
        results.push({ branch: source.branch, head: source.remoteHead, moved: false, red: outcome.red });
        return finish();
      }
      results.push({ branch: source.branch, head: outcome.head, moved: true, ...(entry.conflict?.report && { resolved: entry.conflict.report.files.map((file) => file.path) }) });
    }
    return finish();
  } catch (error) {
    if (error instanceof Halt && error.status === 'aborted') {
      for (const entry of [...saved, ...entries]) removeClones(entry);
      removeRestackRefs(request.repo, state.slug, purpose.prefix);
      progress.set(undefined);
      flow.save();
    }
    throw error;
  }
}

/** An entry's clones: the agent's and the human's. */
export function removeClones(entry: RestackBranch): void {
  for (const clonePath of [entry.clone.clonePath, entry.conflict?.manual]) if (clonePath) fs.rmSync(clonePath, { recursive: true, force: true });
}

/** After the push (or an abort): the rebuilt branches kept in the user's repo. */
export function removeRestackRefs(repo: string, slug: string, prefix = PURPOSES.restack.prefix): void {
  const owned = new RegExp(`/${prefix}-\\d+(-manual)?$`);
  const refs = hostGit(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/agentic/${slug}/`, `refs/agentic/${slug}/`])
    .split('\n')
    .filter((ref) => owned.test(ref));
  for (const ref of refs) hostGit(repo, ['update-ref', '-d', ref]);
}

class BranchRebuilder {
  private readonly work: CloneWork;
  private readonly owner: CloneOwner;
  private readonly purpose: RebuildPurpose;

  constructor(
    private readonly flow: FlowRun,
    private readonly gatekeeper: GateKeeper,
    sessions: SessionRunner,
    private readonly request: RestackRequest,
    private readonly entry: RestackBranch,
    position: number,
    /** The top branch: with `final-fixes` its tree is checked against the final review's instead of `checks`. */
    private readonly last: boolean,
  ) {
    this.purpose = request.purpose ?? 'restack';
    const { prefix, label } = PURPOSES[this.purpose];
    this.owner = { name: `${prefix}-${position}`, label: `${label} ${entry.branch}`, repo: '.' };
    this.work = new CloneWork(flow, sessions, this.owner, entry.clone);
  }

  async rebuild(): Promise<{ head: string } | { red: string }> {
    const { entry } = this;
    for (;;) {
      if (entry.conflict?.manual) return { head: this.accept(await this.takeManual(entry.conflict.manual)) };
      if (!entry.conflict) {
        this.prepare();
        if (!this.startRebase(this.work.cwd)) {
          const red = await this.checkClean();
          if (red) return { red };
          return { head: this.accept(await this.work.sync('rebuilt')) };
        }
        entry.conflict = {};
        this.flow.save();
        this.flow.log(`${this.owner.label}: conflict moving onto ${entry.onto.slice(0, 12)}; merge session`);
      } else if (!this.work.prepared) {
        // the clone went (a retry at the gate): the rebase stopped on its conflicts again, for a fresh session
        this.prepare();
        this.startRebase(this.work.cwd);
      }
      entry.conflict.report ??= await this.mergeSession();
      this.flow.save();
      const decision = await this.decide(entry.conflict.report);
      if (decision.action === 'continue') return { head: this.accept(this.work.head!) };
      this.work.discard(true);
      delete entry.conflict.report;
      if (decision.action === 'retry') {
        this.flow.note(this.flow.state.stage, decision.note, entry.group);
      } else if (decision.action === 'manual') {
        entry.conflict.manual = this.manualClone();
        this.flow.save();
        throw new Halt('paused', {
          reason: 'human',
          gate: 'merge',
          group: entry.group,
          message: `finish the rebase in ${entry.conflict.manual} (resolve conflicts, git add, git rebase --continue)`,
        });
      }
      this.flow.save();
    }
  }

  /** The clone at the new base, its work branch kept in the user's repo until the push. */
  private prepare(): void {
    // a clone this entry doesn't know is an earlier run's, whose inputs moved (positions shift once a PR merges)
    if (!this.entry.clone.clonePath) fs.rmSync(path.join(this.flow.context.workDir, 'clones', this.owner.name), { recursive: true, force: true });
    this.work.prepare(this.entry.onto);
  }

  /** The branch (and its `picks`) replayed onto the new base in a clone no agent touched yet; true when it stopped on conflicts. */
  private startRebase(clonePath: string): boolean {
    hostGit(clonePath, ['reset', '--quiet', '--hard', this.entry.source]);
    const result = rebaseOnto(clonePath, this.entry.onto, this.entry.upstream, [], this.entry.picks);
    if (result.status === 0) return false;
    if (!rebaseInProgress(clonePath)) throw new Error(`${this.owner.label}: git rebase failed: ${(result.stderr || result.stdout).trim()}`);
    return true;
  }

  /**
   * `review.checks` on a rebase without conflicts: nobody changed the code, but what's under it did. Red: `restack`
   * stops, `final-fixes` gets the description back. The top branch of `final-fixes` isn't checked.
   */
  private async checkClean(): Promise<string | undefined> {
    if (this.purpose === 'final-fixes' && this.last) return undefined;
    const red = await this.redChecks(this.work.cwd, `onto-${this.entry.onto.slice(0, 8)}`);
    if (!red) return undefined;
    this.work.discard(true);
    if (this.purpose === 'final-fixes') return red;
    throw new Error(`checks red on ${this.entry.branch} after moving onto ${this.entry.onto.slice(0, 12)}; nothing pushed:\n${red}`);
  }

  /** The red ones described; undefined when all are green (or none verify anything). */
  private async redChecks(cwd: string, label: string): Promise<string | undefined> {
    const commands = this.work.verifiedChecks;
    if (!commands.length) return undefined;
    const scope = { owner: this.owner.name, label };
    const runs = await rerunFailed(this.flow, cwd, scope, await runChecks(this.flow, cwd, scope, commands));
    const red = runs.filter((run) => !passed(run));
    return red.length ? describeFailures(red) : undefined;
  }

  private accept(head: string): string {
    this.entry.rebuilt = head;
    removeClones(this.entry);
    delete this.entry.clone.clonePath;
    this.flow.save();
    this.flow.log(`✓ ${this.entry.branch} rebuilt on ${this.entry.onto.slice(0, 12)}: ${head.slice(0, 12)}`);
    return head;
  }

  private async mergeSession(): Promise<MergeArtifact> {
    const { config, catalog } = this.flow.context;
    const { entry, request } = this;
    const groups = approvedGroups(this.flow.context.workDir).filter((group) => group.id === entry.group);
    const describe = (group: Group) => `- ${group.id}: ${group.summary ?? group.title ?? ''} (acceptance: ${[...new Set(group.tasks.flatMap((task) => task.acceptance))].join(', ')})`;
    return this.work.run({
      kind: 'merge',
      executor: mergeExecutor(config, groups, catalog),
      label: `${PURPOSES[this.purpose].prefix}-${entry.group}`,
      parse: parseMerge,
      handsOver: (report) => report.status === 'escalated',
      verify: (head, report) => {
        if (rebaseInProgress(this.work.cwd)) return 'The rebase is not finished: resolve the conflicts, `git add` the files and `git rebase --continue` until it completes.';
        if (!isAncestor(request.repo, entry.onto, head)) return `The branch no longer sits on ${entry.onto.slice(0, 12)}: finish the rebase onto it, don't abort it.`;
        // a marker in a config file or a doc passes `checks`
        const markers = conflictMarkers(request.repo, entry.onto, head);
        if (markers.length) return `Conflict markers are still in the rebased commits — resolve them:\n${markers.map((line) => `- ${line}`).join('\n')}`;
        return this.frozenTestsProblem(groups[0], head, report);
      },
      scope: {
        group: entry.group,
        label: `${PURPOSES[this.purpose].prefix}-${entry.group}`,
        extra: [
          this.why(),
          'Resolve each stop keeping what the group delivers, `git add` the files and `git rebase --continue`; repeat until the rebase completes. Do not squash, reorder, drop or reword commits.',
          ...(groups.length ? ['The group (details in the plan):', ...groups.map(describe)] : []),
        ].join('\n'),
      },
    });
  }

  /** What the `merge` session is told about the rebase it finishes. */
  private why(): string {
    const { entry, request } = this;
    const onto = entry.onto.slice(0, 12);
    if (this.purpose === 'final-fixes') {
      return [
        `This is a rebase, not a merge: the branch of group ${entry.group} (${entry.branch}) is being rebuilt so that the final review's fixes to its own lines land in its PR.`,
        `Its commits are replayed onto ${onto} (${request.onto === entry.onto ? `where the group starts` : 'the rebuilt branch of the group under it, which already carries its fixes'}), followed by the commits marked \`(final review)\` that carry this group's fixes. The rebase stopped on conflicts.`,
        "Keep both the group's work and each fix exactly as the final review left it: the rebuilt stack must end with the same code as the final review.",
      ].join(' ');
    }
    return `This is a rebase, not a merge: the PR of group ${entry.group} (branch ${entry.branch}) is being moved onto ${onto} — ${request.onto === entry.onto ? `the tip of ${request.base}, after the PR under it was merged` : 'the rebuilt branch of the PR under it'}. The rebase stopped on conflicts.`;
  }

  /**
   * The group's frozen tests (design: pr-stack, checks with frozen tests) stay as written through the conflicts, or
   * `checks` could be turned green by editing them. A frozen file may change only where the rebase had to change it:
   * a conflict the session resolved, a change the new base brings to it, or a final review fix the rebuild carries.
   */
  private frozenTestsProblem(group: Group | undefined, head: string, report: MergeArtifact | undefined): string | undefined {
    const groupState = this.flow.state.groups[this.entry.group];
    if (!group || !groupState) return undefined;
    const names = (from: string, to: string) => hostGit(this.request.repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean);
    const fromBase = names(this.entry.upstream, this.entry.onto);
    const fixes = (this.entry.picks ?? []).flatMap((commit) => names(`${commit}^`, commit));
    const resolved = report?.files.map((file) => file.path) ?? [];
    return new GroupTests(this.flow, this.work, group, groupState).frozenProblem(head, [...resolved, ...fromBase, ...fixes]);
  }

  /** Escalated: the human decides. Resolved: the `merge` gate with how each commit changed in the rebase. */
  private decide(report: MergeArtifact): Promise<GateDecision> {
    const where = `${this.owner.label}: moving onto ${this.entry.onto.slice(0, 12)}`;
    if (report.status === 'escalated') {
      return this.gatekeeper.ask('merge', `${where}; the agent escalated: ${report.reason}`, ['retry', 'manual', 'stop', 'abort'], { group: this.entry.group });
    }
    return this.gatekeeper.gate('merge', () => ({ text: this.summary(where, report) }), { group: this.entry.group });
  }

  private summary(where: string, report: MergeArtifact): string {
    const { entry, request } = this;
    const head = this.work.head!;
    const range = `${entry.upstream.slice(0, 12)}..${entry.source.slice(0, 12)} ${entry.onto.slice(0, 12)}..${head.slice(0, 12)}`;
    const diff = hostGit(request.repo, ['range-diff', '--no-color', `${entry.upstream}..${entry.source}`, `${entry.onto}..${head}`]).split('\n');
    return [
      `${where}; conflicts resolved by the agent (${head.slice(0, 12)}):`,
      ...report.files.map((file) => `- ${file.path}: ${file.decision} — ${file.rationale}`),
      '',
      'Commits before → after (`git range-diff`):',
      ...diff.slice(0, GATE_DIFF_LINES),
      ...(diff.length > GATE_DIFF_LINES ? [`… (${diff.length - GATE_DIFF_LINES} more lines: git range-diff ${range})`] : []),
    ].join('\n');
  }

  /** A fresh clone with the stopped rebase for the human — never the agent's one, whose hooks the human's git would run. */
  private manualClone(): string {
    const clonePath = path.join(this.flow.context.workDir, 'manual', this.owner.name);
    fs.rmSync(clonePath, { recursive: true, force: true });
    cloneForGroup({ repoPath: this.request.repo, clonePath, branch: `agentic/${this.flow.state.slug}/${this.owner.name}-manual`, baseRef: this.entry.onto });
    this.startRebase(clonePath);
    return clonePath;
  }

  /** The human's finished rebase: a clean tree on the new base, no markers, checks green. */
  private async takeManual(clonePath: string): Promise<string> {
    const { entry, request } = this;
    const pending = (why: string) =>
      new Halt('paused', { reason: 'human', gate: 'merge', group: entry.group, message: `rebase in ${clonePath} unfinished (${why}); finish it (git rebase --continue)` });
    if (!fs.existsSync(clonePath)) throw new Error(`the clone for the manual rebase is gone: ${clonePath}`);
    if (rebaseInProgress(clonePath)) throw pending('rebase in progress');
    if (hostGit(clonePath, ['status', '--porcelain'])) throw pending('uncommitted changes');
    const head = hostGit(clonePath, ['rev-parse', 'HEAD']);
    if (!isAncestor(clonePath, entry.onto, head)) throw pending(`HEAD is not on ${entry.onto.slice(0, 12)}`);
    const markers = conflictMarkers(clonePath, entry.onto, head);
    if (markers.length) throw pending(`conflict markers: ${markers.join('; ')}`);
    const red = await this.redChecks(clonePath, 'manual');
    if (red) throw pending(`checks red:\n${red}`);
    hostGit(request.repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', clonePath, `+${head}:refs/agentic/${this.flow.state.slug}/${this.owner.name}`]);
    this.flow.log(`${this.owner.label}: manual rebase accepted (${head.slice(0, 12)})`);
    return head;
  }
}
