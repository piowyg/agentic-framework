import type { Profile } from '../config/types.js';
import type { ReviewLoopState } from './state.js';
import type { UsageRecord } from './usage.js';

// Cost breakdown: stage → group → task / review round / fix.

export type Pricing = NonNullable<Profile['pricing']>;
export type UsageDimension = 'kind' | 'model' | 'stage' | 'group' | 'task';

export interface Cost {
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  /** `undefined` when no session has a harness cost or a price. */
  usd?: number;
  /** Some of the cost was priced from `pricing`. */
  estimated: boolean;
  /** Tokens with neither a harness cost nor a price: `usd` is then a lower bound. */
  unpricedTokens: number;
  unpricedModels: string[];
}

export interface UsageNode extends Cost {
  label: string;
  children: UsageNode[];
}

/** Harness-reported cost, else profile pricing (USD per 1M tokens). */
export function recordUsd(record: UsageRecord, pricing: Pricing = {}): { usd?: number; estimated: boolean } {
  if (record.cost_usd !== undefined) return { usd: record.cost_usd, estimated: false };
  const modelPricing = Object.hasOwn(pricing, record.model) ? pricing[record.model] : undefined;
  if (!modelPricing) return { estimated: false };
  const cacheRate = modelPricing.cache_read ?? modelPricing.in;
  const usd = ((record.input_tokens - record.cache_read_tokens) * modelPricing.in + record.cache_read_tokens * cacheRate + record.output_tokens * modelPricing.out) / 1e6;
  return { usd, estimated: true };
}

function emptyCost(): Cost {
  return { sessions: 0, input: 0, output: 0, cacheRead: 0, estimated: false, unpricedTokens: 0, unpricedModels: [] };
}

function addCost(cost: Cost, record: UsageRecord, pricing: Pricing): void {
  cost.sessions++;
  cost.input += record.input_tokens;
  cost.output += record.output_tokens;
  cost.cacheRead += record.cache_read_tokens ?? 0;
  const { usd, estimated } = recordUsd(record, pricing);
  if (usd !== undefined) cost.usd = (cost.usd ?? 0) + usd;
  else {
    cost.unpricedTokens += record.input_tokens + record.output_tokens;
    if (!cost.unpricedModels.includes(record.model)) cost.unpricedModels.push(record.model);
  }
  cost.estimated ||= estimated;
}

function leafLabel(record: UsageRecord): string {
  if (record.kind === 'implement') return `task ${record.task ?? '?'}`;
  if (record.kind === 'fix') return record.round ? `fix r${record.round}` : 'fix';
  if (record.kind.startsWith('review')) return record.round ? `review r${record.round}` : 'review';
  return record.kind;
}

export function usageTree(records: UsageRecord[], pricing: Pricing = {}): UsageNode {
  const root: UsageNode = { label: 'total', children: [], ...emptyCost() };
  const child = (parent: UsageNode, label: string): UsageNode => {
    let node = parent.children.find((child) => child.label === label);
    if (!node) parent.children.push((node = { label, children: [], ...emptyCost() }));
    return node;
  };
  for (const record of records) {
    const path: string[] = [record.stage ?? 'unknown'];
    if (record.group) path.push(record.group, leafLabel(record));
    let node = root;
    addCost(node, record, pricing);
    for (const label of path) {
      node = child(node, label);
      addCost(node, record, pricing);
    }
  }
  return root;
}

export function usageBy(records: UsageRecord[], dimension: UsageDimension, pricing: Pricing = {}): UsageNode[] {
  const nodesByLabel = new Map<string, UsageNode>();
  for (const record of records) {
    const key = dimension === 'task' ? (record.task ? `${record.group}/${record.task}` : '-') : String(record[dimension] ?? '-');
    let node = nodesByLabel.get(key);
    if (!node) nodesByLabel.set(key, (node = { label: key, children: [], ...emptyCost() }));
    addCost(node, record, pricing);
  }
  return [...nodesByLabel.values()].sort((left, right) => right.input + right.output - (left.input + left.output));
}

export function usageCategories(records: UsageRecord[], pricing: Pricing = {}): UsageNode[] {
  const category = (record: UsageRecord) =>
    record.kind.startsWith('review') ? 'review' : record.kind.startsWith('grill') ? 'grill' : record.kind;
  const nodesByLabel = new Map<string, UsageNode>();
  for (const record of records) {
    const key = category(record);
    let node = nodesByLabel.get(key);
    if (!node) nodesByLabel.set(key, (node = { label: key, children: [], ...emptyCost() }));
    addCost(node, record, pricing);
  }
  return [...nodesByLabel.values()];
}

/** What one review axis cost and found over the flow: does it pay off? */
export interface AxisYield {
  axis: string;
  /** Blocking findings the axis wrote, not carried from an earlier round. */
  blocking: number;
  /** Of them, the ones verification didn't reject. */
  confirmed: number;
  tokens: number;
  /** Confirmed findings per 1M tokens of the axis's sessions. */
  perMillion?: number;
}

/** Below this many tokens a rate per 1M says nothing (a skipped axis, a session that barely ran). */
export const YIELD_MIN_TOKENS = 10_000;

/** Per axis of every review loop (groups and the final review), with the tokens of its `review-<axis>` sessions. */
export function reviewYield(records: UsageRecord[], loops: ReviewLoopState[]): AxisYield[] {
  const byAxis = new Map<string, AxisYield>();
  const axis = (name: string) => {
    let entry = byAxis.get(name);
    if (!entry) byAxis.set(name, (entry = { axis: name, blocking: 0, confirmed: 0, tokens: 0 }));
    return entry;
  };
  for (const record of records) if (record.kind.startsWith('review-')) axis(record.kind.slice('review-'.length)).tokens += record.input_tokens + record.output_tokens;
  for (const finding of loops.flatMap((loop) => loop.review?.rounds ?? []).flatMap((round) => round.findings)) {
    if (finding.severity !== 'blocking' || finding.carried_from !== undefined || !finding.axis) continue;
    const entry = axis(finding.axis);
    entry.blocking++;
    if (finding.verdict?.status !== 'rejected') entry.confirmed++;
  }
  return [...byAxis.values()].map((entry) => ({ ...entry, ...(entry.tokens >= YIELD_MIN_TOKENS && { perMillion: (entry.confirmed / entry.tokens) * 1e6 }) }));
}

export function renderYield(rows: AxisYield[]): string | undefined {
  if (!rows.length) return undefined;
  const row = (entry: AxisYield) =>
    `${entry.axis} ${entry.confirmed}/${entry.blocking} confirmed, ${formatTokens(entry.tokens)}${entry.perMillion !== undefined ? ` → ${entry.perMillion.toFixed(1)} per 1M` : ''}`;
  return `review (blocking findings): ${rows.map(row).join(' · ')}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(2)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(tokens);
}

function formatUsd(cost: Cost): string {
  if (cost.usd === undefined) return '-';
  return `${cost.unpricedTokens ? '≥' : cost.estimated ? '≈' : ''}$${cost.usd.toFixed(2)}`;
}

export function renderTree(root: UsageNode, title: string): string {
  const total = root.input + root.output || 1;
  const lines: string[] = [];
  const renderRow = (prefix: string, node: UsageNode) => {
    const tokens = node.input + node.output;
    lines.push(
      `${(prefix + node.label).padEnd(34)} ${formatTokens(tokens).padStart(8)} ${formatUsd(node).padStart(9)} ${`${Math.round((tokens / total) * 100)}%`.padStart(5)}`,
    );
  };
  lines.push(`${title.padEnd(34)} ${'tokens'.padStart(8)} ${'$'.padStart(9)} ${'%'.padStart(5)}`);
  const walk = (nodes: UsageNode[], indent: string) => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      renderRow(`${indent}${last ? '└─ ' : '├─ '}`, node);
      walk(node.children, `${indent}${last ? '   ' : '│  '}`);
    });
  };
  walk(root.children, '');
  renderRow('', root);
  return lines.join('\n');
}

export function renderCategories(categories: UsageNode[], root: UsageNode): string {
  const total = root.input + root.output || 1;
  return `split: ${categories.map((category) => `${category.label} ${Math.round(((category.input + category.output) / total) * 100)}%`).join(' · ')}`;
}

export function renderUnpriced(root: UsageNode): string | undefined {
  if (!root.unpricedTokens || root.usd === undefined) return undefined;
  const share = Math.round((root.unpricedTokens / (root.input + root.output || 1)) * 100);
  return `≥ cost incomplete: ${share}% of tokens without a price (${root.unpricedModels.join(', ')}); add them to the profile's \`pricing\`.`;
}
