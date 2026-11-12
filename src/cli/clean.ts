import path from 'node:path';
import { applyCleanup, flowCleanup, isEmpty, orphanCleanups, type Cleanup, type WorkBranch } from '../orchestrator/cleanup.js';
import { appendEvent } from '../orchestrator/events.js';
import { acquireLock, flowRunning } from '../orchestrator/lock.js';
import { listFlows, loadState, saveState, type FlowOrigin, type FlowState } from '../orchestrator/state.js';
import { plural } from '../plural.js';

export interface CleanPrompt {
  confirm(question: string): Promise<boolean>;
  choose(question: string, items: string[]): Promise<number | undefined>;
}

export interface CleanOptions {
  dryRun?: boolean;
  /** No questions: everything but the only copy of some work. */
  yes?: boolean;
}

const FINISHED: FlowState['status'][] = ['done', 'aborted', 'failed'];

/**
 * `agentic clean` without a slug: finished flows of this repo with something left, then work branches of flows
 * whose directory is gone. A paused flow is only named: cleaning it ends it, so it takes its slug.
 */
export async function cleanAll(roots: string[], origin: FlowOrigin, prompt: CleanPrompt, options: CleanOptions, say: (text: string) => void): Promise<void> {
  const flows = roots.flatMap((root) => listFlows(root).flows.map((state) => ({ state, dir: path.join(root, state.slug) })));
  const own = flows.filter(({ state }) => path.resolve(state.origin.repoRoot) === origin.repoRoot);
  const cleanups = [
    ...own.filter(({ state, dir }) => FINISHED.includes(state.status) && !flowRunning(dir)).map(({ state, dir }) => ({ cleanup: flowCleanup(dir, state), state })),
    ...orphanCleanups(origin.repoRoot, new Set(flows.map(({ state }) => state.slug))).map((cleanup) => ({ cleanup, state: undefined })),
  ].filter(({ cleanup }) => !isEmpty(cleanup));
  const paused = own.filter(({ state, dir }) => !FINISHED.includes(state.status) && !flowRunning(dir)).map(({ state }) => state.slug);
  if (!cleanups.length) say('Nothing to clean up.');
  for (const { cleanup, state } of cleanups) {
    if (!state) {
      await offer(cleanup, undefined, prompt, options, say);
      continue;
    }
    const release = acquireLock(cleanup.workDir!);
    try {
      await offer(cleanup, state, prompt, options, say);
    } finally {
      release();
    }
  }
  if (paused.length) say(`Paused (clean one by giving its slug; it can't be resumed afterwards): ${paused.join(', ')}`);
}

/** `agentic clean <slug>`: also a paused flow, which ends as aborted. */
export async function cleanOne(workDir: string, prompt: CleanPrompt, options: CleanOptions, say: (text: string) => void): Promise<void> {
  const release = acquireLock(workDir);
  try {
    const state = loadState(workDir);
    const cleanup = flowCleanup(workDir, state);
    if (isEmpty(cleanup)) return say(`${state.slug}: nothing to clean up.`);
    if (!FINISHED.includes(state.status)) say(`! ${state.slug} is paused (stage ${state.stage}); after the cleanup it can't be resumed`);
    await offer(cleanup, state, prompt, options, say, () => {
      if (FINISHED.includes(state.status)) return;
      state.status = 'aborted';
      saveState(workDir, state);
      appendEvent(workDir, state.slug, { type: 'flow_aborted', message: 'ended by agentic clean' });
    });
  } finally {
    release();
  }
}

/** After a flow ended `aborted` or `failed`: the same question as `agentic clean <slug>`. */
export async function offerAfterEnd(workDir: string, state: FlowState, prompt: CleanPrompt, say: (text: string) => void): Promise<void> {
  const cleanup = flowCleanup(workDir, state);
  if (isEmpty(cleanup)) return;
  await offer(cleanup, state, prompt, {}, say);
  say(`Later: agentic clean ${state.slug}`);
}

async function offer(
  cleanup: Cleanup,
  state: FlowState | undefined,
  prompt: CleanPrompt,
  options: CleanOptions,
  say: (text: string) => void,
  beforeApply = () => {},
): Promise<void> {
  say(describeCleanup(cleanup, state));
  if (options.dryRun) return;
  const dropWork = await decide(cleanup, prompt, options);
  if (dropWork === undefined) return;
  beforeApply();
  const { removedBranches, keptBranches } = applyCleanup(cleanup, { dropWork });
  const removed = [
    ...(cleanup.dirs.length ? [`work directories (${formatBytes(totalBytes(cleanup))})`] : []),
    ...(removedBranches.length ? [`branches: ${removedBranches.map(branchName).join(', ')}`] : []),
    ...(cleanup.hiddenRefs.length ? [`hidden refs: ${cleanup.hiddenRefs.length}`] : []),
  ];
  say(`✓ ${cleanup.slug}: removed ${removed.join('; ') || 'nothing'}`);
  if (keptBranches.length) say(`  kept branches ${keptBranches.map(branchName).join(', ')}`);
}

/** Whether to drop the only copy of some work too; undefined: nothing goes. */
async function decide(cleanup: Cleanup, prompt: CleanPrompt, options: CleanOptions): Promise<boolean | undefined> {
  if (options.yes) return false;
  const work = cleanup.branches.filter((branch) => branch.onlyHere && !branch.current);
  if (!work.length) return (await prompt.confirm(`Clean up ${cleanup.slug}?`)) ? false : undefined;
  const commits = work.reduce((sum, branch) => sum + branch.onlyHere, 0);
  const choice = await prompt.choose(`Clean up ${cleanup.slug}?`, [
    'Yes, except branches holding the only copy of work',
    `Yes, those too (${plural(commits, 'commit', 'commits')} will be lost)`,
    'No',
  ]);
  return choice === 0 ? false : choice === 1 ? true : undefined;
}

export function describeCleanup(cleanup: Cleanup, state?: FlowState): string {
  const header = state ? `${cleanup.slug} (${state.status}${state.outcome ? `, ${state.outcome}` : ''})` : `${cleanup.slug} (no flow directory)`;
  return [
    header,
    ...(cleanup.dirs.length ? [`  work directories ${formatBytes(totalBytes(cleanup))}: ${cleanup.dirs.map((dir) => path.basename(dir.path)).join(', ')}`] : []),
    ...cleanup.branches.map((branch) => `  branch ${branchName(branch)}${branchNote(branch)}`),
    ...(cleanup.hiddenRefs.length ? [`  hidden rollback refs: ${cleanup.hiddenRefs.length}`] : []),
  ].join('\n');
}

function branchNote(branch: WorkBranch): string {
  if (branch.current) return ': checked out in the repo, stays';
  if (!branch.onlyHere) return ': its commits exist elsewhere too';
  return `: ${plural(branch.onlyHere, 'commit', 'commits')} only here`;
}

function branchName(branch: WorkBranch): string {
  return branch.ref.replace('refs/heads/', '');
}

function totalBytes(cleanup: Cleanup): number {
  return cleanup.dirs.reduce((sum, dir) => sum + dir.bytes, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
