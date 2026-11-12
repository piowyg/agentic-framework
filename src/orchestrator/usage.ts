import path from 'node:path';
import { frameworkVersion } from '../paths.js';
import type { Executor } from '../config/types.js';
import type { SessionKind, SessionResult } from '../harness/types.js';
import { appendJsonLine, readJsonLines } from './jsonl.js';
import type { StageId } from './state.js';

export interface UsageRecord {
  at: string;
  stage: StageId;
  kind: SessionKind;
  group?: string;
  task?: string;
  round?: number;
  harness: string;
  model: string;
  effort: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** This run's cost (harness-reported, less the session's earlier runs); otherwise priced from `pricing` at report time. */
  cost_usd?: number;
  duration_ms: number;
  exit_code: number;
  /** Matches the session's events and its `transcripts/` file. */
  session_id?: string;
  /** Per skill version stats: the skills the session got, their content hashes and the framework that shipped them. */
  skills?: string[];
  skill_hashes?: Record<string, string>;
  framework_version?: string;
}

export function usageFile(workDir: string): string {
  return path.join(workDir, 'usage.jsonl');
}

export function appendUsage(
  workDir: string,
  record: {
    stage: StageId;
    kind: SessionKind;
    group?: string;
    task?: string;
    round?: number;
    executor: Executor;
    result: SessionResult;
    sessionId?: string;
    skills?: string[];
    skillHashes?: Record<string, string>;
  },
): void {
  const line: UsageRecord = {
    at: new Date().toISOString(),
    stage: record.stage,
    kind: record.kind,
    group: record.group,
    task: record.task,
    round: record.round,
    harness: record.executor.harness,
    model: record.executor.model,
    effort: record.executor.effort,
    input_tokens: record.result.usage?.inputTokens ?? 0,
    output_tokens: record.result.usage?.outputTokens ?? 0,
    cache_read_tokens: record.result.usage?.cacheReadTokens ?? 0,
    cost_usd: runCost(workDir, record.result.usage?.costUsd, record.sessionId),
    duration_ms: record.result.durationMs,
    exit_code: record.result.exitCode,
    session_id: record.sessionId,
    skills: record.skills,
    ...(record.skillHashes && { skill_hashes: record.skillHashes }),
    framework_version: frameworkVersion(),
  };
  appendJsonLine(usageFile(workDir), line);
}

/**
 * A resumed session's reported cost covers its earlier runs too, already logged: only the rest is this run's.
 * A total below what was logged means the harness reported this run alone.
 */
function runCost(workDir: string, sessionCost: number | undefined, sessionId: string | undefined): number | undefined {
  if (sessionCost === undefined || !sessionId) return sessionCost;
  const logged = readUsage(workDir)
    .filter((earlier) => earlier.session_id === sessionId)
    .reduce((sum, earlier) => sum + (earlier.cost_usd ?? 0), 0);
  return logged > 0 && sessionCost >= logged ? sessionCost - logged : sessionCost;
}

/** Skips truncated lines left by a killed process. */
export function readUsage(workDir: string): UsageRecord[] {
  return readJsonLines(usageFile(workDir), (value): value is UsageRecord => typeof (value as UsageRecord | null)?.input_tokens === 'number');
}

export interface UsageSummary {
  sessions: number;
  tokens: number;
  costUsd: number;
  minutes: number;
}

export function summarizeUsage(workDir: string): UsageSummary {
  const summary: UsageSummary = { sessions: 0, tokens: 0, costUsd: 0, minutes: 0 };
  for (const record of readUsage(workDir)) {
    summary.sessions++;
    summary.tokens += record.input_tokens + record.output_tokens;
    summary.costUsd += record.cost_usd ?? 0;
    summary.minutes += record.duration_ms / 60000;
  }
  return summary;
}
