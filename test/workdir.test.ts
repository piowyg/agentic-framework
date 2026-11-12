import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyWorkRoot, workRoot, workRoots } from '../src/orchestrator/workdir.js';
import { tmpDir } from './helpers.js';

describe('workRoot', () => {
  const globalDir = '/home/dev/.agentic';

  it('keeps flows outside the repo, one dir per repo or workspace', () => {
    const repo = workRoot({ globalDir, repoRoot: '/code/Shop App' }, '/code/Shop App/src');
    expect(repo).toMatch(/^\/home\/dev\/\.agentic\/work\/shop-app-[0-9a-f]{8}$/);
    expect(workRoot({ globalDir, repoRoot: '/code/Shop App' }, '/elsewhere')).toBe(repo);
    expect(workRoot({ globalDir, repoRoot: '/other/Shop App' }, '/other/Shop App')).not.toBe(repo);
    expect(workRoot({ globalDir, workspaceRoot: '/teams/payments', repoRoot: '/teams/payments/api' }, '/teams/payments/api')).toMatch(
      /\/work\/payments-[0-9a-f]{8}$/,
    );
    expect(workRoot({ globalDir }, '/scratch/idea')).toMatch(/\/work\/idea-[0-9a-f]{8}$/);
  });

  it('lists the legacy root inside the repo only when it exists', () => {
    const repoRoot = tmpDir();
    const location = { globalDir: path.join(tmpDir(), '.agentic'), repoRoot };
    expect(legacyWorkRoot(location, repoRoot)).toBe(path.join(repoRoot, '.agentic', 'work'));
    expect(legacyWorkRoot({ ...location, workspaceRoot: '/teams/payments' }, repoRoot)).toBe('/teams/payments/work');
    expect(workRoots(location, repoRoot)).toEqual([workRoot(location, repoRoot)]);
    fs.mkdirSync(path.join(repoRoot, '.agentic', 'work'), { recursive: true });
    expect(workRoots(location, repoRoot)).toEqual([workRoot(location, repoRoot), path.join(repoRoot, '.agentic', 'work')]);
  });
});
