// `agentic init`: `.agentic/` in a service repo — config with the checks of the
// detected build and the ticket template. Deterministic, no agent; writes only after the human approves and never
// overwrites, then shows what the repo has for agents (`repo-readiness.ts`). TODO: templates of
// the three standards, the short Strategy grill for `testing.md`, a skill in place of the missing-standard note.

import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { gitInfo } from './config/git.js';
import type { ConfigLayer } from './config/types.js';
import { validateLayer } from './config/validate.js';
import { PACKAGE_ROOT } from './paths.js';
import { repoReadiness, RULE_FORMAT, STANDARDS_DIR } from './repo-readiness.js';
import { CONTAINERS_FIX, containerTestSignals } from './sandbox/container-tests.js';

export interface InitDeps {
  confirm: (question: string) => Promise<boolean>;
  /** False without a terminal: init only shows what it would write, unless `yes`. */
  interactive: boolean;
  say: (text: string) => void;
}

/** What init proposes for `review` after reading the build files. */
export interface StackProposal {
  stack: string;
  review: NonNullable<ConfigLayer['review']>;
  /** Other build files found and not covered by the proposal. */
  others: string[];
}

const CONFIG = path.join('.agentic', 'config.yaml');
const TICKET_TEMPLATE = path.join('.agentic', 'templates', 'ticket.md');

/** JVM builds first: a backend repo with a frontend `package.json` is still a Gradle/Maven repo. */
export function detectStack(root: string): StackProposal | undefined {
  const has = (file: string) => fs.existsSync(path.join(root, file));
  const found = [
    has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts') ? gradle(has('gradlew')) : undefined,
    has('pom.xml') ? maven(has('mvnw')) : undefined,
    has('package.json') ? node(root, has) : undefined,
  ].filter((proposal): proposal is Omit<StackProposal, 'others'> => !!proposal);
  const [first, ...rest] = found;
  return first && { ...first, others: rest.map((proposal) => proposal.stack) };
}

function gradle(wrapper: boolean): Omit<StackProposal, 'others'> {
  const gradlew = wrapper ? './gradlew' : 'gradle';
  return {
    stack: wrapper ? 'Gradle (wrapper)' : 'Gradle',
    // --continue: one red test task must not hide the reports of the others (the "red" gate needs them all)
    review: { checks: [`${gradlew} build --continue`], compile: `${gradlew} testClasses`, test_reports: '**/build/test-results/**/*.xml' },
  };
}

function maven(wrapper: boolean): Omit<StackProposal, 'others'> {
  const mvn = wrapper ? './mvnw' : 'mvn';
  return {
    stack: wrapper ? 'Maven (wrapper)' : 'Maven',
    // -fae: the same reason as Gradle's --continue; the glob takes both surefire and failsafe reports
    review: { checks: [`${mvn} -B -fae verify`], compile: `${mvn} -B test-compile`, test_reports: '**/target/*-reports/TEST-*.xml' },
  };
}

/** The repo's own `ci` script when there is one; otherwise its typecheck, lint, build and test scripts, in that order. */
function node(root: string, has: (file: string) => boolean): Omit<StackProposal, 'others'> | undefined {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return undefined;
  }
  const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
  const run = (script: string) => `${manager} run ${script}`;
  const names = 'ci' in scripts ? ['ci'] : ['typecheck', 'lint', 'build', 'test'].filter((name) => name in scripts);
  if (!names.length) return undefined;
  return {
    stack: manager,
    review: { checks: names.map(run), ...('typecheck' in scripts && { compile: run('typecheck') }) },
  };
}

export async function runInit(options: { cwd: string; yes?: boolean }, deps: InitDeps): Promise<void> {
  const root = gitInfo(options.cwd).root;
  if (!root) throw new Error("`agentic init` works in a git repo; run it in the service repo's directory.");
  const exists = (file: string) => fs.existsSync(path.join(root, file));

  /** `append` adds to a file the human keeps; every other write creates a new file. */
  const writes: { file: string; content: string; note: string; append?: boolean }[] = [];
  // what is there already shows in the readiness list at the end
  if (!exists(CONFIG)) {
    const proposal = detectStack(root);
    if (proposal) {
      writes.push({ file: CONFIG, content: configText(proposal), note: `review.checks for: ${proposal.stack}` });
      if (proposal.others.length) deps.say(`i also found: ${proposal.others.join(', ')}; add their commands to review.checks by hand if they should be checked`);
    } else {
      deps.say(
        `! no known build found (Gradle, Maven, npm); create ${CONFIG} by hand:\n  review:\n    checks: ["<build>", "<tests>"]   # or \`none\`: knowingly without verification`,
      );
    }
  }
  // init writes only the repo config, which can't set `sandbox`: it can only point at the global one
  const containerTests = containerTestSignals(root, []);
  if (containerTests.length) deps.say(`! tests start containers (${containerTests.join(', ')}); with \`sandbox.mode: container\` they need ${CONTAINERS_FIX}; \`agentic doctor\` checks it`);
  if (!exists(TICKET_TEMPLATE)) writes.push({ file: TICKET_TEMPLATE, content: fs.readFileSync(path.join(PACKAGE_ROOT, 'templates', 'ticket.md'), 'utf8'), note: 'ticket template (adjust it; ACs with IDs are required)' });

  // AGENTS.md is the source and CLAUDE.md imports it; init only adds to one the repo already has (`agent-files` makes it)
  const instructions = ['AGENTS.md', 'CLAUDE.md'].find(exists);
  if (instructions && !/^## Agentic\s*$/m.test(fs.readFileSync(path.join(root, instructions), 'utf8'))) {
    const map = exists('CONTEXT-MAP.md') && !exists(path.join('.agentic', 'context-map.md')) ? 'CONTEXT-MAP.md' : '.agentic/context-map.md';
    writes.push({ file: instructions, content: agenticSection(map), note: 'an `## Agentic` section at the end (where the config, context map and standards are)', append: true });
  }

  if (writes.length) {
    deps.say(`To write in ${root}:`);
    for (const write of writes) deps.say(`  + ${write.file} — ${write.note}`);
    const config = writes.find((write) => write.file === CONFIG);
    if (config) deps.say(indent(config.content));
    // the readiness list below is shown either way: it writes nothing
    if (await approved(options, deps)) {
      for (const write of writes) {
        const file = path.join(root, write.file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // wx: a file created between the check and now stays the human's
        if (write.append) fs.appendFileSync(file, `${fs.readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '\n\n'}${write.content}`);
        else fs.writeFileSync(file, write.content, { flag: 'wx' });
        deps.say(`✓ ${write.file}`);
      }
    }
  }

  const readiness = repoReadiness(root);
  deps.say('The repo for agents:');
  for (const item of readiness) deps.say(`  ${item.present ? '✓' : '✗'} ${item.file}${item.detail ? ` — ${item.detail}` : ''}`);
  if (readiness.some((item) => !item.present && item.file.startsWith(STANDARDS_DIR))) deps.say(`  standards: ${RULE_FORMAT}`);
  deps.say('Next: `agentic doctor`, then `agentic new "<idea>"`.');
}

/** Paths, not contents: the files under `.agentic/` stay the single source, and a path missing today is made later. */
const agenticSection = (map: string) => `## Agentic

Files for agents in \`.agentic/\` (from \`agentic init\`):

- \`${map}\` — the bounded contexts of this repo, their relations and hotspots; read the part you change first.
- \`.agentic/standards/*.md\` — the team's rules with IDs (\`architecture.md\`, \`testing.md\`, \`code.md\`); follow them, cite the ID when one decides something.
- \`.agentic/config.yaml\` — \`review.checks\`: the commands that decide whether the code works.
`;

async function approved(options: { yes?: boolean }, deps: InitDeps): Promise<boolean> {
  if (options.yes) return true;
  if (!deps.interactive) {
    deps.say('Without a terminal this is a preview only; to write: `agentic init --yes`.');
    return false;
  }
  if (await deps.confirm('Write?')) return true;
  deps.say('Nothing written.');
  return false;
}

function configText(proposal: StackProposal): string {
  const layer: ConfigLayer = { review: proposal.review };
  validateLayer(layer, CONFIG);
  return [
    `# agentic: config of this repo (from \`agentic init\`, detected: ${proposal.stack}).`,
    '# review.checks run after every agent session; adjust them to what your CI runs. All fields: docs/reference/config.md',
    stringify(layer).trimEnd(),
    '',
  ].join('\n');
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
