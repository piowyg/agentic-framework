// Rule ids a `basis: standard` finding may cite: the repo standards and the skills of the sessions.

import fs from 'node:fs';
import path from 'node:path';
import { STAGE_CONFIG_KEYS } from '../config/schema.js';
import type { AgenticConfig } from '../config/types.js';
import { checkedByRules, resolveSkill, ruleIds, sessionSkills } from '../skills/stage.js';
import { FRAMEWORK_RULE_PREFIX } from './rule-id.js';

/** Where a repo keeps the standards the agents follow and the reviewers cite. */
export const STANDARDS_DIR = path.join('.agentic', 'standards');

/** A markdown file that may define rules; `name` says where it came from in an error. */
export interface RuleSource {
  name: string;
  text: string;
}

/** Markdown files in `<root>/.agentic/standards/`, sorted by name. */
export function standardsSources(root: string): RuleSource[] {
  const dir = path.join(root, STANDARDS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => ({ name: path.posix.join('.agentic', 'standards', file), text: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

/** Every markdown file of the skills; staging skips symlinks, so they are skipped here too. */
export function skillSources(names: string[], repoRoot: string): RuleSource[] {
  return names.flatMap((name) => {
    const dir = resolveSkill(name, repoRoot);
    return markdownFiles(dir).map((file) => ({ name: `skill ${name}: ${path.relative(dir, file)}`, text: fs.readFileSync(file, 'utf8') }));
  });
}

function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return markdownFiles(file);
      return entry.name.endsWith('.md') ? [file] : [];
    });
}

/** Where repos keep their architecture decision records, by the common conventions. */
const DECISION_DIRS = ['docs/adr', 'doc/adr', 'adr', 'docs/decisions', 'docs/architecture/decisions'];

/** `ADR-0004` for each `0004-….md` or `ADR-0004-….md` in the repo's ADR directory: a reviewer may cite a decision. */
export function decisionIds(root: string): Set<string> {
  const ids = new Set<string>();
  for (const dir of DECISION_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      const number = /^(?:adr-?)?(\d+)-.*\.md$/i.exec(file)?.[1];
      if (number) ids.add(`ADR-${number}`);
    }
  }
  return ids;
}

export function ruleIdSet(sources: RuleSource[]): Set<string> {
  return new Set(sources.flatMap((source) => ruleIds(source.text)));
}

/** `ARCH-01: standards/a.md, skill x: SKILL.md` for every id defined more than once. */
export function ruleCollisions(sources: RuleSource[]): string[] {
  const definedIn = new Map<string, string[]>();
  for (const source of sources) for (const id of ruleIds(source.text)) definedIn.set(id, [...(definedIn.get(id) ?? []), source.name]);
  return [...definedIn].filter(([, names]) => names.length > 1).map(([id, names]) => `${id}: ${names.join(', ')}`);
}

/**
 * A flow start error when one rule id means two rules: a finding citing it couldn't say which one it broke.
 * Checks the repo standards against the skills of every session the config enables.
 */
export function assertUniqueRuleIds(config: Pick<AgenticConfig, 'stages' | 'skills'>, repoRoot: string): void {
  const skills = [...new Set(STAGE_CONFIG_KEYS.flatMap((kind) => sessionSkills(config, kind)))];
  const own = [...standardsSources(repoRoot), ...skillSources(skills.filter((skill) => skill.startsWith('repo:')), repoRoot)];
  const reserved = own.flatMap((source) => ruleIds(source.text).filter((id) => id.startsWith(FRAMEWORK_RULE_PREFIX)).map((id) => `${id}: ${source.name}`));
  if (reserved.length) {
    throw new Error(
      [
        `The \`${FRAMEWORK_RULE_PREFIX}\` prefix is reserved for framework rules; repo standards and skills use their own (e.g. \`ARCH-01\`, \`CODE-01\`):`,
        ...reserved.map((entry) => `  ${entry}`),
      ].join('\n'),
    );
  }
  const collisions = ruleCollisions([...standardsSources(repoRoot), ...skillSources(skills, repoRoot)]);
  if (collisions.length) {
    throw new Error(
      [
        'The same rule ID defined more than once; a `basis: standard` finding cannot point at one rule:',
        ...collisions.map((collision) => `  ${collision}`),
        'Change the ID in the repo standards (`.agentic/standards/`) or turn one of the skills off in the config.',
      ].join('\n'),
    );
  }
}

/** Why a rule is out of a session: switched off in the config, or left to the repo checks. */
export type InactiveReason = 'rules.disabled' | 'checked-by';

/**
 * Rules the agents neither apply nor cite: `rules.disabled`, and rules marked `Checked by:` while the repo has
 * checks to run (`review.checks: none` would leave them unchecked, so they stay with the reviewer).
 */
export function inactiveRules(config: Pick<AgenticConfig, 'rules' | 'review'>, sources: RuleSource[]): Map<string, InactiveReason> {
  const inactive = new Map<string, InactiveReason>();
  if (config.review.checks !== 'none') {
    for (const source of sources) for (const id of checkedByRules(source.text)) inactive.set(id, 'checked-by');
  }
  for (const id of config.rules?.disabled ?? []) inactive.set(id, 'rules.disabled');
  return inactive;
}
