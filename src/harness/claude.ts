import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelCatalog } from '../config/models.js';
import { SECRET_ENV_VARS } from '../sandbox/host-policy.js';
import { CliHarness, jsonLines, stderrTail } from './cli.js';
import type { HarnessCommand, ProcessResult, SessionRequest, SessionResult, Usage } from './types.js';

/**
 * Claude Code. Headless: `claude -p --output-format stream-json`, prompt on stdin, the stream becomes
 * the transcript and its `result` event the output and usage. Interactive: the terminal belongs to the
 * human, so there is no stream — only the exit code and the session id we passed in; the usage comes afterwards
 * from Claude Code's own session file (`sessionUsage`), as for a headless session killed before its `result`.
 */
export class ClaudeHarness extends CliHarness {
  readonly sessionsHome = '.claude/projects';
  protected readonly credentials = CLAUDE_CREDENTIALS;

  /** `env`: where the gateway settings are looked up (`claudeContainerEnv`); tests point it at their own. */
  constructor(
    catalog: ModelCatalog,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super('claude', catalog);
  }

  /** In a container also the gateway's settings, by value (the container has no `settings.json`), and its host. */
  protected override command(request: SessionRequest, command: HarnessCommand): HarnessCommand {
    if (!request.isolated) return command;
    const { values } = claudeContainerEnv(this.env);
    const host = gatewayHost(values);
    return {
      ...super.command(request, command),
      ...(Object.keys(values).length && { env: { ...command.env, ...values } }),
      ...(host && { allow: [host] }),
    };
  }

  buildCommand(request: SessionRequest): HarnessCommand {
    const { executor } = request;
    const options = [
      '--model',
      this.modelId(executor.model),
      '--effort',
      executor.effort,
      ...(request.resumeSessionId ? ['--resume', request.resumeSessionId] : ['--session-id', request.sessionId]),
      ...addDirs([request.outDir, ...contextDirs(request), ...hostReadDirs(request)]),
      ...this.permissions(request),
    ];
    const prompt = request.prompt;
    if (request.mode === 'interactive') return this.command(request, { argv: [this.binary, ...options, prompt] });
    return this.command(request, { argv: [this.binary, '-p', '--output-format', 'stream-json', '--verbose', ...options], stdin: prompt });
  }

  parseResult(result: ProcessResult, request: SessionRequest): SessionResult {
    const base = { durationMs: result.durationMs, timedOut: result.timedOut, sessionId: request.resumeSessionId ?? request.sessionId };
    if (request.mode === 'interactive') return { ...base, exitCode: result.exitCode, output: '' };

    const events = jsonLines<ClaudeEvent>(result.stdout);
    const final = events.findLast((event) => event.type === 'result');
    const rejected = events.findLast((event) => event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected');
    const rateLimited = final?.api_error_status === 429 || !!rejected;
    const resetsAt = rejected?.rate_limit_info?.resetsAt;
    const exitCode = result.exitCode !== 0 ? result.exitCode : final && !final.is_error ? 0 : 1;
    return {
      ...base,
      // a stream that ends in an error, or not at all, is a failed session even when the CLI exits with 0
      exitCode,
      output: final?.result ?? stderrTail(result.stderr),
      // a killed session has no `result`: its usage so far is in the stream's responses
      ...(final?.usage ? { usage: usageOf(final) } : { usage: streamUsage(events), usagePartial: true as const }),
      rateLimited: rateLimited || undefined,
      ...(rateLimited && resetsAt && { rateLimitResetsAt: resetsAt * 1000 }),
      ...(exitCode !== 0 && !rateLimited && !result.timedOut && transientFailure(events, final) && { transient: true }),
      ...(events.some((event) => event.type === 'assistant') && { startedWork: true }),
      sessionId: final?.session_id ?? base.sessionId,
      transcript: result.stdout,
    };
  }

  sessionUsage(request: SessionRequest, startedAt: number): Usage | undefined {
    if (request.isolated && !request.sessionsDir) return undefined;
    return sessionFileUsage(request.resumeSessionId ?? request.sessionId, startedAt, request.isolated ? { projectsDir: request.sessionsDir } : {});
  }

  /**
   * In a container nothing else is reachable. On the host the session gets Claude Code's own sandbox
   * (`hostSettings`) and an explicit mode, never the user's own `defaultMode` (e.g. `auto`, `bypassPermissions`).
   * Headless, nobody answers a prompt, so edits in the working dirs pass (`acceptEdits`); interactive, the human
   * answers what `hostSettings` doesn't allow (`default`).
   * `auto` mode is no option — unavailable for some models, it silently falls back to `default`, which
   * denies every write.
   */
  private permissions(request: SessionRequest): string[] {
    if (request.isolated) return ['--dangerously-skip-permissions'];
    const mode = request.mode === 'headless' ? 'acceptEdits' : 'default';
    return ['--permission-mode', mode, '--settings', JSON.stringify(hostSettings(request))];
  }
}

/**
 * What Claude Code signs in with in a container, by name: an API key, or a subscription's token from `claude setup-token`
 * (the keychain login on the host is out of its reach).
 */
export const CLAUDE_CREDENTIALS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * A company gateway (LiteLLM or another proxy) in place of `api.anthropic.com`: the URL, the token it signs in with
 * (`ANTHROPIC_AUTH_TOKEN`), extra headers and the model names behind Claude Code's aliases.
 */
const CLAUDE_GATEWAY_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export interface ClaudeContainerEnv {
  values: Record<string, string>;
  /** The names whose value came from `settings.json`, not from the shell. */
  fromSettings: string[];
  settingsFile: string;
}

/**
 * Claude Code's sign-in and gateway variables, as a container needs them: from the shell, else from the `env` of
 * `settings.json` (where a company setup often keeps the gateway's URL and token). Only these names, never the rest.
 */
export function claudeContainerEnv(env: NodeJS.ProcessEnv = process.env): ClaudeContainerEnv {
  const settingsFile = path.join(claudeConfigDir(env), 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const parsed = (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { env?: unknown }).env;
    if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
  } catch {
    // no settings.json, or one Claude Code would refuse too
  }
  const values: Record<string, string> = {};
  const fromSettings: string[] = [];
  for (const name of [...CLAUDE_CREDENTIALS, ...CLAUDE_GATEWAY_ENV]) {
    const fromShell = env[name];
    const fromFile = settings[name];
    if (fromShell) values[name] = fromShell;
    else if (typeof fromFile === 'string' && fromFile) {
      values[name] = fromFile;
      fromSettings.push(name);
    }
  }
  return { values, fromSettings, settingsFile };
}

/** The gateway's host, for the session's allowlist; undefined without a gateway or with a URL that doesn't parse. */
export function gatewayHost(values: Record<string, string>): string | undefined {
  try {
    return values.ANTHROPIC_BASE_URL ? new URL(values.ANTHROPIC_BASE_URL).hostname : undefined;
  } catch {
    return undefined;
  }
}

/** The fields we read from `stream-json` events: `result`, `rate_limit_event` and `assistant`. */
interface ClaudeEvent {
  type?: string;
  message?: { id?: string; usage?: ClaudeEvent['usage'] };
  is_error?: boolean;
  result?: string;
  session_id?: string;
  api_error_status?: number | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  rate_limit_info?: { status?: string; resetsAt?: number };
}

const TRANSIENT_ERROR = /overloaded|API Error: 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up|network|fetch failed/i;

/**
 * An overloaded or failing API, or a session that started (`init`) and died without a result — not a CLI that
 * refused its arguments, which ends before `init` and would fail the same way again.
 */
function transientFailure(events: ClaudeEvent[], final: ClaudeEvent | undefined): boolean {
  if (!final) return events.some((event) => event.type === 'system');
  const status = final.api_error_status ?? 0;
  return status >= 500 || TRANSIENT_ERROR.test(final.result ?? '');
}

/** Anthropic counts cache reads and writes apart from `input_tokens`; `Usage.inputTokens` is all of them. */
function usageOf(final: ClaudeEvent): Usage {
  const usage = final.usage ?? {};
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cacheReadTokens,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens,
    costUsd: final.total_cost_usd,
  };
}

/**
 * Usage of a session without a `result` (killed at `session_timeout`, crashed), a lower bound for when its session file
 * is out of reach (a container): the responses it got, each once. The input is exact; the output is what the stream
 * reports at each response's start, a fraction of it (checked 2.1.292: 16 for a response the session file counts
 * at 607). Smoke 92-5: a session killed after 90 s logged 0 tokens.
 */
function streamUsage(events: ClaudeEvent[]): Usage | undefined {
  const responses = new Map<string, ClaudeEvent>();
  for (const event of events) if (event.type === 'assistant' && event.message?.id && event.message.usage) responses.set(event.message.id, { usage: event.message.usage });
  if (!responses.size) return undefined;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const response of responses.values()) {
    const counts = usageOf(response);
    usage.inputTokens += counts.inputTokens;
    usage.outputTokens += counts.outputTokens;
    usage.cacheReadTokens! += counts.cacheReadTokens ?? 0;
  }
  return usage;
}

/**
 * Two layers, because Claude Code's sandbox wraps only shell commands: the file tools (Read, Grep, Glob)
 * read only the working dirs (`hostAccess.read` among them, see `hostReadDirs`) and never a sensitive path; shell commands run sandboxed with no way out
 * (no unsandboxed retry, no start without the sandbox), the home directory closed except `hostAccess.read`,
 * credentials and secret variables out of reach, the network only to `request.network`. The one way out is the
 * session's `run-checks`, allowed without asking.
 * Interactive, the session writes its artifacts without asking, and its shell can't write the code or the
 * context copies (`denyWrite`), so shell commands run without asking too: a grill reads the code, it doesn't
 * change it, and Claude Code ships no Grep or Glob tool (2.1.292, checked 2026-10-07) — it searches with
 * `rg`, `find` and `git`, often chained, which would otherwise ask the human for every search.
 * A command with a shell variable (`for f in …; do cat $f; done`) still asks: Claude Code can't check it before
 * it runs (checked 2026-10-07), so the grill skills tell the session to read files with Read.
 * The user's own allow rules still apply.
 */
export function hostSettings(request: SessionRequest): object {
  const access = request.hostAccess ?? { read: [], deny: [] };
  const interactive = request.mode === 'interactive';
  const allow = [
    ...(interactive ? [`Edit(/${request.outDir}/**)`] : COMMIT_RULES),
    ...runnerRules(request.checksRunner).map((rule) => `Bash(${rule})`),
  ];
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      ...(allow.length && { allow }),
      deny: access.deny.flatMap((denied) => [`Read(${denied})`, `Read(${denied}/**)`]),
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      ...(request.checksRunner && { excludedCommands: runnerRules(request.checksRunner) }),
      ...(request.network?.length && { network: { allowedDomains: request.network.map(claudeDomain) } }),
      filesystem: {
        ...(interactive && { denyWrite: [request.cwd, ...contextDirs(request)] }),
        denyRead: ['~/'],
        allowRead: [request.cwd, request.outDir, ...contextDirs(request), ...access.read],
      },
      credentials: {
        files: access.deny.map((denied) => ({ path: denied, mode: 'deny' })),
        envVars: SECRET_ENV_VARS.map((name) => ({ name, mode: 'deny' })),
      },
    },
  };
}

/** Our allowlist's `.example.com` (subdomains) is Claude Code's `*.example.com`. */
function claudeDomain(host: string): string {
  return host.startsWith('.') ? `*${host}` : host;
}

/**
 * A sandboxed `git commit` whose message holds a `=` ("role=status") still asks for approval, and so does every
 * command chained with it (Claude Code, checked 2026-10-20); headless, nobody answers and the work stays uncommitted.
 * Allowed, they still run in the sandbox.
 */
const COMMIT_RULES = ['Bash(git add:*)', 'Bash(git commit:*)'];

/**
 * The runner alone or with an argument. Checked live (Claude Code, 2026-10-06): the runner leaves the sandbox
 * alone or after `cd … &&`; a line with anything else chained (`&&`, `;`, `$(…)`) runs sandboxed as a whole.
 */
function runnerRules(runner: string | undefined): string[] {
  return runner ? [runner, `${runner} *`] : [];
}

function contextDirs(request: SessionRequest): string[] {
  return [...new Set(request.contextFiles.map((file) => path.dirname(file)))];
}

/**
 * `sandbox.host.read` as working dirs: without them only the shell could read there, and the skills tell the session
 * to read files with Read (a prototype beside the repo, pilot 2026-11-11). The deny rules still cover what lies inside.
 */
function hostReadDirs(request: SessionRequest): string[] {
  return (request.hostAccess?.read ?? []).map((entry) => entry.replace(/^~(?=\/|$)/, os.homedir()));
}

function addDirs(dirs: string[]): string[] {
  return [...new Set(dirs)].flatMap((dir) => ['--add-dir', dir]);
}

/** Where Claude Code keeps its sessions: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The session file's entries we read (Claude Code 2.1.292, checked 2026-10-08). */
interface SessionFileEntry {
  type?: string;
  timestamp?: string;
  message?: { id?: string; usage?: ClaudeEvent['usage'] };
  /** `cost-state`: Claude Code's own total for the session, its subagents included. */
  totalCostUSD?: number;
}

/**
 * Usage from Claude Code's record of a session: `<config>/projects/<cwd>/<id>.jsonl` and its subagents'
 * `<id>/subagents/*.jsonl`. One response spans several `assistant` entries with the same usage, so they count once
 * per `message.id`; only entries since `since` (a resumed session's file holds its earlier runs too). The cost is the
 * last `cost-state` total — the whole session's, `appendUsage` subtracts the earlier runs — when written after this
 * run's last response: one before it is an earlier run's (a killed run writes none), and the run is priced from its tokens.
 * Smoke 92-4: the technical grill, the flow's dearest session, logged nothing.
 */
export function sessionFileUsage(sessionId: string, since: number, options: { projectsDir?: string } = {}): Usage | undefined {
  const projects = options.projectsDir ?? path.join(claudeConfigDir(), 'projects');
  const project = safeReaddir(projects).find((dir) => fs.existsSync(path.join(projects, dir, `${sessionId}.jsonl`)));
  if (!project) return undefined;
  const mainFile = path.join(projects, project, `${sessionId}.jsonl`);
  const subagentsDir = path.join(projects, project, sessionId, 'subagents');
  const files = [mainFile, ...safeReaddir(subagentsDir).filter((file) => file.endsWith('.jsonl')).map((file) => path.join(subagentsDir, file))];
  const counted = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let costUsd: number | undefined;
  for (const file of files) {
    for (const entry of jsonLines<SessionFileEntry>(fs.readFileSync(file, 'utf8'))) {
      if (file === mainFile && entry.type === 'cost-state' && typeof entry.totalCostUSD === 'number') costUsd = entry.totalCostUSD;
      const messageId = entry.message?.id;
      if (entry.type !== 'assistant' || !entry.message?.usage || !messageId || counted.has(messageId)) continue;
      if (!entry.timestamp || Date.parse(entry.timestamp) < since) continue;
      if (file === mainFile) costUsd = undefined;
      counted.add(messageId);
      const counts = usageOf({ usage: entry.message.usage });
      usage.inputTokens += counts.inputTokens;
      usage.outputTokens += counts.outputTokens;
      usage.cacheReadTokens! += counts.cacheReadTokens ?? 0;
    }
  }
  return { ...usage, ...(costUsd !== undefined && { costUsd }) };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
