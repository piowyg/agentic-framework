import { deepMerge } from '../config/merge.js';
import { checkExecutor, modelEntry, type ModelCatalog } from '../config/models.js';
import { TIERS } from '../config/schema.js';
import type { AgenticConfig, Executor, StageConfig } from '../config/types.js';
import { ArtifactError, groupTier, taskTier, type Group, type Task } from './artifacts.js';

export function stageExecutor(
  config: AgenticConfig,
  stage: 'grill-business' | 'grill-technical' | 'breakdown' | 'write-tests',
  catalog: ModelCatalog,
): Executor {
  return complete(`stages.${stage}`, config.stages[stage], catalog);
}

/** `tiers[task tier ?? group tier]` plus an optional override from tasks.yaml. */
export function taskExecutor(config: AgenticConfig, group: Group, task: Task, catalog: ModelCatalog): Executor {
  const base = config.tiers[taskTier(group, task)];
  const merged = deepMerge<Partial<Executor>>(base, task.executor ?? {});
  // model-only override: take the harness from the catalog
  if (task.executor?.model && !task.executor.harness) delete merged.harness;
  const where = `tasks.yaml ${group.id}.${task.id}`;
  const problems = checkExecutor(where, merged, catalog);
  if (problems.length) throw new ArtifactError('tasks.yaml', problems);
  return complete(where, merged, catalog);
}

export function groupExecutor(config: AgenticConfig, group: Group): Executor {
  return config.tiers[groupTier(group)];
}

/** Executor of the plan's most demanding group tier; it fixes findings of the whole feature. */
export function featureExecutor(config: AgenticConfig, groups: Group[]): Executor {
  const tier = [...TIERS].reverse().find((candidate) => groups.some((group) => groupTier(group) === candidate)) ?? 'standard';
  return config.tiers[tier];
}

/** `base` (the group's or the feature's executor) with any `stages.fix` fields applied on top. */
export function fixExecutor(config: AgenticConfig, base: Executor, catalog: ModelCatalog): Executor {
  return stageOverride(config, 'fix', base, catalog);
}

/**
 * The fixer `steps` rungs up `review.escalation` (`on_stop: escalate`): the ladder from the model after
 * the fixer's own (from the bottom when the fixer isn't on it), the fixer's effort when the model has it, else its
 * highest. Undefined past the top.
 */
export function escalatedFixer(config: AgenticConfig, fixer: Executor, steps: number, catalog: ModelCatalog): Executor | undefined {
  const ladder = config.review.escalation;
  const model = ladder[ladder.indexOf(fixer.model) + steps];
  const entry = modelEntry(catalog, model);
  if (!model || !entry) return undefined;
  return { harness: entry.harness, model, effort: entry.efforts.includes(fixer.effort) ? fixer.effort : entry.efforts.at(-1)! };
}

/** The most demanding tier among the merged groups, with any `stages.merge` fields on top. */
export function mergeExecutor(config: AgenticConfig, groups: Group[], catalog: ModelCatalog): Executor {
  return stageOverride(config, 'merge', featureExecutor(config, groups), catalog);
}

function stageOverride(config: AgenticConfig, stage: 'fix' | 'merge', base: Executor, catalog: ModelCatalog): Executor {
  const { model, harness, effort } = config.stages[stage];
  const merged: Partial<Executor> = { ...base };
  if (model) Object.assign(merged, { model, harness: harness ?? modelEntry(catalog, model)?.harness });
  else if (harness) merged.harness = harness;
  if (effort) merged.effort = effort;
  const problems = checkExecutor(`stages.${stage}`, merged, catalog);
  if (problems.length) throw new Error(problems.join('; '));
  return complete(`stages.${stage}`, merged, catalog);
}

function complete(where: string, settings: StageConfig | Partial<Executor>, catalog: ModelCatalog): Executor {
  if (!settings.model) throw new Error(`${where}: no \`model\``);
  const entry = modelEntry(catalog, settings.model);
  if (!entry) throw new Error(`${where}: unknown model \`${settings.model}\``);
  return { harness: settings.harness ?? entry.harness, model: settings.model, effort: settings.effort ?? 'medium' };
}
