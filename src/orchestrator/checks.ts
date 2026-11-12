import fs from 'node:fs';
import path from 'node:path';
import type { ReviewConfig } from '../config/types.js';
import { writeFileSafe } from '../fsutil.js';
import { SECRET_ENV_VARS, SECRET_ENV_PATTERN, secretEnvNames } from '../sandbox/host-policy.js';
import { commandWorkspace } from './bundles.js';
import { Halt, type FlowRun } from './run.js';
import { plural } from '../plural.js';

/** What the agent and the gate see of a command's output; the whole of it stays in the log. */
export const CHECK_TAIL_LINES = 200;
/** The agent's own `run-checks` prints less: its output lands in the conversation. */
const RUNNER_TAIL_LINES = 80;
/** Lines that name a failure (Gradle, JUnit, Playwright, vitest/jest, most compilers), searched above the tail. */
export const ERROR_LINE_PATTERN = String.raw`✘|✗|\bFAIL(ED)?\b|\bError\b|What went wrong`;
const MAX_ERROR_LINES = 40;

export const MISSING_CHECKS = [
  '`review.checks` not set; the flow cannot check that the code builds and the tests pass.',
  "`agentic init` detects the repo's build and writes them; or add the commands to the repo's `.agentic/config.yaml`, e.g.:",
  '  review:',
  '    checks: ["./gradlew build"]          # Gradle',
  '    checks: ["npm ci", "npm test"]       # npm',
  'or knowingly `review.checks: none` (groups will be marked unverified).',
].join('\n');

/** The configured commands; `none` = deliberately unverified. An unset list is a start error. */
export function checkCommands(review: Pick<ReviewConfig, 'checks'>): string[] | 'none' {
  if (review.checks === 'none') return 'none';
  if (!review.checks.length) throw new Error(MISSING_CHECKS);
  return review.checks;
}

/** What runs on the host with the human's consent: `checks`, and `review.compile` that the test gates run before them. */
export function hostCommands(review: Pick<ReviewConfig, 'checks' | 'compile'>): string[] {
  const commands = checkCommands(review);
  return [...(commands === 'none' ? [] : commands), ...(review.compile ? [review.compile] : [])];
}

/** `90s`, `5m` → milliseconds. */
export function parseDuration(text: string): number {
  const match = /^([1-9][0-9]*)(s|m)$/.exec(text);
  if (!match) throw new Error(`invalid duration \`${text}\` (expected e.g. \`90s\`, \`5m\`)`);
  return Number(match[1]) * (match[2] === 'm' ? 60_000 : 1000);
}

/** `checks_timeout`, cut to the global ceiling. */
export function checksTimeoutMs(review: Pick<ReviewConfig, 'checks_timeout' | 'checks_timeout_max'>): number {
  return Math.min(parseDuration(review.checks_timeout), parseDuration(review.checks_timeout_max));
}

export interface CheckRun {
  command: string;
  exitCode: number;
  timedOut?: boolean;
  durationMs: number;
  /** The full output. */
  log: string;
  /** Failure lines from above the tail, then its last `CHECK_TAIL_LINES` lines. */
  excerpt: string;
  /** Red at first, green when run once more (`rerunFailed`): flaky, or the environment's. */
  retried?: boolean;
}

export const passed = (run: CheckRun) => run.exitCode === 0 && !run.timedOut;

/** Names the logs (`checks/<owner>-<label>-<n>-<command>.log`) and the events. */
export interface ChecksScope {
  /** A group id, or `_final`. */
  owner: string;
  /** `t2`, `r1-fix`, `baseline`. */
  label: string;
}

/**
 * Runs every command in `cwd` through the sandbox (`sh -c`), each with the configured timeout, the environment
 * stripped of secrets. On the host that is code the agent may have changed, so it needs the human's consent
 * for this repo's list (`checksTrusted`).
 */
export async function runChecks(flow: FlowRun, cwd: string, scope: ChecksScope, commands: string[]): Promise<CheckRun[]> {
  const { context } = flow;
  if (!context.sandbox.isolated && !context.checksTrusted) {
    throw new Halt('paused', { reason: 'error', message: '`review.checks` without consent to run on the host; `agentic resume` asks for it' });
  }
  const name = `${scope.owner}-${scope.label}`;
  const timeoutMs = checksTimeoutMs(context.config.review);
  const logDir = path.join(context.workDir, 'checks');
  fs.mkdirSync(logDir, { recursive: true });
  // a build downloads its dependencies (in a container through the allowlist proxy; on the host the network is open)
  const workspace = commandWorkspace(flow, cwd, `checks-${name}`, context.config.sandbox.network.allow);
  const group = scope.owner.startsWith('_') ? undefined : scope.owner;
  flow.log(`… checks ${scope.owner}/${scope.label}: ${plural(commands.length, 'command', 'commands')}`);
  flow.emit({ type: 'checks_started', group, owner: scope.owner, label: scope.label, commands });
  const startedAt = Date.now();
  const runs: CheckRun[] = [];
  for (const [index, command] of commands.entries()) {
    const commandStartedAt = Date.now();
    const step = `${scope.owner}/${scope.label} ${index + 1}/${commands.length}: ${command}`;
    flow.progress(name, `  ▸ ${step}`);
    const result = await context.sandbox
      .exec({ argv: ['sh', '-c', command] }, workspace, { interactive: false, timeoutMs, dropEnv: secretEnvNames() })
      .finally(() => flow.progress(name));
    const log = path.join(logDir, `${name}-${index + 1}-${commandSlug(command)}.log`);
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const timeoutNote = result.timedOut ? `\n[agentic] timeout after ${context.config.review.checks_timeout}; raise \`review.checks_timeout\` (ceiling \`review.checks_timeout_max\` in the global config)\n` : '';
    writeFileSafe(log, output + timeoutNote);
    const run: CheckRun = {
      command,
      exitCode: result.exitCode,
      ...(result.timedOut && { timedOut: true }),
      durationMs: Date.now() - commandStartedAt,
      log,
      excerpt: failureExcerpt(output, CHECK_TAIL_LINES, ERROR_LINE_PATTERN, MAX_ERROR_LINES) + timeoutNote,
    };
    runs.push(run);
    // a run of several minutes says how far it got (smoke 92-3)
    flow.log(`  ${passed(run) ? '✓' : '✗'} ${step} (${seconds(run.durationMs)})`);
  }
  const durationMs = Date.now() - startedAt;
  const green = runs.filter(passed).length;
  flow.log(`${green === runs.length ? '✓' : '✗'} checks ${scope.owner}/${scope.label}: ${green}/${runs.length} in ${seconds(durationMs)}`);
  flow.emit({
    type: 'checks_done',
    group,
    owner: scope.owner,
    label: scope.label,
    passed: green === runs.length,
    duration_ms: durationMs,
    results: runs.map((run) => ({ command: run.command, exit_code: run.exitCode, ...(run.timedOut && { timed_out: true }), duration_ms: run.durationMs, log: run.log })),
  });
  return runs;
}

/**
 * Each failed command once more, before a session is woken or a human asked: a red that turns green was the
 * environment's (smoke 92-3: Gradle passed every test, then couldn't write its XML reports through the mount).
 * A timeout isn't run again — it would cost as much once more. Returns `runs` with the reruns in place.
 */
export async function rerunFailed(flow: FlowRun, cwd: string, scope: ChecksScope, runs: CheckRun[]): Promise<CheckRun[]> {
  const failed = runs.flatMap((run, index) => (!passed(run) && !run.timedOut ? [index] : []));
  if (!failed.length) return runs;
  flow.log(`↻ checks ${scope.owner}/${scope.label}: ${failed.length === 1 ? 'red command' : 'red commands'} once more`);
  const again = await runChecks(flow, cwd, { ...scope, label: `${scope.label}-retry` }, failed.map((index) => runs[index]!.command));
  const rerun = new Map(failed.map((index, position) => [index, again[position]!]));
  return runs.map((run, index) => {
    const retry = rerun.get(index);
    if (!retry) return run;
    if (!passed(retry)) return retry;
    flow.log(`! checks ${scope.owner}/${scope.label}: \`${run.command}\` green only on the second try; flaky? first attempt log: ${run.log}`);
    return { ...retry, retried: true };
  });
}

/**
 * `✗ ./gradlew test (exit 1) — full log: …` per failed command, with its excerpt; read by the agent.
 * `logPath` maps a log to where the reader finds it (a copy in the session's `out/`).
 */
export function describeFailures(runs: CheckRun[], logPath: (log: string) => string = (log) => log): string {
  return runs
    .filter((run) => !passed(run))
    .map((run) => `✗ \`${run.command}\` (${run.timedOut ? 'timeout' : `exit ${run.exitCode}`}) — full log: ${logPath(run.log)}\n${run.excerpt}`)
    .join('\n\n');
}

/** What a reviewer reads about the commit it reviews: the last control's commands and results. */
export function checksReport(owner: string, commit: string, runs: CheckRun[], knownRed: string[] = []): string {
  return [
    `# Checks — ${owner}`,
    '',
    `The orchestrator ran these commands on commit \`${commit}\`, after the last session that changed the code:`,
    '',
    ...runs.map(
      (run) =>
        `- ${passed(run) ? '✓' : '✗'} \`${run.command}\` (${run.timedOut ? 'timeout' : `exit ${run.exitCode}`}, ${seconds(run.durationMs)}${run.retried ? ', green only on the second run' : ''})`,
    ),
    ...(knownRed.length ? ['', 'Red already on the base, before any agent change — not verified:', ...knownRed.map((command) => `- \`${command}\``)] : []),
    '',
  ].join('\n');
}

export function checksReportName(owner: string): string {
  return `checks-${owner}.md`;
}

/**
 * Failure lines from above the tail (deduplicated, at most `maxErrorLines`), then the last `tailLines` lines.
 * Self-contained: its source is embedded in the generated `run-checks` runner as well.
 */
export function failureExcerpt(output: string, tailLines: number, errorPattern: string, maxErrorLines: number): string {
  const lines = output.trimEnd().split('\n');
  const tail = lines.slice(-tailLines);
  const errorLine = new RegExp(errorPattern);
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const line of lines.slice(0, -tailLines)) {
    const key = line.trim();
    if (!errorLine.test(line) || seen.has(key)) continue;
    seen.add(key);
    errors.push(line);
    if (errors.length >= maxErrorLines) break;
  }
  if (!errors.length) return tail.join('\n');
  return [`[failure lines above the tail, first ${maxErrorLines} at most]`, ...errors, `[last ${tailLines} lines]`, ...tail].join('\n');
}

/** Where the agent's `run-checks` writes its logs, under the session's `out/`. */
export const RUNNER_LOG_DIR = 'checks';

/**
 * `run-checks` for one session on the host: the repo's `review.checks`, the only commands
 * a session runs outside Claude Code's sandbox (`excludedCommands`) — the build needs `~/.gradle`, Docker,
 * a browser. It runs them in `cwd` (fixed, whatever directory the agent calls it from), without secrets
 * in the environment, logs to `<outDir>/checks/`, prints a summary and what failed.
 * Written where no session can write (`<flow>/bin/<session>/`, not `out/` nor the clone), since what it
 * runs leaves the sandbox. Returns its path.
 */
export function writeChecksRunner(flow: FlowRun, session: { name: string; cwd: string; outDir: string; commands: string[] }): string {
  const dir = path.join(flow.context.workDir, 'bin', session.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const runnerPath = path.join(dir, 'run-checks');
  const config = {
    self: runnerPath,
    cwd: session.cwd,
    logDir: path.join(session.outDir, RUNNER_LOG_DIR),
    commands: session.commands,
    slugs: session.commands.map(commandSlug),
    timeoutMs: checksTimeoutMs(flow.context.config.review),
    secretNames: [...SECRET_ENV_VARS],
    secretPattern: SECRET_ENV_PATTERN,
    errorPattern: ERROR_LINE_PATTERN,
    tailLines: RUNNER_TAIL_LINES,
    maxErrorLines: MAX_ERROR_LINES,
  };
  // `.cjs`: the user's `package.json` above may say `"type": "module"`
  const script = path.join(dir, 'run-checks.cjs');
  fs.writeFileSync(script, `'use strict';\n// Generated by agentic for one session — see writeChecksRunner.\nconst config = ${JSON.stringify(config, null, 2)};\n${failureExcerpt.toString()}\n${RUNNER_MAIN}`);
  fs.writeFileSync(runnerPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  return runnerPath;
}

/** The runner's body; `config` and `failureExcerpt` precede it in the generated file. */
const RUNNER_MAIN = String.raw`
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const count = config.commands.length;
if (args.length > 1 || (args.length === 1 && !(/^[1-9][0-9]*$/.test(args[0]) && Number(args[0]) <= count))) {
  console.error('usage: ' + config.self + ' [n]   (n = 1..' + count + '; without n: all of them)');
  process.exit(2);
}
const selected = args.length ? [Number(args[0])] : config.commands.map((_command, index) => index + 1);
const env = { ...process.env };
const secret = new RegExp(config.secretPattern, 'i');
for (const name of Object.keys(env)) if (config.secretNames.includes(name) || secret.test(name)) delete env[name];
fs.mkdirSync(config.logDir, { recursive: true });

const failures = [];
for (const number of selected) {
  const command = config.commands[number - 1];
  const log = path.join(config.logDir, number + '-' + config.slugs[number - 1] + '.log');
  const descriptor = fs.openSync(log, 'w');
  const startedAt = Date.now();
  const result = spawnSync('sh', ['-c', command], { cwd: config.cwd, env, stdio: ['ignore', descriptor, descriptor], timeout: config.timeoutMs });
  fs.closeSync(descriptor);
  const seconds = Math.round((Date.now() - startedAt) / 1000) + ' s';
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (result.status === 0 && !timedOut) {
    console.log('✓ [' + number + '] ' + command + ' (' + seconds + ')');
    continue;
  }
  const why = timedOut ? 'timeout' : result.error ? result.error.message : result.status === null ? 'signal ' + result.signal : 'exit ' + result.status;
  console.log('✗ [' + number + '] ' + command + ' (' + why + ', ' + seconds + ') — log: ' + log);
  failures.push({ number, command, log });
}
for (const failure of failures) {
  console.log('\n--- [' + failure.number + '] ' + failure.command + ' ---');
  console.log(failureExcerpt(fs.readFileSync(failure.log, 'utf8'), config.tailLines, config.errorPattern, config.maxErrorLines));
}
process.exit(failures.length ? 1 : 0);
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `42 s`, `1m 20s`. */
export function seconds(durationMs: number): string {
  const total = Math.round(durationMs / 1000);
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

function commandSlug(command: string): string {
  return command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'command';
}
