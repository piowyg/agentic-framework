import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from '../config/git.js';
import { secretEnvNames } from '../sandbox/host-policy.js';
import type { SessionWorkspace } from '../sandbox/types.js';
import { hostGit, isAncestor, SAFE_GIT } from './repos.js';
import type { FlowRun } from './run.js';

const COMMIT = /^[0-9a-f]{40}$/;

export interface ExportedBundle {
  /** Host path of the bundle; absent when the clone has no commits since `baseRef`. */
  file?: string;
}

/**
 * Git in the agent's clone runs only through the sandbox, as a fixed command: in a container
 * that is safe; on the host (`mode: none`) a knowingly accepted risk, since isolation there is a convention anyway.
 */
export async function cloneGit(flow: FlowRun, workspace: SessionWorkspace, args: string[]): Promise<string> {
  const result = await execCloneGit(flow, workspace, args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} in the clone: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout.trim();
}

/** A file as committed at `commit`, untouched (leading blank lines keep line numbers); undefined when it isn't there. */
export async function showFile(flow: FlowRun, workspace: SessionWorkspace, commit: string, file: string): Promise<string | undefined> {
  const result = await execCloneGit(flow, workspace, ['show', `${commit}:${file}`]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

function execCloneGit(flow: FlowRun, workspace: SessionWorkspace, args: string[]) {
  const kept = gitEnv();
  const dropEnv = [...secretEnvNames(), ...Object.keys(process.env).filter((name) => !(name in kept))];
  return flow.context.sandbox.exec({ argv: ['git', ...SAFE_GIT, ...args] }, workspace, { interactive: false, dropEnv });
}

/** A workspace for the orchestrator's own commands in a clone: `out/<name>/` emptied, nothing else mounted, no network unless given. */
export function commandWorkspace(flow: FlowRun, clonePath: string, name: string, network: string[] = []): SessionWorkspace {
  const outDir = path.join(flow.context.workDir, 'out', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  return { codeDir: clonePath, outDir, readOnlyMounts: [], network };
}

/** `<baseRef>..HEAD` of the clone as `out/bundle-<name>/<name>.bundle`. */
export async function exportBundle(flow: FlowRun, clonePath: string, baseRef: string, name: string): Promise<ExportedBundle> {
  const workspace = commandWorkspace(flow, clonePath, `bundle-${name}`);
  const count = await cloneGit(flow, workspace, ['rev-list', '--count', `${baseRef}..HEAD`]);
  if (count === '0') return {};
  const agentOut = flow.context.sandbox.view(workspace).outDir;
  await cloneGit(flow, workspace, ['bundle', 'create', path.posix.join(agentOut, `${name}.bundle`), `${baseRef}..HEAD`]);
  const file = path.join(workspace.outDir, `${name}.bundle`);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`bundle ${name}: no file after \`git bundle create\``);
  return { file };
}

export interface ImportedBundle {
  commit: string;
  /** The previous head is not an ancestor: the agent amended or rebased. */
  rewritten: boolean;
}

/**
 * The bundle is passive data: verified in the user's repo, it must carry only `HEAD`, built on `baseRef`;
 * then fetched and set as `branch`. `previous` is the branch's head before, for the rewritten-history warning.
 */
export function importBundle(repoPath: string, file: string, expected: { baseRef: string; branch: string; previous?: string }): ImportedBundle {
  hostGit(repoPath, ['bundle', 'verify', '--quiet', file]);
  const heads = hostGit(repoPath, ['bundle', 'list-heads', file]).split('\n').filter(Boolean);
  const [commit, ref] = heads[0]?.split(' ') ?? [];
  if (heads.length !== 1 || ref !== 'HEAD' || !commit || !COMMIT.test(commit)) {
    throw new Error(`bundle ${path.basename(file)}: expected one HEAD ref, found: ${heads.join(', ') || 'none'}`);
  }
  hostGit(repoPath, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', file, `HEAD:refs/agentic/incoming/${commit}`]);
  try {
    if (!isAncestor(repoPath, expected.baseRef, commit)) {
      throw new Error(`bundle ${path.basename(file)}: ${commit.slice(0, 12)} does not grow from the group base ${expected.baseRef.slice(0, 12)}`);
    }
    hostGit(repoPath, ['update-ref', `refs/heads/${expected.branch}`, commit]);
  } finally {
    hostGit(repoPath, ['update-ref', '-d', `refs/agentic/incoming/${commit}`]);
  }
  const rewritten = !!expected.previous && !isAncestor(repoPath, expected.previous, commit);
  return { commit, rewritten };
}
