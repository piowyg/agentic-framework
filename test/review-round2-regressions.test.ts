import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { deepMerge } from '../src/config/merge.js';
import type { AgenticConfig } from '../src/config/types.js';
import { ConfigError, validateLayer } from '../src/config/validate.js';
import { fakeRegistry, FAKE_TICKET, type FakeScript } from '../src/harness/fake.js';
import { ScriptedGates, type GateDecision } from '../src/orchestrator/gates.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { acquireLock } from '../src/orchestrator/lock.js';
import { renderUnpriced, renderYield, reviewYield, usageTree } from '../src/orchestrator/usage-report.js';
import type { UsageRecord } from '../src/orchestrator/usage.js';
import { committedRepo, gitRepo, sandboxEnv, tmpDir, write, TEST_CONFIG, QUOTED } from './helpers.js';

// Second independent review (correctness F1–F7, security S1–S6).

function setup(options: { config?: Record<string, unknown>; script?: FakeScript; gates?: Record<string, GateDecision[]> } = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(options.script);
  const gates = new ScriptedGates(options.gates);
  const config = deepMerge(TEST_CONFIG, options.config ?? {}) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates });
  return { workDir, harnesses, gates, run };
}

const blocking = {
  findings: [{ id: 'B', severity: 'blocking', message: 'x', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' } }],
};

describe('config', () => {
  it('F1: stricter global config + team repeating the default → no error, the stricter value stays', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'autonomy: strict\nreview: { max_rounds: 1 }\n');
    const repo = gitRepo(path.join(root, 'repo'));
    write(repo, '.agentic/config.yaml', 'autonomy: standard\nreview: { max_rounds: 2 }\n');
    const { config, warnings } = loadConfig({ cwd: repo, env: sandboxEnv(home) });
    expect(config.review.max_rounds).toBe(1);
    expect(config.gates).toContain('group');
    expect(warnings).toHaveLength(2);
  });

  it('S1: a repo with repos.yaml does not pose as the workspace — the real workspace above stays, sandbox from the repo is forbidden', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const ws = path.join(root, 'ws');
    write(ws, 'repos.yaml', 'repos: []\n');
    write(ws, '.agentic/config.yaml', 'autonomy: strict\n');
    const evil = gitRepo(path.join(ws, 'evil'));
    write(evil, 'repos.yaml', 'repos: []\n');
    write(evil, '.agentic/config.yaml', 'sandbox: { network: { allow: [attacker.example] } }\n');
    expect(() => loadConfig({ cwd: evil, env: sandboxEnv(home) })).toThrow(/sandbox: not allowed in a repo config/);

    write(evil, '.agentic/config.yaml', 'review: { checks: ["npm test"] }\n');
    const loaded = loadConfig({ cwd: evil, env: sandboxEnv(home) });
    expect(loaded.workspaceRoot).toBe(ws);
    expect(loaded.config.autonomy).toBe('strict');
  });

  it('S1: a standalone repo with repos.yaml cannot set sandbox unless the workspace is listed in the global config', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const repo = gitRepo(path.join(root, 'standalone'));
    write(repo, 'repos.yaml', 'repos: []\n');
    write(repo, '.agentic/config.yaml', 'sandbox: { network: { allow: [attacker.example] } }\n');
    expect(() => loadConfig({ cwd: repo, env: sandboxEnv(home) })).toThrow(/sandbox: not allowed/);
    write(home, 'config.yaml', `workspaces: [${repo}]\n`);
    expect(loadConfig({ cwd: repo, env: sandboxEnv(home) }).config.sandbox.network.allow).toEqual(['attacker.example']);
  });

  it('S6: skill names and branch_prefix are neither paths nor git options', () => {
    expect(() => validateLayer({ git: { branch_prefix: '--upload-pack=x' } }, 'repo')).toThrow(ConfigError);
    expect(() => validateLayer({ stages: { implement: { skills: ['repo:../../x'] } } }, 'repo')).toThrow(ConfigError);
    expect(() => validateLayer({ stages: { implement: { skills: ['team:tdd-java', 'tdd'] } } }, 'repo')).not.toThrow();
  });
});

describe('flow', () => {
  it('F3: editing AC in the ticket after spec_issue does not block the approved plan', async () => {
    let reported = false;
    const { run, workDir } = setup({
      script: {
        implement: () => (reported ? { output: 'ok' } : ((reported = true), { report: { status: 'spec_issue', summary: 'x', issue: 'AC-2 wymaga danych', tests_added: [] } })),
      },
    });
    expect((await run()).paused).toMatchObject({ reason: 'spec_issue' });
    fs.writeFileSync(path.join(workDir, 'ticket.md'), FAKE_TICKET.replace('AC-2', 'AC-3'));
    expect(await run()).toMatchObject({ status: 'done' });
  });

  it('F6: a bad fixer executor surfaces at breakdown, not midway through implementation', async () => {
    const { run, harnesses } = setup({
      config: { stages: { ...TEST_CONFIG.stages, fix: { model: 'haiku', skills: [] } }, tiers: Object.fromEntries(Object.keys(TEST_CONFIG.tiers).map((tier) => [tier, { harness: 'claude', model: 'opus', effort: 'xhigh' }])) },
    });
    const state = await run();
    expect(state).toMatchObject({ stage: 'breakdown', paused: { reason: 'error' } });
    expect(state.paused?.message).toMatch(/stages\.fix\.effort/);
    expect(harnesses.calls().some((call) => call.kind === 'implement')).toBe(false);
  });

  it('F7: stop at the decision after the final review → resume asks again without another review-final session', async () => {
    const { run, harnesses, gates } = setup({ script: { 'review-final': { report: blocking } }, gates: { final: [{ action: 'stop' }] } });
    const finalReviews = () => harnesses.calls().filter((call) => call.kind === 'review-final');
    expect((await run()).paused).toMatchObject({ reason: 'human', gate: 'final' });
    expect(finalReviews()).toHaveLength(TEST_CONFIG.review.max_rounds);
    expect(await run()).toMatchObject({ status: 'done' });
    expect(finalReviews()).toHaveLength(TEST_CONFIG.review.max_rounds);
    expect(gates.seen.filter((gate) => gate.gate === 'final')).toHaveLength(2);
  });

  it('S4: tasks.yaml as a symlink to a host file → refused, the file content does not reach state.json', async () => {
    const secret = write(tmpDir(), 'credentials', 'aws_secret_access_key = wJalrSECRET\n');
    const { run, workDir } = setup({
      script: {
        breakdown: (request) => {
          fs.symlinkSync(secret, path.join(request.outDir, 'tasks.yaml'));
          return { output: 'ok' };
        },
      },
    });
    const state = await run();
    expect(state.paused?.message).toMatch(/symlink not allowed/);
    expect(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8')).not.toContain('wJalrSECRET');
  });
});

describe('parsers and reports', () => {
  it('F5: unpriced sessions → cost as a lower bound plus the list of models', () => {
    const record = (model: string, tokens: number): UsageRecord => ({
      at: '', stage: 'implement', kind: 'implement', harness: 'x', model, effort: 'high',
      input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, duration_ms: 0, exit_code: 0,
    });
    const tree = usageTree([record('opus', 1e6), record('terra', 3e6)], { opus: { in: 1, out: 1 } });
    expect(tree.usd).toBeCloseTo(1);
    expect(tree.unpricedModels).toEqual(['terra']);
    expect(renderUnpriced(tree)).toMatch(/75% of tokens without a price \(terra\)/);
  });

  it('review yield: confirmed blocking findings per 1M tokens of each axis, carried and nits not counted', () => {
    const record = (kind: string, tokens: number) => ({ at: '', stage: 'implement', kind, harness: 'x', model: 'm', effort: 'high', input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, duration_ms: 0, exit_code: 0 }) as UsageRecord;
    const finding = (axis: string, extra: object = {}) => ({ id: 'F', severity: 'blocking', message: 'x', fingerprint: 'f', axis, ...extra });
    const rounds = (...findings: object[]) => ({ review: { rounds: [{ round: 1, finished_at: '', findings }] } }) as never;
    const rows = reviewYield(
      [record('review-spec', 400_000), record('review-spec', 100_000), record('review-final', 1_000_000), record('review-standards', 4), record('implement', 9e6)],
      [
        rounds(finding('spec'), finding('spec', { verdict: { status: 'rejected' } }), finding('spec', { carried_from: 1 }), finding('spec', { severity: 'nit' })),
        rounds(finding('final', { verdict: { status: 'confirmed' } }), finding('standards')),
      ],
    );
    expect(rows).toEqual([
      { axis: 'spec', blocking: 2, confirmed: 1, tokens: 500_000, perMillion: 2 },
      { axis: 'final', blocking: 1, confirmed: 1, tokens: 1_000_000, perMillion: 1 },
      // a handful of tokens gives no rate (smoke 92-6: 250000 per 1M)
      { axis: 'standards', blocking: 1, confirmed: 1, tokens: 4 },
    ]);
    expect(renderYield(rows)).toBe(
      'review (blocking findings): spec 1/2 confirmed, 500.0k → 2.0 per 1M · final 1/1 confirmed, 1.00M → 1.0 per 1M · standards 1/1 confirmed, 4',
    );
  });

  it('S5: a stale lock (dead PID) is taken over', () => {
    const workDir = tmpDir();
    fs.writeFileSync(path.join(workDir, '.lock'), '999999');
    const release = acquireLock(workDir);
    expect(fs.readFileSync(path.join(workDir, '.lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(fs.existsSync(path.join(workDir, '.lock'))).toBe(false);
    expect(fs.readdirSync(workDir)).toEqual([]);
  });
});
