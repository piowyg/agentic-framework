import type { Estimate, Group } from '../orchestrator/artifacts.js';
import type { StackPosition } from './description.js';

/** A group that becomes one PR of a stack. */
export interface StackGroup {
  id: string;
  /** The group's title; the id when the plan gave none. */
  title: string;
  /** What the group is for, from the plan (`summary`). */
  goal?: string;
  /** The plan's size estimate, for a PR whose measured size crossed it. */
  estimate?: Estimate;
  /** Its work branch's head: the lower PR's head. The top PR takes the whole feature's head instead. */
  head: string;
}

/** A group as a stack PR shows it, from the plan; `undefined` (the plan lost it): just its id. */
export function stackGroupOf(id: string, group: Group | undefined): Omit<StackGroup, 'head'> {
  return { id, title: group?.title?.trim() || id, ...(group?.summary?.trim() && { goal: group.summary.trim() }), ...(group?.estimate && { estimate: group.estimate }) };
}

/** One PR of a stack as its description lists it. */
export interface StackEntry {
  group: Omit<StackGroup, 'head'>;
  branch: string;
  url?: string | undefined;
  /** `agentic restack` saw it merged. */
  merged?: boolean | undefined;
  /** Groups whose review notes it carries. */
  notesOf: string[];
  /** The group's measured size crossed what the plan expected (`GroupSize.warning`). */
  sizeWarning?: string | undefined;
}

/** Where PR `index` sits in the stack, for its description (`publish` and `restack` alike). */
export function stackPosition(entries: StackEntry[], index: number): StackPosition {
  const { group, notesOf, sizeWarning } = entries[index]!;
  return {
    index,
    group: group.id,
    notesOf,
    ...(group.goal && { goal: group.goal }),
    ...(sizeWarning && { missedEstimate: { ...(group.estimate && { estimate: group.estimate }) } }),
    pulls: entries.map((other) => ({ title: other.group.title, branch: other.branch, ...(other.url && { url: other.url }), ...(other.merged && { merged: true }) })),
  };
}

export interface StackLayout {
  /** Bottom first; fewer than two: one PR of the whole flow. */
  groups: StackGroup[];
  /** Why there are several groups but one PR. */
  reason?: string;
}

/**
 * The stack of the origin repo's groups (`groups` in plan order): each one starts at its predecessor's head, so each
 * PR goes onto the one before it. A plan that isn't a chain (from before `publish.stack`, or edited at the gate),
 * or group branches that don't lie one on another, give one PR, with the reason.
 */
export function stackLayout(input: {
  groups: Group[];
  heads: Record<string, string | undefined>;
  featureHead: string;
  isAncestor: (ancestor: string, descendant: string) => boolean;
}): StackLayout {
  const { groups, heads } = input;
  if (groups.length < 2) return { groups: [] };
  const ids = new Set(groups.map((group) => group.id));
  for (const [index, group] of groups.entries()) {
    if (!index) continue;
    const predecessors = group.depends_on.filter((dependency) => ids.has(dependency));
    if (predecessors.length !== 1 || predecessors[0] !== groups[index - 1]!.id) {
      return { groups: [], reason: `the plan is not a chain: ${group.id} does not sit on ${groups[index - 1]!.id} alone` };
    }
  }
  const missing = groups.filter((group) => !heads[group.id]).map((group) => group.id);
  if (missing.length) return { groups: [], reason: `missing group branches ${missing.join(', ')}` };
  const chain = [...groups.map((group) => heads[group.id]!), input.featureHead];
  const broken = chain.findIndex((head, index) => index > 0 && !input.isAncestor(chain[index - 1]!, head));
  if (broken > 0) {
    const missingAncestor = broken < groups.length ? `${groups[broken]!.id} doesn't contain ${groups[broken - 1]!.id}` : `the final review doesn't contain ${groups.at(-1)!.id}`;
    return { groups: [], reason: `the group branches don't sit one on another: ${missingAncestor}` };
  }
  return {
    groups: groups.map((group) => ({ ...stackGroupOf(group.id, group), head: heads[group.id]! })),
  };
}
