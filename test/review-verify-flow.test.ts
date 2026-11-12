import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry, type FakeScript } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { committedRepo, QUOTED, QUOTED_FILE, tmpDir, TEST_CONFIG } from './helpers.js';

const blocking = (overrides: Record<string, unknown> = {}) => ({
  findings: [{ id: 'B1', severity: 'blocking', message: 'suma bez walidacji', ...QUOTED, weight: 'medium', impact: 'x', basis: { type: 'spec', ref: 'AC-1' }, ...overrides }],
});
const clean = { findings: [] };

function setup(script: FakeScript) {
  const root = tmpDir();
  const repo = committedRepo(path.join(root, 'repo'));
  const harnesses = fakeRegistry(script);
  const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'flow', entry: 'new', origin: { repoRoot: repo } });
  const run = () => runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
  const fixes = () => harnesses.calls().filter((call) => call.kind === 'fix' && call.group === 'g1');
  const report = (name: string) => JSON.parse(fs.readFileSync(path.join(workDir, name), 'utf8'));
  return { workDir, harnesses, run, fixes, report };
}

describe('verified findings in the review loop', () => {
  it('a finding whose quote is not in the code reaches the gate report, not the fixer', async () => {
    const { run, fixes, report } = setup({ 'review-standards': (request) => ({ report: request.group === 'g1' ? blocking({ quote: 'long overdraft;' }) : clean }) });
    const state = await run();
    expect(state.status).toBe('done');
    expect(fixes()).toHaveLength(0);
    expect(report('review-standards-g1-r1.json').findings[0]).toMatchObject({ id: 'B1', verdict: { status: 'rejected', reason: expect.stringMatching(/does not occur/) } });
    expect(state.groups.g1!.review!.rounds[0]!.findings[0]!.verdict?.status).toBe('rejected');
  });

  it('an ambiguous quote resumes the reviewer once; the longer quote is confirmed and goes to the fixer', async () => {
    const { run, fixes, harnesses } = setup({
      'review-standards': (request, call) => {
        if (request.group !== 'g1' || call > 2) return { report: clean };
        // `total` is both the field (line 2) and the addItems (line 5); `long total;` only the field
        return { report: blocking(call === 1 ? { quote: 'total' } : { quote: 'long total;' }) };
      },
    });
    expect((await run()).status).toBe('done');
    const reviews = harnesses.calls().filter((call) => call.kind === 'review-standards' && call.group === 'g1');
    expect(reviews[1]!.resumeSessionId).toBe(reviews[0]!.sessionId);
    expect(reviews[1]!.prompt).toContain('B1 src/Cart.java:2: "total"');
    expect(fixes()).toHaveLength(1);
  });

  it('code a reviewer writes into the clone can’t back its own quote', async () => {
    const { run, fixes, report } = setup({
      'review-standards': (request) =>
        request.group === 'g1'
          ? { uncommitted: { [QUOTED_FILE.path]: 'long forged;\n' }, report: blocking({ line: 1, quote: 'long forged;' }) }
          : { report: clean },
    });
    const state = await run();
    expect(state.status).toBe('done');
    expect(fixes()).toHaveLength(0);
    expect(report('review-standards-g1-r1.json').findings[0].verdict.status).toBe('rejected');
    expect(state.groups.g1!.review!.rounds[0]!.warnings?.[0]).toMatch(/changed code/);
  });
});
