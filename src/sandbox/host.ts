import fs from 'node:fs';
import path from 'node:path';
import type { HarnessCommand, ProcessResult } from '../harness/types.js';
import { hostEnv, runProcess } from './process.js';
import type { AgentView, ExecOptions, Sandbox, SessionWorkspace } from './types.js';

/**
 * `sandbox.mode: none` — the harness runs on the host with the user's rights, confined only by its own
 * sandbox (see the adapters). The session reads copies of the flow artifacts in `<out>.context/`, so the
 * flow directory with `state.json` stays outside its working dirs. `network` is not enforced.
 */
export class HostSandbox implements Sandbox {
  readonly label = 'none';
  readonly isolated = false;

  view(workspace: SessionWorkspace): AgentView {
    return { codeDir: workspace.codeDir, outDir: workspace.outDir, readOnlyMounts: contextCopies(workspace) };
  }

  exec(command: HarnessCommand, workspace: SessionWorkspace, options: ExecOptions): Promise<ProcessResult> {
    const copies = contextCopies(workspace);
    const contextDir = hostContextDir(workspace);
    fs.rmSync(contextDir, { recursive: true, force: true });
    if (copies.length) fs.mkdirSync(contextDir, { recursive: true });
    workspace.readOnlyMounts.forEach((source, index) => fs.cpSync(source, copies[index]!, { recursive: true }));
    return runProcess(command.argv, { cwd: workspace.codeDir, env: hostEnv(command.env, options.dropEnv), stdin: command.stdin, ...options });
  }
}

export function hostContextDir(workspace: SessionWorkspace): string {
  return `${workspace.outDir}.context`;
}

function contextCopies(workspace: SessionWorkspace): string[] {
  const copies = workspace.readOnlyMounts.map((source) => path.join(hostContextDir(workspace), path.basename(source)));
  const duplicate = copies.find((copy, index) => copies.indexOf(copy) !== index);
  if (duplicate) throw new Error(`sandbox: two context files under the same path ${duplicate}`);
  return copies;
}
