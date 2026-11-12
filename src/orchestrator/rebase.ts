import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from '../config/git.js';
import { checkCommands, describeFailures, passed, rerunFailed, runChecks } from './checks.js';
import { cloneForGroup, hostGit, isAncestor, rebaseOnto, SAFE_GIT } from './repos.js';
import { FlowRun, Halt, type FlowContext } from './run.js';
import { knownRed, loadState, type FlowState } from './state.js';

export interface RebaseRequest {
  /** The user's repo. */
  repo: string;
  /** The PR's target branch, for the messages. */
  base: string;
  /** `origin/<base>` now. */
  onto: string;
  /** Where the feature's commits start: the target's tip the flow started on (or was last rebased onto). */
  upstream: string;
  head: string;
  /** The stack's group heads, bottom first (all ancestors of `head`), carried onto the rebased commits; the top group's PR takes `head`. */
  stack?: StackHead[];
}

export interface StackHead {
  group: string;
  head: string;
}

export interface RebaseResult {
  head: string;
  /** Where each of the request's `stack` heads landed, in the same order. */
  stack: string[];
}

/**
 * `publish` after the target moved: the feature's commits rebased onto the target's new tip in a fresh
 * clone no agent touched, then `review.checks` there (without the ones known red on the flow's base): on the head of
 * each of the stack's lower PRs, bottom first, then on the feature's head — every PR's own code is green, not only the top one's. Returns
 * the new head, its objects fetched into the user's repo, and where the stack's lower heads landed (`--update-refs`).
 * A conflict or red checks throw: nothing in the repo changes.
 */
export async function rebaseFeature(context: FlowContext, request: RebaseRequest): Promise<RebaseResult> {
  const state = loadState(context.workDir);
  const flow = new FlowRun(context, state);
  const clonePath = path.join(context.workDir, 'clones', '_rebase');
  const branch = `agentic/${state.slug}/_rebase`;
  fs.rmSync(clonePath, { recursive: true, force: true });
  cloneForGroup({ repoPath: request.repo, clonePath, branch, baseRef: request.head });
  try {
    // a group with nothing past the old tip lies outside the rebased range, which `--update-refs` would leave behind: it lands on the new tip
    const stack = (request.stack ?? []).map((entry, index) => ({
      ...entry,
      ref: isAncestor(clonePath, entry.head, request.upstream) ? undefined : `refs/heads/agentic-stack/${index + 1}`,
    }));
    for (const { ref, head } of stack) if (ref) hostGit(clonePath, ['update-ref', ref, head]);
    const conflicts = rebase(clonePath, request);
    if (conflicts) {
      throw new Error(
        [
          `origin/${request.base} moved, and the flow's work conflicts with it (${conflicts.join(', ') || 'rebase stopped'}); nothing pushed.`,
          `Move it yourself: git rebase --rebase-merges --onto origin/${request.base} ${request.upstream.slice(0, 12)} <flow branch>, run checks, then agentic publish ${state.slug}.`,
        ].join('\n'),
      );
    }
    const commands = verifiedCommands(context, state);
    // the top group's PR takes the whole feature's head (the final review's fixes land there): the lower ones get their own
    const lowerWithCommits = stack.slice(0, -1).filter((entry) => entry.ref);
    for (const { group, ref } of lowerWithCommits) {
      hostGit(clonePath, ['checkout', '--quiet', '--force', '--detach', ref!]);
      await checkRebased(flow, clonePath, request, commands, group);
    }
    if (lowerWithCommits.length) hostGit(clonePath, ['checkout', '--quiet', '--force', branch]);
    await checkRebased(flow, clonePath, request, commands);
    const head = hostGit(clonePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    // forced: a publish stopped after an earlier rebase left its head here, and this rebase made new commits
    hostGit(request.repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', clonePath, `+HEAD:refs/agentic/${state.slug}/rebased`]);
    return { head, stack: stack.map(({ ref }) => (ref ? hostGit(clonePath, ['rev-parse', '--verify', `${ref}^{commit}`]) : request.onto)) };
  } catch (error) {
    // checks without the human's consent on the host pause a flow; here they only stop the publish
    if (error instanceof Halt) throw new Error(error.message);
    throw error;
  } finally {
    fs.rmSync(clonePath, { recursive: true, force: true });
  }
}

/** `review.checks` on what the clone has checked out (a lower group's head, else the feature's); red ones throw before anything is pushed. */
async function checkRebased(flow: FlowRun, clonePath: string, request: RebaseRequest, commands: string[], lowerGroup?: string): Promise<void> {
  if (!commands.length) return;
  const scope = { owner: '_rebase', label: `onto-${request.onto.slice(0, 8)}${lowerGroup ? `-${lowerGroup}` : ''}` };
  const runs = await rerunFailed(flow, clonePath, scope, await runChecks(flow, clonePath, scope, commands));
  const red = runs.filter((run) => !passed(run));
  if (red.length) {
    throw new Error(`checks red after the rebase onto origin/${request.base}${lowerGroup ? ` (code of group ${lowerGroup}, a PR lower in the stack)` : ''}; nothing pushed, the flow branch unchanged:\n${describeFailures(red)}`);
  }
}

/** Undefined when the rebase went through; else the conflicting files (the rebase is aborted). */
function rebase(clonePath: string, request: RebaseRequest): string[] | undefined {
  const result = rebaseOnto(clonePath, request.onto, request.upstream, ['--update-refs']);
  if (result.status === 0) return undefined;
  const env = gitEnv();
  const conflicts = spawnSync('git', [...SAFE_GIT, 'diff', '--name-only', '--diff-filter=U'], { cwd: clonePath, env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  spawnSync('git', [...SAFE_GIT, 'rebase', '--abort'], { cwd: clonePath, env });
  return conflicts;
}

function verifiedCommands(context: FlowContext, state: FlowState): string[] {
  const commands = checkCommands(context.config.review);
  if (commands === 'none') return [];
  const red = knownRed(state);
  return commands.filter((command) => !red.includes(command));
}
