import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, NO_PROFILE } from '../src/config/load.js';
import { deepMerge } from '../src/config/merge.js';
import { checkConfigModels, loadCatalog } from '../src/config/models.js';
import { REVIEW_AXES } from '../src/config/schema.js';
import type { AgenticConfig } from '../src/config/types.js';
import { ConfigError } from '../src/config/validate.js';
import { fakeRegistry } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { committedRepo, gitRepo, sandboxEnv, tmpDir, write, TEST_CONFIG } from './helpers.js';

const opus = { harness: 'claude', model: 'opus', effort: 'high' } as const;

async function reviewKindsOf(review: Record<string, unknown>): Promise<string[]> {
  const root = tmpDir();
  const harnesses = fakeRegistry();
  const config = deepMerge(TEST_CONFIG, { review }) as AgenticConfig;
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Axes', entry: 'new', origin: { repoRoot: committedRepo(root) } });
  const state = await runFlow({ workDir, config, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  expect(state.status).toBe('done');
  return harnesses
    .calls()
    .filter((call) => call.kind.startsWith('review-') && call.kind !== 'review-final' && call.group === 'g1')
    .map((call) => call.kind);
}

describe('review axes as a list', () => {
  it('declares spec, standards and security', () => {
    expect(REVIEW_AXES).toEqual(['spec', 'standards', 'security']);
  });

  it('security is off by default; when enabled the group is reviewed in all three axes, in list order', async () => {
    expect(TEST_CONFIG.review.security).toBeNull();
    expect(await reviewKindsOf({})).toEqual(['review-spec', 'review-standards']);
    expect(await reviewKindsOf({ security: opus })).toEqual(['review-spec', 'review-standards', 'review-security']);
  });

  it('an axis set to null is skipped', async () => {
    expect(await reviewKindsOf({ spec: null })).toEqual(['review-standards']);
  });

  it('the schema accepts an executor or null for every axis and rejects unknown axes', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'review:\n  security: { harness: claude, model: opus, effort: high }\n  spec: null\n');
    const { config } = loadConfig({ cwd: root, env: sandboxEnv(home) });
    expect(config.review.security).toEqual(opus);
    expect(config.review.spec).toBeNull();

    write(home, 'config.yaml', 'review:\n  performance: { harness: claude, model: opus, effort: high }\n');
    expect(() => loadConfig({ cwd: root, env: sandboxEnv(home) })).toThrow(ConfigError);
  });

  it('at least one axis must stay enabled', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    write(home, 'config.yaml', 'review:\n  spec: null\n  standards: null\n');
    expect(() => loadConfig({ cwd: root, env: sandboxEnv(home) })).toThrow(/at least one review axis/);
  });

  it('repo config cannot switch off an axis enabled by an earlier layer, but can switch one on', () => {
    const root = tmpDir();
    const home = path.join(root, 'home');
    const repo = gitRepo(path.join(root, 'repo'));
    write(repo, '.agentic/config.yaml', 'review:\n  spec: null\n  security: { harness: claude, model: opus, effort: high }\n');
    const { config, warnings } = loadConfig({ cwd: repo, env: sandboxEnv(home) });
    expect(config.review.spec).toEqual(TEST_CONFIG.review.spec);
    expect(config.review.security).toEqual(opus);
    expect(warnings.join('\n')).toMatch(/review\.spec turned the axis off/);
  });

  it('model check covers every enabled axis', () => {
    const config = deepMerge(TEST_CONFIG, { review: { security: { harness: 'claude', model: 'nope', effort: 'high' } } }) as AgenticConfig;
    expect(checkConfigModels(config, loadCatalog()).join('\n')).toMatch(/review\.security/);
  });
});
