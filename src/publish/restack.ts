import fs from 'node:fs';
import path from 'node:path';
import { prLanguage } from '../config/language.js';
import type { AgenticConfig, ForgeConfig } from '../config/types.js';
import { approvedGroups } from '../orchestrator/artifacts.js';
import { appendEvent } from '../orchestrator/events.js';
import { acquireLock } from '../orchestrator/lock.js';
import { hostGit, isAncestor } from '../orchestrator/repos.js';
import { removeClones, removeRestackRefs, type RebuiltBranch, type RestackRequest } from '../orchestrator/restack-rebase.js';
import { loadState, saveState, type FlowState, type PublishedPullRequest } from '../orchestrator/state.js';
import { plural } from '../plural.js';
import { PR_LABEL, prDescription } from './description.js';
import { createForge, forgeToken, type Fetch, type Forge, type PullRequestState } from './forge.js';
import { measure, originRemote, ticketOf } from './publish.js';
import { stackGroupOf, stackPosition, type StackEntry } from './stack.js';

/** One PR of the stack as `restack` leaves it. */
export interface RestackPull {
  group: string;
  branch: string;
  title: string;
  url?: string;
  /** `merged`: in the target already (now or by an earlier restack); `rebuilt`: force-pushed onto what's under it now. */
  status: 'merged' | 'rebuilt' | 'unchanged';
  /** Its branch's head after the restack (the merged ones: as last published). */
  head: string;
  /** Commits the human pushed onto it since the last publish: they ride along. */
  humanCommits: number;
  /** Conflicted files a `merge` session (or the human) resolved in the rebuild. */
  resolved?: string[];
  /** The new lowest PR: its base moves to the target and, a draft, it is marked ready for review. */
  becomesLowest?: boolean;
}

/** What `restack` is about to do; the human confirms it before anything is force-pushed. */
export interface RestackPlan {
  slug: string;
  base: string;
  /** The whole stack, bottom first. */
  pulls: RestackPull[];
  /** Merged now, since the last publish or restack. */
  newlyMerged: string[];
  /** Branches force-pushed (`--force-with-lease` on what `origin` has now). */
  push: string[];
}

export interface RestackOptions {
  workDir: string;
  config: AgenticConfig;
  forge?: ForgeConfig;
  profileName?: string;
  framework: string;
  /** Rebuilds the open PRs' branches in clones, with checks and conflicts resolved (`rebuildStack`). */
  rebuild: (request: RestackRequest) => Promise<RebuiltBranch[]>;
  confirm: (plan: RestackPlan) => Promise<boolean>;
  log: (message: string) => void;
  fetcher?: Fetch;
  token?: typeof forgeToken;
}

export interface RestackResult {
  plan: RestackPlan;
  /** False: the stack was up to date, or the human declined. */
  pushed: boolean;
}

/**
 * `agentic restack <slug>` (design: pr-stack): the stack's PRs as the forge sees them; after the lowest ones merged
 * (any way: squash, merge, rebase), the rest rebuilt onto the target with `rebase --onto`, and a PR whose lower one got
 * the human's commits rebuilt onto them. Then one atomic force-push (leased on what `origin` has), the new lowest PR
 * moved onto the target and out of draft, and every open PR's list updated. Undefined when there is nothing to do.
 */
export async function restackFlow(options: RestackOptions): Promise<RestackResult | undefined> {
  const release = acquireLock(options.workDir);
  try {
    return await restackLocked(options);
  } finally {
    release();
  }
}

async function restackLocked(options: RestackOptions): Promise<RestackResult | undefined> {
  const { workDir, log } = options;
  const state = loadState(workDir);
  const published = state.published;
  if (!published?.stack) throw new Error(`Flow \`${state.slug}\` has no published stack of PRs; restack works on a stack (\`agentic publish\` with a chain of groups).`);
  const forgeConfig = options.forge ?? { type: 'none' as const };
  if (forgeConfig.type === 'none') throw new Error(`restack reads PR state from the forge, but profile ${options.profileName ?? '(none)'} has no \`forge\`; add one in ~/.agentic/config.yaml.`);
  const repo = state.origin.repoRoot;
  const remote = originRemote(repo);
  const { base } = published;
  const stack = published.stack;
  const forge = createForge(forgeConfig, remote, await (options.token ?? forgeToken)(forgeConfig, remote.host), options.fetcher);
  if (!forge) throw new Error(`forge ${forgeConfig.type}: restack doesn't support it.`);

  const remoteHeads = fetchStack(repo, base, stack);
  const statuses = await Promise.all(stack.map((pull) => (pull.merged ? undefined : forge.pullRequestState(pull.branch))));
  const lowestOpen = classify(stack, statuses, remoteHeads, base, repo);
  const newlyMerged = stack.filter((pull, index) => !pull.merged && index < lowestOpen).map((pull) => pull.branch);
  if (lowestOpen === stack.length) {
    markMerged(state, stack, lowestOpen);
    saveState(workDir, state);
    log(`All PRs of the stack merged (${stack.length}); nothing to rebuild.`);
    return undefined;
  }
  const target = hostGit(repo, ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
  const open = stack.slice(lowestOpen);
  const request: RestackRequest = {
    repo,
    base,
    // the target is the new base only when a PR under the lowest open one merged now: a target that merely moved is no reason to push
    ...(newlyMerged.length && { onto: target }),
    branches: open.map((pull, index) => ({
      group: pull.group,
      branch: pull.branch,
      upstream: stack[lowestOpen + index - 1]?.head ?? state.target?.commit ?? target,
      remoteHead: remoteHeads.get(pull.branch)!,
    })),
    retry: `agentic restack ${state.slug}`,
  };
  const rebuilt = await options.rebuild(request);
  const lowestBefore = published.lowest ?? stack.find((pull) => !pull.merged)?.branch;
  const lowestStatus = statuses[lowestOpen];
  const lowestMoves = open[0]!.branch !== lowestBefore || (lowestStatus?.base !== undefined && lowestStatus.base !== base);
  const plan: RestackPlan = {
    slug: state.slug,
    base,
    newlyMerged,
    push: rebuilt.filter((branch) => branch.moved).map((branch) => branch.branch),
    pulls: stack.map((pull, index): RestackPull => {
      const title = pull.title ?? pull.branch;
      if (index < lowestOpen) return { group: pull.group, branch: pull.branch, title, ...(pull.url && { url: pull.url }), status: 'merged', head: pull.head, humanCommits: 0 };
      const result = rebuilt[index - lowestOpen]!;
      const source = remoteHeads.get(pull.branch)!;
      return {
        group: pull.group,
        branch: pull.branch,
        title,
        ...(pull.url && { url: pull.url }),
        status: result.moved ? 'rebuilt' : 'unchanged',
        head: result.head,
        humanCommits: Number(hostGit(repo, ['rev-list', '--count', `${pull.head}..${source}`])),
        ...(result.resolved?.length && { resolved: result.resolved }),
        ...(index === lowestOpen && lowestMoves && { becomesLowest: true }),
      };
    }),
  };
  if (!plan.push.length && !newlyMerged.length && !lowestMoves) {
    log('Stack up to date: nothing merged, and each PR sits on the one below it.');
    finishRebuild(state, repo);
    saveState(workDir, state);
    return { plan, pushed: false };
  }
  if (!(await options.confirm(plan))) return { plan, pushed: false };

  forcePush(repo, plan, remoteHeads);
  for (const branch of plan.push) log(`Pushed (force) ${plan.pulls.find((pull) => pull.branch === branch)!.head.slice(0, 12)} → origin/${branch}`);
  markMerged(state, stack, lowestOpen);
  for (const [index, pull] of open.entries()) {
    pull.head = rebuilt[index]!.head;
    pull.base = index ? open[index - 1]!.branch : base;
  }
  published.head = open.at(-1)!.head;
  published.restacked = new Date().toISOString();
  if (request.onto) state.target = { branch: base, commit: request.onto };
  finishRebuild(state, repo);
  moveFeatureBranch(repo, state, published.head);
  saveState(workDir, state);

  await updatePulls({ forge, state, options, lowestOpen, lowestMoves });
  saveState(workDir, state);
  appendEvent(workDir, state.slug, { type: 'flow_restacked', merged: newlyMerged.length, pushed: plan.push.length, ...(published.url && { url: published.url }) });
  return { plan, pushed: true };
}

/** `origin`'s target and the open PRs' branches, fetched; their heads by branch (a deleted one is absent). */
function fetchStack(repo: string, base: string, stack: PublishedPullRequest[]): Map<string, string> {
  const open = stack.filter((pull) => !pull.merged);
  const heads = new Map(
    hostGit(repo, ['ls-remote', 'origin', ...open.map((pull) => `refs/heads/${pull.branch}`)])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, ref] = line.split(/\s+/);
        return [ref!.replace('refs/heads/', ''), commit!] as const;
      }),
  );
  const refspecs = [base, ...open.map((pull) => pull.branch).filter((branch) => heads.has(branch))].map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  hostGit(repo, ['fetch', '--quiet', '--no-tags', 'origin', ...refspecs]);
  return heads;
}

/**
 * The index of the lowest open PR (the stack's length: all merged). Refuses what restack can't rebuild safely: a PR
 * closed without merging, a merged one above an open one or into another branch than the target, an open one whose
 * branch is gone or no longer holds what was published (its history rewritten).
 */
function classify(stack: PublishedPullRequest[], statuses: Array<PullRequestState | undefined>, remoteHeads: Map<string, string>, base: string, repo: string): number {
  let lowestOpen = stack.length;
  for (const [index, pull] of stack.entries()) {
    if (pull.merged) {
      if (lowestOpen < index) throw new Error(`state: ${pull.branch} marked merged above an open PR; restack can't tell where to start.`);
      continue;
    }
    const status = statuses[index];
    const name = `PR ${index + 1}/${stack.length} (${pull.branch}${status?.url ? `, ${status.url}` : ''})`;
    if (!status) throw new Error(`${name}: the forge knows no PR for this branch; restack has nothing to rebuild.`);
    if (status.status === 'closed') throw new Error(`${name} closed without a merge; reopen it or close the whole stack; restack pushed nothing.`);
    if (status.status === 'merged') {
      if (lowestOpen < index) throw new Error(`${name} merged while the PR below it is open; its changes are in that PR's branch; restack can't untangle this.`);
      if (status.base && status.base !== base) throw new Error(`${name} merged into ${status.base}, not into ${base}; restack can't untangle this.`);
      continue;
    }
    if (lowestOpen > index) lowestOpen = index;
    const head = remoteHeads.get(pull.branch);
    if (!head) throw new Error(`${name} open, but its branch is not on origin; restack pushed nothing.`);
    if (!isAncestor(repo, pull.head, head)) {
      throw new Error(`origin/${pull.branch} doesn't contain ${pull.head.slice(0, 12)}, which agentic pushed; someone rewrote its history; restack won't overwrite it.`);
    }
  }
  return lowestOpen;
}

function markMerged(state: FlowState, stack: PublishedPullRequest[], lowestOpen: number): void {
  for (const pull of stack.slice(0, lowestOpen)) pull.merged = true;
  state.published!.lowest = stack[lowestOpen]?.branch ?? state.published!.lowest;
}

/** The rebuilt branches went out (or there was nothing to rebuild): their clones and refs go with the progress record. */
function finishRebuild(state: FlowState, repo: string): void {
  for (const entry of state.restack?.branches ?? []) removeClones(entry);
  removeRestackRefs(repo, state.slug);
  delete state.restack;
}

/** One atomic push of the rebuilt branches, each leased on what `origin` had when the restack started. */
function forcePush(repo: string, plan: RestackPlan, remoteHeads: Map<string, string>): void {
  if (!plan.push.length) return;
  const pulls = plan.push.map((branch) => plan.pulls.find((pull) => pull.branch === branch)!);
  const leases = pulls.map((pull) => `--force-with-lease=refs/heads/${pull.branch}:${remoteHeads.get(pull.branch)}`);
  hostGit(repo, ['push', '--quiet', ...(pulls.length > 1 ? ['--atomic'] : []), ...leases, 'origin', ...pulls.map((pull) => `${pull.head}:refs/heads/${pull.branch}`)]);
}

/** The flow's final review branch, if still in the repo, follows the top PR: the human's repo shows what `origin` has. */
function moveFeatureBranch(repo: string, state: FlowState, head: string): void {
  const branch = state.final_review?.branch;
  if (!branch) return;
  try {
    hostGit(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    return;
  }
  hostGit(repo, ['update-ref', '-m', 'agentic restack', `refs/heads/${branch}`, head]);
}

/**
 * Every open PR updated in turn: the lowest onto the target and, when it just became the lowest, out of draft; each
 * list with the merged ones struck through. A failed update is a warning: the push is done, the body is on disk.
 */
async function updatePulls(input: { forge: Forge; state: FlowState; options: RestackOptions; lowestOpen: number; lowestMoves: boolean }): Promise<void> {
  const { forge, state, options, lowestOpen } = input;
  const { workDir, log } = options;
  const published = state.published!;
  const stack = published.stack!;
  const repo = state.origin.repoRoot;
  const ticket = ticketOf(workDir, state);
  const plan = new Map(approvedGroups(workDir).map((group) => [group.id, group]));
  const entries = stack.map((pull): StackEntry => ({
    group: stackGroupOf(pull.group, plan.get(pull.group)),
    branch: pull.branch,
    url: pull.url,
    merged: pull.merged,
    notesOf: pull.notes_of ?? [pull.group],
    sizeWarning: state.groups[pull.group]?.size?.warning,
  }));
  const specFile = path.join(workDir, 'spec.md');
  const specText = fs.existsSync(specFile) ? fs.readFileSync(specFile, 'utf8') : undefined;
  const target = `refs/remotes/origin/${published.base}`;
  const position = (index: number) => `${index + 1}/${stack.length}`;
  for (const [index, pull] of stack.entries()) {
    if (index < lowestOpen) continue;
    const from = index === lowestOpen ? target : stack[index - 1]!.head;
    const { danger, size } = measure(repo, from, pull.head, options.config);
    const body = prDescription({ state, language: prLanguage(options.config.language), ticket, specText, danger, size, framework: options.framework, profile: options.profileName, stack: stackPosition(entries, index) });
    fs.writeFileSync(path.join(workDir, `pr-${index + 1}.md`), body);
    const ready = index === lowestOpen && input.lowestMoves;
    try {
      const opened = await forge.openPullRequest({ head: pull.branch, base: pull.base, title: pull.title ?? pull.branch, body, labels: [PR_LABEL], ...(ready && { ready }) });
      pull.url = opened.url;
      if (index === lowestOpen) {
        published.lowest = pull.branch;
        published.url = opened.url;
      }
      for (const warning of opened.warnings) log(`! ${warning}`);
      log(`PR updated ${position(index)}: ${opened.url}${index === lowestOpen && input.lowestMoves ? `; now the lowest, into ${published.base}${opened.readied ? ', out of draft and ready for review' : ''}` : ''}`);
    } catch (error) {
      log(`! PR ${position(index)} (${pull.branch}) not updated (body and base): ${(error as Error).message}; the branches are already pushed, fix it by hand (body: pr-${index + 1}.md)`);
    }
    saveState(workDir, state);
  }
  const mergedCount = stack.filter((pull) => pull.merged).length;
  if (mergedCount) log(`Stack: ${mergedCount} merged, ${stack.length - mergedCount} open.`);
}
