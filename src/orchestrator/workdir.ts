import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { slugify } from './state.js';

type Location = Pick<LoadedConfig, 'globalDir' | 'workspaceRoot' | 'repoRoot'>;

/**
 * Flows of this workspace (or repo) live outside its tree, in `<global dir>/work/<name>-<hash>/`: tools that look
 * for config up the directory tree (lockfiles, ESLint, Prettier, `tsconfig`, `settings.gradle`) would find the
 * user's repo from a clone inside it, and `checks` could differ from a clean checkout in CI.
 */
export function workRoot(loaded: Location, cwd: string): string {
  const owner = path.resolve(loaded.workspaceRoot ?? loaded.repoRoot ?? cwd);
  const hash = crypto.createHash('sha256').update(owner).digest('hex').slice(0, 8);
  return path.join(loaded.globalDir, 'work', `${slugify(path.basename(owner))}-${hash}`);
}

/** `<workspace>/work/` or `<repo>/.agentic/work/`: where flows lived before; `status` and `resume` still find them there. */
export function legacyWorkRoot(loaded: Location, cwd: string): string {
  if (loaded.workspaceRoot) return path.join(loaded.workspaceRoot, 'work');
  return path.join(loaded.repoRoot ?? cwd, '.agentic', 'work');
}

/** Every root with flows of this workspace (or repo): the current one first, then the legacy one if it exists. */
export function workRoots(loaded: Location, cwd: string): string[] {
  const legacy = legacyWorkRoot(loaded, cwd);
  return [workRoot(loaded, cwd), ...(fs.existsSync(legacy) ? [legacy] : [])];
}
