import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { ClaudeHarness, hostSettings, sessionFileUsage } from '../src/harness/claude.js';
import { CodexHarness, hostProfile } from '../src/harness/codex.js';
import { fakeRegistry } from '../src/harness/fake.js';
import type { Harness, ProcessResult, SessionRequest } from '../src/harness/types.js';
import { readEvents } from '../src/orchestrator/events.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { readUsage } from '../src/orchestrator/usage.js';
import { hostAccess, SECRET_ENV_VARS } from '../src/sandbox/host-policy.js';
import { committedRepo, tmpDir, TEST_CONFIG, write } from './helpers.js';

const SESSION_ID = '6f1c2a3e-0000-4000-8000-000000000001';

function request(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    kind: 'implement',
    mode: 'headless',
    executor: { harness: 'claude', model: 'opus', effort: 'high' },
    cwd: '/flows/s/clones/g1',
    outDir: '/flows/s/out/implement-g1-t1',
    contextFiles: ['/flows/s/out/implement-g1-t1.context/spec.md', '/flows/s/out/implement-g1-t1.context/tasks.yaml'],
    prompt: 'Zaimplementuj task.',
    skills: ['implement', 'tdd'],
    sessionId: SESSION_ID,
    isolated: false,
    hostAccess: { read: ['~/.m2'], deny: ['~/.ssh', '~/.m2/settings.xml'] },
    ...overrides,
  };
}

function processResult(stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, stdout, stderr: '', durationMs: 900, ...overrides };
}

const jsonl = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

/** Trimmed from a real `claude -p --output-format stream-json --verbose` run (2.1.289). */
const CLAUDE_STREAM = jsonl(
  { type: 'system', subtype: 'init', session_id: 'e87e2a4e-cfb3-43c1-91f2-c9f1c2668aad', model: 'claude-opus-5-5' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, session_id: 'e87e2a4e-cfb3-43c1-91f2-c9f1c2668aad' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, session_id: 'e87e2a4e-cfb3-43c1-91f2-c9f1c2668aad' },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: 'ok',
    session_id: 'e87e2a4e-cfb3-43c1-91f2-c9f1c2668aad',
    total_cost_usd: 0.0111703,
    usage: { input_tokens: 9, cache_creation_input_tokens: 5261, cache_read_input_tokens: 4293, output_tokens: 42 },
  },
);

/** Event shapes from the Codex non-interactive docs (`codex exec --json`). */
const CODEX_STREAM = jsonl(
  { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Najpierw test.' } },
  { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', exit_code: 0 } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '{"findings": []}' } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 30 } },
);

describe('ClaudeHarness', () => {
  const claude = new ClaudeHarness(loadCatalog());

  it('headless: stream-json, model id from the catalog, prompt on stdin, its own sandbox on the host', () => {
    const command = claude.buildCommand(request());
    expect(command.argv.slice(0, -1)).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--session-id',
      SESSION_ID,
      '--add-dir',
      '/flows/s/out/implement-g1-t1',
      '--add-dir',
      '/flows/s/out/implement-g1-t1.context',
      '--add-dir',
      path.join(os.homedir(), '.m2'),
      '--permission-mode',
      'acceptEdits',
      '--settings',
    ]);
    expect(JSON.parse(command.argv.at(-1)!)).toEqual(hostSettings(request()));
    // skills reach the session as SKILL.md paths in the prompt, not as slash commands
    expect(command.stdin).toBe('Zaimplementuj task.');
  });

  it('resume: `--resume <id>` instead of a new session id', () => {
    const claude = new ClaudeHarness(loadCatalog());
    const resumed = request({ resumeSessionId: 'earlier-session', prompt: 'Checks failed.' });
    const { argv, stdin } = claude.buildCommand(resumed);
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe('earlier-session');
    expect(argv).not.toContain('--session-id');
    expect(stdin).toBe('Checks failed.');
    expect(claude.parseResult(processResult(''), resumed).sessionId).toBe('earlier-session');
  });

  it('host settings: file tools stay in the working dirs, shell commands in a sandbox with no way out', () => {
    const settings = hostSettings(request()) as any;
    expect(settings.permissions).toEqual({
      blockReadsOutsideWorkingDirectories: true,
      allow: ['Bash(git add:*)', 'Bash(git commit:*)'],
      deny: ['Read(~/.ssh)', 'Read(~/.ssh/**)', 'Read(~/.m2/settings.xml)', 'Read(~/.m2/settings.xml/**)'],
    });
    expect(settings.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true });
    expect(settings.sandbox.filesystem).toEqual({
      denyRead: ['~/'],
      allowRead: ['/flows/s/clones/g1', '/flows/s/out/implement-g1-t1', '/flows/s/out/implement-g1-t1.context', '~/.m2'],
    });
    expect(settings.sandbox.credentials.files).toEqual([
      { path: '~/.ssh', mode: 'deny' },
      { path: '~/.m2/settings.xml', mode: 'deny' },
    ]);
    expect(settings.sandbox.credentials.envVars.map((entry: { name: string }) => entry.name)).toEqual([...SECRET_ENV_VARS]);
  });

  it('host settings: shell commands reach the session’s hosts without asking — headless, nobody approves another one', () => {
    const settings = hostSettings(request({ network: ['registry.npmjs.org', '.example.com'] })) as any;
    expect(settings.sandbox.network).toEqual({ allowedDomains: ['registry.npmjs.org', '*.example.com'] });
    expect((hostSettings(request()) as any).sandbox.network).toBeUndefined();
  });

  it('host settings: the session’s run-checks alone leaves the sandbox, allowed without asking', () => {
    const runner = '/flows/s/bin/implement-g1-t1/run-checks';
    const settings = hostSettings(request({ checksRunner: runner })) as any;
    expect(settings.sandbox.excludedCommands).toEqual([runner, `${runner} *`]);
    expect(settings.permissions.allow).toEqual(['Bash(git add:*)', 'Bash(git commit:*)', `Bash(${runner})`, `Bash(${runner} *)`]);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it('host settings, headless: a commit is allowed without asking — a message with `=` would otherwise wait for an approval nobody gives', () => {
    const settings = hostSettings(request()) as any;
    expect(settings.permissions.allow).toEqual(['Bash(git add:*)', 'Bash(git commit:*)']);
    // allowed, not excluded: it still runs in the sandbox
    expect(settings.sandbox.excludedCommands).toBeUndefined();
  });

  it('the built-in credential list always reaches the session', () => {
    const settings = hostSettings(request({ hostAccess: hostAccess({ read: [], deny: [] }) })) as any;
    expect(settings.permissions.deny).toContain('Read(~/.aws/**)');
    expect(settings.sandbox.credentials.files).toContainEqual({ path: '~/.codex', mode: 'deny' });
  });

  it('isolated: skips its permission prompts and gets the context directory', () => {
    const { argv } = claude.buildCommand(request({ isolated: true, outDir: '/out', contextFiles: ['/context/spec.md', '/context/tasks.yaml'] }));
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--settings');
    expect(argv.join(' ')).toContain('--add-dir /out --add-dir /context');
    expect(argv.filter((arg) => arg === '/context')).toHaveLength(1);
  });

  it('a company gateway (LiteLLM): its URL and token reach the container by value from settings.json, the shell wins, the host joins the allowlist', () => {
    const configDir = tmpDir();
    write(configDir, 'settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'settings-token', OTHER: 'x' } }));
    const gateway = new ClaudeHarness(loadCatalog(), { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'shell-token' });
    const isolated = gateway.buildCommand(request({ isolated: true }));
    expect(isolated.env).toEqual({ ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'shell-token' });
    expect(isolated.allow).toEqual(['llm.example.com']);
    expect(isolated.argv.join(' ')).not.toMatch(/token/);
    // on the host Claude Code reads its own settings.json
    const host = gateway.buildCommand(request());
    expect(host.env).toBeUndefined();
    expect(host.allow).toBeUndefined();
    expect(new ClaudeHarness(loadCatalog(), { CLAUDE_CONFIG_DIR: tmpDir() }).buildCommand(request({ isolated: true })).allow).toBeUndefined();
  });

  it('interactive on the host: an explicit mode, artifacts written freely, a shell that reads without asking and never writes the code', () => {
    const interactive = request({ kind: 'grill-business', mode: 'interactive', skills: [] });
    const command = claude.buildCommand(interactive);
    expect(command.argv[0]).toBe('claude');
    expect(command.argv).not.toContain('-p');
    // never the user's own defaultMode (auto, bypassPermissions)
    expect(command.argv.slice(-5, -3)).toEqual(['--permission-mode', 'default']);
    expect(command.argv.at(-2)).toBe(JSON.stringify(hostSettings(interactive)));
    expect(command.argv.at(-1)).toBe('Zaimplementuj task.');
    expect(command.stdin).toBeUndefined();
    const settings = hostSettings(interactive) as any;
    expect(settings.permissions.allow).toEqual(['Edit(//flows/s/out/implement-g1-t1/**)']);
    expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(settings.sandbox.filesystem.denyWrite).toEqual(['/flows/s/clones/g1', '/flows/s/out/implement-g1-t1.context']);
    expect((hostSettings(request()) as any).sandbox.filesystem.denyWrite).toBeUndefined();
    expect(settings.permissions.deny).toEqual((hostSettings(request()) as any).permissions.deny);
  });

  it('refuses a model of another harness', () => {
    expect(() => claude.buildCommand(request({ executor: { harness: 'claude', model: 'luna', effort: 'low' } }))).toThrow(/does not belong to harness `claude`/);
  });

  it('reads the result, usage with cache and cost, session id and transcript from the stream', () => {
    const result = claude.parseResult(processResult(CLAUDE_STREAM), request());
    expect(result).toMatchObject({
      exitCode: 0,
      output: 'ok',
      usage: { inputTokens: 9 + 5261 + 4293, outputTokens: 42, cacheReadTokens: 4293, costUsd: 0.0111703 },
      sessionId: 'e87e2a4e-cfb3-43c1-91f2-c9f1c2668aad',
      transcript: CLAUDE_STREAM,
      durationMs: 900,
    });
    expect(result.rateLimited).toBeUndefined();
  });

  it('a rejected rate limit or a 429 is a rate limit, not an agent error', () => {
    const rejected = jsonl({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, { type: 'result', is_error: true, result: 'limit' });
    expect(claude.parseResult(processResult(rejected, { exitCode: 1 }), request()).rateLimited).toBe(true);
    const status429 = jsonl({ type: 'result', is_error: true, api_error_status: 429, result: 'Too many requests' });
    expect(claude.parseResult(processResult(status429), request()).rateLimited).toBe(true);
  });

  it('a rejected rate limit says when it resets; an overloaded API or a session dead after init is worth a retry', () => {
    // the shape of a real event (smoke 92-2), status rejected
    const limit = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791486600, rateLimitType: 'five_hour' } };
    const rejected = claude.parseResult(processResult(jsonl(limit, { type: 'result', is_error: true, result: 'limit' }), { exitCode: 1 }), request());
    expect(rejected).toMatchObject({ rateLimited: true, rateLimitResetsAt: 1791486600_000 });
    expect(rejected.transient).toBeUndefined();

    const init = { type: 'system', subtype: 'init', session_id: 's' };
    const answered = { type: 'assistant', message: { content: [] } };
    const overloaded = claude.parseResult(processResult(jsonl(init, answered, { type: 'result', is_error: true, api_error_status: 529, result: 'Overloaded' })), request());
    expect(overloaded).toMatchObject({ exitCode: 1, transient: true, startedWork: true });
    const died = claude.parseResult(processResult(jsonl(init), { exitCode: 1, stderr: 'socket closed' }), request());
    expect(died).toMatchObject({ exitCode: 1, transient: true });
    expect(died.startedWork).toBeUndefined();
    // a CLI refusing its arguments fails before init, and would again
    expect(claude.parseResult(processResult('', { exitCode: 1, stderr: 'error: unknown option' }), request()).transient).toBeUndefined();
    expect(claude.parseResult(processResult(jsonl(init, { type: 'result', is_error: true, result: 'Prompt is too long' })), request()).transient).toBeUndefined();
  });

  it('an error result or a missing one fails the session even with exit code 0', () => {
    const error = jsonl({ type: 'result', is_error: true, result: 'API Error' });
    expect(claude.parseResult(processResult(error), request())).toMatchObject({ exitCode: 1, output: 'API Error' });
    const crashed = claude.parseResult(processResult('', { stderr: 'boom\n' }), request());
    expect(crashed).toMatchObject({ exitCode: 1, output: 'boom', sessionId: SESSION_ID });
  });

  it('a killed session (no result) is charged for the responses it got, each once at its last count', () => {
    const response = (id: string, output: number) => ({
      type: 'assistant',
      message: { id, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output } },
    });
    const stream = jsonl({ type: 'system', subtype: 'init' }, response('m1', 5), response('m1', 40), response('m2', 7), { type: 'user' });
    const killed = claude.parseResult(processResult(stream, { exitCode: 143, timedOut: true }), request());
    expect(killed).toMatchObject({ usage: { inputTokens: 2204, outputTokens: 47, cacheReadTokens: 2000 }, usagePartial: true });
    expect(claude.parseResult(processResult(jsonl({ type: 'system', subtype: 'init' }), { exitCode: 1 }), request()).usage).toBeUndefined();
  });

  it('interactive: only the exit code and the session id we passed in', () => {
    const result = claude.parseResult(processResult('', { exitCode: 0 }), request({ mode: 'interactive' }));
    expect(result).toEqual({ exitCode: 0, output: '', durationMs: 900, timedOut: undefined, sessionId: SESSION_ID });
  });
});

describe('interactive Claude usage', () => {
  const line = (entry: object) => JSON.stringify(entry);
  const assistant = (id: string, at: string, usage: object) => line({ type: 'assistant', timestamp: at, message: { id, model: 'claude-opus-5-5', usage } });
  const START = Date.parse('2026-10-07T20:00:00Z');

  /** A Claude Code session file as 2.1.292 writes it: one response in several entries, subagents apart, `cost-state` at the end. */
  function sessionFiles(configDir: string, sessionId: string, options: { resumedFrom?: boolean; killed?: boolean } = {}) {
    const project = path.join(configDir, 'projects', '-Users-dev-work-repo');
    const turn = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };
    write(project, `${sessionId}.jsonl`, [
      ...(options.resumedFrom ? [assistant('msg_earlier', '2026-10-07T19:00:00Z', turn), line({ type: 'cost-state', sessionId, totalCostUSD: 0.5 })] : []),
      line({ type: 'user', timestamp: '2026-10-07T20:00:01Z', message: { content: 'hi' } }),
      assistant('msg_1', '2026-10-07T20:00:02Z', turn),
      assistant('msg_1', '2026-10-07T20:00:02Z', turn),
      assistant('msg_2', '2026-10-07T20:01:00Z', { ...turn, output_tokens: 150 }),
      ...(options.killed ? [] : [line({ type: 'cost-state', sessionId, totalCostUSD: 1.25 })]),
      '{"type":"assist',
    ].join('\n'));
    write(path.join(project, sessionId, 'subagents'), 'agent-a1.jsonl', assistant('msg_sub', '2026-10-07T20:00:30Z', { input_tokens: 10, output_tokens: 5 }));
  }

  it('counts each response once, subagents included, and takes the cost Claude Code recorded', () => {
    const configDir = tmpDir();
    sessionFiles(configDir, 'grill-1');
    expect(sessionFileUsage('grill-1', START, { projectsDir: path.join(configDir, 'projects') })).toEqual({ inputTokens: 2 * 1102 + 10, outputTokens: 50 + 150 + 5, cacheReadTokens: 2000, costUsd: 1.25 });
    expect(sessionFileUsage('missing', START, { projectsDir: path.join(configDir, 'projects') })).toBeUndefined();
  });

  it('a resumed session counts only its own run; the cost is the session total written after it, else none', () => {
    const configDir = tmpDir();
    sessionFiles(configDir, 'grill-2', { resumedFrom: true });
    sessionFiles(configDir, 'grill-3', { resumedFrom: true, killed: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    try {
      const claude = new ClaudeHarness(loadCatalog());
      // `appendUsage` subtracts the earlier runs' logged cost from the total
      expect(claude.sessionUsage(request({ mode: 'interactive', resumeSessionId: 'grill-2' }), START)).toEqual({ inputTokens: 2214, outputTokens: 205, cacheReadTokens: 2000, costUsd: 1.25 });
      // the only `cost-state` is the earlier run's: priced from the tokens
      expect(claude.sessionUsage(request({ mode: 'interactive', resumeSessionId: 'grill-3' }), START)).toEqual({ inputTokens: 2214, outputTokens: 205, cacheReadTokens: 2000 });
      // in a container the files are the container's
      expect(claude.sessionUsage(request({ mode: 'interactive', sessionId: 'grill-2', isolated: true }), START)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the flow takes it for a headless session killed before its result (smoke 92-5: 0 tokens)', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry({ implement: { exitCode: 143, timedOut: true } });
    for (const harness of Object.values(harnesses).filter((candidate): candidate is Harness => 'parseResult' in candidate)) {
      const parse = harness.parseResult.bind(harness);
      harness.parseResult = (result, sessionRequest) => ({ ...parse(result, sessionRequest), ...(result.timedOut && { usage: { inputTokens: 10, outputTokens: 1 }, usagePartial: true }) });
      harness.sessionUsage = (sessionRequest) => (sessionRequest.kind === 'implement' ? { inputTokens: 9000, outputTokens: 700 } : undefined);
    }
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    expect(readUsage(workDir).find((record) => record.kind === 'implement')).toMatchObject({ input_tokens: 9000, output_tokens: 700 });
  });

  it('the flow records it for its interactive sessions (smoke 92-4: the grill logged 0 tokens)', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry();
    for (const harness of Object.values(harnesses).filter((candidate): candidate is Harness => 'parseResult' in candidate)) {
      const parse = harness.parseResult.bind(harness);
      harness.parseResult = (result, sessionRequest) => (sessionRequest.mode === 'interactive' ? { ...parse(result, sessionRequest), usage: undefined } : parse(result, sessionRequest));
      harness.sessionUsage = (sessionRequest) => ({ inputTokens: 5000, outputTokens: 300, costUsd: sessionRequest.kind === 'grill-technical' ? 2 : 1 });
    }
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    expect(readUsage(workDir).find((record) => record.kind === 'grill-technical')).toMatchObject({ input_tokens: 5000, output_tokens: 300, cost_usd: 2 });
  });
});

describe('CodexHarness', () => {
  const codex = new CodexHarness(loadCatalog());
  const codexRequest = (overrides: Partial<SessionRequest> = {}) => request({ executor: { harness: 'codex', model: 'luna', effort: 'medium' }, ...overrides });

  it('headless: exec --json, effort through --config, a permission profile on the host, prompt on stdin', () => {
    const command = codex.buildCommand(codexRequest());
    expect(command.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-6-luna',
      '--config',
      'model_reasoning_effort="medium"',
      ...hostProfile(codexRequest()),
      '-',
    ]);
    expect(command.stdin).toBe('Zaimplementuj task.');
  });

  it('resume: `exec … resume <id>`, the next message on stdin; the thread id stays when the stream has none', () => {
    const codex = new CodexHarness(loadCatalog());
    const resumed = codexRequest({ resumeSessionId: 'thread-1', prompt: 'Checks failed.' });
    const command = codex.buildCommand(resumed);
    expect(command.argv.slice(-3)).toEqual(['resume', 'thread-1', '-']);
    expect(command.stdin).toBe('Checks failed.');
    const turn = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } };
    expect(codex.parseResult(processResult(jsonl(turn)), resumed).sessionId).toBe('thread-1');
  });

  it('host profile: home closed except toolchains, credentials closed inside them, writes to the code and out/', () => {
    expect(hostProfile(codexRequest())).toEqual([
      '--config',
      'permissions.agentic-host.extends=":workspace"',
      '--config',
      'permissions.agentic-host.filesystem={ "~" = "deny", "~/.m2" = "read", ' +
        '"/flows/s/out/implement-g1-t1.context/spec.md" = "read", "/flows/s/out/implement-g1-t1.context/tasks.yaml" = "read", ' +
        '"/flows/s/clones/g1" = "write", "/flows/s/out/implement-g1-t1" = "write", "~/.ssh" = "deny", "~/.m2/settings.xml" = "deny" }',
      '--config',
      'default_permissions="agentic-host"',
    ]);
  });

  it('host profile: one entry per path, deny decides (a TOML table rejects duplicates)', () => {
    const [, , , filesystem] = hostProfile(codexRequest({ hostAccess: { read: ['~/.m2'], deny: ['~/.m2', '~/.m2'] } }));
    expect(filesystem!.match(/"~\/\.m2"/g)).toHaveLength(1);
    expect(filesystem).toContain('"~/.m2" = "deny"');
  });

  it('isolated: no Codex sandbox inside the container', () => {
    const { argv } = codex.buildCommand(codexRequest({ isolated: true }));
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv.join(' ')).not.toContain('permissions.');
  });

  it('a company gateway: the provider from config.toml reaches the container as --config, its key by name, its host on the allowlist', () => {
    const codexHome = tmpDir();
    write(codexHome, 'config.toml', [
      'model_provider = "litellm"',
      '[mcp_servers.docs]',
      'command = "docs-mcp"',
      '[model_providers.litellm]',
      'name = "LiteLLM"',
      'base_url = "https://llm.example.com/v1"',
      'env_key = "LITELLM_API_KEY"',
      'wire_api = "responses"',
      'experimental_bearer_token = "inline-secret"',
      '',
    ].join('\n'));
    const gateway = new CodexHarness(loadCatalog(), { CODEX_HOME: codexHome });
    const command = gateway.buildCommand(codexRequest({ isolated: true }));
    expect(command.argv.join(' ')).toContain('--config model_provider="litellm" --config model_providers.litellm={ name = "LiteLLM", base_url = "https://llm.example.com/v1", env_key = "LITELLM_API_KEY", wire_api = "responses" }');
    expect(command.argv.join(' ')).not.toMatch(/inline-secret|mcp_servers/);
    expect(command.passEnv).toEqual(['LITELLM_API_KEY']);
    expect(command.allow).toEqual(['llm.example.com']);
    // on the host Codex reads its own config.toml
    expect(gateway.buildCommand(codexRequest()).argv.join(' ')).not.toContain('model_provider');
    // the built-in OpenAI provider: nothing to pass
    write(codexHome, 'config.toml', 'model = "gpt-6"\n');
    expect(gateway.buildCommand(codexRequest({ isolated: true }))).toMatchObject({ passEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'] });
    expect(gateway.buildCommand(codexRequest({ isolated: true })).allow).toBeUndefined();
  });

  it('interactive on the host: asks for approval, prompt as the last argument', () => {
    const { argv, stdin } = codex.buildCommand(codexRequest({ mode: 'interactive', skills: [] }));
    expect(argv.slice(0, 2)).toEqual(['codex', '--model']);
    expect(argv.join(' ')).toContain('--ask-for-approval on-request');
    expect(argv.at(-1)).toBe('Zaimplementuj task.');
    expect(stdin).toBeUndefined();
  });

  it('reads the last agent message, usage summed over turns and the thread id', () => {
    const result = codex.parseResult(processResult(CODEX_STREAM), codexRequest());
    expect(result).toMatchObject({
      exitCode: 0,
      output: '{"findings": []}',
      usage: { inputTokens: 25763, outputTokens: 152, cacheReadTokens: 24948 },
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      transcript: CODEX_STREAM,
    });
  });

  it('a failed turn fails the session; a usage limit is a rate limit', () => {
    const failed = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } });
    expect(codex.parseResult(processResult(failed), codexRequest())).toMatchObject({ exitCode: 1, output: "You've hit your usage limit.", rateLimited: true });
    const broken = codex.parseResult(processResult('', { exitCode: 2, stderr: 'error: unexpected argument' }), codexRequest());
    expect(broken).toMatchObject({ exitCode: 2, output: 'error: unexpected argument' });
    expect(broken.rateLimited).toBeUndefined();
    expect(broken.transient).toBeUndefined();
    const dropped = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: 'x' } }, { type: 'error', message: 'stream disconnected before completion' });
    expect(codex.parseResult(processResult(dropped, { exitCode: 1 }), codexRequest())).toMatchObject({ transient: true, startedWork: true, sessionId: 't' });
    const overloaded = jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'error', message: 'unexpected status 503' });
    const limitedInStderr = codex.parseResult(processResult(overloaded, { exitCode: 1, stderr: '429 Too Many Requests' }), codexRequest());
    expect(limitedInStderr.rateLimited).toBe(true);
    expect(limitedInStderr.transient).toBeUndefined();
  });
});

describe('session records', () => {
  it('the transcript lands in transcripts/, the session id in usage.jsonl and events.jsonl', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry({ implement: { transcript: '{"type":"turn.completed"}\n', sessionId: 'codex-thread-1' } });
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });

    expect(fs.readFileSync(path.join(workDir, 'transcripts', 'implement-g1-t1-codex-thread-1.jsonl'), 'utf8')).toBe('{"type":"turn.completed"}\n');
    const implement = readUsage(workDir).find((record) => record.kind === 'implement');
    expect(implement).toMatchObject({ session_id: 'codex-thread-1', skills: ['agentic-implement', 'agentic-test-quality', 'agentic-clean-code'], framework_version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(readEvents(workDir)).toContainEqual(expect.objectContaining({ type: 'session_done', kind: 'implement', task: 't1', session_id: 'codex-thread-1' }));

    // a session without its own id is recorded under the orchestrator's
    const breakdown = readUsage(workDir).find((record) => record.kind === 'breakdown');
    expect(breakdown?.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
