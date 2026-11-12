import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ModelCatalog } from '../config/models.js';
import { CliHarness, jsonLines, stderrTail } from './cli.js';
import type { HarnessCommand, ProcessResult, SessionRequest, SessionResult, Usage } from './types.js';

const RATE_LIMIT = /rate.?limit|usage limit|429|too many requests/i;
/** An overloaded or failing API, a dropped stream: worth a retry. */
const TRANSIENT_ERROR = /\b5\d\d\b|overloaded|stream disconnected|ECONNRESET|network|timed out/i;

/**
 * What Codex signs in with in a container, by name. A ChatGPT login (`~/.codex/auth.json`) stays on the host.
 * TODO(work): check against a real Codex in the container.
 */
export const CODEX_CREDENTIALS = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

/**
 * Codex CLI. Headless: `codex exec --json`, prompt on stdin (`-`); the JSONL stream becomes the transcript,
 * the last agent message the output, `turn.completed` events the usage. Codex picks the session id itself
 * (`thread.started`), so an interactive session has none.
 */
export class CodexHarness extends CliHarness {
  readonly sessionsHome = '.codex/sessions';
  protected readonly credentials = CODEX_CREDENTIALS;

  /** `env`: where `CODEX_HOME` and the gateway provider are looked up (`codexProvider`); tests point it at their own. */
  constructor(
    catalog: ModelCatalog,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super('codex', catalog);
  }

  /**
   * In a container also the provider of `config.toml` (the container has no `~/.codex`): its table as `--config`,
   * its key variable by name, its host on the allowlist.
   */
  protected override command(request: SessionRequest, command: HarnessCommand): HarnessCommand {
    const provider = request.isolated ? codexProvider(this.env) : undefined;
    if (!provider) return super.command(request, command);
    const [binary, ...rest] = command.argv;
    const options = ['--config', `model_provider=${JSON.stringify(provider.name)}`, '--config', `model_providers.${tomlKey(provider.name)}=${inlineTable(provider.table)}`];
    // `exec` stays the first argument: its own options follow it
    const argv = rest[0] === 'exec' ? [binary!, 'exec', ...options, ...rest.slice(1)] : [binary!, ...options, ...rest];
    return { ...command, argv, passEnv: provider.passEnv, ...(provider.host && { allow: [provider.host] }) };
  }

  buildCommand(request: SessionRequest): HarnessCommand {
    const { executor } = request;
    const options = [
      '--model',
      this.modelId(executor.model),
      '--config',
      `model_reasoning_effort="${executor.effort}"`,
      ...this.permissions(request),
    ];
    const prompt = request.prompt;
    if (request.mode === 'interactive') return this.command(request, { argv: [this.binary, ...options, prompt] });
    // TODO(work): check `exec … resume <id>` against a real Codex (the subcommand after exec's own options)
    const resume = request.resumeSessionId ? ['resume', request.resumeSessionId] : [];
    return this.command(request, { argv: [this.binary, 'exec', '--json', '--skip-git-repo-check', ...options, ...resume, '-'], stdin: prompt });
  }

  parseResult(result: ProcessResult, request: SessionRequest): SessionResult {
    const base = { durationMs: result.durationMs, timedOut: result.timedOut };
    if (request.mode === 'interactive') return { ...base, exitCode: result.exitCode, output: '' };

    const events = jsonLines<CodexEvent>(result.stdout);
    const errors = events.flatMap((event) => {
      if (event.type === 'turn.failed') return [event.error?.message ?? 'turn.failed'];
      if (event.type === 'error') return [event.message ?? 'error'];
      return [];
    });
    const lastMessage = events.findLast((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
    const turns = events.filter((event) => event.type === 'turn.completed');
    // a rate limit seen anywhere (stderr too) is never a transient error: it pauses or waits, not retries
    const rateLimited = [...errors, result.stderr].some((text) => RATE_LIMIT.test(text));
    return {
      ...base,
      exitCode: result.exitCode !== 0 ? result.exitCode : errors.length || !turns.length ? 1 : 0,
      output: lastMessage?.item?.text ?? (errors.join('\n') || stderrTail(result.stderr)),
      usage: turns.length ? sumUsage(turns) : undefined,
      rateLimited: rateLimited || undefined,
      ...(!rateLimited && errors.some((text) => TRANSIENT_ERROR.test(text)) && { transient: true }),
      ...(events.some((event) => event.type === 'item.completed') && { startedWork: true }),
      sessionId: events.find((event) => event.type === 'thread.started')?.thread_id ?? request.resumeSessionId,
      transcript: result.stdout,
    };
  }

  /**
   * In a container Codex's own sandbox has nothing to add (and may not start); on the host it is the boundary.
   * TODO(work): `checksRunner` as an exception in the permission profile, once checked against a real Codex.
   */
  private permissions(request: SessionRequest): string[] {
    if (request.isolated) return ['--dangerously-bypass-approvals-and-sandbox'];
    return [...hostProfile(request), ...(request.mode === 'interactive' ? ['--ask-for-approval', 'on-request'] : [])];
  }
}

/**
 * The provider fields a container gets. Others stay out: `experimental_bearer_token` and `http_headers` hold values
 * that would land on the command line (use `env_key` / `env_http_headers`).
 */
const PROVIDER_FIELDS = ['name', 'base_url', 'env_key', 'wire_api', 'query_params', 'env_http_headers', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'];

export interface CodexProvider {
  name: string;
  table: Record<string, unknown>;
  /** The variables it signs in with (`env_key`, `env_http_headers`), passed by name. */
  passEnv: string[];
  host?: string;
  baseUrl?: string;
  configFile: string;
}

/**
 * A company gateway (LiteLLM) set as Codex's `model_provider` with its own `[model_providers.<name>]` in
 * `$CODEX_HOME/config.toml`; undefined for the built-in providers, without the file, or with one that doesn't parse.
 */
export function codexProvider(env: NodeJS.ProcessEnv = process.env): CodexProvider | undefined {
  const configFile = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let config: Record<string, unknown>;
  try {
    config = parseToml(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const name = config.model_provider;
  const declared = (config.model_providers as Record<string, unknown> | undefined)?.[name as string];
  if (typeof name !== 'string' || !declared || typeof declared !== 'object') return undefined;
  const table = Object.fromEntries(PROVIDER_FIELDS.flatMap((field) => (field in declared ? [[field, (declared as Record<string, unknown>)[field]]] : [])));
  const headers = table.env_http_headers && typeof table.env_http_headers === 'object' ? Object.values(table.env_http_headers).filter((value): value is string => typeof value === 'string') : [];
  const baseUrl = typeof table.base_url === 'string' ? table.base_url : undefined;
  let host: string | undefined;
  try {
    host = baseUrl ? new URL(baseUrl).hostname : undefined;
  } catch {
    host = undefined;
  }
  return { name, table, passEnv: [...(typeof table.env_key === 'string' ? [table.env_key] : []), ...headers], host, baseUrl, configFile };
}

/** A TOML inline table (`--config` takes TOML values): strings as JSON strings, which TOML reads the same. */
function inlineTable(table: Record<string, unknown>): string {
  const value = (item: unknown): string =>
    item && typeof item === 'object' ? inlineTable(item as Record<string, unknown>) : typeof item === 'string' ? JSON.stringify(item) : String(item);
  return `{ ${Object.entries(table).map(([key, item]) => `${tomlKey(key)} = ${value(item)}`).join(', ')} }`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

const HOST_PROFILE = 'agentic-host';

/**
 * A permission profile (Codex ≥ 0.138, beta) instead of `--sandbox workspace-write`, which reads everything:
 * the home directory closed except `hostAccess.read`, credentials closed inside it, writes to the code and
 * `out/` only. More specific entries win; on the same path `deny` wins. The `--sandbox` flag is not combined
 * with profiles. Codex itself drops `*KEY*`/`*SECRET*`/`*TOKEN*` variables from the shell environment.
 */
export function hostProfile(request: SessionRequest): string[] {
  const access = request.hostAccess ?? { read: [], deny: [] };
  const filesystem: [string, 'read' | 'write' | 'deny'][] = [
    ['~', 'deny'],
    ...access.read.map((entry) => [entry, 'read'] as [string, 'read']),
    ...request.contextFiles.map((file) => [file, 'read'] as [string, 'read']),
    [request.cwd, 'write'],
    [request.outDir, 'write'],
    ...access.deny.map((entry) => [entry, 'deny'] as [string, 'deny']),
  ];
  // a TOML table rejects duplicate keys; the later entry (deny last) decides
  const table = [...new Map(filesystem)].map(([entry, level]) => `${JSON.stringify(entry)} = "${level}"`).join(', ');
  return [
    '--config',
    `permissions.${HOST_PROFILE}.extends=":workspace"`,
    '--config',
    `permissions.${HOST_PROFILE}.filesystem={ ${table} }`,
    '--config',
    `default_permissions="${HOST_PROFILE}"`,
  ];
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** One `turn.completed` per turn; `cached_input_tokens` is a part of `input_tokens`, as in `Usage`. */
function sumUsage(turns: CodexEvent[]): Usage {
  const total = (field: 'input_tokens' | 'cached_input_tokens' | 'output_tokens') =>
    turns.reduce((sum, turn) => sum + (turn.usage?.[field] ?? 0), 0);
  return { inputTokens: total('input_tokens'), outputTokens: total('output_tokens'), cacheReadTokens: total('cached_input_tokens') };
}

