import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, migrateState, newState, saveState, STATE_VERSION } from '../src/orchestrator/state.js';
import { tmpDir } from './helpers.js';

function savedFlow(mutate: (raw: Record<string, unknown>) => void): string {
  const workDir = path.join(tmpDir(), 'flow');
  saveState(workDir, newState({ slug: 'flow', title: 'Flow', entry: 'new', origin: { repoRoot: '/repo' } }));
  const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));
  mutate(raw);
  fs.writeFileSync(path.join(workDir, 'state.json'), JSON.stringify(raw));
  return workDir;
}

describe('state.json migrations', () => {
  it('new state carries the current version', () => {
    expect(newState({ slug: 'a', title: 'A', entry: 'new', origin: { repoRoot: '/' } }).version).toBe(STATE_VERSION);
  });

  it('rejects a state written by a newer framework', () => {
    const workDir = savedFlow((raw) => (raw.version = STATE_VERSION + 1));
    expect(() => loadState(workDir)).toThrow(/newer framework version/);
  });

  it('rejects a missing or non-integer version', () => {
    expect(() => loadState(savedFlow((raw) => delete raw.version))).toThrow(/version/);
    expect(() => loadState(savedFlow((raw) => (raw.version = '1')))).toThrow(/version/);
  });

  it('fills stages missing in an older state as pending', () => {
    const workDir = savedFlow((raw) => delete (raw.stages as Record<string, unknown>)['final-review']);
    expect(loadState(workDir).stages['final-review']).toEqual({ status: 'pending' });
  });

  it('v3 → v4: an unfinished final review runs again as a review loop; a passed one stays done', () => {
    const v3Flow = (finalReview: Record<string, unknown>) =>
      savedFlow((raw) => {
        raw.version = 3;
        (raw.stages as Record<string, unknown>)['final-review'] = finalReview;
      });
    expect(loadState(v3Flow({ status: 'running', final_blocking: 2 })).stages['final-review']).toEqual({ status: 'running' });
    expect(loadState(v3Flow({ status: 'done' })).stages['final-review']).toEqual({ status: 'pending' });
    expect(loadState(v3Flow({ status: 'done', gate: 'passed', final_blocking: 0 })).stages['final-review']).toEqual({ status: 'done', gate: 'passed' });
  });

  it('v2 → v3: cwd becomes origin; groups already started keep working in place', () => {
    const workDir = savedFlow((raw) => {
      raw.version = 2;
      raw.cwd = '/repo';
      delete raw.origin;
      raw.groups = { g1: { status: 'done', tasks: {} }, g2: { status: 'pending', tasks: {} } };
    });
    const state = loadState(workDir);
    expect(state.origin).toEqual({ repoRoot: '/repo' });
    expect(state).not.toHaveProperty('cwd');
    expect(state.groups.g1).toMatchObject({ clonePath: '/repo' });
    expect(state.groups.g2).toEqual({ status: 'pending', tasks: {} });
  });

  it('runs the migration chain step by step up to the current version', () => {
    const applied: number[] = [];
    const migrations = {
      0: (raw: Record<string, unknown>) => {
        applied.push(0);
        return { ...raw, legacy: true };
      },
    };
    const migrated = migrateState({ version: 0, slug: 'x' }, migrations, 1);
    expect(applied).toEqual([0]);
    expect(migrated).toMatchObject({ version: 1, legacy: true });
  });

  it('fails clearly when a migration step is missing', () => {
    expect(() => migrateState({ version: 0 }, {}, 1)).toThrow(/no migration v0 → v1/);
  });
});
