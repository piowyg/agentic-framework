import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config/defaults.js';
import { gitEnv } from '../src/config/git.js';
import type { AgenticConfig } from '../src/config/types.js';

export function tmpDir(prefix = 'agentic-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root: string, relativePath: string, content: string): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** CI has no global git identity: a test that commits passes this one. */
export const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** git in `cwd` with the test identity, trimmed output. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...gitEnv(), ...GIT_IDENTITY }, encoding: 'utf8' }).trim();
}

export function gitRepo(dir: string, remote?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, env: gitEnv() });
  return dir;
}

/** A file every `committedRepo` has, so review findings in tests can quote real code. */
export const QUOTED_FILE = {
  path: 'src/Cart.java',
  content: ['class Cart {', '  long total;', '', '  void addItems(long amount) {', '    total += amount;', '  }', '}', ''].join('\n'),
  line: 2,
  quote: 'long total;',
};

/** Where a blocking finding in a test points: `QUOTED_FILE`, at a line its quote is found. */
export const QUOTED = { file: QUOTED_FILE.path, line: QUOTED_FILE.line, quote: QUOTED_FILE.quote };

/** A git repo with one commit holding `QUOTED_FILE` — a flow's groups branch off its HEAD. */
export function committedRepo(dir: string): string {
  gitRepo(dir);
  write(dir, QUOTED_FILE.path, QUOTED_FILE.content);
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: { ...gitEnv(), ...GIT_IDENTITY } });
  return dir;
}

/** Isolated env: empty AGENTIC_HOME, no AGENTIC_WORKSPACE, no GIT_*. */
export function sandboxEnv(home: string): NodeJS.ProcessEnv {
  return { ...gitEnv(), AGENTIC_HOME: home, AGENTIC_WORKSPACE: undefined };
}

/**
 * Defaults a flow can start with: `review.checks` must be set, tests opt out unless they test checks.
 * `write-tests` is off unless a test is about it: its red gate wants the checks red on the base.
 */
export const TEST_CONFIG: AgenticConfig = {
  ...DEFAULTS,
  stages: { ...DEFAULTS.stages, 'write-tests': { ...DEFAULTS.stages['write-tests'], enabled: false } },
  review: { ...DEFAULTS.review, checks: 'none' },
};

/** `TEST_CONFIG` without a PR stack: groups of one repo may run side by side (diamonds, `parallel_groups`). */
export const NO_STACK_CONFIG: AgenticConfig = { ...TEST_CONFIG, publish: { ...TEST_CONFIG.publish, stack: false } };

/** `TEST_CONFIG` with the group's tests written first. */
export const TESTS_FIRST_CONFIG: AgenticConfig = { ...TEST_CONFIG, stages: DEFAULTS.stages };
