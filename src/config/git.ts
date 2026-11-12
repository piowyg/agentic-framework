import { execFileSync } from 'node:child_process';

export interface GitInfo {
  root?: string;
  remote?: string;
}

/** Missing git or remote is not an error. */
export function gitInfo(cwd: string): GitInfo {
  return { root: git(cwd, ['rev-parse', '--show-toplevel']), remote: git(cwd, ['remote', 'get-url', 'origin']) };
}

/** GIT_DIR & co. (e.g. inside a git hook) would point git at a different repo than `cwd`. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
