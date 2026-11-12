// What a service repo has for agents (grilling `agentic init`, 2026-10-23): the files `agentic init` writes, the
// context map, agent instructions and the three standards. `init` and `doctor` show the same list; nothing here writes.

import fs from 'node:fs';
import path from 'node:path';

export interface ReadinessItem {
  file: string;
  present: boolean;
  /** What makes a missing item, or what a present one is. */
  detail: string;
}

/** The names `agentic init` proposes; the review reads every `.md` in the directory, whatever its name. */
export const STANDARDS_DIR = path.join('.agentic', 'standards');
const STANDARDS = ['architecture.md', 'testing.md', 'code.md'];
const NO_STANDARD = "the standards review checks only the framework's AG- rules for now";
/** How a standard's rule looks, so agents apply it and the review cites it. */
export const RULE_FORMAT = 'rules with IDs, e.g. `- **TEST-01 Title.** …`';

export function repoReadiness(root: string): ReadinessItem[] {
  const exists = (file: string) => fs.existsSync(path.join(root, file));
  const item = (file: string, present: boolean, missing: string, found = ''): ReadinessItem => ({ file, present, detail: present ? found : missing });
  const instructions = ['AGENTS.md', 'CLAUDE.md'].filter(exists);
  // the skill writes under .agentic/; a map the repo already keeps elsewhere counts too (the skill extends it in place)
  const map = [path.join('.agentic', 'context-map.md'), 'CONTEXT-MAP.md'].find(exists);
  const standards = fs.existsSync(path.join(root, STANDARDS_DIR)) ? fs.readdirSync(path.join(root, STANDARDS_DIR)).filter((file) => file.endsWith('.md')).sort() : [];
  const own = standards.filter((file) => !STANDARDS.includes(file));
  return [
    item(path.join('.agentic', 'config.yaml'), exists(path.join('.agentic', 'config.yaml')), '`agentic init`'),
    item(path.join('.agentic', 'templates', 'ticket.md'), exists(path.join('.agentic', 'templates', 'ticket.md')), '`agentic init`'),
    item(map ?? path.join('.agentic', 'context-map.md'), !!map, '`/agentic-context-map` in Claude Code or Codex (`agentic skills install`)'),
    item(instructions.join(' + ') || 'AGENTS.md / CLAUDE.md', instructions.length > 0, 'instructions for agents: build commands, conventions, a pointer to the context map'),
    // a team with its own standard files has standards: the three names are a proposal, not a requirement
    ...(own.length
      ? [item(STANDARDS_DIR, true, '', `own standards: ${standards.join(', ')}`)]
      : [
          ...standards.map((file) => item(path.join(STANDARDS_DIR, file), true, '')),
          ...(standards.length < STANDARDS.length
            ? [item(path.join(STANDARDS_DIR, STANDARDS.filter((file) => !standards.includes(file)).join(', ')), false, NO_STANDARD)]
            : []),
        ]),
  ];
}
