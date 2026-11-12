import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { PACKAGE_ROOT } from '../paths.js';
import { REVIEW_AXES, TIERS } from './schema.js';
import type { AgenticConfig, Effort, Executor, HarnessName } from './types.js';

export interface ModelEntry {
  harness: HarnessName;
  id: string;
  efforts: Effort[];
}

export interface HarnessEntry {
  binary: string;
  version_args: string[];
  min_version?: string;
}

export interface ModelCatalog {
  harnesses: Record<HarnessName, HarnessEntry>;
  models: Record<string, ModelEntry>;
}

const DEFAULT_CATALOG = path.join(PACKAGE_ROOT, 'catalog', 'models.yaml');
let cached: ModelCatalog | undefined;

export function loadCatalog(file = DEFAULT_CATALOG): ModelCatalog {
  if (file !== DEFAULT_CATALOG) return parse(fs.readFileSync(file, 'utf8')) as ModelCatalog;
  cached ??= parse(fs.readFileSync(file, 'utf8')) as ModelCatalog;
  return cached;
}

/** Own keys only — `constructor` or `toString` are not models. */
export function modelEntry(catalog: ModelCatalog, alias: string | undefined): ModelEntry | undefined {
  return alias !== undefined && Object.hasOwn(catalog.models, alias) ? catalog.models[alias] : undefined;
}

/**
 * Fills a missing `harness` from the catalog before merging, so a model-only override
 * doesn't inherit the harness of a lower layer.
 */
export function fillHarness<T>(layer: T, catalog: ModelCatalog): T {
  if (Array.isArray(layer)) return layer.map((item) => fillHarness(item, catalog)) as T;
  if (!layer || typeof layer !== 'object') return layer;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer)) out[key] = fillHarness(value, catalog);
  if (typeof out.model === 'string' && out.harness === undefined) {
    const entry = modelEntry(catalog, out.model);
    if (entry) out.harness = entry.harness;
  }
  return out as T;
}

export function checkExecutor(where: string, executor: Partial<Executor>, catalog: ModelCatalog): string[] {
  const problems: string[] = [];
  if (!executor.model) return [`${where}: no \`model\``];
  const entry = modelEntry(catalog, executor.model);
  if (!entry) {
    return [`${where}.model: unknown model \`${executor.model}\` (known: ${Object.keys(catalog.models).join(', ')})`];
  }
  if (executor.harness && executor.harness !== entry.harness) {
    problems.push(`${where}: model \`${executor.model}\` runs in the \`${entry.harness}\` harness, not \`${executor.harness}\``);
  }
  if (executor.effort && !entry.efforts.includes(executor.effort)) {
    problems.push(`${where}.effort: \`${executor.effort}\` not available for \`${executor.model}\` (allowed: ${entry.efforts.join(', ')})`);
  }
  return problems;
}

export function checkConfigModels(config: AgenticConfig, catalog: ModelCatalog): string[] {
  const problems: string[] = [];
  for (const tier of TIERS) problems.push(...checkExecutor(`tiers.${tier}`, config.tiers[tier], catalog));
  for (const [name, stage] of Object.entries(config.stages)) {
    if (stage.model) problems.push(...checkExecutor(`stages.${name}`, stage, catalog));
    else if ((stage.harness || stage.effort) && name !== 'fix') {
      problems.push(`stages.${name}: \`harness\`/\`effort\` without \`model\``);
    }
  }
  for (const axis of [...REVIEW_AXES, 'final'] as const) {
    const executor = config.review[axis];
    if (executor) problems.push(...checkExecutor(`review.${axis}`, executor, catalog));
  }
  config.review.escalation.forEach((model, index) => {
    if (!modelEntry(catalog, model)) problems.push(`review.escalation[${index}]: unknown model \`${model}\``);
  });
  return problems;
}
