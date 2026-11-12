import fs from 'node:fs';
import path from 'node:path';
import { hostGit, resolveRepo } from './repos.js';
import type { FlowState } from './state.js';

/**
 * Directories a flow works in. What stays for audit are the files beside them: state, ticket, spec, tasks,
 * review reports, `pr.md`, `usage.jsonl`, `events.jsonl`.
 */
const WORK_DIRS = ['clones', 'out', 'bin', 'checks', 'harness', 'transcripts'];

export interface WorkBranch {
  repo: string;
  /** `refs/heads/agentic/<slug>/<name>` */
  ref: string;
  tip: string;
  /** Commits no ref outside the flow holds (other branches, tags, remotes, the published head): work lost with the branch. */
  onlyHere: number;
  /** Checked out in the repo: never removed. */
  current: boolean;
}

/** What `clean` would remove for one flow, or for work branches whose flow directory is gone (`workDir` absent). */
export interface Cleanup {
  slug: string;
  workDir?: string;
  dirs: Array<{ path: string; bytes: number }>;
  hiddenRefs: Array<{ repo: string; ref: string }>;
  branches: WorkBranch[];
}

export interface CleanupResult {
  removedBranches: WorkBranch[];
  keptBranches: WorkBranch[];
}

export function flowCleanup(workDir: string, state: FlowState): Cleanup {
  const repos = new Set([state.origin.repoRoot, ...Object.values(state.groups).flatMap((group) => (group.repo ? [resolveRepo(group.repo, state.origin)] : []))]);
  return {
    ...repoLeftovers(state.slug, [...repos].filter((repo) => fs.existsSync(repo)), state.published?.head),
    workDir,
    dirs: WORK_DIRS.map((name) => path.join(workDir, name))
      .filter((dir) => fs.existsSync(dir) && fs.readdirSync(dir).length)
      .map((dir) => ({ path: dir, bytes: diskUsage(dir) })),
  };
}

/** Work branches and hidden refs in `repo` of flows not in `knownSlugs` (their directory was removed by hand). */
export function orphanCleanups(repo: string, knownSlugs: Set<string>): Cleanup[] {
  const refs = hostGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/agentic/', 'refs/agentic/']).split('\n').filter(Boolean);
  const slugs = new Set(refs.map((ref) => ref.replace(/^refs\/(heads\/)?agentic\//, '').split('/')[0]!));
  return [...slugs]
    .filter((slug) => !knownSlugs.has(slug))
    .sort()
    .map((slug) => ({ ...repoLeftovers(slug, [repo]), dirs: [] }));
}

export function isEmpty(cleanup: Cleanup): boolean {
  return !cleanup.dirs.length && !cleanup.hiddenRefs.length && !cleanup.branches.length;
}

/**
 * Removes the work directories and hidden refs, and the work branches whose commits are elsewhere; with
 * `dropWork` also those holding the only copy of some work. A checked-out branch always stays.
 */
export function applyCleanup(cleanup: Cleanup, options: { dropWork: boolean }): CleanupResult {
  const result: CleanupResult = { removedBranches: [], keptBranches: [] };
  for (const branch of cleanup.branches) {
    if (branch.current || (branch.onlyHere && !options.dropWork)) {
      result.keptBranches.push(branch);
      continue;
    }
    // with the tip as the old value: a branch moved since the plan stays
    hostGit(branch.repo, ['update-ref', '-d', branch.ref, branch.tip]);
    result.removedBranches.push(branch);
  }
  for (const { repo, ref } of cleanup.hiddenRefs) hostGit(repo, ['update-ref', '-d', ref]);
  if (cleanup.workDir) for (const name of WORK_DIRS) fs.rmSync(path.join(cleanup.workDir, name), { recursive: true, force: true });
  return result;
}

function repoLeftovers(slug: string, repos: string[], publishedHead?: string): Omit<Cleanup, 'dirs'> {
  const hiddenRefs = repos.flatMap((repo) => refsUnder(repo, `refs/agentic/${slug}/`).map((ref) => ({ repo, ref })));
  const branches = repos.flatMap((repo) => {
    const current = currentBranch(repo);
    return refsUnder(repo, `refs/heads/agentic/${slug}/`).map((ref) => {
      const tip = hostGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
      return { repo, ref, tip, onlyHere: commitsOnlyIn(repo, slug, tip, publishedHead), current: ref === current };
    });
  });
  return { slug, hiddenRefs, branches };
}

function commitsOnlyIn(repo: string, slug: string, tip: string, publishedHead?: string): number {
  const elsewhere = [`--exclude=agentic/${slug}/*`, '--branches', '--tags', '--remotes'];
  const published = publishedHead && knownCommit(repo, publishedHead);
  const only = hostGit(repo, ['rev-list', tip, '--not', ...elsewhere, ...(published ? [published] : [])]).split('\n').filter(Boolean);
  if (!only.length || !published) return only.length;
  // publish rebased the work onto a moved target: the pushed branch has the same patches under new ids
  const copied = new Set(hostGit(repo, ['cherry', published, tip]).split('\n').flatMap((line) => (line.startsWith('- ') ? [line.slice(2)] : [])));
  return only.filter((commit) => !copied.has(commit)).length;
}

/** The published head may be pruned from this repo. */
function knownCommit(repo: string, commit: string): string | undefined {
  try {
    return hostGit(repo, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  } catch {
    return undefined;
  }
}

function refsUnder(repo: string, prefix: string): string[] {
  return hostGit(repo, ['for-each-ref', '--format=%(refname)', prefix]).split('\n').filter(Boolean);
}

function currentBranch(repo: string): string | undefined {
  try {
    return hostGit(repo, ['symbolic-ref', '--quiet', 'HEAD']);
  } catch {
    return undefined;
  }
}

/** Bytes of the files under `dir`, symlinks not followed. */
function diskUsage(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    try {
      bytes += fs.lstatSync(path.join(entry.parentPath, entry.name)).size;
    } catch {
      // gone while counting
    }
  }
  return bytes;
}
