import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { staleBuild } from '../src/paths.js';
import { tmpDir, write } from './helpers.js';

describe('a linked checkout built from older sources', () => {
  const checkout = (builtAt: Date, changedAt: Date) => {
    const root = tmpDir();
    fs.utimesSync(write(root, path.join('dist', 'cli', 'main.js'), ''), builtAt, builtAt);
    fs.utimesSync(write(root, path.join('src', 'orchestrator', 'write-tests.ts'), ''), changedAt, changedAt);
    return root;
  };
  const evening = new Date(2026, 9, 24, 20, 0);
  const later = new Date(2026, 9, 24, 22, 32);

  it('is stale when a source changed after the build', () => {
    expect(staleBuild(checkout(evening, later), true)).toEqual({ built: evening, changed: later });
    expect(staleBuild(checkout(later, evening), true)).toBeUndefined();
  });

  it('says nothing under tsx or for an installed package without sources', () => {
    expect(staleBuild(checkout(evening, later), false)).toBeUndefined();
    const installed = tmpDir();
    write(installed, path.join('dist', 'cli', 'main.js'), '');
    expect(staleBuild(installed, true)).toBeUndefined();
  });
});
