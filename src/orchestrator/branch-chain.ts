import fs from 'node:fs';
import path from 'node:path';
import { parseMerge } from '../contracts/index.js';
import type { MergeArtifact } from '../contracts/schemas.js';
import type { Group } from './artifacts.js';
import type { CloneWork } from './clone-work.js';
import { mergeExecutor } from './executors.js';
import type { GateKeeper } from './gatekeeper.js';
import type { GateDecision } from './gates.js';
import { AGENTIC_IDENTITY, cloneForGroup, conflictMarkers, hostGit, isAncestor, mergeTree, resolveRepo } from './repos.js';
import { Halt, type FlowRun } from './run.js';
import type { CloneState } from './state.js';

/** A finished predecessor whose branch the owner starts from. */
export interface ChainSource {
  group: Group;
  /** Its work branch's head in the user's repo. */
  head: string;
}

/** Lines of the resolution diff the `merge` gate shows; the rest is a `git show` away. */
const GATE_DIFF_LINES = 200;

/**
 * A dependent group, and the whole feature, start from the merged branches of their predecessors.
 * The host merges in the user's repo (`merge-tree`, no working tree, nothing an agent touched); a conflict goes to
 * a `merge` session in the owner's clone, then through the control after the session and the `merge` gate.
 * Pairwise, in plan order, persisted after each step: `chore(agentic): merge g1, g2`, then `…, g3`.
 */
export class BranchChain {
  constructor(
    private readonly flow: FlowRun,
    private readonly gatekeeper: GateKeeper,
    private readonly work: CloneWork,
    private readonly clone: CloneState,
    /** The owner's group, for pauses and notes; absent for the whole feature. */
    private readonly group?: string,
  ) {}

  /** The commit the owner starts from; undefined without predecessors (where the flow starts then). */
  async base(sources: ChainSource[]): Promise<string | undefined> {
    // a branch another one already contains adds nothing (g3 built on g1 and g2: the feature is g3)
    const leaves = sources.filter(
      (source, index) =>
        !sources.some((other, otherIndex) => (other.head === source.head ? otherIndex < index : isAncestor(this.repoPath, source.head, other.head))),
    );
    const [first] = leaves;
    if (!first) return undefined;
    const chain = (this.clone.chain ??= { merged: [first.group.id], commit: first.head });
    for (const source of leaves) {
      if (chain.merged.includes(source.group.id)) continue;
      const merged = leaves.filter((candidate) => chain.merged.includes(candidate.group.id));
      const message = `chore(agentic): merge ${[...chain.merged, source.group.id].join(', ')}`;
      if (!chain.conflict) {
        const tree = mergeTree(this.repoPath, chain.commit, source.head);
        if (tree) {
          chain.commit = hostGit(this.repoPath, ['commit-tree', tree, '-p', chain.commit, '-p', source.head, '-m', message], AGENTIC_IDENTITY);
          chain.merged.push(source.group.id);
          this.flow.save();
          continue;
        }
        chain.conflict = { from: source.group.id };
        this.flow.save();
        this.flow.log(`${this.work.owner.label}: conflict merging ${source.group.id}; merge session`);
      }
      chain.commit = await this.resolve(chain.commit, source, merged, message);
      chain.merged.push(source.group.id);
      delete chain.conflict;
      this.flow.save();
    }
    hostGit(this.repoPath, ['update-ref', `refs/agentic/${this.flow.state.slug}/${this.work.owner.name}/base`, chain.commit]);
    return chain.commit;
  }

  /** Until a resolution is accepted: a `merge` session and the gate, or the human's own clone. */
  private async resolve(into: string, source: ChainSource, merged: ChainSource[], message: string): Promise<string> {
    const conflict = this.clone.chain!.conflict!;
    for (;;) {
      if (conflict.manual) return this.takeManual(conflict.manual, into, source);
      if (!this.work.prepared) {
        this.work.prepare(into);
        mergeWithConflicts(this.work.cwd, source.head, message);
      }
      conflict.report ??= await this.mergeSession(into, source, merged);
      this.flow.save();
      const decision = await this.decide(conflict.report, into, source);
      if (decision.action === 'continue') {
        const commit = this.work.head!;
        this.work.discard(true);
        this.flow.log(`${this.work.owner.label}: merge of ${source.group.id} accepted (${commit.slice(0, 12)})`);
        return commit;
      }
      this.work.discard();
      delete conflict.report;
      if (decision.action === 'retry') {
        this.flow.note(this.flow.state.stage, decision.note, this.group);
      } else if (decision.action === 'manual') {
        conflict.manual = this.manualClone(into, source, message);
        this.flow.save();
        throw new Halt('paused', {
          reason: 'human',
          gate: 'merge',
          group: this.group,
          message: `resolve the conflict in ${conflict.manual} (commit the merge), then \`agentic resume ${this.flow.state.slug}\``,
        });
      }
      this.flow.save();
    }
  }

  private async mergeSession(into: string, source: ChainSource, merged: ChainSource[]): Promise<MergeArtifact> {
    const { config, catalog } = this.flow.context;
    const groups = [...merged.map((entry) => entry.group), source.group];
    const describe = (group: Group) =>
      `- ${group.id}: ${group.summary ?? group.title ?? ''} (acceptance: ${[...new Set(group.tasks.flatMap((task) => task.acceptance))].join(', ')})`;
    return this.work.run({
      kind: 'merge',
      executor: mergeExecutor(config, groups, catalog),
      label: `merge-${source.group.id}`,
      parse: parseMerge,
      handsOver: (report) => report.status === 'escalated',
      verify: (head) => {
        if (!isAncestor(this.repoPath, source.head, head)) return `The merge of ${source.group.id} is not committed: resolve the conflicts and \`git commit --no-edit\`.`;
        // a marker in a config file or a doc passes `checks`
        const markers = conflictMarkers(this.repoPath, into, head);
        return markers.length ? `Conflict markers are still in the merge — resolve them and commit:\n${markers.map((line) => `- ${line}`).join('\n')}` : undefined;
      },
      scope: {
        group: this.group,
        label: source.group.id,
        extra: [`Merging group ${source.group.id} into ${merged.map((entry) => entry.group.id).join(', ')}. The groups (details in the plan):`, ...groups.map(describe)].join('\n'),
      },
    });
  }

  /** Escalated: the human decides how to merge. Resolved: the `merge` gate with the resolution diff. */
  private decide(report: MergeArtifact, into: string, source: ChainSource): Promise<GateDecision> {
    const where = `${this.work.owner.label}: merging ${source.group.id}`;
    if (report.status === 'escalated') {
      return this.gatekeeper.ask('merge', `${where}; the agent escalated: ${report.reason}`, ['retry', 'manual', 'stop', 'abort'], { group: this.group });
    }
    return this.gatekeeper.gate('merge', () => ({ text: this.summary(where, report, into, source) }), { group: this.group });
  }

  private summary(where: string, report: MergeArtifact, into: string, source: ChainSource): string {
    const commit = this.work.head!;
    const diff = hostGit(this.repoPath, ['show', '--remerge-diff', '--format=', commit]).split('\n');
    return [
      `${where}; conflict resolved by the agent (${commit.slice(0, 12)}, parents ${into.slice(0, 12)} + ${source.head.slice(0, 12)}):`,
      ...report.files.map((file) => `- ${file.path}: ${file.decision} — ${file.rationale}`),
      '',
      'Conflicts → resolution (`git show --remerge-diff`):',
      ...diff.slice(0, GATE_DIFF_LINES),
      ...(diff.length > GATE_DIFF_LINES ? [`… (${diff.length - GATE_DIFF_LINES} more lines: git show --remerge-diff ${commit.slice(0, 12)})`] : []),
    ].join('\n');
  }

  /** A fresh clone with the conflict for the human — never the agent's one, whose hooks the human's git would run. */
  private manualClone(into: string, source: ChainSource, message: string): string {
    const clonePath = path.join(this.flow.context.workDir, 'manual', `${this.work.owner.name}-${source.group.id}`);
    fs.rmSync(clonePath, { recursive: true, force: true });
    cloneForGroup({ repoPath: this.repoPath, clonePath, branch: `agentic/${this.flow.state.slug}/${this.work.owner.name}-manual`, baseRef: into });
    mergeWithConflicts(clonePath, source.head, message);
    return clonePath;
  }

  /** The human's resolution: a clean tree whose HEAD merges exactly the two sides. */
  private takeManual(clonePath: string, into: string, source: ChainSource): string {
    const pending = () => new Halt('paused', { reason: 'human', gate: 'merge', group: this.group, message: `conflict in ${clonePath} unresolved; commit the merge and resume` });
    if (!fs.existsSync(clonePath)) throw new Error(`the clone for the manual merge is gone: ${clonePath}`);
    if (hostGit(clonePath, ['status', '--porcelain'])) throw pending();
    const parents = hostGit(clonePath, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1);
    if (parents.length !== 2 || parents[0] !== into || parents[1] !== source.head) throw pending();
    const commit = hostGit(clonePath, ['rev-parse', 'HEAD']);
    hostGit(this.repoPath, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', clonePath, `${commit}:refs/agentic/incoming/${commit}`]);
    hostGit(this.repoPath, ['update-ref', '-d', `refs/agentic/incoming/${commit}`]);
    fs.rmSync(clonePath, { recursive: true, force: true });
    this.flow.log(`${this.work.owner.label}: manual merge of ${source.group.id} accepted (${commit.slice(0, 12)})`);
    return commit;
  }

  private get repoPath(): string {
    return resolveRepo(this.work.owner.repo, this.flow.state.origin);
  }
}

/** Starts the merge in a clone no agent has touched yet and leaves it stopped on its conflicts. */
function mergeWithConflicts(clonePath: string, theirs: string, message: string): void {
  try {
    hostGit(clonePath, ['merge', '--no-ff', '--no-edit', '-m', message, theirs], AGENTIC_IDENTITY);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return;
    throw error;
  }
  throw new Error(`expected a conflict merging ${theirs.slice(0, 12)}, but the merge went through`);
}
