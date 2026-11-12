import type { HarnessCommand, ProcessResult } from '../harness/types.js';

/** What one session gets, as host paths. */
export interface SessionWorkspace {
  /** The code the session works on (a group's clone, or the origin repo before groups exist). */
  codeDir: string;
  /** Writable; the only way artifacts leave the session. */
  outDir: string;
  /** Files and directories the session reads: ticket, spec, tasks, its skills. */
  readOnlyMounts: string[];
  /** Hosts the session may reach; empty = no network. */
  network: string[];
  /** The code is the human's own repo, not a clone: the session reads it (in a container it can't write it). */
  codeReadOnly?: boolean;
  /** In a container: the host directory mounted as the harness's `sessionsHome` (under the home), this session's own. */
  harnessSessions?: { hostDir: string; sessionsHome: string };
}

/** The workspace as the agent sees it; `readOnlyMounts` in the same order. */
export interface AgentView {
  codeDir: string;
  outDir: string;
  readOnlyMounts: string[];
}

export interface ExecOptions {
  /** The session takes over the terminal. */
  interactive: boolean;
  timeoutMs?: number;
  /** Host path of the file whose appearance ends the session (`process.ts`). */
  doneFile?: string;
  /** Host path the process's stdout is streamed to while it runs (a headless session's transcript). */
  liveOutput?: string;
  /** Removed from the environment the command inherits on the host (a container inherits nothing anyway). */
  dropEnv?: readonly string[];
}

/** Where a harness command runs: on the host, in a container, or in-process for the fake harness. */
export interface Sandbox {
  /** Names the sandbox in logs and `doctor`. */
  readonly label: string;
  /** Nothing but the workspace is reachable — the harness may run without its own permission checks. */
  readonly isolated: boolean;
  view(workspace: SessionWorkspace): AgentView;
  exec(command: HarnessCommand, workspace: SessionWorkspace, options: ExecOptions): Promise<ProcessResult>;
}
