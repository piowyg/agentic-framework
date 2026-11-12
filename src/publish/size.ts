import { execFileSync } from 'node:child_process';
import picomatch from 'picomatch';
import { gitEnv } from '../config/git.js';
import type { AgenticConfig } from '../config/types.js';
import type { Estimate } from '../orchestrator/artifacts.js';
import { SAFE_GIT } from '../orchestrator/repos.js';
import type { ChangedFile } from './merge-danger.js';

/** `publish.size`: the thresholds and the globs that sort files into production, tests and excluded. */
export type SizeConfig = AgenticConfig['publish']['size'];

/** Soft thresholds of `publish.size`: production lines, and production with tests. */
export interface SizeThresholds {
  prod: number;
  total: number;
}

export function sizeThresholds(size: SizeConfig): SizeThresholds {
  return { prod: size.max_prod_lines, total: size.max_total_lines };
}

/** Lines changed (added + deleted) by kind: production, tests, and left out of both (lockfiles, generated). */
export interface LineCounts {
  prod: number;
  tests: number;
  excluded: number;
}

/** `over` names the soft thresholds the change crosses. */
export interface DiffSize extends LineCounts {
  over: Array<'prod' | 'total'>;
  /** The thresholds it was measured against, for the warning's text. */
  limits: SizeThresholds;
}

/**
 * What the reviewer actually reads: lockfiles and generated files (by glob or `linguist-generated`) are left out,
 * tests are counted apart from production code, docs count as production. A threshold crossed is only a warning.
 */
export function diffSize(files: ChangedFile[], limits: SizeConfig, generated: ReadonlySet<string> = new Set()): DiffSize {
  const excluded = picomatch(limits.exclude, { dot: true });
  const tests = picomatch(limits.tests, { dot: true });
  const size: DiffSize = { prod: 0, tests: 0, excluded: 0, over: [], limits: sizeThresholds(limits) };
  for (const file of files) {
    const lines = file.added + file.deleted;
    if (generated.has(file.path) || (limits.exclude.length && excluded(file.path))) size.excluded += lines;
    else if (limits.tests.length && tests(file.path)) size.tests += lines;
    else size.prod += lines;
  }
  size.over = overLimits(size.prod, size.tests, size.limits);
  return size;
}

/** The soft thresholds `prod` production and `tests` test lines cross: of a measured diff or of a plan's estimate. */
export function overLimits(prod: number, tests: number, limits: SizeThresholds): Array<'prod' | 'total'> {
  return [...(prod > limits.prod ? (['prod'] as const) : []), ...(prod + tests > limits.total ? (['total'] as const) : [])];
}

/** Production and test lines, for the human: the same words in the publish plan and at the breakdown gate. */
export function linesText(prod: number, tests: number): string {
  return `${prod} prod / ${tests} test`;
}

/** The thresholds, for the human: what a size warning is measured against. */
export function thresholdsText(limits: SizeThresholds): string {
  return `${limits.prod} prod, ${limits.total} with tests`;
}

/** `diffSize` of `changed` (a diff ending at `head` in `repo`), with the files `.gitattributes` marks generated at `head`. */
export function diffSizeAt(repo: string, head: string, changed: ChangedFile[], limits: SizeConfig): DiffSize {
  return diffSize(changed, limits, generatedFiles(repo, head, changed.map((file) => file.path)));
}

/**
 * Paths marked `linguist-generated` (set or `true`) by the `.gitattributes` of `commit`, not of the working tree.
 * Paths go through stdin: a wide diff doesn't fit on one command line.
 */
export function generatedFiles(repo: string, commit: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const output = execFileSync('git', [...SAFE_GIT, 'check-attr', `--source=${commit}`, '--stdin', '-z', 'linguist-generated'], {
    cwd: repo,
    env: gitEnv(),
    input: paths.map((file) => `${file}\0`).join(''),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const fields = output.split('\0');
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (['set', 'true'].includes(fields[index + 2]!)) generated.add(fields[index]!);
  }
  return generated;
}

/** How far past its estimate a diff may go over a threshold the plan's `oversize_reason` justified. */
const OVERSIZE_ESTIMATE_FACTOR = 2;

/**
 * A group's measured diff against its plan's estimate: news when the diff crosses a threshold the estimate stayed
 * under, or goes past twice the estimate over one the plan crossed (its `oversize_reason` covered the estimate, not
 * any size). Undefined: nothing to tell.
 */
export function sizeWarning(measured: Pick<LineCounts, 'prod' | 'tests'>, estimate: Estimate | undefined, limits: SizeThresholds): string | undefined {
  const planned = estimate ? overLimits(estimate.prod, estimate.tests, limits) : [];
  const measuredText = linesText(measured.prod, measured.tests);
  if (overLimits(measured.prod, measured.tests, limits).some((limit) => !planned.includes(limit))) {
    const plan = estimate ? `planned ~${linesText(estimate.prod, estimate.tests)}` : 'the plan had no estimate';
    return `over the publish.size threshold (${thresholdsText(limits)}): ${measuredText}, ${plan}`;
  }
  const lines = (counts: Estimate, limit: 'prod' | 'total') => (limit === 'prod' ? counts.prod : counts.prod + counts.tests);
  if (!estimate || !planned.some((limit) => lines(measured, limit) > OVERSIZE_ESTIMATE_FACTOR * lines(estimate, limit))) return undefined;
  return `over ${OVERSIZE_ESTIMATE_FACTOR}× the estimate behind oversize_reason: ${measuredText}, planned ~${linesText(estimate.prod, estimate.tests)}`;
}
