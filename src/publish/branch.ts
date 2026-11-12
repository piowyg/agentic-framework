import { slugify } from '../orchestrator/state.js';

export interface BranchVariables {
  /** Conventional commit type of the feature (`feat`, `fix`, …). */
  type: string;
  /** Tracker key without `#`; empty when the ticket has none. */
  ticket: string;
  title: string;
  slug: string;
  /** The group's title as a slug; one PR of the whole flow has no group and takes the ticket's `title`. */
  group: string;
}

/** Conventional Commits types; `feat` wins over `fix`, `fix` over the rest: a feature that also fixes something is still a feature. */
const CONVENTIONAL_TYPES = ['feat', 'fix', 'perf', 'refactor', 'revert', 'docs', 'test', 'build', 'ci', 'style', 'chore'];

/** The feature's type from its commit subjects (`feat(admission): …`); without a conventional subject, `feat`. */
export function featureType(subjects: string[]): string {
  const types = subjects.map((subject) => /^([a-z]+)(\([^)]*\))?!?:/.exec(subject)?.[1]);
  return CONVENTIONAL_TYPES.find((type) => types.includes(type)) ?? 'feat';
}

export function branchVariables(input: { subjects: string[]; trackerKey?: string; title: string; slug: string }): BranchVariables {
  return {
    type: featureType(input.subjects),
    ticket: (input.trackerKey ?? '').replace(/^#/, '').replace(/[^A-Za-z0-9._-]+/g, '-'),
    title: titleSlug(input.title),
    slug: input.slug,
    group: titleSlug(input.title),
  };
}

/** At most `TITLE_LENGTH` characters, cut after a whole word. */
const TITLE_LENGTH = 40;

function titleSlug(title: string): string {
  const full = slugify(title, Number.MAX_SAFE_INTEGER);
  if (full.length <= TITLE_LENGTH) return full;
  const cut = full.slice(0, TITLE_LENGTH + 1);
  return cut.slice(0, cut.lastIndexOf('-')) || full.slice(0, TITLE_LENGTH);
}

/**
 * `git.branch_pattern` with its variables filled in. An empty variable takes its separator with it
 * (`{type}/{ticket}-{title}` without a ticket → `feat/admission-…`).
 */
export function renderBranch(pattern: string, variables: BranchVariables): string {
  const unknown = [...pattern.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]!).filter((name) => !(name in variables));
  if (unknown.length) throw new Error(`git.branch_pattern: unknown variables ${unknown.map((name) => `{${name}}`).join(', ')}; allowed: {type}, {ticket}, {title}, {slug}, {group}`);
  const filled = pattern.replace(/\{([^}]*)\}/g, (_match, name: keyof BranchVariables) => variables[name]);
  const branch = filled
    .replace(/(^|\/)[-_.]+/g, '$1')
    .replace(/[-_.]+(\/|$)/g, '$1')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '');
  if (!branch) throw new Error(`git.branch_pattern \`${pattern}\` gave an empty branch name`);
  return branch;
}

/**
 * One branch per group of a stack, in chain order: `{group}` filled with each group's title, or, in a pattern without
 * it, the flow's name with `-1`, `-2`, … (a single group keeps the plain name). A name already taken gets `-2`, `-3`, …
 * until it is free.
 */
export function groupBranches(pattern: string, variables: BranchVariables, groupTitles: string[]): string[] {
  const perGroup = /\{group\}/.test(pattern);
  const names = groupTitles.map((title, index) => {
    if (perGroup) return renderBranch(pattern, { ...variables, group: titleSlug(title) });
    const name = renderBranch(pattern, variables);
    return groupTitles.length === 1 ? name : `${name}-${index + 1}`;
  });
  const taken = new Set<string>();
  return names.map((name) => {
    let free = name;
    for (let suffix = 2; taken.has(free); suffix++) free = `${name}-${suffix}`;
    taken.add(free);
    return free;
  });
}

/**
 * A republished stack keeps each group's branch from the last publish, so a group that gained or lost commits of its
 * own doesn't shift the names of the others (a pattern without `{group}` numbers by position). A group new to the
 * stack takes its fresh name, bumped past every branch the last publish used.
 */
export function keepGroupBranches(fresh: string[], groups: string[], previous: ReadonlyMap<string, string>): string[] {
  const taken = new Set(groups.flatMap((group) => (previous.has(group) ? [previous.get(group)!] : [])));
  const reserved = new Set([...taken, ...previous.values()]);
  return groups.map((group, index) => {
    const kept = previous.get(group);
    if (kept) return kept;
    const name = fresh[index]!;
    let free = name;
    for (let suffix = 2; reserved.has(free) || taken.has(free); suffix++) free = `${name}-${suffix}`;
    taken.add(free);
    return free;
  });
}
