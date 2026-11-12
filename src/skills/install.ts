// `agentic skills`: the framework's practice skills in the user's own sessions —
// Claude Code reads `~/.claude/skills`, Codex `~/.agents/skills`. Linked, not copied, so a framework update reaches
// them. Stage skills stay out: they are contracts of flow sessions, useless outside a flow.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { SessionKind } from '../harness/types.js';
import { FRAMEWORK_SKILLS_DIR, stageSkill } from './stage.js';

export interface FrameworkSkill {
  name: string;
  description: string;
  /** A stage skill of the flow; never installed. */
  stage: boolean;
}

/** Where each harness looks for the user's skills, relative to the home directory. */
export const SKILL_TARGETS = [
  { harness: 'Claude Code', dir: path.join('.claude', 'skills') },
  { harness: 'Codex', dir: path.join('.agents', 'skills') },
] as const;

export type Harness = (typeof SKILL_TARGETS)[number]['harness'];

/** `linked` → this framework's skill; `other-link` → a symlink elsewhere (an old checkout); `taken` → the user's own file or directory. */
export type LinkState = 'linked' | 'missing' | 'other-link' | 'taken';

export type InstallResult = 'linked' | 'already' | 'relinked' | 'skipped';

// A Record, so a new session kind can't be left out of the stage skills.
const SESSION_KINDS: Record<SessionKind, true> = {
  'grill-business': true,
  'grill-technical': true,
  breakdown: true,
  'write-tests': true,
  implement: true,
  'review-spec': true,
  'review-standards': true,
  'review-security': true,
  fix: true,
  merge: true,
  'review-final': true,
};
const STAGE_SKILLS = new Set(Object.keys(SESSION_KINDS).map((kind) => stageSkill(kind as SessionKind)));

export function frameworkSkills(dir = FRAMEWORK_SKILLS_DIR): FrameworkSkill[] {
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'SKILL.md')))
    .sort()
    .map((name) => ({ name, description: frontmatter(path.join(dir, name, 'SKILL.md')).description ?? '', stage: STAGE_SKILLS.has(name) }));
}

function frontmatter(file: string): { description?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf8'));
  return match ? ((parse(match[1]!) as { description?: string } | null) ?? {}) : {};
}

export function linkState(link: string, source: string): LinkState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return 'missing';
  }
  if (!stat.isSymbolicLink()) return 'taken';
  return path.resolve(path.dirname(link), fs.readlinkSync(link)) === source ? 'linked' : 'other-link';
}

/** Each practice skill into each harness; idempotent, and a file or directory of the same name is never touched. */
export function installSkills(home: string, dir = FRAMEWORK_SKILLS_DIR): { harness: Harness; skill: string; result: InstallResult }[] {
  return practice(dir).flatMap((skill) =>
    SKILL_TARGETS.map(({ harness, dir: target }) => {
      const source = path.join(dir, skill);
      const link = path.join(home, target, skill);
      const state = linkState(link, source);
      if (state === 'linked') return { harness, skill, result: 'already' as const };
      if (state === 'taken') return { harness, skill, result: 'skipped' as const };
      if (state === 'other-link') fs.rmSync(link);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(source, link, 'dir');
      return { harness, skill, result: state === 'other-link' ? ('relinked' as const) : ('linked' as const) };
    }),
  );
}

/** Removes only the links to this framework's skills. */
export function uninstallSkills(home: string, dir = FRAMEWORK_SKILLS_DIR): { harness: Harness; skill: string }[] {
  return practice(dir).flatMap((skill) =>
    SKILL_TARGETS.flatMap(({ harness, dir: target }) => {
      const link = path.join(home, target, skill);
      if (linkState(link, path.join(dir, skill)) !== 'linked') return [];
      fs.rmSync(link);
      return [{ harness, skill }];
    }),
  );
}

function practice(dir: string): string[] {
  return frameworkSkills(dir)
    .filter((skill) => !skill.stage)
    .map((skill) => skill.name);
}
