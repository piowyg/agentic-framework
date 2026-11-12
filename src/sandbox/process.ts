import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessResult } from '../harness/types.js';

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  /** Inherits the terminal; nothing is captured. */
  interactive: boolean;
  timeoutMs?: number;
  /** Once this file exists, the session is done: the process is asked to quit (an agent can't leave an interactive harness itself). */
  doneFile?: string;
  /** stdout is also written here as it arrives, for `tail -f` while the process runs. */
  liveOutput?: string;
}

const KILL_GRACE_MS = 5000;
const DONE_POLL_MS = 1000;
/** Lets the agent finish its closing message before the harness is asked to quit. */
const DONE_GRACE_MS = 3000;
/** After the process exits, its pipes get this long to deliver what's left before they're cut. */
const DRAIN_GRACE_MS = 2000;

/** The host environment with `extra` on top and `drop` removed. */
export function hostEnv(extra: Record<string, string> = {}, drop: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of drop) delete env[name];
  return env;
}

/** Runs `argv` without a shell; a missing binary rejects, any exit code resolves. */
export function runProcess(argv: string[], options: ProcessOptions): Promise<ProcessResult> {
  const [binary, ...args] = argv;
  if (!binary) return Promise.reject(new Error('empty command'));
  const startedAt = Date.now();
  const terminalSettings = options.interactive ? saveTerminal() : undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.interactive ? 'inherit' : [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const live = child.stdout && options.liveOutput !== undefined ? openLive(options.liveOutput) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (live !== undefined) fs.writeSync(live, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let quitTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const timeoutTimer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs);
    const doneFile = options.doneFile;
    const donePoll =
      doneFile === undefined
        ? undefined
        : setInterval(() => {
            if (!fs.existsSync(doneFile)) return;
            clearInterval(donePoll);
            quitTimer = setTimeout(terminate, DONE_GRACE_MS);
          }, DONE_POLL_MS);
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(quitTimer);
      clearInterval(donePoll);
    };

    const closeLive = () => {
      if (live !== undefined) fs.closeSync(live);
    };

    child.on('error', (error) => {
      clearTimers();
      closeLive();
      reject(new Error(`cannot run \`${binary}\`: ${error.message}`));
    });
    // a background process the session left behind can hold its stdout open forever: once the session itself exits,
    // the pipes are cut after a grace period, so `close` doesn't wait for the leftover
    child.on('exit', () => {
      const drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, DRAIN_GRACE_MS);
      child.on('close', () => clearTimeout(drainTimer));
    });
    child.on('close', (code, signal) => {
      clearTimers();
      closeLive();
      // a harness stopped by a signal may leave the shared terminal in raw mode; the gates read lines from it
      if (terminalSettings) restoreTerminal(terminalSettings);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
        ...(timedOut && { timedOut }),
      });
    });
  });
}

/** Truncates an earlier run's file but never follows a planted symlink. */
function openLive(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
  return fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
}

/**
 * The terminal's settings as `stty -g` prints them. `setRawMode(false)` can't undo a child's raw mode:
 * Node only restores settings it changed itself.
 */
function saveTerminal(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
  const result = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function restoreTerminal(settings: string): void {
  spawnSync('stty', [settings], { stdio: ['inherit', 'ignore', 'ignore'] });
}
