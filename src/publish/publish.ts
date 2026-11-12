import fs from 'node:fs';
import path from 'node:path';
import { prLanguage } from '../config/language.js';
import type { AgenticConfig, ForgeConfig } from '../config/types.js';
import { applyCleanup, flowCleanup } from '../orchestrator/cleanup.js';
import { appendEvent } from '../orchestrator/events.js';
import { APPROVED_TASKS, parseMarkdown, parseTasks, topoOrder } from '../orchestrator/artifacts.js';
import { acquireLock } from '../orchestrator/lock.js';
import type { RebaseRequest, RebaseResult } from '../orchestrator/rebase.js';
import { hostGit, isAncestor, resolveRepo } from '../orchestrator/repos.js';
import { loadState, saveState, type FlowState, type PublishedPullRequest, type PublishedState } from '../orchestrator/state.js';
import { branchVariables, groupBranches, keepGroupBranches, renderBranch } from './branch.js';
import { PR_LABEL, prDescription } from './description.js';
import { createForge, forgeToken, newPullRequestUrl, type Fetch } from './forge.js';
import { mergeDanger, parseNumstat, type MergeDanger } from './merge-danger.js';
import { parseRemote, type RemoteRepo } from './remote.js';
import { gitleaks, type SecretScan } from './secrets.js';
import { diffSizeAt, type DiffSize } from './size.js';
import { stackLayout, stackPosition, type StackGroup, type StackLayout } from './stack.js';
import { defaultBranch } from './target.js';
import { plural } from '../plural.js';

/** A PR about to go out: the whole flow, or one group of a stack (`GroupPull`). */
interface Pull {
  branch: string;
  base: string;
  /** Where its diff starts: `origin/<target>`, or the head of the PR under it. */
  from: string;
  head: string;
  title: string;
  commits: number;
  danger: MergeDanger;
  size: DiffSize;
  bodyFile: string;
  /** All but a stack's lowest go out as drafts: they can't be merged before the one under them. */
  draft: boolean;
  url?: string;
}

/** One PR of a stack. */
interface GroupPull extends Pull {
  group: StackGroup;
  /** Groups whose review notes it carries: its own, and those under it left without a PR of their own. */
  notesOf: string[];
  /** The group's measured size crossed what the plan expected (`GroupSize.warning`). */
  sizeWarning?: string;
}

/** One PR of a stack, as the plan shows it: `base` is the target for the lowest PR, the branch of the one before it for the rest. */
export type StackPullRequest = Omit<Pull, 'from' | 'url'> & { group: string; sizeWarning?: string };

/** What `publish` is about to do; the human confirms it before anything leaves the machine. */
export interface PublishPlan {
  slug: string;
  repo: string;
  /** The branch holding the whole feature: the only PR's, or a stack's top one. */
  branch: string;
  base: string;
  head: string;
  title: string;
  /** Commits the PR brings onto `origin/<base>`. */
  commits: number;
  /** Of those, commits the flow started on that `origin/<base>` doesn't have (local work of the human). */
  foreignCommits: number;
  /** The target moved since the flow started: its new commits the feature was rebased onto (checks green). */
  rebasedOnto?: number;
  /** The whole feature's, whether it goes out as one PR or a stack. */
  danger: MergeDanger;
  /** Lines the reviewer reads: production / tests / excluded, against `publish.size`. */
  size: DiffSize;
  /** The PR body, written next to the flow's artifacts (a stack: its top PR's). */
  bodyFile: string;
  forge: ForgeConfig['type'];
  /** Groups in other repos: not published yet. */
  skippedGroups: string[];
  /** A PR per group, bottom first; absent: one PR of the whole flow. */
  stack?: StackPullRequest[];
  /**
   * Why the flow goes out as one PR although it has several groups: `--single`, `publish.stack: false`, no approved
   * plan, a plan that isn't a chain, or a single group with commits of its own. Free text: the plan's reasons name groups.
   */
  singlePrReason?: string;
}

export interface PublishOptions {
  workDir: string;
  config: AgenticConfig;
  forge?: ForgeConfig;
  profileName?: string;
  framework: string;
  /** The branch the PR goes into; default: the one chosen at flow start, else `origin`'s default branch. */
  base?: string;
  /** One PR of the whole flow this time, whatever `publish.stack` says (`--single`). */
  single?: boolean;
  /** Rebases the feature (and the stack's lower heads) onto the moved target and runs `review.checks` (`rebaseFeature`). */
  rebase?: (request: RebaseRequest) => Promise<RebaseResult>;
  confirm: (plan: PublishPlan) => Promise<boolean>;
  log: (message: string) => void;
  scan?: SecretScan;
  fetcher?: Fetch;
  token?: typeof forgeToken;
}

const PR_BODY_FILE = 'pr.md';

/**
 * `agentic publish`: secret scan → push → PR(s) → cleanup, for the flow's origin repo. A plan whose groups
 * form a chain goes out as a stack: a PR per group, each on the branch of the one before it. Rerunnable: a PR that
 * failed after the push, or a branch pushed again, updates the same PR. Returns undefined when the human declined.
 */
export async function publishFlow(options: PublishOptions): Promise<PublishedState | undefined> {
  const release = acquireLock(options.workDir);
  try {
    return await publishLocked(options);
  } finally {
    release();
  }
}

async function publishLocked(options: PublishOptions): Promise<PublishedState | undefined> {
  const { workDir, config, log } = options;
  const state = loadState(workDir);
  if (state.status !== 'done' || !['ready_to_publish', 'published'].includes(state.outcome ?? '')) {
    throw new Error(`Flow \`${state.slug}\` is not ready to publish (status ${state.status}${state.outcome ? `, outcome ${state.outcome}` : ''}).`);
  }
  // the group heads inside the rebuilt top PR are unknown: publish would see a broken chain and fold the stack into one PR
  if (state.published?.restacked) {
    throw new Error(`Flow \`${state.slug}\`: \`agentic restack\` rebuilt the stack (${state.published.restacked}); restack keeps it up to date now, not publish.`);
  }
  const repo = state.origin.repoRoot;
  const remote = originRemote(repo);
  const base = options.base ?? state.published?.base ?? state.target?.branch ?? defaultBranch(repo);
  hostGit(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  const target = `refs/remotes/origin/${base}`;
  const feature = featureHead(state, repo);
  let { head } = feature;
  const forcedSingle = options.single ? '--single' : !config.publish.stack ? 'publish.stack: false' : undefined;
  const layout = forcedSingle ? { groups: [] } : originLayout(workDir, state, repo, head);
  let stack = layout.groups;
  let rebasedOnto: number | undefined;
  let landRebase: (() => void) | undefined;
  const onto = hostGit(repo, ['rev-parse', '--verify', `${target}^{commit}`]);
  if (state.target && !isAncestor(repo, onto, head)) {
    rebasedOnto = Number(hostGit(repo, ['rev-list', '--count', `${state.target.commit}..${onto}`]));
    log(`origin/${base} has ${plural(rebasedOnto, 'new commit', 'new commits')} since the flow started; moving the work onto ${onto.slice(0, 12)} and running checks`);
    if (!options.rebase) throw new Error(`origin/${base} moved since the flow started, and publish has no way to move the work.`);
    const rebased = await options.rebase({ repo, base, onto, upstream: state.target.commit, head, ...(stack.length && { stack: stack.map((group) => ({ group: group.id, head: group.head })) }) });
    const headBefore = head;
    head = rebased.head;
    stack = stack.map((group, index) => ({ ...group, head: rebased.stack[index]! }));
    // the refs and the state move once no branch on origin stops the publish: a refused one leaves the repo as it was
    landRebase = () => {
      if (feature.branch) hostGit(repo, ['update-ref', '-m', `agentic publish: rebase onto origin/${base}`, `refs/heads/${feature.branch}`, head, headBefore]);
      // the group branches follow, so a rerun finds the stack where it now is and the cleanup sees their work pushed
      for (const group of stack) moveGroupBranch(repo, state, group, base);
      state.target = { branch: base, commit: onto };
      saveState(workDir, state);
      log(`✓ Work moved onto origin/${base}: ${head.slice(0, 12)}`);
    };
  }
  const range = `${target}..${head}`;
  const commits = Number(hostGit(repo, ['rev-list', '--count', range]));
  if (!commits) throw new Error(`Flow \`${state.slug}\`: nothing to publish; origin/${base} already contains ${head.slice(0, 12)}.`);

  const leaks = await (options.scan ?? gitleaks)(repo, range);
  if (leaks.length) {
    throw new Error(
      [
        `gitleaks: ${leaks.length} possible secrets in the flow's commits; nothing pushed:`,
        ...leaks.map((leak) => `  ${leak.file}:${leak.line} (${leak.rule}, commit ${leak.commit.slice(0, 12)})`),
        "Remove them from the branch history (or add false alarms to the repo's .gitleaksignore) and run publish again.",
      ].join('\n'),
    );
  }

  const ticket = ticketOf(workDir, state);
  const title = ticket.trackerKey && !ticket.title.includes(ticket.trackerKey) ? `${ticket.trackerKey} ${ticket.title}` : ticket.title;
  const whole = measure(repo, target, head, config);
  const previousStack = previousPulls(state);
  const previous = new Map(previousStack.map((pull) => [pull.branch, pull]));
  // a publish that failed before the lowest PR opened leaves the one before it; states from before `lowest`: the first
  const lowestBefore = state.published?.lowest ?? previousStack[0]?.branch;
  const outsideStack = Object.keys(state.groups).filter((id) => !stack.some((group) => group.id === id));
  const steps = stackSteps(repo, target, stack, head, outsideStack, log);
  const variables = branchVariables({ subjects: hostGit(repo, ['log', '--format=%s', range]).split('\n'), trackerKey: ticket.trackerKey, title: ticket.title, slug: state.slug });
  const previousBranchOf = new Map((state.published?.stack ?? []).map((pull) => [pull.group, pull.branch]));
  const branches = () => keepGroupBranches(groupBranches(config.git.branch_pattern, variables, steps.map((step) => step.group.title)), steps.map((step) => step.group.id), previousBranchOf);
  const groupPulls = steps.length > 1 ? buildGroupPulls({ repo, workDir, state, config, steps, title, base, previous, branches: branches() }) : undefined;
  const wholeBranch = renderBranch(config.git.branch_pattern, variables);
  const pulls: Pull[] = groupPulls ?? [{ branch: wholeBranch, base, from: target, head, title, ...whole, bodyFile: path.join(workDir, PR_BODY_FILE), draft: false, url: previous.get(wholeBranch)?.url }];
  const collapsedReason = stack.length > 1 && !groupPulls ? `only ${steps[0]?.group.id ?? 'the final review'} has commits of its own` : undefined;
  const singlePrReason = forcedSingle ?? layout.reason ?? collapsedReason;
  const remoteHeads = remoteBranchHeads(repo, pulls);
  refuseForeignBranches(pulls, remoteHeads, previous);
  landRebase?.();

  const specFile = path.join(workDir, 'spec.md');
  const specText = fs.existsSync(specFile) ? fs.readFileSync(specFile, 'utf8') : undefined;
  const body = (index: number): string =>
    prDescription({
      state,
      language: prLanguage(config.language),
      ticket,
      specText,
      danger: pulls[index]!.danger,
      size: pulls[index]!.size,
      framework: options.framework,
      profile: options.profileName,
      ...(groupPulls && { stack: stackPosition(groupPulls, index) }),
    });
  const bodies = pulls.map((pull, index) => writeBody(pull, body(index)));
  const top = pulls.at(-1)!;
  const forgeConfig = options.forge ?? { type: 'none' as const };
  const plan: PublishPlan = {
    slug: state.slug,
    repo,
    branch: top.branch,
    base,
    head,
    title,
    foreignCommits: foreignCommits(state, repo, target),
    ...(rebasedOnto !== undefined && { rebasedOnto }),
    ...whole,
    bodyFile: top.bodyFile,
    forge: forgeConfig.type,
    skippedGroups: Object.entries(state.groups)
      .filter(([, group]) => group.repo && resolveRepo(group.repo, state.origin) !== repo)
      .map(([id]) => id),
    ...(groupPulls && { stack: groupPulls.map(stackPullRequest) }),
    ...(singlePrReason && { singlePrReason }),
  };
  if (!(await options.confirm(plan))) return undefined;

  // a forge that can't give a token stops before the push, not after it
  const forge = forgeConfig.type === 'none' ? undefined : createForge(forgeConfig, remote, await (options.token ?? forgeToken)(forgeConfig, remote.host), options.fetcher);
  const pushed = push(repo, pulls, remoteHeads, previous);
  const published: PublishedState = { branch: top.branch, base, head, at: new Date().toISOString(), ...(lowestBefore && { lowest: lowestBefore }) };
  const record = () => {
    if (pulls[0]!.url) published.url = pulls[0]!.url;
    if (groupPulls) published.stack = groupPulls.map(publishedPullRequest);
    state.published = published;
    saveState(workDir, state);
  };
  state.outcome = 'published';
  record();
  for (const pull of pulls) log(pushed.includes(pull) ? `Pushed ${pull.head.slice(0, 12)} → origin/${pull.branch}` : `origin/${pull.branch} already has ${pull.head.slice(0, 12)}; no push`);
  const dropped = [...previous.keys()].filter((branch) => !pulls.some((pull) => pull.branch === branch));
  if (dropped.length) log(`! The previous publish pushed ${dropped.join(', ')}; that branch is no longer updated, close its PR if it is still open`);

  const lowestOpened = () => (published.lowest = pulls[0]!.branch);
  if (forge) await openPulls({ forge, pulls, bodies, body, record, lowestOpened, log, lowestBefore, stacked: Boolean(groupPulls), retry: `agentic publish ${state.slug}`, pushedSeveral: pushed.length > 1 });
  else {
    log(`! No PR opened: profile ${options.profileName ?? '(none)'} has no \`forge\`; add to the profile in ~/.agentic/config.yaml: forge: { type: github, auth: { from: gh } } (GitLab: type: gitlab, auth: { env: GITLAB_TOKEN })`);
    for (const pull of pulls) {
      const link = newPullRequestUrl(remote, { head: pull.branch, base: pull.base });
      log(link ? `Create the PR: ${link} (body: ${pull.bodyFile})` : `forge: none; create a PR from branch ${pull.branch} into ${pull.base} (body: ${pull.bodyFile})`);
    }
  }
  appendEvent(workDir, state.slug, { type: 'flow_published', branch: top.branch, ...(published.url && { url: published.url }), ...(groupPulls && { pulls: groupPulls.length }) });
  cleanUp(workDir, state, log);
  return published;
}

/** The origin repo's groups as a stack, or why there is none; no approved plan names no chain. */
function originLayout(workDir: string, state: FlowState, repo: string, featureHead: string): StackLayout {
  const file = path.join(workDir, APPROVED_TASKS);
  if (!fs.existsSync(file)) return { groups: [], ...(originGroupStates(state, repo).length > 1 && { reason: `no approved plan (${APPROVED_TASKS})` }) };
  const groups = topoOrder(parseTasks(fs.readFileSync(file, 'utf8')).groups).filter((group) => resolveRepo(group.repo, state.origin) === repo);
  const heads = Object.fromEntries(Object.entries(state.groups).map(([id, group]) => [id, group.head]));
  return stackLayout({ groups, heads, featureHead, isAncestor: (ancestor, descendant) => isAncestor(repo, ancestor, descendant) });
}

/** The state's groups that work in the origin repo. */
function originGroupStates(state: FlowState, repo: string): FlowState['groups'][string][] {
  return Object.values(state.groups).filter((group) => !group.repo || resolveRepo(group.repo, state.origin) === repo);
}

interface StackStep {
  group: StackGroup;
  from: string;
  head: string;
  notesOf: string[];
}

/**
 * Each group's PR: from the head under it to its own head; the top one takes the whole feature's head (the final
 * review's fixes land there). A group without commits of its own gets no PR: its review notes go to the PR above it
 * (the top one, when nothing is above). The top one also carries the notes of groups outside the stack (another repo's).
 */
function stackSteps(repo: string, target: string, stack: StackGroup[], head: string, outsideStack: string[], log: (message: string) => void): StackStep[] {
  const steps: StackStep[] = [];
  let carriedNotes: string[] = [];
  for (const [index, group] of stack.entries()) {
    const from = steps.at(-1)?.head ?? target;
    const own = index === stack.length - 1 ? head : group.head;
    carriedNotes.push(group.id);
    if (Number(hostGit(repo, ['rev-list', '--count', `${from}..${own}`]))) {
      steps.push({ group, from, head: own, notesOf: carriedNotes });
      carriedNotes = [];
    } else log(`Group ${group.id} has no commits of its own: no PR of its own; its review notes go to the PR above`);
  }
  // the top group had nothing of its own: the PR under it carries the feature, and the notes, to the end
  const topStep = steps.at(-1);
  if (topStep) {
    topStep.head = head;
    topStep.notesOf.push(...carriedNotes, ...outsideStack);
  }
  return steps;
}

function buildGroupPulls(input: {
  repo: string;
  workDir: string;
  state: FlowState;
  config: AgenticConfig;
  steps: StackStep[];
  title: string;
  base: string;
  branches: string[];
  previous: Map<string, PreviousPull>;
}): GroupPull[] {
  const { steps, branches } = input;
  return steps.map((step, index) => {
    const sizeWarning = input.state.groups[step.group.id]?.size?.warning;
    return {
      group: step.group,
      notesOf: step.notesOf,
      ...(sizeWarning && { sizeWarning }),
      branch: branches[index]!,
      base: index ? branches[index - 1]! : input.base,
      from: step.from,
      head: step.head,
      title: `${input.title} (${index + 1}/${steps.length}): ${step.group.title}`,
      ...measure(input.repo, step.from, step.head, input.config),
      bodyFile: path.join(input.workDir, `pr-${index + 1}.md`),
      draft: index > 0,
      url: input.previous.get(branches[index]!)?.url,
    };
  });
}

/**
 * Each PR opened (or updated) in turn: its base is pushed already, and the stack's list needs the URLs of the ones
 * before it. Then the lower PRs' lists get the links to those opened after them.
 */
async function openPulls(input: {
  forge: NonNullable<ReturnType<typeof createForge>>;
  pulls: Pull[];
  bodies: string[];
  body: (index: number) => string;
  record: () => void;
  /** The lowest PR is open as the forge should have it: the next publish compares against it. */
  lowestOpened: () => void;
  log: (message: string) => void;
  /** The branch of the last publish's lowest PR: a PR that wasn't the lowest then had all reason to be a draft. */
  lowestBefore: string | undefined;
  /** False for a single PR: publish never opens one as a draft, so a draft one is the human's. */
  stacked: boolean;
  retry: string;
  pushedSeveral: boolean;
}): Promise<void> {
  const { forge, pulls, bodies, log } = input;
  const position = (index: number) => (pulls.length > 1 ? `${index + 1}/${pulls.length}` : '');
  const open = (pull: Pull, body: string, ready: boolean) =>
    forge.openPullRequest({ head: pull.branch, base: pull.base, title: pull.title, body, labels: [PR_LABEL], ...(pull.draft && { draft: true }), ...(ready && { ready }) });
  for (const [index, pull] of pulls.entries()) {
    try {
      // the lowest is the one to review first; a draft the human made of the lowest stays theirs
      const becameLowest = input.stacked && index === 0 && pull.branch !== input.lowestBefore;
      const opened = await open(pull, bodies[index]!, becameLowest);
      pull.url = opened.url;
      if (index === 0) input.lowestOpened();
      input.record();
      for (const warning of opened.warnings) log(`! ${warning}`);
      log(`${opened.created ? 'PR opened' : 'PR updated'}${position(index) && ` ${position(index)}`}: ${opened.url}${opened.readied ? '; now the lowest, out of draft and ready for review' : ''}`);
    } catch (error) {
      throw new Error(`${input.pushedSeveral ? 'Branches pushed' : 'Branch pushed'}, but PR ${position(index) && `${position(index)} `}was not opened: ${(error as Error).message}\nRetry: ${input.retry}`);
    }
  }
  for (const [index, pull] of pulls.entries()) {
    const linkedBody = input.body(index);
    if (linkedBody === bodies[index]) continue;
    bodies[index] = writeBody(pull, linkedBody);
    // an open PR keeps its draft state: no `draft` here
    await open(pull, linkedBody, false).catch((error: Error) => log(`! PR ${position(index)}: stack list without links; ${error.message}`));
  }
}

export function measure(repo: string, from: string, head: string, config: AgenticConfig): { commits: number; danger: MergeDanger; size: DiffSize } {
  const changed = parseNumstat(hostGit(repo, ['diff', '--numstat', '-z', `${from}...${head}`]));
  return {
    commits: Number(hostGit(repo, ['rev-list', '--count', `${from}..${head}`])),
    danger: mergeDanger(changed, config.publish.one_way_paths),
    size: diffSizeAt(repo, head, changed, config.publish.size),
  };
}

function stackPullRequest({ group, from, url, notesOf, ...pull }: GroupPull): StackPullRequest {
  return { ...pull, group: group.id };
}

function publishedPullRequest({ group, branch, base, head, url, title, notesOf }: GroupPull): PublishedPullRequest {
  return { group: group.id, branch, base, head, ...(url && { url }), title, notes_of: notesOf };
}

function writeBody(pull: Pull, body: string): string {
  fs.writeFileSync(pull.bodyFile, body);
  return body;
}

type PreviousPull = Pick<PublishedPullRequest, 'branch' | 'head' | 'url'>;

/** What the last publish pushed: its stack, or its one branch. */
function previousPulls(state: FlowState): PreviousPull[] {
  const published = state.published;
  if (!published) return [];
  return published.stack ?? [{ branch: published.branch, head: published.head, ...(published.url && { url: published.url }) }];
}

/** `origin`'s heads of the PRs' branches; a branch it doesn't have is absent. */
function remoteBranchHeads(repo: string, pulls: Pull[]): Map<string, string> {
  return new Map(
    hostGit(repo, ['ls-remote', 'origin', ...pulls.map((pull) => `refs/heads/${pull.branch}`)])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, ref] = line.split(/\s+/);
        return [ref!.replace('refs/heads/', ''), commit!];
      }),
  );
}

/**
 * A branch on `origin` that this flow never pushed is someone else's: a push would move it (a fast-forward needs no
 * force). Stops before the plan, so nothing leaves the machine.
 */
function refuseForeignBranches(pulls: Pull[], remoteHeads: Map<string, string>, previous: Map<string, PreviousPull>): void {
  const foreign = pulls.filter((pull) => remoteHeads.has(pull.branch) && remoteHeads.get(pull.branch) !== pull.head && !previous.has(pull.branch)).map((pull) => `origin/${pull.branch}`);
  if (!foreign.length) return;
  throw new Error(
    `${foreign.join(', ')} ${foreign.length > 1 ? 'already exist' : 'already exists'}, and no earlier publish of this flow pushed ${foreign.length > 1 ? 'them' : 'it'}; nothing pushed.\n` +
      `Remove ${foreign.length > 1 ? 'them' : 'it'} from origin or change git.branch_pattern and run publish again.`,
  );
}

/**
 * One atomic push of the branches whose remote head differs: a stack updates all its branches or none. Each is leased
 * on what the last publish pushed there, a new one on not existing yet (someone pushing it meanwhile stops the push).
 */
function push(repo: string, pulls: Pull[], remoteHeads: Map<string, string>, previous: Map<string, PreviousPull>): Pull[] {
  const changed = pulls.filter((pull) => remoteHeads.get(pull.branch) !== pull.head);
  if (!changed.length) return [];
  const leases = changed.map((pull) => `--force-with-lease=refs/heads/${pull.branch}:${previous.get(pull.branch)?.head ?? ''}`);
  hostGit(repo, ['push', '--quiet', ...(changed.length > 1 ? ['--atomic'] : []), ...leases, 'origin', ...changed.map((pull) => `${pull.head}:refs/heads/${pull.branch}`)]);
  return changed;
}

/** A group's work branch, still in the repo, moved to where the rebase carried its head. */
function moveGroupBranch(repo: string, state: FlowState, group: StackGroup, base: string): void {
  const groupState = state.groups[group.id];
  if (!groupState) return;
  const previousHead = groupState.head;
  groupState.head = group.head;
  if (!groupState.branch || !previousHead) return;
  try {
    hostGit(repo, ['update-ref', '-m', `agentic publish: rebase onto origin/${base}`, `refs/heads/${groupState.branch}`, group.head, previousHead]);
  } catch {
    // gone (cleaned up by an earlier publish) or moved by the human: the state holds the head either way
  }
}

/** The URL as configured: `insteadOf` rewrites change how git reaches it, not which forge repo it is. */
export function originRemote(repo: string): RemoteRepo {
  const url = hostGit(repo, ['config', '--get', 'remote.origin.url']);
  const remote = parseRemote(url);
  if (!remote) throw new Error(`origin \`${url}\`: can't tell the host and repo path`);
  return remote;
}

/**
 * The feature's last commit, from the work branch in the user's repo (state.json is only a hint): the final review's
 * branch, or the only group's. After a publish cleaned the branches up, the commit that was pushed.
 */
function featureHead(state: FlowState, repo: string): { head: string; branch?: string } {
  const originGroups = originGroupStates(state, repo).filter((group) => group.branch);
  const branch = state.final_review?.branch ?? (originGroups.length === 1 ? originGroups[0]!.branch : undefined);
  if (!branch) throw new Error(`Flow \`${state.slug}\`: no final review branch; nothing to tell what to publish.`);
  try {
    return { head: hostGit(repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]), branch };
  } catch {
    if (state.published) return { head: state.published.head };
    throw new Error(`Flow \`${state.slug}\`: branch ${branch} is gone from ${repo}.`);
  }
}

/**
 * Commits under the flow's starting point that `origin/<base>` lacks: the human's local work would ride along.
 * The starting point is the group base all others build on (a dependent group starts at its predecessor's head).
 */
function foreignCommits(state: FlowState, repo: string, target: string): number {
  const bases = Object.values(state.groups).flatMap((group) => (group.baseRef && (!group.repo || resolveRepo(group.repo, state.origin) === repo) ? [group.baseRef] : []));
  const start = bases.find((candidate) => bases.every((other) => isAncestor(repo, candidate, other)));
  return start ? Number(hostGit(repo, ['rev-list', '--count', `${target}..${start}`])) : 0;
}

export function ticketOf(workDir: string, state: FlowState): { title: string; trackerKey?: string } {
  const file = ['ticket.approved.md', 'ticket.md'].map((name) => path.join(workDir, name)).find((candidate) => fs.existsSync(candidate));
  const frontmatter = file ? parseMarkdown(fs.readFileSync(file, 'utf8')).frontmatter : {};
  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : state.title;
  // a ticket pasted from an issue is often titled `… (#5)` without `tracker_key`
  const trackerKey = typeof frontmatter.tracker_key === 'string' && frontmatter.tracker_key.trim() ? frontmatter.tracker_key.trim() : /\((#\d+)\)\s*$/.exec(title)?.[1];
  return { title, ...(trackerKey && { trackerKey }) };
}

/**
 * After the push: the work branches whose commits are elsewhere (the pushed branch, a remote, another
 * branch), the hidden rollback refs and the work directories. A branch holding commits that went nowhere stays,
 * with a warning; artifacts stay for audit.
 */
function cleanUp(workDir: string, state: FlowState, log: (message: string) => void): void {
  const { keptBranches } = applyCleanup(flowCleanup(workDir, state), { dropWork: false });
  if (keptBranches.length) {
    log(`! Keeping branches ${keptBranches.map((branch) => branch.ref.replace('refs/heads/', '')).join(', ')}: checked out in the repo or with commits the pushed branch doesn't have.`);
  }
  log(`Cleaned up: work branches of flow ${state.slug} and work directories; artifacts stay in ${workDir}.`);
}
