import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { acquireLock, flowRunning } from '../src/orchestrator/lock.js';
import { loadState, saveState, stateFile } from '../src/orchestrator/state.js';
import { readUsage } from '../src/orchestrator/usage.js';
import { committedRepo, tmpDir, TEST_CONFIG } from './helpers.js';

// State durability.

function setup(script: FakeScript = {}) {
  const root = tmpDir();
  const harnesses = fakeRegistry(script);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const run = () => runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  const kinds = () => harnesses.calls().map((call) => call.kind);
  return { workDir, run, kinds };
}

describe('state.json backup', () => {
  it('keeps the previous version in state.json.prev, with fsync outside the test suite', () => {
    const { workDir } = setup();
    const state = loadState(workDir);
    vi.stubEnv('AGENTIC_NO_FSYNC', '');
    const fsync = vi.spyOn(fs, 'fsyncSync');
    try {
      saveState(workDir, { ...state, title: 'second' });
      expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      fsync.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(JSON.parse(fs.readFileSync(`${stateFile(workDir)}.prev`, 'utf8')).title).toBe('flow');
  });

  it('falls back to state.json.prev when state.json is corrupt, with a warning', () => {
    const { workDir } = setup();
    saveState(workDir, { ...loadState(workDir), title: 'second' });
    fs.writeFileSync(stateFile(workDir), '{"slug": "flo');
    const warnings: string[] = [];
    expect(loadState(workDir, (warning) => warnings.push(warning)).title).toBe('flow');
    expect(warnings.join('\n')).toMatch(/state\.json\.prev/);
  });

  it('a corrupt state.json without a usable backup is still an error', () => {
    const { workDir } = setup();
    fs.writeFileSync(stateFile(workDir), '{');
    expect(() => loadState(workDir)).toThrow(/Corrupt/);
  });
});

describe('review axes are persisted one by one', () => {
  it('a pause between axes does not pay for the first axis again', async () => {
    const { run, kinds } = setup({ 'review-standards': (_request, call) => (call === 1 ? { rateLimited: true } : { report: { findings: [] } }) });
    expect((await run()).paused?.reason).toBe('rate_limit');
    expect((await run()).status).toBe('done');
    // g1: spec once, standards twice (rate limit + retry); g2: one of each
    expect(kinds().filter((kind) => kind === 'review-spec')).toHaveLength(2);
    expect(kinds().filter((kind) => kind === 'review-standards')).toHaveLength(3);
  });
});

describe('usage of a crashed session', () => {
  it('is recorded before the error propagates', async () => {
    const { run, workDir } = setup({ breakdown: { throws: 'harness crashed' } });
    const paused = await run();
    expect(paused.paused).toMatchObject({ reason: 'error', message: expect.stringMatching(/harness crashed/) });
    const breakdown = readUsage(workDir).filter((record) => record.kind === 'breakdown');
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]!.exit_code).not.toBe(0);
  });
});

describe('interrupted flows', () => {
  it('a running state without a live lock owner is reported as not running', () => {
    const { workDir } = setup();
    expect(flowRunning(workDir)).toBe(false);
    const release = acquireLock(workDir);
    expect(flowRunning(workDir)).toBe(true);
    release();
    fs.writeFileSync(path.join(workDir, '.lock'), '999999999');
    expect(flowRunning(workDir)).toBe(false);
  });
});
