import { Ajv, type ValidateFunction } from 'ajv';
import type { TSchema } from 'typebox';
import type { ScopeAxis } from '../orchestrator/state.js';
import { formatErrors } from '../config/validate.js';
import type { SessionKind } from '../harness/types.js';
import { ArtifactError, EXTERNAL_ASSETS, MAX_GROUP_TASKS, OVERSIZED_GROUPS, SPEC_SECTIONS } from '../orchestrator/artifacts.js';
import type { SizeThresholds } from '../publish/size.js';
import {
  CONTRACT_VERSION,
  fixSchema,
  implementSchema,
  mergeSchema,
  reviewSchemas,
  writeTestsSchema,
  type FixArtifact,
  type ImplementArtifact,
  type MergeArtifact,
  type WriteTestsArtifact,
} from './schemas.js';

export { CONTRACT_VERSION } from './schemas.js';

/** What the contract text needs to know about the session. */
export interface ContractContext {
  /** As the agent sees it. */
  outDir: string;
  /** Acceptance criteria of the group the session works on. */
  acceptance?: string[];
  /** Ticket template, as the agent sees it (grill-business). */
  ticketTemplate?: string;
  /** Language of the human at the gates; gate summaries are written in it. */
  conversation?: string;
  /** The PR's language when it differs from the conversation's: the spec then carries a `pr_summary` in it. */
  prSummary?: string;
  /** Breakdown: the `publish.size` thresholds a group's estimate is checked against. */
  size?: SizeThresholds;
  /** Breakdown: `publish.stack` — the groups of one repo must form a chain. */
  stack?: boolean;
}

interface JsonContract {
  file: string;
  schema: TSchema;
  rules: (context: ContractContext) => string[];
}

const BLOCKING_RULE =
  'A blocking finding needs `file`, `line`, `quote`, `basis`, `impact` and `weight` `high` or `medium`; without them it is downgraded to a nit. ' +
  'The orchestrator checks each one mechanically: `quote` is code copied verbatim from the reviewed commit, starting within 5 lines of `line`, ' +
  'long enough to match one place there — otherwise the finding is rejected. `basis: spec` cites an `AC-n` of the ticket or a section of the spec; ' +
  '`basis: standard` cites a rule id defined in the repo standards or your skills, or an ADR of the repo (`ADR-0004` for `docs/adr/0004-….md`) — an id that doesn\'t exist downgrades the finding to a nit. ' +
  'In round 2+ new blocking findings must point within 3 lines of the lines changed since the previous round; other ones are rejected as out of scope.';

const forAcceptance = (context: ContractContext, what: string) =>
  context.acceptance?.length ? [`${what}: ${context.acceptance.join(', ')}.`] : [];

const JSON_CONTRACTS: Partial<Record<SessionKind, JsonContract>> = {
  'write-tests': {
    file: 'write-tests.json',
    schema: writeTestsSchema,
    rules: (context) => [
      ...forAcceptance(context, 'Every one of these acceptance criteria has at least one test'),
      'Each test `name` contains its AC ids (`AC-1 …`, or `ac1_…` where the language forbids dashes) and is the name the test report shows (method or display name, without the class or file).',
      'The orchestrator then compiles and runs the tests on the base code: every new test must fail on an assertion — not error, not be skipped, not pass. A test of behavior the base code already has may pass only when its criterion is in `already_met` with evidence.',
    ],
  },
  implement: {
    file: 'implement.json',
    schema: implementSchema,
    rules: () => ['`issue` is required when `status` is not `done`.'],
  },
  fix: {
    file: 'fix-report.json',
    schema: fixSchema,
    rules: () => ['`disputed` needs `disputed_on` and `reason`; `not_reproduced` and `escalated` need `reason`.'],
  },
  merge: {
    file: 'merge.json',
    schema: mergeSchema,
    rules: () => ['`reason` is required when `status` is `escalated`.', 'When resolved, the merge is committed and no conflict markers are left.'],
  },
  'review-spec': {
    file: 'review-spec.json',
    schema: reviewSchemas.spec,
    rules: (context) => [BLOCKING_RULE, ...forAcceptance(context, '`coverage` has exactly one entry for each of')],
  },
  'review-standards': { file: 'review-standards.json', schema: reviewSchemas.standards, rules: () => [BLOCKING_RULE] },
  'review-security': { file: 'review-security.json', schema: reviewSchemas.security, rules: () => [BLOCKING_RULE] },
  'review-final': { file: 'review-final.json', schema: reviewSchemas.final, rules: () => [BLOCKING_RULE] },
};

/** File a JSON-reporting session writes to its `out/`; undefined for stages that write markdown/YAML. */
export function contractFile(kind: SessionKind): string | undefined {
  return JSON_CONTRACTS[kind]?.file;
}

/** The `## Output contract` section of a session's prompt. */
export function contractText(kind: SessionKind, context: ContractContext): string {
  const json = JSON_CONTRACTS[kind];
  const lines = json ? jsonContractText(json, context) : stageContractText(kind, context);
  return ['## Output contract', '', ...lines, '', 'The orchestrator validates the output; anything else is rejected.'].join('\n');
}

function jsonContractText(contract: JsonContract, context: ContractContext): string[] {
  return [
    `Write \`${join(context.outDir, contract.file)}\` — JSON matching this schema:`,
    '```json',
    JSON.stringify(contract.schema, null, 2),
    '```',
    ...contract.rules(context).map((rule) => `- ${rule}`),
  ];
}

function stageContractText(kind: SessionKind, context: ContractContext): string[] {
  const out = (file: string) => `\`${join(context.outDir, file)}\``;
  const humanLanguage = context.conversation ? `in \`${context.conversation}\`` : 'in the language of the artifacts';
  const gateSummary = `- Frontmatter \`summary\`: two or three sentences ${humanLanguage} — what the human reads at the gate before opening the file.`;
  switch (kind) {
    case 'grill-business':
      return [
        `Write ${out('ticket.md')} following the ticket template${context.ticketTemplate ? ` (\`${context.ticketTemplate}\`)` : ''}.`,
        '- Frontmatter: `status: ready` and `title`.',
        gateSummary,
        '- Every acceptance criterion has an id `AC-1`, `AC-2`, … (Given/When/Then recommended).',
        '- No implementation decisions in the ticket — it goes to the tracker.',
        `- Optionally ${out('business-notes.md')}: current behavior you found in the code (with file references) and open technical questions for the technical grill.`,
      ];
    case 'grill-technical':
      return [
        `Write ${out('spec.md')} with frontmatter \`status: ready\` and these \`##\` sections (a section may say "None", the heading must be there):`,
        ...[...SPEC_SECTIONS, EXTERNAL_ASSETS].map((section) => `- ${section}`),
        gateSummary,
        ...(context.prSummary
          ? [`- Frontmatter \`pr_summary\`: the same two or three sentences in \`${context.prSummary}\` — the first paragraph of the pull request description.`]
          : []),
        '- `Affected repos` is a bullet list of repo names (`- .` for the current repo only).',
        '- `Test seams` lists the public interfaces the tests go through, agreed with the human.',
        '- Optionally `## Slices`: the order the change is built in — a prefactor first when one makes the change easier, then thin vertical slices of behavior, each ending in behavior an acceptance criterion describes. It orders the work and does not split the ticket; the breakdown cuts groups along it.',
        `- \`${EXTERNAL_ASSETS}\` lists, one bullet each, what the change needs from outside the repo — a file to download (font, image, data, binary) or a dependency the repo doesn't have yet — with where it comes from and how it gets there, as agreed with the human: they add it to the repo before implementation, or its host is in \`sandbox.network.allow\`. The sessions after the spec run unattended in a sandbox: a download from anywhere else fails and stops the task.`,
      ];
    case 'breakdown':
      return [
        `Write ${out('tasks.yaml')}:`,
        '```yaml',
        'groups:',
        '  - id: g1                 # [a-z0-9-]',
        '    repo: .                # a name from the spec\'s Affected repos',
        '    title: …',
        `    summary: …             # one sentence ${humanLanguage}: what the group delivers and why it is cut this way`,
        '    rationale: …           # why the work is cut this way',
        '    depends_on: []',
        '    estimate: { prod: 0, tests: 0 }   # lines the diff will add + delete: production (docs included) and tests',
        '    oversize_reason: …     # only over a threshold: why the group stays whole',
        '    tasks:',
        '      - id: t1',
        '        title: …',
        `        summary: …         # a short title ${humanLanguage}, shown at the gate above \`title\``,
        '        tier: standard     # mechanical | standard | domain | design',
        '        acceptance: [AC-1]',
        '```',
        `- 1–${MAX_GROUP_TASKS} tasks per group (3–5 recommended); every AC of the ticket is covered by a task.`,
        `- Every group has an \`estimate\`; lockfiles and generated files don't count. \`oversize_reason\` is required when it is over ${context.size ? `${context.size.prod} production lines or ${context.size.total} with tests` : 'a `publish.size` threshold'}: cut a thinner slice (fewer criteria per group) before you reach for it, never a layer.`,
        ...(context.stack
          ? ['- The groups of one repo form a chain: one first group, every next one has the one before in `depends_on` (it may also depend on groups of other repos). Each group becomes a pull request on top of the one before; groups run side by side only across repos.']
          : []),
        `- More than ${OVERSIZED_GROUPS} groups is allowed but flagged as oversized — prefer suggesting a smaller ticket.`,
        '- Quote a value that contains ` #` (e.g. `"moves to #10"`): unquoted, YAML drops the rest as a comment.',
      ];
    default:
      return [];
  }
}

function join(dir: string, file: string): string {
  return `${dir.replace(/\/+$/, '')}/${file}`;
}

const validators = new Map<TSchema, ValidateFunction>();

/** JSON + schema + version; `artifact` names the file in errors. */
export function parseJsonArtifact<T>(text: string, schema: TSchema, artifact: string): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ArtifactError(artifact, [`invalid JSON: ${(error as Error).message.split('\n')[0]}`]);
  }
  const version = (data as { contract?: unknown } | null)?.contract;
  if (version !== CONTRACT_VERSION) {
    throw new ArtifactError(artifact, [`contract version \`${String(version)}\`, expected ${CONTRACT_VERSION}`]);
  }
  let validate = validators.get(schema);
  if (!validate) {
    validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    validators.set(schema, validate);
  }
  if (!validate(data)) throw new ArtifactError(artifact, formatErrors(validate.errors ?? [], schema));
  return data as T;
}

export function parseImplement(text: string): ImplementArtifact {
  const report = parseJsonArtifact<ImplementArtifact>(text, implementSchema, 'implement.json');
  if (report.status !== 'done' && !report.issue?.trim()) throw new ArtifactError('implement.json', [`status \`${report.status}\` without \`issue\``]);
  return report;
}

export function parseFix(text: string): FixArtifact {
  const report = parseJsonArtifact<FixArtifact>(text, fixSchema, 'fix-report.json');
  const problems = report.findings.flatMap((entry) => {
    if (entry.status === 'disputed' && (!entry.disputed_on || !entry.reason?.trim())) return [`${entry.id}: disputed without \`disputed_on\` and \`reason\``];
    if (entry.status !== 'fixed' && !entry.reason?.trim()) return [`${entry.id}: ${entry.status} without \`reason\``];
    return [];
  });
  if (problems.length) throw new ArtifactError('fix-report.json', problems);
  return report;
}

export function parseMerge(text: string): MergeArtifact {
  const report = parseJsonArtifact<MergeArtifact>(text, mergeSchema, 'merge.json');
  if (report.status === 'escalated' && !report.reason?.trim()) throw new ArtifactError('merge.json', ['status `escalated` without `reason`']);
  return report;
}

export function parseWriteTests(text: string, acceptance: string[]): WriteTestsArtifact {
  const report = parseJsonArtifact<WriteTestsArtifact>(text, writeTestsSchema, 'write-tests.json');
  const covered = new Set(report.tests.flatMap((test) => test.ac));
  const missing = acceptance.filter((id) => !covered.has(id));
  const problems = missing.length ? [`criteria without tests: ${missing.join(', ')}`] : [];
  for (const test of report.tests) {
    const unnamed = test.ac.filter((id) => !compact(test.name).includes(compact(id)));
    if (unnamed.length) problems.push(`test \`${test.name}\` lacks ${unnamed.join(', ')} in its name`);
  }
  const outside = (report.already_met ?? []).map((entry) => entry.ac).filter((id) => !acceptance.includes(id));
  if (outside.length && acceptance.length) problems.push(`\`already_met\` outside the group's criteria: ${outside.join(', ')}`);
  if (problems.length) throw new ArtifactError('write-tests.json', problems);
  return report;
}

/** `AC-1` in `ac1_addsItem` or `AC_1 opens`: case, dashes and underscores aside. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function reviewSchema(axis: ScopeAxis): TSchema {
  return reviewSchemas[axis];
}
