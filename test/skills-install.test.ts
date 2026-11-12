import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameworkSkills, installSkills, linkState, uninstallSkills } from '../src/skills/install.js';
import { tmpDir, write } from './helpers.js';

// `agentic skills` links the practice skills into Claude Code and Codex.

function framework() {
  const dir = tmpDir();
  write(dir, 'agentic-clean-code/SKILL.md', '---\nname: agentic-clean-code\ndescription: Names instead of comments.\n---\n');
  write(dir, 'agentic-implement/SKILL.md', '---\nname: agentic-implement\ndescription: Implement stage.\n---\n');
  return dir;
}

const CLAUDE = path.join('.claude', 'skills', 'agentic-clean-code');
const CODEX = path.join('.agents', 'skills', 'agentic-clean-code');

describe('agentic skills', () => {
  it('lists every framework skill and marks the stage skills', () => {
    expect(frameworkSkills(framework())).toEqual([
      { name: 'agentic-clean-code', description: 'Names instead of comments.', stage: false },
      { name: 'agentic-implement', description: 'Implement stage.', stage: true },
    ]);
  });

  it('the shipped stage skills are recognised, the practice skills are not', () => {
    const shipped = frameworkSkills();
    expect(shipped.filter((skill) => skill.stage).map((skill) => skill.name)).toContain('agentic-review-final');
    expect(shipped.filter((skill) => !skill.stage).map((skill) => skill.name)).toEqual(expect.arrayContaining(['agentic-clean-code', 'agentic-test-quality']));
  });

  it('install links only the practice skills into both harnesses, and a second run changes nothing', () => {
    const dir = framework();
    const home = tmpDir();
    expect(installSkills(home, dir)).toEqual([
      { harness: 'Claude Code', skill: 'agentic-clean-code', result: 'linked' },
      { harness: 'Codex', skill: 'agentic-clean-code', result: 'linked' },
    ]);
    expect(fs.realpathSync(path.join(home, CLAUDE))).toBe(fs.realpathSync(path.join(dir, 'agentic-clean-code')));
    expect(fs.readFileSync(path.join(home, CODEX, 'SKILL.md'), 'utf8')).toMatch(/name: agentic-clean-code/);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'agentic-implement'))).toBe(false);
    expect(installSkills(home, dir).map((each) => each.result)).toEqual(['already', 'already']);
  });

  it('never touches the user’s own skill of the same name; re-points a link left by another checkout', () => {
    const dir = framework();
    const home = tmpDir();
    write(home, path.join(CLAUDE, 'SKILL.md'), 'mine');
    fs.mkdirSync(path.dirname(path.join(home, CODEX)), { recursive: true });
    fs.symlinkSync(path.join(tmpDir(), 'gone'), path.join(home, CODEX));
    expect(installSkills(home, dir).map((each) => each.result)).toEqual(['skipped', 'relinked']);
    expect(fs.readFileSync(path.join(home, CLAUDE, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(linkState(path.join(home, CODEX), path.join(dir, 'agentic-clean-code'))).toBe('linked');
  });

  it('uninstall removes only the links to this framework', () => {
    const dir = framework();
    const home = tmpDir();
    installSkills(home, dir);
    fs.rmSync(path.join(home, CLAUDE));
    write(home, path.join(CLAUDE, 'SKILL.md'), 'mine');
    expect(uninstallSkills(home, dir)).toEqual([{ harness: 'Codex', skill: 'agentic-clean-code' }]);
    expect(fs.existsSync(path.join(home, CODEX))).toBe(false);
    expect(fs.readFileSync(path.join(home, CLAUDE, 'SKILL.md'), 'utf8')).toBe('mine');
  });
});
