import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgenticConfig } from '../config/types.js';
import type { SessionKind } from '../harness/types.js';
import { PACKAGE_ROOT } from '../paths.js';
import { RULE_ID } from '../review/rule-id.js';

/** Skills shipped with the framework; the stage skills and the default practice skills. */
export const FRAMEWORK_SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');

/** Framework skills carry a prefix, so they never collide with a user's own skills. */
export function stageSkill(kind: SessionKind): string {
  return `agentic-${kind}`;
}

/**
 * Directory of a skill: `repo:<name>` from the repo's `.agentic/skills/`, a bare name from the framework.
 * TODO: `me:`, `team:`, `org:`, `ext:` sources.
 */
export function resolveSkill(name: string, repoRoot: string): string {
  const [source, skill] = name.includes(':') ? name.split(':', 2) : ['', name];
  if (source && source !== 'repo') throw new Error(`skill \`${name}\`: source \`${source}:\` not supported yet`);
  const dir = source === 'repo' ? path.join(repoRoot, '.agentic', 'skills', skill!) : path.join(FRAMEWORK_SKILLS_DIR, skill!);
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) throw new Error(`skill \`${name}\`: missing ${skillFile}`);
  // staging skips symlinks, so a linked skill would reach the session empty
  if ([dir, skillFile].some((file) => fs.lstatSync(file).isSymbolicLink())) throw new Error(`skill \`${name}\`: symlink not allowed (${dir})`);
  return dir;
}

/**
 * Copies the session's skills into `target/<name>/` (the prefix dropped from `repo:` names), mounted read-only
 * for the session. Symlinks are skipped: a repo skill must not pull in files from outside it.
 */
export function stageSkills(target: string, names: string[], repoRoot: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of names) {
    const destination = path.join(target, skillDirName(name));
    if (fs.existsSync(destination)) throw new Error(`skill \`${name}\`: two skills under the same directory name`);
    fs.cpSync(resolveSkill(name, repoRoot), destination, {
      recursive: true,
      filter: (source) => !fs.lstatSync(source).isSymbolicLink(),
    });
  }
}

/**
 * Content hash of each staged skill (`sha256` of its files, path and bytes, first 12 hex): stats per skill version
 * (rounds, cost, confirmed findings) tell an edited skill from the one before, whatever its source.
 */
export function skillHashes(staged: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, dirHash(path.join(staged, skillDirName(name)))]));
}

function dirHash(dir: string): string {
  const hash = createHash('sha256');
  const files = (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
  for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(dir, file))).update('\0');
  return hash.digest('hex').slice(0, 12);
}

/**
 * A session's skills: the stage skill (or its `stage_skill` replacement) first, then practice skills.
 * `skills.disabled` drops practice skills from every stage; a stage skill stays — its output is a contract.
 */
export function sessionSkills(config: Pick<AgenticConfig, 'stages' | 'skills'>, kind: SessionKind): string[] {
  const stage = config.stages[kind];
  const disabled = new Set(config.skills?.disabled ?? []);
  const practice = (stage?.skills ?? []).filter((skill) => !disabled.has(skill));
  return [...new Set([stage?.stage_skill ?? stageSkill(kind), ...practice])];
}

/** Directory name of a staged skill. */
export function skillDirName(name: string): string {
  return name.replace(/^repo:/, '');
}

/**
 * Rule ids a skill or a standards file defines: a list item that opens with a bold id (`- **AG-TQ-01 Title.** …`).
 * Read from the text itself, so a rule can't be added without its id being known; `basis: standard` accepts
 * only these ids (src/review/rules.ts).
 */
export function ruleIds(markdown: string): string[] {
  return ruleItems(markdown).map((rule) => rule.id);
}

const RULE_ITEM = new RegExp(`^\\s*[-*]\\s+\\*\\*(${RULE_ID})\\b`);

/** Each rule with its text: the list item and the indented lines under it, up to the next item, heading or blank line. */
export function ruleItems(markdown: string): { id: string; text: string }[] {
  const rules: { id: string; text: string }[] = [];
  let current: { id: string; text: string } | undefined;
  for (const line of markdown.split('\n')) {
    const opening = RULE_ITEM.exec(line);
    if (opening) rules.push((current = { id: opening[1]!, text: line }));
    else if (current && /^\s+\S/.test(line)) current.text += `\n${line}`;
    else current = undefined;
  }
  return rules;
}

/** Rules a tool in the repo checks enforces (`Checked by: ArchUnit`): the reviewer leaves them to the checks. */
export function checkedByRules(markdown: string): string[] {
  return ruleItems(markdown)
    .filter((rule) => /checked[ -]by:/i.test(rule.text.replaceAll(/[_*]/g, '')))
    .map((rule) => rule.id);
}
