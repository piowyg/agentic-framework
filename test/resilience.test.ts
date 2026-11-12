import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE, type ResolvedProfile } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { loadCatalog } from '../src/config/models.js';
import type { AgenticConfig } from '../src/config/types.js';
import { FAKE_SPEC, fakeRegistry, type FakeReply, type FakeScript } from '../src/harness/fake.js';
import { budgetLimits, overBudget } from '../src/orchestrator/budget.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import type { NetworkState } from '../src/orchestrator/network.js';
import { NETWORK_MAX_WAIT_MS, NETWORK_POLL_MS, RATE_LIMIT_POLL_MS, rateLimitDelay, TRANSIENT_RETRY_DELAYS_MS } from '../src/orchestrator/session-runner.js';
import { readUsage } from '../src/orchestrator/usage.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

// Transient errors retried, rate limits waited out, a session time limit, the flow's budget.

const ONE_TASK = `groups:
  - { id: g1, repo: ., rationale: r, estimate: { prod: 50, tests: 50 }, tasks: [{ id: t1, title: x, tier: standard, acceptance: [AC-1, AC-2] }] }
`;

function setup(options: { script?: FakeScript; config?: object; profile?: Partial<ResolvedProfile>; gates?: Record<string, GateDecision[]>; probe?: (url: string) => Promise<NetworkState> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry({ breakdown: { files: { 'tasks.yaml': ONE_TASK } }, ...options.script });
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  const run = () =>
    runFlow({ workDir, config, catalog: loadCatalog(), profile: { ...NO_PROFILE, ...options.profile }, harnesses, sandbox: harnesses.sandbox, gates, sleep, ...(options.probe && { probe: options.probe }) });
  const calls = (kind: string) => harnesses.calls().filter((call) => call.kind === kind);
  return { workDir, harnesses, gates, run, calls, slept };
}

const done: FakeReply = { report: { status: 'done', summary: 'ok', tests_added: [] }, commit: { 'A.java': 'a' } };
const overloaded: FakeReply = { exitCode: 1, output: 'API Error: 529 Overloaded', transient: true };

describe('transient errors', () => {
  it('are retried, backing off; a session that never started runs again under a new id', async () => {
    const { run, calls, slept, workDir } = setup({ script: { implement: (_request, call) => (call <= 2 ? overloaded : done) } });
    expect((await run()).status).toBe('done');
    const [first, second, third] = calls('implement');
    expect(calls('implement')).toHaveLength(3);
    expect(slept).toEqual(TRANSIENT_RETRY_DELAYS_MS.slice(0, 2));
    expect(new Set([first!.sessionId, second!.sessionId, third!.sessionId]).size).toBe(3);
    expect(third!.resumeSessionId).toBeUndefined();
    expect(third!.prompt).toBe(first!.prompt);
    // every run is in usage.jsonl, the failed ones too
    expect(readUsage(workDir).filter((record) => record.kind === 'implement').map((record) => record.exit_code)).toEqual([1, 1, 0]);
  });

  it('a session that had started is resumed, told it was interrupted; each run keeps its transcript', async () => {
    const { run, calls, workDir } = setup({
      script: { implement: (_request, call) => (call === 1 ? { ...overloaded, startedWork: true, transcript: 'first\n' } : { ...done, transcript: 'second\n' }) },
    });
    expect((await run()).status).toBe('done');
    const [first, retried] = calls('implement');
    expect(retried!.resumeSessionId).toBe(first!.sessionId);
    expect(retried!.prompt).toMatch(/Your previous run was interrupted/);
    const transcripts = fs.readdirSync(path.join(workDir, 'transcripts')).filter((file) => file.startsWith('implement-g1-t1'));
    expect(transcripts.sort()).toEqual([`implement-g1-t1-${first!.sessionId}.jsonl`, `implement-g1-t1-retry1-${first!.sessionId}.jsonl`]);
  });

  it('after three retries the group pauses with the error', async () => {
    const { run, calls } = setup({ script: { implement: overloaded } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'error', group: 'g1', message: 'implement: transient error, 3 retries did not help; last: API Error: 529 Overloaded' });
    expect(calls('implement')).toHaveLength(1 + TRANSIENT_RETRY_DELAYS_MS.length);
  });

  it('a session that died without a word is named by its exit code', async () => {
    const { run } = setup({ script: { implement: { exitCode: 1, output: '', transient: true } } });
    expect((await run()).paused?.message).toBe('implement: transient error, 3 retries did not help; last: session stopped without a message (code 1)');
  });

  it('past the retries with the host offline it waits for the network, then retries the session again', async () => {
    // acceptance smoke, finding 6: an outage paused the flow within 20 s
    const answers: NetworkState[] = ['down', 'down', 'up'];
    const probed: string[] = [];
    const probe = async (url: string) => {
      probed.push(url);
      return answers.shift() ?? 'up';
    };
    const { run, calls, slept } = setup({ probe, script: { implement: (_request, call) => (call <= 1 + TRANSIENT_RETRY_DELAYS_MS.length ? overloaded : done) } });
    expect((await run()).status).toBe('done');
    expect(probed).toEqual(Array(3).fill('https://api.openai.com'));
    expect(slept).toEqual([...TRANSIENT_RETRY_DELAYS_MS, NETWORK_POLL_MS, NETWORK_POLL_MS]);
    expect(calls('implement')).toHaveLength(2 + TRANSIENT_RETRY_DELAYS_MS.length);
  });

  it('a network down past the wait pauses saying so, not with the session\'s error alone', async () => {
    const { run, slept } = setup({ probe: async () => 'down', script: { implement: overloaded } });
    const state = await run();
    expect(state.paused?.message).toMatch(/last: API Error: 529 Overloaded\n  the host can't reach https:\/\/api\.openai\.com for 30 min; network down\? `agentic resume` when it is back$/);
    expect(slept.filter((ms) => ms === NETWORK_POLL_MS)).toHaveLength(NETWORK_MAX_WAIT_MS / NETWORK_POLL_MS);
  });

  it('a certificate the host rejects too pauses at once, naming an outage or TLS inspection', async () => {
    const { run, slept } = setup({ probe: async () => 'tls', script: { implement: overloaded } });
    const state = await run();
    expect(state.paused?.message).toMatch(/the host doesn't trust the https:\/\/api\.openai\.com certificate either: a network failure \(router, captive portal\) or TLS inspection/);
    expect(slept).toEqual(TRANSIENT_RETRY_DELAYS_MS);
  });

  it('with the host online the session\'s error pauses as it is', async () => {
    const { run } = setup({ probe: async () => 'up', script: { implement: overloaded } });
    expect((await run()).paused?.message).toBe('implement: transient error, 3 retries did not help; last: API Error: 529 Overloaded');
  });

  it('a plain failure is not retried', async () => {
    const { run, calls } = setup({ script: { implement: { exitCode: 2, output: 'error: unknown option' } } });
    expect((await run()).paused).toMatchObject({ reason: 'error' });
    expect(calls('implement')).toHaveLength(1);
  });
});

describe('rate limit', () => {
  const now = Date.now();

  it('`on_rate_limit: wait` waits until the reported reset, then runs the session again', async () => {
    const resetsAt = now + 60 * 60_000;
    const { run, calls, slept } = setup({
      profile: { on_rate_limit: 'wait' },
      script: { implement: (_request, call) => (call === 1 ? { exitCode: 1, rateLimited: true, rateLimitResetsAt: resetsAt } : done) },
    });
    expect((await run()).status).toBe('done');
    expect(calls('implement')).toHaveLength(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]!).toBeGreaterThan(60 * 60_000);
    expect(slept[0]!).toBeLessThanOrEqual(61 * 60_000);
  });

  it('without a reset time it looks again every 15 minutes, for five hours at most, then pauses', async () => {
    const { run, calls, slept } = setup({ profile: { on_rate_limit: 'wait' }, script: { implement: { exitCode: 1, rateLimited: true } } });
    expect((await run()).paused).toMatchObject({ reason: 'rate_limit' });
    expect(slept).toEqual(Array(20).fill(RATE_LIMIT_POLL_MS));
    expect(calls('implement')).toHaveLength(21);
  });

  it('pauses at once by default', async () => {
    const { run, calls, slept } = setup({ script: { implement: { exitCode: 1, rateLimited: true, rateLimitResetsAt: now + 1000 } } });
    expect((await run()).paused).toMatchObject({ reason: 'rate_limit' });
    expect(calls('implement')).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('a reset in the past or unknown means a poll', () => {
    expect(rateLimitDelay(undefined, now)).toBe(RATE_LIMIT_POLL_MS);
    expect(rateLimitDelay(now - 1, now)).toBe(RATE_LIMIT_POLL_MS);
    expect(rateLimitDelay(now + 1000, now)).toBe(61_000);
  });
});

describe('session_timeout', () => {
  it('headless sessions get it, interactive ones none; a session past it pauses its group, no retry', async () => {
    const { run, calls, harnesses } = setup({ config: { session_timeout: '30m' }, script: { implement: { exitCode: 143, timedOut: true } } });
    const state = await run();
    expect(state.paused).toMatchObject({ reason: 'timeout', group: 'g1', message: 'implement went over `session_timeout` (30m) and was stopped' });
    expect(calls('implement')).toHaveLength(1);
    const timeouts = harnesses.sandbox.execs.map((options) => [options.interactive, options.timeoutMs]);
    expect(timeouts).toContainEqual([false, 30 * 60_000]);
    expect(timeouts.filter(([interactive]) => interactive).every(([, timeoutMs]) => timeoutMs === undefined)).toBe(true);
  });
});

describe('a session stopped midway', () => {
  it('is resumed by the next run, told its uncommitted work is still there', async () => {
    const { run, calls, workDir } = setup({ script: { implement: (_request, call) => (call === 1 ? { exitCode: 143, timedOut: true, startedWork: true } : done) } });
    expect((await run()).paused).toMatchObject({ reason: 'timeout' });
    const [killed] = calls('implement');
    expect(JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8')).groups.g1.interrupted).toEqual({ kind: 'implement', label: 't1', session: killed!.sessionId });
    expect((await run()).status).toBe('done');
    const resumed = calls('implement')[1]!;
    expect(resumed.resumeSessionId).toBe(killed!.sessionId);
    expect(resumed.prompt).toMatch(/stopped before it finished.*uncommitted changes are still in the working directory/s);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8')).groups.g1.interrupted).toBeUndefined();
  });

  it('after failed retries the session that got to work is the one resumed', async () => {
    const { run, calls } = setup({
      script: { implement: (_request, call) => (call === 1 ? { ...overloaded, startedWork: true } : call <= 4 ? overloaded : done) },
    });
    expect((await run()).paused).toMatchObject({ reason: 'error' });
    expect((await run()).status).toBe('done');
    expect(calls('implement')[4]!.resumeSessionId).toBe(calls('implement')[0]!.sessionId);
  });

  it('one that never started work runs fresh', async () => {
    const { run, calls } = setup({ script: { implement: (_request, call) => (call === 1 ? { exitCode: 143, timedOut: true } : done) } });
    expect((await run()).paused).toMatchObject({ reason: 'timeout' });
    expect((await run()).status).toBe('done');
    expect(calls('implement')[1]!.resumeSessionId).toBeUndefined();
  });
});

describe('budget', () => {
  const slow: FakeReply = { ...done, durationMs: 70_000 };

  it('past a limit a human decides before the next session; continue raises every limit by half', async () => {
    const { run, gates, calls } = setup({ config: { budget: { minutes: 1 } }, script: { implement: slow } });
    const state = await run();
    expect(state.status).toBe('done');
    const question = gates.seen.find((request) => request.summary.startsWith('flow budget exceeded'))!;
    expect(question).toMatchObject({ gate: 'group', group: 'g1', actions: ['continue', 'stop', 'abort'] });
    expect(question.summary).toMatch(/^flow budget exceeded: 1\.2 min of 1 min\.\ncontinue = limits \+50% \(1\.5 min\)/);
    expect(state.budget_raises).toBe(1);
    expect(calls('review-spec')).toHaveLength(1);
  });

  it('a retry checks it too; a stop there keeps the started session for resume', async () => {
    const { run, gates, calls, workDir } = setup({
      config: { budget: { minutes: 1 } },
      script: { implement: (_request, call) => (call === 1 ? { ...overloaded, startedWork: true, durationMs: 70_000 } : done) },
      gates: { group: [{ action: 'stop' }] },
    });
    expect((await run()).paused).toMatchObject({ reason: 'budget' });
    expect(calls('implement')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8')).groups.g1.interrupted).toMatchObject({ kind: 'implement', label: 't1' });
    expect((await run()).status).toBe('done');
    expect(calls('implement')[1]!.resumeSessionId).toBe(calls('implement')[0]!.sessionId);
    expect(gates.seen.filter((request) => request.summary.startsWith('flow budget exceeded'))).toHaveLength(2);
  });

  it('the grills go at the human’s pace: their minutes don’t count', async () => {
    const { run, gates } = setup({ config: { budget: { minutes: 1 } }, script: { 'grill-technical': { files: { 'spec.md': FAKE_SPEC }, durationMs: 40 * 60_000 } } });
    expect((await run()).status).toBe('done');
    expect(gates.seen.some((request) => request.summary.startsWith('flow budget exceeded'))).toBe(false);
  });

  it('stop pauses the flow; resume asks again', async () => {
    const { run, gates } = setup({ config: { budget: { minutes: 1 } }, script: { implement: slow }, gates: { group: [{ action: 'stop' }] } });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'budget', group: 'g1', message: 'flow budget exceeded: 1.2 min of 1 min' });
    expect((await run()).status).toBe('done');
    expect(gates.seen.filter((request) => request.summary.startsWith('flow budget exceeded'))).toHaveLength(2);
  });

  it('tokens and dollars are limits too', () => {
    expect(overBudget(budgetLimits({ tokens: 1_000_000, usd: 2 }), { minutes: 5, tokens: 1_500_000, usd: 1 })).toEqual(['1.50M tokens of 1.00M tokens']);
    expect(overBudget(budgetLimits({ usd: 2 }), { minutes: 0, tokens: 0, usd: 2.5 })).toEqual(['$2.50 of $2.00']);
  });

  it('every continue past the budget raises each limit by half', () => {
    expect(budgetLimits({ minutes: 60, usd: 2 }, 2)).toEqual({ minutes: 135, usd: 4.5 });
  });
});
