import type { ContainerEngine } from '../config/types.js';
import type { ProcessResult } from '../harness/types.js';
import { runProcess } from './process.js';

/** One of the sandbox's own engine commands, not a session: no terminal, the host's environment; `strict` throws on failure. */
export async function engineRun(engine: ContainerEngine, args: string[], options: { strict?: boolean; timeoutMs?: number } = {}): Promise<ProcessResult> {
  const result = await runProcess([engine, ...args], { cwd: process.cwd(), env: process.env, interactive: false, timeoutMs: options.timeoutMs ?? 60_000 });
  if (options.strict && result.exitCode !== 0) throw new Error(`sandbox: \`${engine} ${args.slice(0, 2).join(' ')}\` failed: ${result.stderr.trim()}`);
  return result;
}

/** The output of an engine command that has to succeed. */
export async function engineOutput(engine: ContainerEngine, args: string[]): Promise<string> {
  return (await engineRun(engine, args, { strict: true })).stdout;
}
