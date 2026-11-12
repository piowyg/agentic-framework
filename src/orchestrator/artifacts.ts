import fs from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { parse, parseDocument, visit, type Document } from 'yaml';
import { formatErrors } from '../config/validate.js';
import { executorSchema, TIERS } from '../config/schema.js';
import type { AgenticConfig, Executor, Tier } from '../config/types.js';
import type { SessionKind } from '../harness/types.js';
import { linesText, overLimits, sizeThresholds, thresholdsText, type SizeThresholds } from '../publish/size.js';

/** Plan approved at the breakdown gate; later edits of tasks.yaml don't affect implementation. */
export const APPROVED_TASKS = 'tasks.approved.yaml';
export const APPROVED_TICKET = 'ticket.approved.md';

/** The grill-business hand-off for grill-technical: current behavior, open technical questions. Optional, no schema. */
export const BUSINESS_NOTES = 'business-notes.md';

/** The idea pasted at `agentic new` (or a pasted ticket outside the contract), for the business grill. No schema. */
export const IDEA = 'idea.md';

/** Markdown/YAML a stage session leaves in its `out/`; the orchestrator copies them next to `state.json`. */
export const STAGE_ARTIFACTS: Partial<Record<SessionKind, string[]>> = {
  'grill-business': ['ticket.md', BUSINESS_NOTES],
  'grill-technical': ['spec.md'],
  breakdown: ['tasks.yaml'],
};

/** Flow artifacts a session reads, the approved version first; each is mounted read-only. */
export function contextArtifacts(kind: SessionKind): string[][] {
  return [
    ...(kind === 'grill-business' ? [[IDEA]] : []),
    [APPROVED_TICKET, 'ticket.md'],
    ...(kind === 'grill-technical' ? [[BUSINESS_NOTES]] : []),
    ['spec.md'],
    [APPROVED_TASKS, 'tasks.yaml'],
  ];
}

/** Required `##` sections of spec.md; a section may say "None", its heading must be there. */
export const SPEC_SECTIONS = ['Decisions', 'Affected repos', 'Contracts', 'Test seams', 'Risks', 'Out of scope'] as const;
/** Required of a spec the grill writes now; a flow started before it resumes on a spec without one. */
export const EXTERNAL_ASSETS = 'External assets';

export const MAX_GROUP_TASKS = 7;
/** More groups than this: the breakdown gate suggests splitting the ticket. */
export const OVERSIZED_GROUPS = 6;

export class ArtifactError extends Error {
  constructor(
    readonly artifact: string,
    readonly problems: string[],
  ) {
    super(`Invalid artifact ${artifact}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ArtifactError';
  }
}

export interface Markdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(text: string): Markdown {
  const frontMatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!frontMatterMatch) return { frontmatter: {}, body: text };
  let frontMatter: unknown;
  try {
    frontMatter = parse(frontMatterMatch[1]!);
  } catch (error) {
    throw new ArtifactError('frontmatter', [String((error as Error).message).split('\n')[0]!]);
  }
  return { frontmatter: (frontMatter && typeof frontMatter === 'object' ? frontMatter : {}) as Record<string, unknown>, body: frontMatterMatch[2]! };
}

export interface Ticket {
  title?: string;
  /** For the human at the ticket gate, in the conversation language. */
  summary?: string;
  acceptance: string[];
  trackerKey?: string;
}

/** Contract: `status: ready` in frontmatter and acceptance criteria with `AC-n` ids. */
export function validateTicket(text: string): Ticket {
  const { frontmatter, body } = parseMarkdown(text);
  const problems: string[] = [];
  if (frontmatter.status !== 'ready') problems.push('frontmatter: no `status: ready`');
  const ids = [...body.matchAll(/\bAC-(\d+)\b/g)].map((acMatch) => `AC-${acMatch[1]}`);
  const acceptance = [...new Set(ids)];
  if (acceptance.length === 0) problems.push('no acceptance criteria with IDs (`AC-1`, `AC-2`, …)');
  if (problems.length) throw new ArtifactError('ticket.md', problems);
  return {
    title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
    summary: frontmatterText(frontmatter, 'summary'),
    acceptance,
    trackerKey: typeof frontmatter.tracker_key === 'string' ? frontmatter.tracker_key : undefined,
  };
}

export interface Spec {
  /** Repo names from `## Affected repos`, as written (`.` or a repo name). */
  affectedRepos: string[];
  title?: string;
  /** For the human at the spec gate, in the conversation language. */
  summary?: string;
  /** The first paragraph of the PR description, when the PR's language differs from the conversation's. */
  prSummary?: string;
  /** Bullets of `## External assets`: what the change needs from outside the repo, for the human at the spec gate. */
  externalAssets: string[];
}

/** What the grill was asked for beyond `SPEC_SECTIONS`: checked only on the spec it has just written. */
export interface GrillAsks {
  /** The language a `pr_summary` must be written in. */
  prSummary?: string;
}

/**
 * Contract: `status: ready` and every `SPEC_SECTIONS` heading; `checkRepo` throws for an unknown repo name.
 * `grill`: the spec was just written, so it must also carry what the grill is asked for today.
 */
export function validateSpec(text: string, checkRepo?: (name: string) => void, grill?: GrillAsks): Spec {
  const { frontmatter, body } = parseMarkdown(text);
  const problems: string[] = [];
  if (frontmatter.status !== 'ready') problems.push('frontmatter: no `status: ready`');
  const sections = markdownSections(body);
  for (const name of SPEC_SECTIONS) if (!sections.has(name.toLowerCase())) problems.push(`missing section \`## ${name}\``);
  const affectedRepos = listItems(sections.get('affected repos') ?? '');
  if (sections.has('affected repos') && !affectedRepos.length) problems.push('`## Affected repos`: empty list (one repo = `- .`)');
  for (const name of affectedRepos) {
    try {
      checkRepo?.(name);
    } catch (error) {
      problems.push(`\`## Affected repos\`: ${(error as Error).message}`);
    }
  }
  if (grill && !sections.has(EXTERNAL_ASSETS.toLowerCase())) problems.push(`missing section \`## ${EXTERNAL_ASSETS}\``);
  if (grill?.prSummary && !frontmatterText(frontmatter, 'pr_summary')) problems.push(`frontmatter: no \`pr_summary\` (a summary in \`${grill.prSummary}\` for the PR description)`);
  if (problems.length) throw new ArtifactError('spec.md', problems);
  return {
    affectedRepos,
    title: frontmatterText(frontmatter, 'title') ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim(),
    summary: frontmatterText(frontmatter, 'summary'),
    prSummary: frontmatterText(frontmatter, 'pr_summary'),
    externalAssets: bullets(sections.get(EXTERNAL_ASSETS.toLowerCase()) ?? ''),
  };
}

/** Top-level bullets, whole; `None` is no bullet. */
function bullets(section: string): string[] {
  return section
    .split('\n')
    .map((line) => /^[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item) && !/^none\.?$/i.test(item!));
}

function frontmatterText(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `## Heading` (level 2 or 3, case-insensitive) → its text up to the next heading of level ≤ 3. */
export function markdownSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of body.split('\n')) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections.set(current, '');
    } else if (current !== undefined) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  return sections;
}

/** Bullet items, backticks stripped, first word only (`- billing — reason` → `billing`). */
function listItems(section: string): string[] {
  return section
    .split('\n')
    .map((line) => /^\s*[-*]\s+`?([^\s`]+)`?/.exec(line)?.[1])
    .filter((item): item is string => Boolean(item) && item!.toLowerCase() !== 'none');
}

export interface Task {
  id: string;
  title: string;
  /** For the human at the breakdown gate, in the conversation language. */
  summary?: string;
  tier?: Tier;
  acceptance: string[];
  /** Parts of the spec's external assets this task must match, on top of its group's. */
  references?: AssetReference[];
  executor?: Partial<Executor>;
}

/**
 * A part of an asset from the spec's `## External assets` (a prototype, a sample, an API document) the work must
 * match. The breakdown reads the asset once and names the parts, so later sessions read only those.
 */
export interface AssetReference {
  /** The path or URL as `## External assets` writes it. */
  asset: string;
  /** Which parts the work covers: screens, sections, line ranges, functions. */
  parts: string;
  /** What the change must match there. */
  match: string;
}

export interface Group {
  id: string;
  repo: string;
  title?: string;
  /** For the human at the breakdown gate, in the conversation language. */
  summary?: string;
  /** Why the work is cut this way; shown at the breakdown gate. */
  rationale: string;
  depends_on: string[];
  /** Lines the group's diff is expected to change; required of a plan the breakdown has just written. */
  estimate?: Estimate;
  /** Why the group stays whole although its estimate crosses a `publish.size` threshold. */
  oversize_reason?: string;
  /** Defaults to the most common task tier. */
  tier?: Tier;
  /** Parts of the spec's external assets the whole group must match. */
  references?: AssetReference[];
  tasks: Task[];
}

/** Added + deleted lines, as `publish.size` counts them. */
export interface Estimate {
  prod: number;
  tests: number;
}

/** Rules the breakdown's plan follows beyond its shape, from `publish`: checked only on the plan it has just written. */
export interface BreakdownRules {
  /** `publish.size`: a group's estimate over a threshold needs an `oversize_reason`. */
  limits: SizeThresholds;
  /** `publish.stack`: the groups of one repo form a chain, each becomes a PR on the one before. */
  stack: boolean;
  /** The repo a group's `repo` names: `.` and the repo's own name are one chain. Unknown names stay as written. */
  repoKey?: (name: string) => string;
}

export function breakdownRules(config: Pick<AgenticConfig, 'publish'>, repoKey?: (name: string) => string): BreakdownRules {
  return { limits: sizeThresholds(config.publish.size), stack: config.publish.stack, ...(repoKey && { repoKey }) };
}

export interface TasksFile {
  groups: Group[];
  /** Not errors: shown at the breakdown gate (e.g. `oversized`). */
  warnings: string[];
}

const referencesSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['asset', 'parts', 'match'],
    properties: { asset: { type: 'string', minLength: 1 }, parts: { type: 'string', minLength: 1 }, match: { type: 'string', minLength: 1 } },
  },
};

const tasksSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'repo', 'rationale', 'tasks'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]+$' },
          // a repo name or `.`, never a path: tasks.yaml is written by the agent
          repo: { type: 'string', pattern: '^(\\.|[A-Za-z0-9_][A-Za-z0-9._-]*)$' },
          title: { type: 'string' },
          summary: { type: 'string' },
          rationale: { type: 'string', minLength: 1 },
          depends_on: { type: 'array', items: { type: 'string' } },
          estimate: {
            type: 'object',
            additionalProperties: false,
            required: ['prod', 'tests'],
            properties: { prod: { type: 'integer', minimum: 0 }, tests: { type: 'integer', minimum: 0 } },
          },
          oversize_reason: { type: 'string' },
          tier: { enum: [...TIERS] },
          references: referencesSchema,
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_GROUP_TASKS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title'],
              properties: {
                id: { type: 'string', pattern: '^[a-z0-9-]+$' },
                title: { type: 'string' },
                summary: { type: 'string' },
                tier: { enum: [...TIERS] },
                acceptance: { type: 'array', items: { type: 'string', pattern: '^AC-\\d+$' } },
                references: referencesSchema,
                executor: executorSchema,
              },
            },
          },
        },
      },
    },
  },
};

const validateTasksShape = new Ajv({ allErrors: true, strict: true }).compile(tasksSchema);

/**
 * ` #10)` after unquoted text is valid YAML: a comment that silently drops the end of a title.
 * A comment glued to its `#` is almost never meant as one; `# note` is left alone.
 */
function textCutByComments(document: Document): string[] {
  const problems: string[] = [];
  visit(document, {
    Scalar(_key, node) {
      if (node.comment && !/^\s/.test(node.comment)) {
        problems.push(`\`${String(node.value)}\` loses \`#${node.comment}\`: YAML reads \` #\` as a comment; quote the value`);
      }
    },
  });
  return problems;
}

/**
 * Contract: shape, unique ids, a tier per task (or its group), existing acyclic dependencies, every ticket AC covered.
 * `rules`: the breakdown has just written it, so it must also follow what the breakdown is asked for today.
 */
/** The groups of the plan approved at the breakdown gate; none when the flow has no approved plan. */
export function approvedGroups(workDir: string): Group[] {
  const file = path.join(workDir, APPROVED_TASKS);
  return fs.existsSync(file) ? parseTasks(fs.readFileSync(file, 'utf8')).groups : [];
}

export function parseTasks(text: string, ticket?: Ticket, rules?: BreakdownRules): TasksFile {
  const document = parseDocument(text);
  // first line only: the rest quotes file content, which ends up in state.json
  if (document.errors.length) throw new ArtifactError('tasks.yaml', document.errors.map((error) => error.message.split('\n')[0]!));
  const cutOff = textCutByComments(document);
  if (cutOff.length) throw new ArtifactError('tasks.yaml', cutOff);
  const data = document.toJS() as unknown;
  if (!validateTasksShape(data)) throw new ArtifactError('tasks.yaml', formatErrors(validateTasksShape.errors ?? [], tasksSchema));
  const file = data as unknown as TasksFile;
  file.warnings = [];
  for (const group of file.groups) group.depends_on ??= [];
  for (const group of file.groups) for (const task of group.tasks) task.acceptance ??= [];

  const problems: string[] = [];
  const groupIds = new Set<string>();
  for (const group of file.groups) {
    if (groupIds.has(group.id)) problems.push(`duplicate group ID \`${group.id}\``);
    groupIds.add(group.id);
    const taskIds = new Set<string>();
    for (const task of group.tasks) {
      if (taskIds.has(task.id)) problems.push(`${group.id}: duplicate task ID \`${task.id}\``);
      taskIds.add(task.id);
      if (!task.tier && !group.tier) problems.push(`${group.id}.${task.id}: no \`tier\` (neither on the task nor on the group)`);
      if (ticket) {
        for (const acceptanceId of task.acceptance) {
          if (!ticket.acceptance.includes(acceptanceId)) problems.push(`${group.id}.${task.id}: \`${acceptanceId}\` does not exist in ticket.md`);
        }
      }
    }
  }
  for (const group of file.groups) {
    for (const dependency of group.depends_on) if (!groupIds.has(dependency)) problems.push(`${group.id}.depends_on: unknown group \`${dependency}\``);
  }
  if (!problems.length) {
    const cycle = findCycle(file.groups);
    if (cycle) problems.push(`dependency cycle: ${cycle.join(' → ')}`);
  }
  // the chain is read off `depends_on`: only once the ids and dependencies are sound
  if (rules?.stack && !problems.length) problems.push(...chainProblems(file.groups, rules.repoKey));
  if (rules) problems.push(...estimateProblems(file.groups, rules.limits));
  if (ticket) {
    const covered = new Set(file.groups.flatMap((group) => group.tasks.flatMap((task) => task.acceptance)));
    const missing = ticket.acceptance.filter((acceptanceId) => !covered.has(acceptanceId));
    if (missing.length) problems.push(`criteria without tasks: ${missing.join(', ')}`);
  }
  if (problems.length) throw new ArtifactError('tasks.yaml', problems);
  if (file.groups.length > OVERSIZED_GROUPS) {
    file.warnings.push(`oversized: ${file.groups.length} groups (> ${OVERSIZED_GROUPS}); consider splitting the ticket`);
  }
  return file;
}

function estimateProblems(groups: Group[], limits: SizeThresholds): string[] {
  return groups.flatMap((group) => {
    if (!group.estimate) return [`${group.id}: no \`estimate\` (line estimate: \`prod\`, \`tests\`)`];
    const { prod, tests } = group.estimate;
    if (!overLimits(prod, tests, limits).length || group.oversize_reason?.trim()) return [];
    return [`${group.id}: estimate ${linesText(prod, tests)} over the \`publish.size\` threshold (${thresholdsText(limits)}) without \`oversize_reason\``];
  });
}

const CHAIN_HINT = 'the groups of one repo form a chain, each on the previous one (`publish.stack`)';

/**
 * Per repo: one group without a predecessor from its repo, every other on exactly one, no two on the same one.
 * Also for the breakdown gate, where a human's edit may break the chain the breakdown was held to.
 */
export function chainProblems(groups: Group[], repoKey: (name: string) => string = (name) => name): string[] {
  const keyOf = (name: string) => {
    try {
      return repoKey(name);
    } catch {
      return name; // an unknown repo is reported by the plan check, by name
    }
  };
  const repoOf = new Map(groups.map((group) => [group.id, keyOf(group.repo)]));
  const problems: string[] = [];
  for (const key of new Set(repoOf.values())) {
    const own = groups.filter((group) => repoOf.get(group.id) === key);
    const repo = own[0]!.repo;
    const predecessors = new Map(own.map((group) => [group.id, group.depends_on.filter((dependency) => repoOf.get(dependency) === key)]));
    const first = own.filter((group) => !predecessors.get(group.id)!.length);
    if (first.length > 1) problems.push(`repo \`${repo}\`: groups without a predecessor from this repo: ${first.map((group) => group.id).join(', ')} — ${CHAIN_HINT}`);
    const followers = new Map<string, string[]>();
    for (const [id, before] of predecessors) {
      if (before.length > 1) problems.push(`${id}: more than one predecessor from repo \`${repo}\` (${before.join(', ')}); ${CHAIN_HINT}`);
      else if (before.length) followers.set(before[0]!, [...(followers.get(before[0]!) ?? []), id]);
    }
    for (const [predecessor, ids] of followers) {
      if (ids.length > 1) problems.push(`${ids.join(', ')}: a shared predecessor \`${predecessor}\` from repo \`${repo}\`; ${CHAIN_HINT}`);
    }
  }
  return problems;
}

/** What a task's sessions read: its group's references, then its own. */
export function taskReferences(group: Group, task: Task): AssetReference[] {
  return uniqueReferences([...(group.references ?? []), ...(task.references ?? [])]);
}

/** What the group's test author and reviewers read: its own references and every task's. */
export function groupReferences(group: Group): AssetReference[] {
  return uniqueReferences([...(group.references ?? []), ...group.tasks.flatMap((task) => task.references ?? [])]);
}

function uniqueReferences(references: AssetReference[]): AssetReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = JSON.stringify([reference.asset, reference.parts, reference.match]);
    return !seen.has(key) && seen.add(key);
  });
}

/** References whose asset `## External assets` doesn't list: the sessions would read a file nobody agreed on. */
export function referenceProblems(groups: Group[], externalAssets: string[]): string[] {
  return groups.flatMap((group) =>
    [...new Set(groupReferences(group).map((reference) => reference.asset))]
      .filter((asset) => !externalAssets.some((bullet) => bullet.includes(asset)))
      .map((asset) => `${group.id}: reference \`${asset}\` is not in \`## ${EXTERNAL_ASSETS}\` of spec.md`),
  );
}

/** `## External assets` bullets no reference points at: fine for a download, a gap for a design or behaviour source. */
export function unreferencedAssets(groups: Group[], externalAssets: string[]): string[] {
  const assets = groups.flatMap((group) => groupReferences(group).map((reference) => reference.asset));
  return externalAssets.filter((bullet) => !assets.some((asset) => bullet.includes(asset)));
}

/** Acceptance criteria of a group's tasks, in first-seen order. */
export function groupAcceptance(group: Group): string[] {
  return [...new Set(group.tasks.flatMap((task) => task.acceptance))];
}

/** Stable with respect to file order. */
export function topoOrder(groups: Group[]): Group[] {
  const done = new Set<string>();
  const out: Group[] = [];
  while (out.length < groups.length) {
    const next = groups.find((group) => !done.has(group.id) && group.depends_on.every((dependency) => done.has(dependency)));
    if (!next) throw new Error('dependency cycle in tasks.yaml');
    done.add(next.id);
    out.push(next);
  }
  return out;
}

/** Explicit tier or the most common task tier (ties: first seen). */
export function groupTier(group: Group): Tier {
  if (group.tier) return group.tier;
  const counts = new Map<Tier, number>();
  for (const task of group.tasks) if (task.tier) counts.set(task.tier, (counts.get(task.tier) ?? 0) + 1);
  let best: Tier = 'standard';
  let bestCount = 0;
  for (const [tier, count] of counts) if (count > bestCount) [best, bestCount] = [tier, count];
  return best;
}

/** The task's own tier or its group's. */
export function taskTier(group: Group, task: Task): Tier {
  return task.tier ?? groupTier(group);
}

function findCycle(groups: Group[]): string[] | undefined {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const group of groups) {
    const cycle = visit(group.id);
    if (cycle) return cycle;
  }
  return undefined;
}
