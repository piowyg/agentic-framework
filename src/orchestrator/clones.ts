import fs from 'node:fs';
import path from 'node:path';
import { parseNumstat, type ChangedFile } from '../publish/merge-danger.js';
import { exportBundle, importBundle } from './bundles.js';
import { cloneForGroup, headCommit, hostGit, resolveRepo } from './repos.js';
import type { FlowRun } from './run.js';
import type { CloneState } from './state.js';

/** Whose clone it is: `name` is its directory and branch suffix, `label` names it in messages (`group g1`). */
export interface CloneOwner {
  name: string;
  label: string;
  /** `tasks.yaml` repo name. */
  repo: string;
}

/**
 * The clone the owner's sessions work in, on `agentic/<slug>/<name>`, at `base` (the predecessors' merged
 * branches, `BranchChain`) or else where the flow starts (`startCommit`); the branch is set there in the user's repo too. Made once; resume reuses it.
 */
export function prepareClone(flow: FlowRun, owner: CloneOwner, clone: CloneState, base?: string): string {
  if (clone.clonePath) {
    if (fs.existsSync(clone.clonePath)) return clone.clonePath;
    throw new Error(`clone ${owner.label} is gone: ${clone.clonePath}`);
  }
  const repoPath = resolveRepo(owner.repo, flow.state.origin);
  clone.repo = owner.repo;
  clone.branch = `agentic/${flow.state.slug}/${owner.name}`;
  clone.baseRef = base ?? startCommit(flow, repoPath);
  clone.head = clone.baseRef;
  const clonePath = path.join(flow.context.workDir, 'clones', owner.name);
  cloneForGroup({ repoPath, clonePath, branch: clone.branch, baseRef: clone.baseRef });
  // the work branch exists in the repo from the start: an owner whose sessions commit nothing (a final review
  // without a fix) still leaves a branch to publish
  hostGit(repoPath, ['update-ref', `refs/heads/${clone.branch}`, clone.baseRef]);
  clone.clonePath = clonePath;
  flow.save();
  flow.log(`Clone ${owner.label}: ${clonePath} (branch ${clone.branch} from ${clone.baseRef.slice(0, 12)})`);
  return clonePath;
}

/** Where an owner without predecessors starts: in the origin repo the PR target's tip chosen at start, else HEAD. */
function startCommit(flow: FlowRun, repoPath: string): string {
  const { target, origin } = flow.state;
  return target && path.resolve(repoPath) === path.resolve(origin.repoRoot) ? target.commit : headCommit(repoPath);
}

/**
 * The clone's new commits come back to the user's repo as a bundle and move the work
 * branch `agentic/<slug>/<name>` there. `label` names the bundle (`g1-t2`, `g1-r3`). Returns the branch head.
 */
export async function syncClone(flow: FlowRun, owner: CloneOwner, clone: CloneState, label: string): Promise<string> {
  const { clonePath, baseRef, branch } = cloneOf(owner, clone);
  const { file } = await exportBundle(flow, clonePath, baseRef, `${owner.name}-${label}`);
  if (!file) return clone.head ?? baseRef;
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  const { commit, rewritten } = importBundle(repoPath, file, { baseRef, branch, previous: clone.head });
  if (rewritten) flow.log(`! ${owner.label}: history rewritten (amend/rebase); ${clone.head?.slice(0, 12)} is not an ancestor of ${commit.slice(0, 12)}`);
  clone.head = commit;
  flow.save();
  return commit;
}

/** The code a review round sees, kept as `refs/agentic/<slug>/<name>/r<round>`: rollback works whatever the agent does to its history. */
export function snapshotRound(flow: FlowRun, owner: CloneOwner, clone: CloneState, round: number): string {
  const { baseRef } = cloneOf(owner, clone);
  const commit = clone.head ?? baseRef;
  hostGit(resolveRepo(clone.repo ?? owner.repo, flow.state.origin), ['update-ref', roundRef(flow, owner, round), commit]);
  return commit;
}

/** `git diff -U0 <since> <head>` in the user's repo, where round commits are kept under hidden refs. */
export function changedSince(flow: FlowRun, owner: CloneOwner, clone: CloneState, since: string): string {
  const { baseRef } = cloneOf(owner, clone);
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  return hostGit(repoPath, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', since, clone.head ?? baseRef]);
}

/** `git diff -U0` from `base` (the clone's by default) to `commit`, for the signals of the round (src/review/signals.ts). */
export function diffText(flow: FlowRun, owner: CloneOwner, clone: CloneState, commit: string, base?: string): string {
  const { baseRef } = cloneOf(owner, clone);
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  return hostGit(repoPath, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', base ?? baseRef, commit]);
}

/** Lines added and deleted from `base` (the clone's by default) to `commit` (`--numstat`; binary files count as none). */
export function diffLines(flow: FlowRun, owner: CloneOwner, clone: CloneState, commit: string, base?: string): number {
  const { baseRef } = cloneOf(owner, clone);
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  return hostGit(repoPath, ['diff', '--numstat', '--no-color', base ?? baseRef, commit])
    .split('\n')
    .reduce((sum, line) => sum + line.split('\t').slice(0, 2).reduce((lines, count) => lines + (Number(count) || 0), 0), 0);
}

/** Files changed from `base` (the clone's by default) to `commit`, with their line counts. */
export function changedFiles(flow: FlowRun, owner: CloneOwner, clone: CloneState, commit: string, base?: string): ChangedFile[] {
  const { baseRef } = cloneOf(owner, clone);
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  return parseNumstat(hostGit(repoPath, ['diff', '--numstat', '-z', '--no-color', base ?? baseRef, commit]));
}

export function roundRef(flow: FlowRun, owner: CloneOwner, round: number): string {
  return `refs/agentic/${flow.state.slug}/${owner.name}/r${round}`;
}

/**
 * Rollback: a fresh clone at `commit` replaces the agent's one — git on the host never runs in a clone
 * an agent touched — and the work branch goes back with it.
 */
export function restartClone(flow: FlowRun, owner: CloneOwner, clone: CloneState, commit: string): void {
  const { clonePath, branch } = cloneOf(owner, clone);
  const repoPath = resolveRepo(clone.repo ?? owner.repo, flow.state.origin);
  const discardedPath = `${clonePath}.discarded`;
  fs.rmSync(discardedPath, { recursive: true, force: true });
  if (fs.existsSync(clonePath)) fs.renameSync(clonePath, discardedPath);
  cloneForGroup({ repoPath, clonePath, branch, baseRef: commit });
  fs.rmSync(discardedPath, { recursive: true, force: true });
  hostGit(repoPath, ['update-ref', `refs/heads/${branch}`, commit]);
  clone.head = commit;
  flow.save();
  flow.log(`Clone ${owner.label} restored from ${commit.slice(0, 12)}`);
}

/** Once the owner's work is in the user's repo, its clone goes. */
export function removeClone(flow: FlowRun, owner: CloneOwner, clone: CloneState): void {
  if (!clone.clonePath) return;
  fs.rmSync(clone.clonePath, { recursive: true, force: true });
  delete clone.clonePath;
  clone.clone_removed = true;
  flow.save();
  flow.log(`Clone ${owner.label} removed; changes on ${clone.branch}`);
}

/**
 * The clone and its base go (before the owner's own sessions), so the next `prepareClone` starts from the current base.
 * `quiet` for an accepted merge: its clone was only for the merge, the next line names the one the owner works in.
 */
export function discardClone(flow: FlowRun, owner: CloneOwner, clone: CloneState, quiet = false): void {
  if (clone.clonePath) fs.rmSync(clone.clonePath, { recursive: true, force: true });
  for (const field of ['repo', 'branch', 'baseRef', 'clonePath', 'head'] as const) delete clone[field];
  flow.save();
  if (!quiet) flow.log(`Clone ${owner.label} discarded; the next start uses the current base`);
}

function cloneOf(owner: CloneOwner, clone: CloneState): Required<Pick<CloneState, 'clonePath' | 'baseRef' | 'branch'>> {
  const { clonePath, baseRef, branch } = clone;
  if (!clonePath || !baseRef || !branch) throw new Error(`clone ${owner.label}: no clone`);
  return { clonePath, baseRef, branch };
}
