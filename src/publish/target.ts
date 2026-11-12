import { hostGit } from '../orchestrator/repos.js';
import type { FlowTarget } from '../orchestrator/state.js';

/**
 * The branch the PR goes into, chosen when the flow starts: tests, baseline and review run from the
 * start on the code the PR lands on, not on the human's local HEAD. A repo without `origin` has none (the flow
 * starts at HEAD). `branch` defaults to `origin`'s default branch.
 */
export function flowTarget(repo: string, branch?: string): FlowTarget | undefined {
  if (!hasOrigin(repo)) {
    if (branch) throw new Error(`--base ${branch}: the repo has no \`origin\` remote; the flow starts from HEAD, without a target branch.`);
    return undefined;
  }
  const name = branch ?? defaultBranch(repo);
  return { branch: name, commit: fetchTarget(repo, name) };
}

/** `origin/<branch>` fetched now; offline, the last fetched one. */
export function fetchTarget(repo: string, branch: string): string {
  const ref = `refs/remotes/origin/${branch}`;
  try {
    hostGit(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`]);
  } catch (error) {
    const known = knownCommit(repo, ref);
    if (!known) throw new Error(`Could not fetch origin/${branch}: ${(error as Error).message.split('\n')[0]}`);
    return known;
  }
  return hostGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export function defaultBranch(repo: string): string {
  try {
    return hostGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    throw new Error("origin's default branch is unknown; give one: --base <branch> (or `git remote set-head origin --auto`).");
  }
}

function hasOrigin(repo: string): boolean {
  try {
    hostGit(repo, ['config', '--get', 'remote.origin.url']);
    return true;
  } catch {
    return false;
  }
}

function knownCommit(repo: string, ref: string): string | undefined {
  try {
    return hostGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}
