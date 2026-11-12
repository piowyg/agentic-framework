import { contractText } from '../contracts/index.js';
import { conversationLanguage, prSummaryLanguage, type Languages } from '../config/language.js';
import { COMMITTING_KINDS, type SessionKind, type SessionMode } from '../harness/types.js';
import type { BreakdownRules } from './artifacts.js';

export interface PromptContext {
  title: string;
  mode: SessionMode;
  /** As the agent sees it. */
  outDir: string;
  /** Interactive sessions in a sandbox: `outDir` on the human's machine, for the paths the agent names to them. */
  hostOutDir?: string;
  /** Interactive sessions: the file the agent creates to end the session, as the agent sees it. */
  doneFile?: string;
  /** Read-only files as the agent sees them; the staged skills directory is not among them. */
  contextFiles: string[];
  /** `SKILL.md` paths as the agent sees them: the stage skill first, then practice skills. */
  skills: string[];
  /** Repo standards found in the working directory (relative paths). */
  standards: string[];
  /** Rules of the standards and skills the agent must neither apply nor cite, with the reason: `AG-CODE-03 (rules.disabled)`. */
  inactiveRules?: string[];
  ticketTemplate?: string;
  language: Languages;
  /** Breakdown: the size thresholds and the chain the plan is checked for. */
  breakdownRules?: BreakdownRules;
  group?: string;
  task?: string;
  taskTitle?: string;
  round?: number;
  /** Acceptance criteria of the group (or task) the session works on. */
  acceptance?: string[];
  notes?: string[];
  /** Run-specific input, e.g. the fixer's findings. */
  extra?: string;
  /** Sessions that change code: the commands the orchestrator verifies their commits with. */
  checks?: string[];
  /** On the host: the session's `run-checks` (`writeChecksRunner`), the only way to run them outside the sandbox. */
  checksRunner?: string;
}

/**
 * Interactive sessions read the code and talk; every permission prompt interrupts the human (smoke 92-3).
 * Their shell is sandboxed and can't write the code, so read-only commands run without asking.
 */
const READING = [
  'Read files with your file tools; search with plain read-only shell commands (`grep -rn`, `find`, `git log`) — they run sandboxed without asking. The shell cannot write the code: write artifacts with your file tools.',
  'You have no access to the issue tracker (no `gh`, no network): for related tickets or issues, ask the human.',
];


/**
 * Thin by design: the data of this run, the skills to follow and the output contract.
 * The process lives in the stage skill; the contract comes from the schemas, so a replaced skill can't drop it.
 */
export function buildPrompt(kind: SessionKind, context: PromptContext): string {
  const [stageSkill, ...practiceSkills] = context.skills;
  const where = [
    context.group && `group ${context.group}`,
    context.task && `task ${context.task}${context.taskTitle ? ` — ${context.taskTitle}` : ''}`,
    context.round && `review round ${context.round}`,
  ].filter(Boolean);
  const conversation = conversationLanguage(context.language);
  const sections = [
    [
      `Stage \`${kind}\` of the flow "${context.title}"${where.length ? `, ${where.join(', ')}` : ''}.`,
      `Follow the stage skill: ${stageSkill}`,
      ...(practiceSkills.length ? ['Practice skills — read them before you start:', ...practiceSkills.map((skill) => `- ${skill}`)] : []),
    ],
    [
      ...(context.contextFiles.length ? ['Read-only context:', ...context.contextFiles.map((file) => `- ${file}`)] : []),
      ...(context.standards.length ? ['Repo standards (relative to the working directory):', ...context.standards.map((file) => `- ${file}`)] : []),
      ...(context.inactiveRules?.length
        ? [`Rules switched off for this repo — do not apply them and do not cite them in findings (\`checked-by\`: the repo checks enforce it): ${context.inactiveRules.join(', ')}.`]
        : []),
      ...(context.acceptance?.length ? [`Acceptance criteria in scope: ${context.acceptance.join(', ')}.`] : []),
    ],
    [
      context.mode === 'interactive'
        ? `Talk to the human in \`${conversation}\`; write artifacts in \`${context.language.artifacts}\`.`
        : `Write artifacts in \`${context.language.artifacts}\`. Nobody is watching this session: do not ask questions, decide or report an issue.`,
      ...(context.mode === 'interactive' ? READING : []),
      context.hostOutDir
        ? `The human's machine sees your output directory \`${context.outDir}\` as \`${context.hostOutDir}\`: name files in it to them by that path.`
        : '',
    ],
    (COMMITTING_KINDS as readonly SessionKind[]).includes(kind)
      ? [
          'Commit your work on the current branch; never amend, rebase or reset commits — the orchestrator collects them, and it rejects uncommitted changes.',
          ...(context.checks?.length
            ? [
                kind === 'write-tests'
                  ? 'After you finish, the orchestrator runs these checks in the working directory and expects every new test to fail; run them yourself first:'
                  : 'After you finish, the orchestrator runs these checks in the working directory; run them yourself first:',
                ...(context.checksRunner ? [...numbered(context.checks), ...runnerUsage(context.checksRunner)] : context.checks.map((command) => `- \`${command}\``)),
              ]
            : []),
        ]
      : context.checksRunner
        ? ['To check a claim about the build or the tests, run the repo checks:', ...runnerUsage(context.checksRunner)]
        : [],
    context.notes?.length ? ['Notes from the human:', ...context.notes.map((note) => `- ${note}`)] : [],
    context.extra ? [context.extra] : [],
    [
      contractText(kind, {
        outDir: context.outDir,
        acceptance: context.acceptance,
        ticketTemplate: context.ticketTemplate,
        conversation,
        prSummary: prSummaryLanguage(context.language),
        ...(context.breakdownRules && { size: context.breakdownRules.limits, stack: context.breakdownRules.stack }),
      }),
      context.mode === 'interactive'
        ? `When the artifact is written and the human has confirmed it, create the empty file \`${context.doneFile}\`: the session then closes on its own and the flow moves on. Do not create it before the confirmation.`
        : '',
    ],
  ];
  return sections
    .map((lines) => lines.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

function numbered(commands: string[]): string[] {
  return commands.map((command, index) => `${index + 1}. \`${command}\``);
}

/**
 * Only the runner's own call leaves the sandbox; chained with other commands the line runs sandboxed, where
 * builds fail on a read-only home (`~/.gradle`), no Docker and no browser.
 */
function runnerUsage(runner: string): string[] {
  return [
    `Run them only through \`${runner}\` (all) or \`${runner} <n>\` (just the n-th) — exactly so: no \`cd\`, pipes or redirection, nothing before or after it.`,
    'It runs them in the working directory outside the sandbox (the sandbox blocks builds and tests), prints a summary and what failed; full logs go to `checks/` in your output directory.',
    'Do not run the build or the tests any other way.',
  ];
}
