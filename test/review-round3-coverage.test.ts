import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitEnv, gitInfo } from '../src/config/git.js';
import { findWorkspaceRoot, loadConfig, NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig } from '../src/config/types.js';
import { readFileSafe } from '../src/fsutil.js';
import { fakeRegistry, FAKE_TASKS, FAKE_TICKET, type FakeScript } from '../src/harness/fake.js';
import { APPROVED_TASKS, parseTasks, validateSpec, validateTicket } from '../src/orchestrator/artifacts.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { gateActions, ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { acquireLock } from '../src/orchestrator/lock.js';
import { loadState, saveState } from '../src/orchestrator/state.js';
import { recordUsd } from '../src/orchestrator/usage-report.js';
import { appendUsage, summarizeUsage, type UsageRecord } from '../src/orchestrator/usage.js';
import { parseReview } from '../src/review/findings.js';
import { committedRepo, gitRepo, sandboxEnv, tmpDir, write, TEST_CONFIG, QUOTED } from './helpers.js';

// Gaps found by mutation testing in the third review (T1–T12).

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  return { workDir, harnesses, gates, run };
}

const blockingReview = {
  findings: [{ id: 'B', severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};

describe('config: trust and tightening', () => {
  it('T1: workspace does not loosen limits (usd/tokens budget, rounds, gates)', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'review: { max_rounds: 1 }\nbudget: { usd: 5, tokens: 1000 }\n');
    const workspace = path.join(root, 'ws');
    write(workspace, 'repos.yaml', 'repos: []\n');
    write(workspace, '.agentic/config.yaml', 'autonomy: autopilot\nreview: { max_rounds: 9 }\nbudget: { usd: 500, tokens: 99999999 }\n');
    const { config, warnings } = loadConfig({ cwd: workspace, env: sandboxEnv(home) });
    expect(config.review.max_rounds).toBe(1);
    expect(config.budget).toMatchObject({ usd: 5, tokens: 1000 });
    expect(config.gates).toEqual(expect.arrayContaining(['ticket', 'spec']));
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });

  it('T5: GIT_DIR from the environment (e.g. a git hook) does not redirect repo detection', () => {
    const repo = gitRepo(path.join(tmpDir(), 'repo'));
    const other = gitRepo(path.join(tmpDir(), 'other'), 'git@example.com:other.git');
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    try {
      expect(gitInfo(repo)).toEqual({ root: repo, remote: undefined });
      expect(gitInfo(tmpDir()).root).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('T10: a workspace owned by someone else is skipped', () => {
    const workspace = tmpDir();
    write(workspace, 'repos.yaml', 'repos: []\n');
    write(workspace, '.agentic/config.yaml', '{}\n');
    expect(findWorkspaceRoot(workspace, {})).toBe(workspace);
    const getuid = vi.spyOn(process as { getuid: () => number }, 'getuid').mockReturnValue(424242);
    try {
      expect(findWorkspaceRoot(workspace, {})).toBeUndefined();
    } finally {
      getuid.mockRestore();
    }
  });

  it('T10: a workspace inside a repo pointed to by AGENTIC_WORKSPACE is trusted (may set sandbox)', () => {
    const root = tmpDir();
    const repo = gitRepo(path.join(root, 'repo'));
    write(repo, 'repos.yaml', 'repos: []\n');
    write(repo, '.agentic/config.yaml', 'sandbox: { network: { allow: [registry.example] } }\n');
    const env = { ...sandboxEnv(path.join(root, 'home')), AGENTIC_WORKSPACE: repo };
    expect(loadConfig({ cwd: repo, env }).config.sandbox.network.allow).toEqual(['registry.example']);
  });
});

describe('flow', () => {
  it('T2: a headless session with exit code ≠ 0 pauses the flow', async () => {
    const { run } = setup({ script: { breakdown: { exitCode: 2, output: 'boom' } } });
    expect((await run()).paused).toMatchObject({ reason: 'error', message: expect.stringMatching(/code 2/) });
  });

  it('T3: editing tasks.yaml after the gate (during implementation) is ignored', async () => {
    let limited = true;
    const { run, workDir, harnesses } = setup({
      script: { implement: () => (limited ? ((limited = false), { rateLimited: true }) : { output: 'ok' }) },
    });
    expect((await run()).paused?.reason).toBe('rate_limit');
    const extra = FAKE_TASKS + `  - id: g9\n    repo: .\n    depends_on: []\n    tasks:\n      - { id: t1, title: x, tier: mechanical, acceptance: [AC-1] }\n`;
    fs.writeFileSync(path.join(workDir, 'tasks.yaml'), extra);
    expect((await run()).status).toBe('done');
    expect(harnesses.calls().some((call) => call.group === 'g9')).toBe(false);
  });

  it('T3: retry at the breakdown gate saves the new plan as approved', async () => {
    const retried = FAKE_TASKS.replace('Limit rule', 'Limit rule v2');
    const { run, workDir } = setup({
      script: { breakdown: (_request, call) => ({ files: { 'tasks.yaml': call === 1 ? FAKE_TASKS : retried } }) },
      gates: { breakdown: [{ action: 'retry', note: 'popraw' }, { action: 'continue' }] },
    });
    expect((await run()).status).toBe('done');
    expect(fs.readFileSync(path.join(workDir, APPROVED_TASKS), 'utf8')).toBe(retried);
  });

  it('T7: retry after exhausting rounds gives another max_rounds rounds, not one', async () => {
    const { run, harnesses } = setup({
      // only the round limit stops this loop
      config: { review: { ...TEST_CONFIG.review, stop_on: [] } },
      script: { 'review-spec': (request) => ({ report: request.group === 'g1' ? blockingReview : { findings: [] } }) },
      gates: { group: [{ action: 'retry', note: 'jeszcze raz' }, { action: 'continue' }] },
    });
    expect((await run()).status).toBe('done');
    const g1 = harnesses.calls().filter((call) => call.group === 'g1');
    expect(g1.filter((call) => call.kind === 'review-spec')).toHaveLength(4);
    expect(g1.filter((call) => call.kind === 'fix')).toHaveLength(3);
  });

  it('T9: a `failed` flow is final — resume starts no session', async () => {
    const { run, harnesses, workDir } = setup({
      config: { review: { ...TEST_CONFIG.review, on_stop: ['fail'], max_rounds: 1 } },
      script: { 'review-spec': { report: blockingReview } },
    });
    expect((await run()).status).toBe('failed');
    const calls = harnesses.calls().length;
    const failedAt = loadState(workDir).updated_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await run()).status).toBe('failed');
    expect(harnesses.calls()).toHaveLength(calls);
    expect(loadState(workDir).updated_at).toBe(failedAt);
  });

  it('T9: a note from retrying group g1 does not reach g2 prompts', async () => {
    const { run, harnesses } = setup({
      config: { autonomy: 'strict' },
      gates: { group: [{ action: 'retry', note: 'NOTATKA-G1' }] },
    });
    expect((await run()).status).toBe('done');
    const calls = harnesses.calls();
    expect(calls.some((call) => call.group === 'g1' && call.prompt.includes('NOTATKA-G1'))).toBe(true);
    expect(calls.filter((call) => call.group === 'g2').every((call) => !call.prompt.includes('NOTATKA-G1'))).toBe(true);
  });
});

describe('downgrading blocking without basis (T4)', () => {
  const blockingCount = (finding: Record<string, unknown>) =>
    parseReview(
      JSON.stringify({
        contract: 1,
        coverage: { rules: [], tests: [] },
        findings: [{ severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', ...finding }],
      }),
      'standards',
    ).blocking.length;

  it.each([
    ['spec without ref', { basis: { type: 'spec' } }, 0],
    ['spec with AC', { basis: { type: 'spec', ref: 'AC-1' } }, 1],
    ['spec with a section', { basis: { type: 'spec', ref: 'spec:API' } }, 1],
    ['standard without a rule ID', { basis: { type: 'standard', ref: 'arch' } }, 0],
    ['standard with ID', { basis: { type: 'standard', ref: 'ARCH-01' } }, 1],
    ['defect without scenario', { basis: { type: 'defect', scenario: ' ' } }, 0],
    ['defect with scenario', { basis: { type: 'defect', scenario: 'null → NPE' } }, 1],
    ['bez line', { line: undefined, basis: { type: 'spec', ref: 'AC-1' } }, 0],
  ])('%s', (_label, finding, expected) => {
    expect(blockingCount(finding)).toBe(expected);
  });
});

describe('cost and usage (T8)', () => {
  const record: UsageRecord = {
    at: '', stage: 'implement', kind: 'implement', harness: 'claude', model: 'opus', effort: 'high',
    input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 5e5, duration_ms: 0, exit_code: 0,
  };

  it('input, output and cache rates are counted separately', () => {
    expect(recordUsd(record, { opus: { in: 10, out: 50, cache_read: 1 } }).usd).toBeCloseTo(55.5);
  });

  it('cost reported by the harness takes precedence', () => {
    expect(recordUsd({ ...record, cost_usd: 0.42 }, { opus: { in: 10, out: 50 } })).toEqual({ usd: 0.42, estimated: false });
  });

  it('prototype keys are not priced models', () => {
    expect(recordUsd({ ...record, model: 'constructor' }, {}).usd).toBeUndefined();
  });

  it('minutes are summed from usage.jsonl', () => {
    const workDir = tmpDir();
    const result = { exitCode: 0, output: '', durationMs: 90_000 };
    for (let session = 0; session < 2; session++) {
      appendUsage(workDir, { stage: 'implement', kind: 'implement', executor: { harness: 'claude', model: 'opus', effort: 'high' }, result });
    }
    expect(summarizeUsage(workDir).minutes).toBeCloseTo(3);
  });
});

describe('artifacts, files, gates, lock (T10–T11)', () => {
  it('duplicate group and task IDs are rejected', () => {
    const ticket = validateTicket(FAKE_TICKET);
    expect(() => parseTasks(FAKE_TASKS.replace('id: g2', 'id: g1').replace('depends_on: [g1]', 'depends_on: []'), ticket)).toThrow();
    expect(() => parseTasks(FAKE_TASKS.replace('id: t2', 'id: t1'), ticket)).toThrow();
  });

  it('a spec with empty content is rejected', () => {
    expect(() => validateSpec('---\nstatus: ready\n---\n')).toThrow();
  });

  it('readFileSafe rejects a directory', () => {
    expect(() => readFileSafe(tmpDir(), 'x')).toThrow(/not a regular file/);
  });

  it('push_and_stop only at the ticket gate', () => {
    expect(gateActions('ticket')).toContain('push_and_stop');
    expect(gateActions('group')).not.toContain('push_and_stop');
  });

  it.skipIf(process.getuid?.() === 0)("a lock held by another user's process (EPERM) is alive", () => {
    const workDir = tmpDir();
    fs.writeFileSync(path.join(workDir, '.lock'), '1');
    expect(() => acquireLock(workDir)).toThrow(/already running/);
    expect(fs.readFileSync(path.join(workDir, '.lock'), 'utf8')).toBe('1');
  });
});

describe('CLI (T6)', () => {
  const cli = path.resolve('src/cli/main.ts');
  const tsx = path.resolve('node_modules/.bin/tsx');
  const agentic = (cwd: string, home: string, args: string[]) =>
    spawnSync(tsx, [cli, ...args], { cwd, encoding: 'utf8', input: '', env: { ...gitEnv(sandboxEnv(home)), NO_COLOR: '1' } });

  it('a slug with path traversal is rejected', () => {
    const repo = gitRepo(path.join(tmpDir(), 'repo'));
    const result = agentic(repo, path.join(repo, '..', 'home'), ['resume', '../x']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Invalid slug/);
  });

  it('--fake reaches done in a repo whose checks pass on the base: the red gate is not its business', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const repo = committedRepo(path.join(root, 'repo'));
    write(home, 'config.yaml', 'autonomy: autopilot\nreview: { checks: ["true"] }\nsandbox: { mode: none }\n');
    const result = spawnSync(tsx, [cli, 'new', 'Cart limit', '--fake'], {
      cwd: repo,
      encoding: 'utf8',
      input: 'y\n' + '1\n'.repeat(5),
      env: { ...gitEnv(sandboxEnv(home)), NO_COLOR: '1' },
    });
    expect(result.stdout).toMatch(/--fake: write-tests stage skipped/);
    expect(result.stdout).toMatch(/cart-limit: done/);
  });

  it('resume: a saved preset that removes gates is ignored; a flow from another repo is rejected', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const repo = committedRepo(path.join(root, 'repo'));
    const { workDir, slug } = createFlow({ workRoot: path.join(repo, '.agentic', 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
    const state = loadState(workDir);
    state.overrides = { autonomy: 'autopilot' };
    saveState(workDir, state);

    const resumed = agentic(repo, home, ['resume', slug, '--fake']);
    expect(resumed.stdout).toMatch(/drops gates ticket, spec/);
    expect(loadState(workDir).overrides?.autonomy).toBe('autopilot');

    saveState(workDir, { ...loadState(workDir), origin: { repoRoot: tmpDir() } });
    const foreign = agentic(repo, home, ['resume', slug, '--fake']);
    expect(foreign.status).not.toBe(0);
    expect(foreign.stderr + foreign.stdout).toMatch(/belongs to/);
  });
});
