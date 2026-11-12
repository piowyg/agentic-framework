import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PROFILE } from '../src/config/load.js';
import { loadCatalog } from '../src/config/models.js';
import { fakeRegistry } from '../src/harness/fake.js';
import { createFlow, runFlow } from '../src/orchestrator/flow.js';
import { ScriptedGates } from '../src/orchestrator/gates.js';
import { readUsage } from '../src/orchestrator/usage.js';
import { skillHashes } from '../src/skills/stage.js';
import { committedRepo, tmpDir, write, TEST_CONFIG } from './helpers.js';

// The content hash of every skill a session got, in its usage record.

describe('skill hashes', () => {
  it('change with any file of the skill, its name or contents, not with where it was staged', () => {
    const staged = (files: Record<string, string>) => {
      const dir = tmpDir();
      for (const [file, text] of Object.entries(files)) write(path.join(dir, 'team-api'), file, text);
      return skillHashes(dir, ['repo:team-api'])['repo:team-api']!;
    };
    const base = staged({ 'SKILL.md': '# API\n', 'references/rest.md': 'REST\n' });
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(staged({ 'SKILL.md': '# API\n', 'references/rest.md': 'REST\n' })).toBe(base);
    expect(staged({ 'SKILL.md': '# API\n', 'references/rest.md': 'REST!\n' })).not.toBe(base);
    expect(staged({ 'SKILL.md': '# API\n', 'references/http.md': 'REST\n' })).not.toBe(base);
  });

  it('every usage record names the hash of each skill the session got', async () => {
    const root = tmpDir();
    const harnesses = fakeRegistry();
    const { workDir } = createFlow({ workRoot: path.join(root, 'work'), title: 'Koszyk', entry: 'new', origin: { repoRoot: committedRepo(root) } });
    await runFlow({ workDir, config: TEST_CONFIG, catalog: loadCatalog(), profile: NO_PROFILE, harnesses, sandbox: harnesses.sandbox, gates: new ScriptedGates() });
    const records = readUsage(workDir);
    expect(records.length).toBeGreaterThan(3);
    for (const record of records) expect(Object.keys(record.skill_hashes ?? {})).toEqual(record.skills);
    const implement = records.find((record) => record.kind === 'implement')!;
    const staged = path.join(workDir, 'out', 'implement-g1-t1.skills');
    expect(fs.existsSync(staged)).toBe(true);
    expect(implement.skill_hashes).toEqual(skillHashes(staged, implement.skills!));
  });
});
