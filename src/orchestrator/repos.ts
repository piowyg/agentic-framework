import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from '../config/git.js';
import type { FlowOrigin } from './state.js';

/** Neither hooks nor fsmonitor may run code from a repository's own config. */
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * Directory of a `tasks.yaml` repo name. Names are identifiers, never paths:
 * `.` or the origin repo's own name → the origin repo; in a workspace → `services/<name>`.
 * TODO: resolve through repos.yaml.
 */
export function resolveRepo(name: string, origin: FlowOrigin): string {
  if (name === '.' || name === path.basename(origin.repoRoot)) return origin.repoRoot;
  if (origin.workspaceRoot) {
    const candidate = path.join(origin.workspaceRoot, 'services', name);
    if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
  }
  const known = origin.workspaceRoot ? `\`.\`, \`${path.basename(origin.repoRoot)}\` or a repo from ${path.join(origin.workspaceRoot, 'services')}` : `\`.\` or \`${path.basename(origin.repoRoot)}\``;
  throw new Error(`repo \`${name}\` unknown; allowed: ${known}`);
}

/** Commit the repo's HEAD points at; a group branches off it when the flow has no PR target. */
export function headCommit(repoPath: string): string {
  try {
    return git(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    throw new Error(`${repoPath}: not a git repository with at least one commit`);
  }
}

/**
 * Local clone of `repoPath` on a new `branch` at `baseRef`. Built in a temp directory and renamed,
 * so an interrupted clone never looks finished. Git runs here only before any agent touched the clone.
 */
export function cloneForGroup(spec: { repoPath: string; clonePath: string; branch: string; baseRef: string }): void {
  const tempPath = `${spec.clonePath}.tmp`;
  fs.rmSync(tempPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(spec.clonePath), { recursive: true });
  git(path.dirname(spec.clonePath), ['clone', '--quiet', '--local', '--no-checkout', spec.repoPath, tempPath]);
  git(tempPath, ['checkout', '--quiet', '-b', spec.branch, spec.baseRef]);
  fs.renameSync(tempPath, spec.clonePath);
}

/** Git on the host, with hooks and fsmonitor off. Only ever in the user's repo or a clone no agent touched. */
export function hostGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return git(cwd, args, env);
}

/** Merge commits the orchestrator makes itself are signed as the framework, not as the user. */
export const AGENTIC_IDENTITY = { GIT_AUTHOR_NAME: 'agentic', GIT_AUTHOR_EMAIL: 'agentic@localhost', GIT_COMMITTER_NAME: 'agentic', GIT_COMMITTER_EMAIL: 'agentic@localhost' };

/**
 * `git rebase --rebase-merges --onto <onto> <upstream>` in `clonePath`; the orchestrator commits as the framework, as it
 * signs its merges, authors stay. `picks`: commits replayed after the branch's own, appended to an interactive rebase's
 * todo (a commit that comes out empty is dropped).
 */
export function rebaseOnto(clonePath: string, onto: string, upstream: string, gitOptions: string[] = [], picks: string[] = []): SpawnSyncReturns<string> {
  const env: Record<string, string> = { ...gitEnv(), GIT_COMMITTER_NAME: AGENTIC_IDENTITY.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: AGENTIC_IDENTITY.GIT_COMMITTER_EMAIL };
  const interactive: string[] = [];
  if (picks.length) {
    for (const commit of picks) if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`rebase: \`${commit}\` is not a full commit SHA`);
    // git runs it as `<editor> <todo file>`: the picks land after the branch's own; the user's own config stays out
    env.GIT_SEQUENCE_EDITOR = `printf 'pick %s\\n' ${picks.join(' ')} >>`;
    interactive.push('--interactive', '--no-autosquash', '--no-update-refs', '--empty=drop');
  }
  return spawnSync('git', [...SAFE_GIT, 'rebase', '--quiet', '--rebase-merges', ...interactive, ...gitOptions, '--onto', onto, upstream], { cwd: clonePath, env, encoding: 'utf8' });
}

/** A rebase stopped (on conflicts, or by the human) and not finished or aborted yet. */
export function rebaseInProgress(clonePath: string): boolean {
  return ['rebase-merge', 'rebase-apply'].some((dir) => fs.existsSync(path.join(clonePath, '.git', dir)));
}

/**
 * Merges `theirs` into `ours` without a working tree (`git merge-tree --write-tree`, git ≥ 2.38).
 * Returns the merged tree, or undefined on conflicts.
 */
export function mergeTree(repoPath: string, ours: string, theirs: string): string | undefined {
  const result = spawnSync('git', [...SAFE_GIT, 'merge-tree', '--write-tree', '--no-messages', ours, theirs], { cwd: repoPath, env: gitEnv(), encoding: 'utf8' });
  if (result.status === 0) return result.stdout.split('\n')[0]!.trim();
  if (result.status === 1) return undefined;
  throw new Error(`git merge-tree: ${(result.stderr || result.error?.message || '').trim()}`);
}

/** `git merge-base --is-ancestor`: exit 1 is a plain no. */
export function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/** Conflict markers the lines added from `from` to `to` hold (`git diff --check`), as `file:line: …`. */
export function conflictMarkers(repoPath: string, from: string, to: string): string[] {
  const result = spawnSync('git', [...SAFE_GIT, 'diff', '--check', from, to], { cwd: repoPath, env: gitEnv(), encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 2) throw new Error(`git diff --check: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split('\n').filter((line) => line.includes('leftover conflict marker'));
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', [...SAFE_GIT, ...args], {
    cwd,
    env: { ...gitEnv(), ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
